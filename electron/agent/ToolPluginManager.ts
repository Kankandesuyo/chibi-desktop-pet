import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServerConfig, PluginInfo, RiskLevel } from '../../shared/agentTypes';
import { McpStdioClient } from './mcpClient';
import { maxRisk } from './PermissionManager';
import type { ToolRegistry } from './ToolRegistry';
import type { AnyTool, ObjectSchema, ToolResult } from './types';

/** What a local plugin's main file exports (CommonJS): `module.exports = { tools: [...] }`. */
export interface PluginToolSpec {
  name: string;
  description: string;
  inputSchema: ObjectSchema;
  riskLevel?: RiskLevel;
  requiresConfirmation?: boolean;
  execute(args: Record<string, unknown>, api: { signal: AbortSignal; log: (msg: string) => void }): Promise<{ ok: boolean; summary: string; data?: unknown; error?: string }>;
  verify?(args: Record<string, unknown>, result: unknown): Promise<{ verified: boolean; detail: string }>;
}

interface PluginManifest { name: string; version?: string; description?: string; main?: string }

export interface PluginApprovals { get(): Record<string, string>; set(name: string, hash: string | null): void }

const safeName = (s: string): string => s.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+/, '').slice(0, 24) || 'x';

/**
 * Loads extra tools without touching the agent:
 *  - local plugins in <userData>/agent/plugins/<name>/ (plugin.json + JS). A plugin runs only after the
 *    user approves it in Settings; approval is tied to a hash of its files, so a changed plugin is blocked again.
 *  - MCP servers (stdio) the user configured and enabled.
 * Plugin tools are always at least medium risk (they ask before running unless auto-approve is on).
 */
export class ToolPluginManager {
  private readonly infos = new Map<string, PluginInfo>();
  private readonly mcpClients = new Map<string, McpStdioClient>();

  constructor(
    private readonly registry: ToolRegistry,
    readonly pluginDir: string,
    private readonly approvals: PluginApprovals,
    private readonly mcpServers: () => McpServerConfig[],
  ) {}

  info(): PluginInfo[] { return [...this.infos.values()]; }

  /** Hash of a plugin's manifest + every JS file in it. */
  static hashPlugin(dir: string): string {
    const h = createHash('sha256');
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(d, e.name);
        if (e.isDirectory() && e.name !== 'node_modules') walk(full);
        else if (e.isFile() && /\.(js|cjs|json)$/i.test(e.name)) { h.update(path.relative(dir, full)); h.update(fs.readFileSync(full)); }
      }
    };
    walk(dir);
    return h.digest('hex');
  }

  async reloadAll(): Promise<void> {
    this.unloadAll();
    this.loadLocalPlugins();
    await this.loadMcpServers();
  }

  unloadAll(): void {
    this.registry.unregisterSource('plugin:');
    this.registry.unregisterSource('mcp:');
    for (const c of this.mcpClients.values()) c.close();
    this.mcpClients.clear();
    this.infos.clear();
  }

  approve(name: string, approve: boolean): void {
    const dir = path.join(this.pluginDir, name);
    this.approvals.set(name, approve && fs.existsSync(dir) ? ToolPluginManager.hashPlugin(dir) : null);
  }

  loadLocalPlugins(): void {
    let dirs: string[] = [];
    try { fs.mkdirSync(this.pluginDir, { recursive: true }); dirs = fs.readdirSync(this.pluginDir).filter((d) => fs.statSync(path.join(this.pluginDir, d)).isDirectory()); } catch { return; }
    const approved = this.approvals.get();
    for (const dirName of dirs) {
      const dir = path.join(this.pluginDir, dirName);
      const key = `plugin:${dirName}`;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')) as PluginManifest;
        const hash = ToolPluginManager.hashPlugin(dir);
        if (approved[dirName] !== hash) {
          this.infos.set(key, { name: dirName, kind: 'local', status: 'pending-approval', detail: approved[dirName] ? '插件文件变了，需要重新批准' : `${manifest.description ?? ''}（未批准，不会运行）`, tools: [] });
          continue;
        }
        const mainFile = path.resolve(dir, manifest.main ?? 'index.js');
        if (!mainFile.startsWith(dir + path.sep)) throw new Error('main 必须在插件文件夹内');
        delete require.cache[require.resolve(mainFile)];
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(mainFile) as { tools?: PluginToolSpec[] };
        const names: string[] = [];
        for (const spec of mod.tools ?? []) {
          const tool = this.wrapLocal(dirName, spec);
          this.registry.register(tool);
          names.push(tool.name);
        }
        this.infos.set(key, { name: dirName, kind: 'local', status: 'loaded', detail: manifest.description, tools: names });
      } catch (err) {
        this.registry.unregisterSource(`${key}`);
        this.infos.set(key, { name: dirName, kind: 'local', status: 'error', detail: err instanceof Error ? err.message : String(err), tools: [] });
      }
    }
  }

  private wrapLocal(plugin: string, spec: PluginToolSpec): AnyTool {
    if (typeof spec.execute !== 'function' || typeof spec.name !== 'string' || spec.inputSchema?.type !== 'object') throw new Error(`工具定义不完整：${spec.name}`);
    return {
      name: `${safeName(plugin)}__${safeName(spec.name)}`.slice(0, 64),
      description: `[插件 ${plugin}] ${String(spec.description ?? '').slice(0, 500)}`,
      group: 'plugins',
      inputSchema: spec.inputSchema,
      riskLevel: maxRisk('medium', spec.riskLevel ?? 'medium'),
      requiresConfirmation: Boolean(spec.requiresConfirmation),
      source: `plugin:${plugin}`,
      title: () => `插件 ${plugin}：${spec.name}`,
      execute: async (args, ctx): Promise<ToolResult> => {
        const r = await spec.execute(args, { signal: ctx.signal, log: (msg) => ctx.log('plugin_log', { msg: String(msg).slice(0, 500) }) });
        return { ok: Boolean(r?.ok), summary: String(r?.summary ?? ''), data: r?.data, error: r?.error, external: true };
      },
      verify: spec.verify ? async (args, result) => spec.verify!(args, result.data) : undefined,
    };
  }

  async loadMcpServers(): Promise<void> {
    for (const s of this.mcpServers()) {
      const key = `mcp:${s.name}`;
      if (!s.enabled) { this.infos.set(key, { name: s.name, kind: 'mcp', status: 'disabled', tools: [] }); continue; }
      const client = new McpStdioClient({ command: s.command, args: s.args });
      try {
        await client.start();
        const specs = await client.listTools();
        const names: string[] = [];
        for (const spec of specs.slice(0, 60)) {
          const name = `mcp_${safeName(s.name)}__${safeName(spec.name)}`.slice(0, 64);
          if (this.registry.listAll().some((t) => t.name === name)) continue;
          const schema = (spec.inputSchema && spec.inputSchema.type === 'object' ? spec.inputSchema : { type: 'object', properties: {} }) as unknown as ObjectSchema;
          this.registry.register({
            name, group: 'plugins', source: key, looseSchema: true,
            description: `[MCP ${s.name}] ${(spec.description ?? spec.name).slice(0, 500)}`,
            inputSchema: schema, riskLevel: s.risk, requiresConfirmation: false,
            title: () => `MCP ${s.name}：${spec.name}`,
            assess: () => ({ risk: s.risk, reason: `调用外部 MCP 服务“${s.name}”的工具`, preview: [`工具：${spec.name}`] }),
            execute: async (args, ctx) => {
              const r = await client.callTool(spec.name, args, ctx.signal);
              return { ok: !r.isError, summary: r.isError ? 'MCP 工具返回错误' : 'MCP 工具已执行', data: { text: r.text.slice(0, 20_000), structured: r.structured }, error: r.isError ? r.text.slice(0, 300) : undefined, external: true };
            },
          });
          names.push(name);
        }
        this.mcpClients.set(s.name, client);
        this.infos.set(key, { name: s.name, kind: 'mcp', status: 'loaded', detail: `${client.serverInfo.name ?? ''} ${client.serverInfo.version ?? ''}`.trim(), tools: names });
      } catch (err) {
        client.close();
        this.infos.set(key, { name: s.name, kind: 'mcp', status: 'error', detail: err instanceof Error ? err.message : String(err), tools: [] });
      }
    }
  }
}
