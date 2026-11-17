import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentInfo, AgentSettings, McpServerConfig } from '../../shared/agentTypes';
import { AgentController } from './AgentController';
import { AgentMemory } from './AgentMemory';
import { FileJournal } from './FileJournal';
import type { LlmClient } from './llm';
import { PermissionManager } from './PermissionManager';
import { Redactor } from './redact';
import { TaskLogger } from './TaskLogger';
import { TaskPlanner, updatePlanTool } from './TaskPlanner';
import { TaskVerifier } from './TaskVerifier';
import { ToolExecutor } from './ToolExecutor';
import { ToolPluginManager, type PluginApprovals } from './ToolPluginManager';
import { ToolRegistry } from './ToolRegistry';
import { appTools, systemTools } from './tools/appTools';
import { BrowserSession, browserTools, type BrowserOptions } from './tools/browserTools';
import { devTools, ProcessManager } from './tools/devTools';
import { fileTools } from './tools/fileTools';
import { adminTools } from './tools/adminTools';
import { memoryTools, uiTools } from './tools/memoryUiTools';
import type { AgentServices, DesktopPlatform } from './types';

export interface AgentRuntimeOptions {
  /** Where memory, logs, journal and plugins live. */
  baseDir: string;
  platform: DesktopPlatform;
  llm: LlmClient;
  settings(): AgentSettings;
  vision(pngPath: string, question: string, signal: AbortSignal): Promise<string>;
  /** Exact strings that must never reach the log or the model (e.g. the API keys). */
  secrets(): string[];
  browser(): BrowserOptions;
  approvals: PluginApprovals;
  mcpServers(): McpServerConfig[];
  /** Persona block shared with plain chat. */
  persona?(): string;
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>;

/** Wires every agent module together. Used by the Electron main process and by the tests. */
export function createAgentRuntime(o: AgentRuntimeOptions) {
  fs.mkdirSync(o.baseDir, { recursive: true });
  const redactor = new Redactor();
  const refreshSecrets = (): void => redactor.setSecrets(o.secrets());
  refreshSecrets();

  const registry = new ToolRegistry();
  registry.registerAll([updatePlanTool, ...systemTools, ...fileTools, ...appTools, ...memoryTools, ...uiTools, ...browserTools, ...devTools, ...adminTools]);

  const allowedRoots = (): string[] => {
    const f = o.platform.knownFolders();
    if (o.settings().fullDiskAccess) return o.platform.drives();
    const extra = o.settings().allowedRoots.filter((r) => path.isAbsolute(r) && fs.existsSync(r));
    return [...new Set([f.desktop, f.documents, f.downloads, f.pictures, f.music, f.videos, ...extra])];
  };
  // The pet's own data (permissions, approvals, audit log) and install folder are never writable by the agent,
  // whatever the settings — otherwise it could grant itself permissions.
  const protectedRoots = (): string[] => {
    const f = o.platform.knownFolders();
    return [...f.protected, o.baseDir, ...(o.settings().fullDiskAccess ? [] : f.system)];
  };
  const systemZones = (): string[] => (o.settings().fullDiskAccess ? o.platform.knownFolders().system : []);

  let controller: AgentController | null = null;
  const permissions = new PermissionManager(
    () => ({ allowedRoots: allowedRoots(), protectedRoots: protectedRoots(), systemZones: systemZones(), autoApproveMedium: o.settings().autoApproveMedium }),
    (req, signal) => (controller ? controller.confirm(req, signal) : Promise.resolve('deny')),
  );
  const logger = new TaskLogger(o.baseDir, redactor);
  const memory = new AgentMemory(o.baseDir);
  const planner = new TaskPlanner();
  const journal = new FileJournal(o.baseDir);
  const processes = new ProcessManager();
  const browser = new BrowserSession(o.browser);
  const services: AgentServices = { memory, planner, journal, processes, browser, vision: o.vision };
  const executor = new ToolExecutor(registry, permissions, new TaskVerifier(), logger, redactor, o.platform, services);
  controller = new AgentController({
    registry, executor, permissions, planner, memory, logger, llm: o.llm, platform: o.platform,
    settings: o.settings, allowedRoots, persona: o.persona,
  });
  const plugins = new ToolPluginManager(registry, path.join(o.baseDir, 'plugins'), o.approvals, o.mcpServers);
  const applyGroups = (): void => registry.setEnabledGroups(o.settings().toolGroups);
  applyGroups();

  return {
    controller, registry, permissions, logger, memory, planner, journal, processes, browser, plugins, redactor,
    allowedRoots, applyGroups, refreshSecrets,
    info(): AgentInfo {
      const f = o.platform.knownFolders();
      return {
        tools: registry.info(), plugins: plugins.info(), mcpServers: o.mcpServers(), memories: memory.list(),
        recentTasks: logger.recentTasks(), defaultRoots: [f.desktop, f.documents, f.downloads, f.pictures, f.music, f.videos],
        logDir: logger.logDir, pluginDir: plugins.pluginDir,
      };
    },
    async shutdown(): Promise<void> {
      processes.stopAll();
      plugins.unloadAll();
      await browser.close();
    },
  };
}
