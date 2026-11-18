import { defineTool, type AnyTool } from '../types';

/**
 * delegate_task: hand one self-contained investigation to a helper (subagent) with its own context and
 * read-only tools; only its conclusion comes back. Several in the same step run side by side.
 */
const delegateTask = defineTool<{ task: string }>({
  name: 'delegate_task', group: 'internal', riskLevel: 'low', requiresConfirmation: false, concurrencySafe: true,
  description: '派一个小帮手去完成一项独立的调查（只能查看，不能修改任何东西），它会把结论交回来。几项互不相关的调查可以在同一步里各派一个，同时进行。任务描述要写清楚：查什么、在哪里查、要交回什么。',
  inputSchema: {
    type: 'object',
    properties: { task: { type: 'string', minLength: 2, maxLength: 2000, description: '交给小帮手的完整说明（它看不到之前的对话）' } },
    required: ['task'],
  },
  title: (a) => `派小帮手：${a.task.slice(0, 40)}${a.task.length > 40 ? '…' : ''}`,
  execute: async (a, ctx) => {
    if (!ctx.services.helpers) return { ok: false, summary: '现在不能派小帮手', error: '小帮手功能不可用' };
    return ctx.services.helpers.run(a.task, { taskId: ctx.taskId, signal: ctx.signal });
  },
});

export const helperTools: AnyTool[] = [delegateTask];
