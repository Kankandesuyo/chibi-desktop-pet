import type { AgentCommandResult } from '../../shared/agentTypes';
import { SLASH_COMMANDS } from '../../shared/harness';
import type { AgentController } from './AgentController';
import type { SessionStore, TurnRecord } from './SessionStore';
import type { TaskRecaps } from './TaskRecap';
import type { ToolRegistry } from './ToolRegistry';

/**
 * Chat slash commands: handled right here, without a model turn (after Claude Code's / dsh's commands).
 * Only "/word" at the very start counts, so a message like "/r/xxx 是什么" still goes to her as text.
 */

export interface CommandDeps {
  controller: AgentController;
  sessions: SessionStore;
  recaps: TaskRecaps;
  registry: ToolRegistry;
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
