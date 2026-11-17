import type { PlanStepView } from '../../shared/agentTypes';
import { defineTool } from './types';

/**
 * Keeps the plan of each task. The model writes the plan itself through the `update_plan` tool
 * (so planning works for any request, not just ones we anticipated); the UI and the pet show progress.
 */
export class TaskPlanner {
  private readonly plans = new Map<string, PlanStepView[]>();
  onChange: (taskId: string, steps: PlanStepView[]) => void = () => undefined;

  set(taskId: string, steps: PlanStepView[]): void {
    const clean = steps.slice(0, 20).map((s) => ({ title: s.title.slice(0, 120), status: s.status }));
    this.plans.set(taskId, clean);
    this.onChange(taskId, clean);
  }

  get(taskId: string): PlanStepView[] { return this.plans.get(taskId) ?? []; }

  progress(taskId: string): { done: number; total: number } | null {
    const p = this.get(taskId);
    if (p.length === 0) return null;
    return { done: p.filter((s) => s.status === 'done' || s.status === 'skipped').length, total: p.length };
  }

  /** Marks anything still open as failed when a task ends badly, so the UI never shows a stuck spinner. */
  finish(taskId: string, ok: boolean): void {
    const p = this.plans.get(taskId);
    if (p && !ok) this.set(taskId, p.map((s) => (s.status === 'pending' || s.status === 'in_progress' ? { ...s, status: 'failed' } : s)));
    this.plans.delete(taskId);
  }
}

const STATUSES = ['pending', 'in_progress', 'done', 'failed', 'skipped'] as const;

export const updatePlanTool = defineTool<{ steps: { title: string; status: PlanStepView['status'] }[] }>({
  name: 'update_plan',
  group: 'internal',
  description: '记录或更新当前任务的步骤计划。多步骤任务开始前先调用一次，之后每完成/失败一步就更新状态。只是记录，不会操作电脑。',
  inputSchema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array', maxItems: 20, minItems: 1,
        items: { type: 'object', properties: { title: { type: 'string', maxLength: 120 }, status: { type: 'string', enum: STATUSES } }, required: ['title', 'status'] },
      },
    },
    required: ['steps'],
  },
  riskLevel: 'low',
  requiresConfirmation: false,
  title: (a) => `更新计划（${a.steps.length} 步）`,
  execute: async (a, ctx) => {
    ctx.services.planner.set(ctx.taskId, a.steps);
    const p = ctx.services.planner.progress(ctx.taskId);
    return { ok: true, summary: `计划已更新：${p?.done ?? 0}/${p?.total ?? a.steps.length}` };
  },
});
