import type { ToolRegistry } from './ToolRegistry';
import { defineTool, type AnyTool } from './types';

/**
 * Tools on demand (after Claude Code's deferred tools): with many tools enabled, only the everyday groups
 * go to the model with every request; the rest are listed by group with one line each, and the model loads
 * a group with load_tools when the task needs it. Fewer tool schemas per request means fewer tokens and
 * fewer wrong picks. Loading only changes what the model is shown: every call still goes through the
 * executor and the permission checks, and disabled groups stay unavailable.
 */

/** Groups sent with every request. */
const CORE_GROUPS = new Set<string>(['internal', 'files', 'apps', 'system', 'memory']);
/** Single tools sent with every request although their group is loaded on demand. */
const ALWAYS = new Set<string>(['pet_web_search', 'pet_web_read']);
/** Below this many enabled tools everything is sent as before. */
export const LAZY_THRESHOLD = 48;

export const DEFERRED_GROUPS: Record<string, string> = {
  ui: '界面自动化和 Computer Use：列窗口、点按钮、输入文字、按键、滚动、截图分析、指给用户看',
  browser: '网页自动化（她自己的浏览器配置，用户登录过的网站）：打开网页、点击、填表、提取内容、上传下载',
  dev: '开发者工具：项目结构、git 状态、运行命令、启动/停止开发服务器',
  admin: '系统管理（每次 UAC）：安装/卸载/升级软件、服务、注册表、管理员命令',
  plugins: '插件和 MCP 服务器提供的工具',
};

export class ToolLoading {
  constructor(private readonly registry: ToolRegistry) {}

  /** Is the deferred mode on right now (enough tools enabled)? */
  active(): boolean { return this.registry.list().length > LAZY_THRESHOLD; }

  /** The filter for what the model sees, given the groups loaded in this turn. */
  visible(loaded: ReadonlySet<string>): (t: AnyTool) => boolean {
    if (!this.active()) return () => true;
    return (t) => CORE_GROUPS.has(t.group) || ALWAYS.has(t.name) || loaded.has(t.group);
  }

  /** Deferred groups that currently have enabled tools, with how many. */
  deferredGroups(): { group: string; label: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const t of this.registry.list()) {
      if (CORE_GROUPS.has(t.group) || ALWAYS.has(t.name)) continue;
      counts.set(t.group, (counts.get(t.group) ?? 0) + 1);
    }
    return [...counts].map(([group, count]) => ({ group, count, label: DEFERRED_GROUPS[group] ?? group }));
  }

  /** System-prompt block listing the groups that can be loaded. null when not in deferred mode. */
  promptBlock(): string | null {
    if (!this.active()) return null;
    const groups = this.deferredGroups();
    if (!groups.length) return null;
    return [
      '## 按需加载的工具',
      '为了省事，下面这些工具组平时不列出来。任务需要时，先调用 load_tools 加载对应的组（可以一次加载几个），加载后这个任务里就能用了：',
      ...groups.map((g) => `- ${g.group}（${g.count} 个）：${g.label}`),
    ].join('\n');
  }
}

/** Context a turn gives load_tools (set up by the controller). */
export interface ToolLoader { load(groups: string[]): { loaded: string[]; catalog: string } }

export const loadToolsTool = defineTool<{ groups: string[] }>({
  name: 'load_tools', group: 'internal', riskLevel: 'low', requiresConfirmation: false, concurrencySafe: true,
  description: '加载平时不列出的工具组（见系统提示“按需加载的工具”），加载后这个任务里就能调用其中的工具。只是让工具可见，不会操作电脑。',
  inputSchema: {
    type: 'object',
    properties: { groups: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', enum: Object.keys(DEFERRED_GROUPS) } } },
    required: ['groups'],
  },
  title: (a) => `加载工具组：${a.groups.join('、')}`,
  execute: async (a, ctx) => {
    if (!ctx.toolLoader) return { ok: true, summary: '所有工具都已经可用', data: { loaded: [] } };
    const r = ctx.toolLoader.load(a.groups);
    if (!r.loaded.length) return { ok: false, summary: '这些工具组没有可用的工具', error: '可能在设置里被关闭了，或者组名不对' };
    // The catalogue matters for models without native tool calling (their tool list is in the prompt).
    return { ok: true, summary: `已加载 ${r.loaded.length} 个工具`, data: { tools: r.loaded, catalog: r.catalog } };
  },
});
