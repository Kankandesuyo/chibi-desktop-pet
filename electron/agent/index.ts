import { PROJECT_LANGUAGES, type ProjectLanguage } from '../../shared/agentTypes';
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
import type { AgentServices, DesktopPlatform, ScreenTarget } from './types';
import { SessionStore } from './SessionStore';
import { TaskRecaps } from './TaskRecap';
import { TurnHooks } from './TurnHooks';
import { compactionPlugin, readOnlyPlugin, recapPlugin, replayRecaps, sessionLogPlugin } from './turnPlugins';
import { runCommand } from './commands';
import { instructionsPlugin, permissionRulesPlugin, skillsPlugin, userHooksPlugin } from './extensionPlugins';
import { firstMatch } from './permissionRules';
import { SkillLibrary } from './Skills';
import { skillTools } from './tools/skillTools';
import { UserHooks } from './UserHooks';
import { loadToolsTool, ToolLoading } from './toolLoading';
import { helperTools } from './tools/helperTools';
import { scheduleTools } from './tools/scheduleTools';
import { Scheduler } from './Scheduler';
import { RUN_SCHEDULE_ID } from './AgentController';

/**
 * Built-in tools that only look (no side effects, never ask the user), so several in one step may run
 * side by side. read_file is left out on purpose: sensitive files make it ask for confirmation.
 */
const CONCURRENCY_SAFE = new Set([
  'get_known_folders', 'get_system_info', 'list_directory', 'search_files', 'get_file_info',
  'list_running_apps', 'find_installed_app', 'list_installed_software', 'winget_search', 'registry_read',
  'project_tree', 'git_status', 'list_dev_servers', 'list_memories', 'get_active_window', 'list_windows', 'load_skill',
]);

export interface AgentRuntimeOptions {
  /** Where memory, logs, journal and plugins live. */
  baseDir: string;
  platform: DesktopPlatform;
  llm: LlmClient;
  settings(): AgentSettings;
  vision(pngPath: string, question: string, signal: AbortSignal, options?: { json?: boolean }): Promise<string>;
  /** Shows a spot on screen to the user (see AgentServices.pointAt). */
  pointAt?(target: ScreenTarget): void;
  /** Exact strings that must never reach the log or the model (e.g. the API keys). */
  secrets(): string[];
  browser(): BrowserOptions;
  approvals: PluginApprovals;
  mcpServers(): McpServerConfig[];
  /** Persona block shared with plain chat. */
  persona?(): string;
  /** Skills that ship with the app (folder of <name>/SKILL.md). */
  builtinSkillsDir?: string;
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>;

/** Wires every agent module together. Used by the Electron main process and by the tests. */
/** What she is told when the conversation has a project folder. */
export function projectPromptBlock(project: string, language: ProjectLanguage = 'zh'): string {
  const has = (f: string): boolean => fs.existsSync(path.join(project, f));
  const notes = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod'].filter(has);
  const empty = (() => { try { return fs.readdirSync(project).length === 0; } catch { return false; } })();
  return [
    '## 当前项目',
    `这次对话绑定了一个项目文件夹：${project}${empty ? '（目前是空的，可以从零开始建项目）' : ''}`,
    ...(notes.length ? [`根目录里有：${notes.join('、')}（先读 AGENTS.md / CLAUDE.md / README 了解约定）`] : []),
    '- 默认就在这个文件夹里工作：相对路径（例如 src/app.ts）都从这里算起；run_command / start_dev_server 不写 cwd 时就在这里运行。',
    '- 动手前先了解：用 project_tree 看结构，用 read_file 读相关文件，有 git 时用 git_status 看改动。不确定的先查，不要凭空猜文件内容。',
    '- 改已有文件用 edit_file（精确替换一段原文，先读再改）；新文件用 create_file；只有整个重写时才用 write_file。一次改一处，改完再继续。',
    '- 在这个文件夹里新建和修改文件不需要逐个确认（都会备份，用户可以撤销）；删除文件、运行命令仍然每次请用户确认。',
    '- 改完能验证就验证（运行测试、构建或直接运行），失败就看输出继续修；最后简要汇报改了哪些文件、怎么运行、还有什么没做。',
    '- 不要改项目文件夹以外的东西，除非用户这次明确要求。',
    `- 语言：${PROJECT_LANGUAGES.find((l) => l.id === language)?.prompt ?? PROJECT_LANGUAGES[0]?.prompt}（用户在设置里选的；用户这次明确用别的语言要求时以用户为准）`,
  ].join('\n');
}

export function createAgentRuntime(o: AgentRuntimeOptions) {
  fs.mkdirSync(o.baseDir, { recursive: true });
  const redactor = new Redactor();
  const refreshSecrets = (): void => redactor.setSecrets(o.secrets());
  refreshSecrets();

  const registry = new ToolRegistry();
  const builtins = [updatePlanTool, loadToolsTool, ...helperTools, ...skillTools, ...scheduleTools, ...systemTools, ...fileTools, ...appTools, ...memoryTools, ...uiTools, ...browserTools, ...devTools, ...adminTools];
  for (const t of builtins) if (CONCURRENCY_SAFE.has(t.name)) t.concurrencySafe = true;
  registry.registerAll(builtins);

  // The open conversation's project folder (only while it still exists).
  let sessionsRef: SessionStore | null = null;
  const currentProject = (): string | null => {
    const p = sessionsRef?.project() ?? null;
    return p && path.isAbsolute(p) && fs.existsSync(p) ? p : null;
  };
  const allowedRoots = (): string[] => {
    const f = o.platform.knownFolders();
    if (o.settings().fullDiskAccess) return [...new Set([...o.platform.drives(), ...(currentProject() ? [currentProject() as string] : [])])];
    const extra = o.settings().allowedRoots.filter((r) => path.isAbsolute(r) && fs.existsSync(r));
    const project = currentProject();
    return [...new Set([f.desktop, f.documents, f.downloads, f.pictures, f.music, f.videos, ...extra, ...(project ? [project] : [])])];
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
    () => ({
      allowedRoots: allowedRoots(), protectedRoots: protectedRoots(), systemZones: systemZones(), autoApproveMedium: o.settings().autoApproveMedium,
      allowRule: (tool, args) => firstMatch(o.settings().permissionRules?.allow ?? [], tool, args),
      isUnattended: (taskId) => controller?.isUnattended(taskId) ?? false,
      project: currentProject,
    }),
    (req, signal) => (controller ? controller.confirm(req, signal) : Promise.resolve('deny')),
  );
  const logger = new TaskLogger(o.baseDir, redactor);
  const memory = new AgentMemory(o.baseDir);
  const planner = new TaskPlanner();
  const journal = new FileJournal(o.baseDir);
  const processes = new ProcessManager();
  const browser = new BrowserSession(o.browser);
  const skills = new SkillLibrary(o.builtinSkillsDir ?? null, path.join(o.baseDir, 'skills'));
  const scheduler = new Scheduler(path.join(o.baseDir, 'schedules.json'));
  const services: AgentServices = { memory, planner, journal, processes, browser, skills, scheduler, vision: o.vision, ...(o.pointAt ? { pointAt: o.pointAt } : {}) };
  const executor = new ToolExecutor(registry, permissions, new TaskVerifier(), logger, redactor, o.platform, services);
  const redact = (s: string): string => redactor.text(s);
  const hooks = new TurnHooks();
  const sessions = new SessionStore(path.join(o.baseDir, 'sessions'));
  sessionsRef = sessions;
  const recaps = new TaskRecaps();
  replayRecaps(recaps, sessions);
  controller = new AgentController({
    registry, executor, permissions, planner, memory, logger, llm: o.llm, platform: o.platform,
    settings: o.settings, allowedRoots, persona: o.persona, redact, hooks, recaps, toolLoading: new ToolLoading(registry),
  });
  const ctl = controller;
  services.helpers = { run: (task, parent) => ctl.runHelper(task, parent) };
  // Built-in turn plugins (order matters only for what ends up first in the log).
  sessionLogPlugin(hooks, sessions, redact);
  recapPlugin(hooks, recaps, sessions);
  compactionPlugin(hooks, () => ctl.compactOptions, logger, sessions);
  readOnlyPlugin(hooks, registry, () => o.settings().readOnly === true);
  // Project mode: the conversation is bound to a folder she builds and edits in (like Codex / Claude Code).
  hooks.on('turn/start', 'project', (ctx) => {
    const project = currentProject();
    if (project) ctx.systemSections.push(projectPromptBlock(project, o.settings().projectLanguage));
  });
  // Phase 3: skills, instruction files, permission rules, the user's own hooks.
  const instructionsFile = path.join(o.baseDir, 'AGENTS.md');
  const userHooks = new UserHooks(o.baseDir, o.approvals, (event, data) => logger.log('hooks', event, data));
  skillsPlugin(hooks, skills);
  instructionsPlugin(hooks, {
    globalFile: instructionsFile,
    resolvePath: (p) => permissions.resolvePath(p, o.platform.knownFolders().home),
    canRead: (file) => permissions.checkPaths({ read: [file] }).ok,
  });
  permissionRulesPlugin(hooks, () => o.settings().permissionRules ?? { allow: [], deny: [] });
  userHooksPlugin(hooks, userHooks, () => sessions.id);
  // A scheduled run's outcome is kept on the task (shown in settings and /schedule), and reported.
  const scheduleListeners = new Set<(task: { id: string; name: string }, text: string, ok: boolean) => void>();
  hooks.on('turn/end', 'scheduler', (ctx, end) => {
    const id = ctx.state.get(RUN_SCHEDULE_ID) as string | undefined;
    const task = id ? scheduler.get(id) : null;
    if (!task) return;
    const text = end.reply ?? end.error ?? (end.reason === 'aborted' ? '被停止了' : '没有完成');
    scheduler.recordResult(task.id, text);
    for (const fn of scheduleListeners) fn(task, text, end.reason === 'completed');
  });
  const plugins = new ToolPluginManager(registry, path.join(o.baseDir, 'plugins'), o.approvals, o.mcpServers);
  const applyGroups = (): void => registry.setEnabledGroups(o.settings().toolGroups);
  applyGroups();

  return {
    controller, registry, permissions, logger, memory, planner, journal, processes, browser, plugins, redactor, hooks, sessions, recaps, skills, userHooks, instructionsFile, scheduler,
    /** Called when a scheduled run finishes (for a notification). */
    onScheduledDone: (fn: (task: { id: string; name: string }, text: string, ok: boolean) => void) => { scheduleListeners.add(fn); return () => scheduleListeners.delete(fn); },
    platform: o.platform,
    /** A chat slash command (/help, /resume…); null when the text is not one. */
    command: (text: string) => runCommand(text, { controller: ctl, sessions, recaps, registry, skills, userHooks, scheduler, rules: () => o.settings().permissionRules }),
    allowedRoots, applyGroups, refreshSecrets,
    info(): AgentInfo {
      const f = o.platform.knownFolders();
      return {
        schedules: scheduler.info(),
        skills: skills.list().map(({ name, description, source }) => ({ name, description, source })), skillDir: skills.userDir,
        hooks: (userHooks.reload(), userHooks.status()), instructionsFile,
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
