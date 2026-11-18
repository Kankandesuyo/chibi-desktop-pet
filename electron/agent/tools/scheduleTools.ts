import { describeTrigger } from '../Scheduler';
import { defineTool, type AnyTool } from '../types';
import type { ScheduleTrigger } from '../../../shared/agentTypes';

/** Scheduled / proactive tasks: create (always asks), list, cancel (always asks). */

interface TriggerArgs { kind: 'daily' | 'interval' | 'once' | 'folder'; time?: string; minutes?: number; at?: string; path?: string; minFiles?: number }

const scheduleTask = defineTool<{ name: string; prompt: string; trigger: TriggerArgs }>({
  name: 'schedule_task', group: 'system', riskLevel: 'medium', requiresConfirmation: true,
  description: [
    '安排一个定时或自动触发的任务。到时候你会自己执行 prompt 里的请求，并把结果告诉用户。',
    '触发方式 trigger.kind：daily（每天 time="09:00"）、interval（每隔 minutes 分钟，至少 15）、once（一次，at=ISO 时间）、folder（path 文件夹里的文件数达到 minFiles 时）。',
    '注意：定时任务在无人值守时运行，只能查看和汇报，不能修改电脑；需要动手的事会列给用户。只有用户明确要求定时/提醒时才用。',
  ].join(''),
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: 40, description: '简短的名字，例如 早上汇总下载文件夹' },
      prompt: { type: 'string', maxLength: 2000, description: '到时候要做的事，写成完整的请求（执行时看不到现在的对话）' },
      trigger: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['daily', 'interval', 'once', 'folder'] },
          time: { type: 'string', maxLength: 5 },
          minutes: { type: 'integer', minimum: 15, maximum: 10080 },
          at: { type: 'string', maxLength: 40 },
          path: { type: 'string', maxLength: 500 },
          minFiles: { type: 'integer', minimum: 1, maximum: 100000 },
        },
        required: ['kind'],
      },
    },
    required: ['name', 'prompt', 'trigger'],
  },
  title: (a) => `安排定时任务「${a.name}」`,
  // A folder trigger watches a folder: it has to be one she may look at.
  paths: (a, ctx) => (a.trigger.kind === 'folder' && a.trigger.path ? { read: [ctx.resolvePath(a.trigger.path)] } : {}),
  assess: (a, ctx) => {
    const trigger = { ...a.trigger, ...(a.trigger.kind === 'folder' && a.trigger.path ? { path: ctx.resolvePath(a.trigger.path) } : {}) } as ScheduleTrigger;
    let when = '';
    try { when = describeTrigger(trigger); } catch { when = a.trigger.kind; }
    return {
      risk: 'medium',
      reason: '会让她以后在没人看着的时候自己运行这个请求（只查看和汇报，不会修改电脑）',
      preview: [`名称：${a.name}`, `什么时候：${when}`, '要做的事：', ...a.prompt.split('\n').slice(0, 15)],
    };
  },
  execute: async (a, ctx) => {
    if (!ctx.services.scheduler) return { ok: false, summary: '定时任务功能不可用', error: '没有调度器' };
    const trigger = { ...a.trigger, ...(a.trigger.kind === 'folder' && a.trigger.path ? { path: ctx.resolvePath(a.trigger.path) } : {}) };
    const t = ctx.services.scheduler.add({ name: a.name, prompt: a.prompt, trigger });
    const next = ctx.services.scheduler.nextRun(t);
    return { ok: true, summary: `已安排「${t.name}」：${describeTrigger(t.trigger)}`, data: { id: t.id, when: describeTrigger(t.trigger), nextRunAt: next?.toISOString() ?? null } };
  },
  verify: async (_a, r, ctx) => (ctx.services.scheduler?.get((r.data as { id: string }).id)
    ? { verified: true, detail: '已保存到定时任务列表' }
    : { verified: false, detail: '定时任务列表里没有找到' }),
});

const listSchedules = defineTool<Record<string, never>>({
  name: 'list_schedules', group: 'system', riskLevel: 'low', requiresConfirmation: false, concurrencySafe: true,
  description: '列出所有定时任务（名称、什么时候运行、下次运行时间、上次结果、id）。',
  inputSchema: { type: 'object', properties: {} },
  title: () => '查看定时任务',
  execute: async (_a, ctx) => {
    const list = ctx.services.scheduler?.info() ?? [];
    return { ok: true, summary: list.length ? `共有 ${list.length} 个定时任务` : '还没有定时任务', data: list.map(({ id, name, when, enabled, nextRunAt, lastRunAt, lastResult }) => ({ id, name, when, enabled, nextRunAt, lastRunAt, lastResult })) };
  },
});

const cancelSchedule = defineTool<{ id: string }>({
  name: 'cancel_schedule', group: 'system', riskLevel: 'medium', requiresConfirmation: true,
  description: '删除一个定时任务（id 用 list_schedules 查）。',
  inputSchema: { type: 'object', properties: { id: { type: 'string', maxLength: 40 } }, required: ['id'] },
  title: (a) => `删除定时任务 ${a.id}`,
  assess: (a, ctx) => {
    const t = ctx.services.scheduler?.get(a.id);
    return { risk: 'medium', reason: '删除后不会再自动运行', preview: t ? [`名称：${t.name}`, `什么时候：${describeTrigger(t.trigger)}`] : [`没有找到 id 为 ${a.id} 的定时任务`] };
  },
  execute: async (a, ctx) => (ctx.services.scheduler?.remove(a.id)
    ? { ok: true, summary: '已删除这个定时任务' }
    : { ok: false, summary: '没有找到这个定时任务', error: '用 list_schedules 查看现有的 id' }),
});

export const scheduleTools: AnyTool[] = [scheduleTask, listSchedules, cancelSchedule];
