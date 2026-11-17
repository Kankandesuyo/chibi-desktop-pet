import type { ToolGroup, ToolInfo } from '../../shared/agentTypes';
import type { AnyTool, ObjectSchema } from './types';

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/** OpenAI / DeepSeek "tools" entry. */
export interface OpenAiTool {
  type: 'function';
  function: { name: string; description: string; parameters: ObjectSchema };
}

/**
 * The one place tools live. The agent can only ever run what is registered here — a name the model
 * invents is rejected by the executor, never interpreted as a command.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();
  private enabledGroups: Set<string> = new Set();

  register(tool: AnyTool): void {
    if (!NAME_RE.test(tool.name)) throw new Error(`工具名不合法：${tool.name}`);
    if (this.tools.has(tool.name)) throw new Error(`工具重名：${tool.name}`);
    if (tool.inputSchema.type !== 'object') throw new Error(`${tool.name} 的 inputSchema 必须是 object`);
    this.tools.set(tool.name, { source: 'builtin', ...tool });
  }

  registerAll(tools: AnyTool[]): void { for (const t of tools) this.register(t); }

  unregister(name: string): boolean { return this.tools.delete(name); }

  /** Removes every tool whose source starts with the prefix (e.g. when a plugin is unloaded). */
  unregisterSource(prefix: string): void {
    for (const [name, t] of this.tools) if ((t.source ?? '').startsWith(prefix)) this.tools.delete(name);
  }

  setEnabledGroups(groups: Partial<Record<ToolGroup, boolean>>): void {
    this.enabledGroups = new Set(Object.entries(groups).filter(([, on]) => on).map(([g]) => g));
  }

  private isEnabled(t: AnyTool): boolean {
    return t.group === 'internal' || this.enabledGroups.size === 0 || this.enabledGroups.has(t.group);
  }

  /** Only returns tools in enabled groups. */
  get(name: string): AnyTool | undefined {
    const t = this.tools.get(name);
    return t && this.isEnabled(t) ? t : undefined;
  }

  has(name: string): boolean { return this.get(name) !== undefined; }

  list(): AnyTool[] { return [...this.tools.values()].filter((t) => this.isEnabled(t)); }

  listAll(): AnyTool[] { return [...this.tools.values()]; }

  info(): ToolInfo[] {
    return this.listAll().map((t) => ({ name: t.name, group: t.group, risk: t.riskLevel, description: t.description, source: t.source ?? 'builtin' }));
  }

  /** `only` limits the list (tool groups loaded on demand); the default is every enabled tool. */
  toOpenAiTools(only?: (t: AnyTool) => boolean): OpenAiTool[] {
    return this.list().filter((t) => !only || only(t)).map((t) => ({
      type: 'function',
      function: { name: t.name, description: `${t.description}（风险：${riskLabel(t.riskLevel)}）`, parameters: t.inputSchema },
    }));
  }

  /** Compact catalogue for models without native tool calling. */
  toPromptCatalog(only?: (t: AnyTool) => boolean): string {
    return this.list().filter((t) => !only || only(t)).map((t) => `- ${t.name}: ${t.description}\n  参数 JSON Schema: ${JSON.stringify(t.inputSchema)}`).join('\n');
  }
}

export function riskLabel(r: string): string {
  return r === 'high' ? '高' : r === 'medium' ? '中' : '低';
}
