import type { AgentCommandResult } from '../../shared/agentTypes';
import { SLASH_COMMANDS } from '../../shared/harness';
import type { AgentController } from './AgentController';
import type { SessionStore, TurnRecord } from './SessionStore';
import type { TaskRecaps } from './TaskRecap';
import type { ToolRegistry } from './ToolRegistry';
import type { PermissionRules } from './permissionRules';
import type { SkillLibrary } from './Skills';
import type { UserHooks } from './UserHooks';
import type { Scheduler } from './Scheduler';

/**
 * Chat slash commands: handled right here, without a model turn (after Claude Code's / dsh's commands).
 * Only "/word" at the very start counts, so a message like "/r/xxx 是什么" still goes to her as text.
 */

export interface CommandDeps {
  controller: AgentController;
  sessions: SessionStore;
  recaps: TaskRecaps;
  registry: ToolRegistry;
  skills?: SkillLibrary;
  userHooks?: UserHooks;
  scheduler?: Scheduler;
  rules?(): PermissionRules | undefined;
}

interface Command { names: string[]; help: string; run(args: string, d: CommandDeps): AgentCommandResult }

const REASON: Record<string, string> = {
  interrupted: '程序退出时被打断了', aborted: '被停止了', error: '出错停下了', 'max-steps': '做到步骤上限停下了',
};

const short = (s: string, n = 40): string => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

const COMMANDS: Command[] = [
  {
    names: ['help', '帮助'], help: '看看有哪些命令',
    run: () => ({ reply: ['可以用这些命令（直接执行，不经过模型）：', ...SLASH_COMMANDS.map((c) => `/${c.name} — ${c.help}`)].join('\n') }),
  },
  {
    names: ['new', 'clear'], help: '开始新的会话：清空聊天记录，之前的任务不再带入',
    run: (_a, d) => {
      if (d.controller.isRunning()) return { reply: '她还在做上一个任务，先点“停止”再开新会话吧。' };
      d.sessions.newSession();
      d.recaps.clear();
      return { reply: '好，重新开始～', action: 'clear' };
    },
  },
  {
    names: ['resume', '继续'], help: '接着做上一个没做完的任务（程序退出、停止、出错或到步骤上限的）',
    run: (_a, d) => {
      if (d.controller.isRunning()) return { reply: '她正在做事呢，等这一个做完再说。' };
      const t: TurnRecord | null = d.sessions.lastUnfinished();
      if (!t) return { reply: '上一个任务已经做完了，没有需要继续的。' };
      d.sessions.setPendingResume(t);
      return {
        reply: `上一个任务「${short(t.userText)}」${REASON[t.reason ?? ''] ?? '没有做完'}，已做了 ${t.steps.length} 步，接着做。`,
        action: 'send', prompt: `继续刚才没做完的任务：${short(t.userText, 200)}`,
      };
    },
  },
  {
    names: ['status', '状态'], help: '看看当前会话和她的状态',
    run: (_a, d) => {
      const info = d.sessions.info();
      const unfinished = d.sessions.lastUnfinished();
      return {
        reply: [
          `会话：${info.id}（${info.turns} 个回合，${(info.bytes / 1024).toFixed(1)} KB）`,
          `现在：${d.controller.isRunning() ? '正在做任务' : '空闲'}`,
          unfinished ? `上一个任务「${short(unfinished.userText)}」${REASON[unfinished.reason ?? ''] ?? '没做完'}，可以用 /resume 继续` : '上一个任务：已完成',
        ].join('\n'),
      };
    },
  },
  {
    names: ['tools', '工具'], help: '看看她现在能用哪些工具',
    run: (_a, d) => {
      const tools = d.registry.list();                       // enabled groups only
      const byGroup = new Map<string, string[]>();
      for (const t of tools) byGroup.set(t.group, [...(byGroup.get(t.group) ?? []), t.name]);
      return { reply: [`可用工具 ${tools.length} 个：`, ...[...byGroup].map(([g, names]) => `· ${g}（${names.length}）：${names.join('、')}`)].join('\n') };
    },
  },
  {
    names: ['skills', '技能'], help: '看看她会哪些技能',
    run: (_a, d) => {
      const list = d.skills?.list() ?? [];
      if (!list.length) return { reply: '还没有技能。可以让她“把刚才的做法存成技能”，或者在 设置 → 智能体 → 技能 里打开技能文件夹自己写。' };
      return { reply: [`她会 ${list.length} 个技能：`, ...list.map((s) => `· ${s.name}${s.source === 'user' ? '（你教的）' : ''}：${s.description}`)].join('\n') };
    },
  },
  {
    names: ['permissions', '权限'], help: '看看权限规则',
    run: (_a, d) => {
      const r = d.rules?.() ?? { allow: [], deny: [] };
      const list = (rules: string[]): string => rules.map((x) => `  ${x}`).join('\n');
      return {
        reply: [
          '高风险操作永远逐次确认；只读模式、自动允许中风险在聊天框左下角切换。',
          r.allow.length ? `允许（中风险不再询问）：\n${list(r.allow)}` : '允许规则：无',
          r.deny.length ? `禁止：\n${list(r.deny)}` : '禁止规则：无',
          '规则在 设置 → 智能体 → 权限规则 里修改。',
        ].join('\n'),
      };
    },
  },
  {
    names: ['hooks', '钩子'], help: '看看钩子状态',
    run: (_a, d) => {
      if (!d.userHooks) return { reply: '钩子功能不可用。' };
      d.userHooks.reload();
      const s = d.userHooks.status();
      const state = { none: '没有配置', pending: '有改动，等你在设置里批准后才会生效', active: '已启用', error: `出错：${s.detail ?? ''}` }[s.state];
      return { reply: [`钩子：${state}${s.count ? `（${s.count} 条：${s.events.join('、')}）` : ''}`, `文件：${s.file}`].join('\n') };
    },
  },
  {
    names: ['schedule', '定时'], help: '看看定时任务',
    run: (_a, d) => {
      const list = d.scheduler?.info() ?? [];
      if (!list.length) return { reply: '还没有定时任务。可以直接对她说，例如“每天早上 9 点帮我看看下载文件夹里有什么新文件”。' };
      const when = (iso?: string): string => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');
      return {
        reply: [
          `定时任务 ${list.length} 个（无人值守时只查看和汇报，不会修改电脑）：`,
          ...list.map((t) => `· ${t.name}｜${t.when}｜${t.enabled ? `下次 ${when(t.nextRunAt)}` : '已停用'}${t.lastResult ? `\n    上次：${t.lastResult.slice(0, 80)}` : ''}`),
          '在 设置 → 智能体 → 定时任务 里可以停用或删除。',
        ].join('\n'),
      };
    },
  },
];

/** null = not a command (send it to her as a normal message). */
export function runCommand(input: string, d: CommandDeps): AgentCommandResult | null {
  const m = /^\/([A-Za-z]+|[一-龥]{2})(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!m) return null;
  const name = (m[1] as string).toLowerCase();
  const cmd = COMMANDS.find((c) => c.names.includes(name));
  if (!cmd) return { reply: `没有 /${name} 这个命令，输入 /help 看看有哪些。` };
  return cmd.run(m[2] ?? '', d);
}
