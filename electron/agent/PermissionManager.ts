import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ConfirmDecision, ConfirmRequest, RiskLevel } from '../../shared/agentTypes';
import type { PathAccess } from './types';

export interface PermissionPolicy {
  /** Folders the agent may read and change (standard user folders + ones the user added). */
  allowedRoots: string[];
  /** Never writable, even if inside an allowed root (app data, Windows, Program Files…). */
  protectedRoots: string[];
  /** Allowed, but every change inside is high risk (system folders when full disk access is on). */
  systemZones: string[];
  autoApproveMedium: boolean;
  /** Full access: no confirmations (except publishing under the user's account); see AgentSettings.fullAccess. */
  fullAccess?: boolean;
  /** The user's allow rule matching this call, if any (medium risk only; see permissionRules.ts). */
  allowRule?(tool: string, args: unknown): string | null;
  /**
   * The project folder of the current conversation (like Codex / Claude Code's workspace): relative paths
   * resolve there, and medium-risk changes that stay inside it run without asking (high risk still asks).
   */
  project?(): string | null;
  /** Nobody can answer for this task (scheduled run): anything that would ask is skipped instead. */
  isUnattended?(taskId: string): boolean;
}

export type Confirmer = (req: Omit<ConfirmRequest, 'confirmId'>, signal: AbortSignal) => Promise<ConfirmDecision>;

export interface AuthorizeInput {
  taskId: string;
  tool: string;
  title: string;
  baseRisk: RiskLevel;
  assessed: RiskLevel;
  alwaysConfirm: boolean;
  reason?: string;
  preview: string[];
  /** The task has already read external content (files, web pages, program output). */
  tainted: boolean;
  signal: AbortSignal;
  /** The call's arguments (for the user's allow rules). */
  args?: unknown;
  /** Every path it writes or removes is inside the project folder (see PermissionPolicy.project). */
  inProject?: boolean;
}

export type AuthorizeResult =
  | { allowed: true; risk: RiskLevel; how: 'auto' | 'confirmed' | 'task-grant' | 'rule' | 'project' | 'full'; rule?: string }
  | { allowed: false; risk: RiskLevel; reason: string };

const ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };
export const maxRisk = (a: RiskLevel, b: RiskLevel): RiskLevel => (ORDER[a] >= ORDER[b] ? a : b);

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p: string): string => (CASE_INSENSITIVE ? p.toLowerCase() : p);

/** true if `child` is `parent` or inside it. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Resolves symlinks/junctions of the part of the path that already exists, so links can't escape a root. */
export function realResolve(p: string): string {
  let current = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Decides whether a tool call may run.
 *  - low:    runs automatically (still limited to the allowed folders)
 *  - medium: asks, unless the user turned on auto-approve (not after reading external content),
 *            or said "allow for this task" earlier in the same task
 *  - high:   asks every single time; there is no way to grant it permanently
 */
export class PermissionManager {
  private readonly taskGrants = new Map<string, Set<string>>();
  confirmTimeoutMs = 120_000;

  constructor(private readonly policy: () => PermissionPolicy, private readonly confirmer: Confirmer) {}

  /** Turns "~/x", "%USERPROFILE%\\x" or a relative path into an absolute, normalised path. */
  resolvePath(p: string, home = os.homedir()): string {
    let s = p.trim().replace(/^["']|["']$/g, '');
    s = s.replace(/%([A-Za-z_]+)%/g, (_m, name: string) => process.env[name] ?? `%${name}%`);
    if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) s = path.join(home, s.slice(1));
    return path.resolve(this.policy().project?.() ?? home, s);
  }

  /** The open conversation's project folder, if any. */
  project(): string | null { return this.policy().project?.() ?? null; }

  /** The project folder, if the paths written or removed (at least one) all lie inside it. */
  insideProject(access: PathAccess | undefined): boolean {
    const project = this.policy().project?.();
    if (!project || !access) return false;
    const changed = [...(access.write ?? []), ...(access.remove ?? [])];
    const root = realResolve(project);
    return changed.length > 0 && changed.every((p) => isInside(realResolve(p), root) && norm(realResolve(p)) !== norm(root));
  }

  checkPaths(access: PathAccess): { ok: true; systemZone: string | null } | { ok: false; reason: string } {
    const { allowedRoots, protectedRoots, systemZones } = this.policy();
    const zones = systemZones.map(realResolve);
    let systemZone: string | null = null;
    const roots = allowedRoots.map(realResolve);
    const protectedReal = protectedRoots.map(realResolve);
    const check = (p: string, mode: 'read' | 'write' | 'remove'): string | null => {
      const real = realResolve(p);
      if (mode !== 'read' && protectedReal.some((r) => isInside(real, r))) return `${p} 是受保护的位置，不能修改`;
      if (!roots.some((r) => isInside(real, r))) return `${p} 不在允许的文件夹里。可以在“设置 → 智能体 → 允许的文件夹”里添加`;
      if (mode === 'remove' && roots.some((r) => norm(real) === norm(r))) return `不能移动、改名或删除允许的根目录本身：${p}`;
      return null;
    };
    for (const p of access.read ?? []) { const e = check(p, 'read'); if (e) return { ok: false, reason: e }; }
    for (const p of access.write ?? []) { const e = check(p, 'write'); if (e) return { ok: false, reason: e }; }
    for (const p of access.remove ?? []) { const e = check(p, 'remove'); if (e) return { ok: false, reason: e }; }
    for (const p of [...(access.write ?? []), ...(access.remove ?? [])]) {
      if (zones.some((z) => isInside(realResolve(p), z))) { systemZone = p; break; }
    }
    return { ok: true, systemZone };
  }

  async authorize(input: AuthorizeInput): Promise<AuthorizeResult> {
    const risk = maxRisk(input.baseRisk, input.assessed);
    const grants = this.taskGrants.get(input.taskId);
    // Full access asks nothing — except posting or sending something in the browser under the user's account.
    const publishes = input.tool === 'browser_click' && risk === 'high';
    if (this.policy().fullAccess && !publishes && !this.policy().isUnattended?.(input.taskId)) return { allowed: true, risk, how: 'full' };
    let needConfirm = input.alwaysConfirm || risk === 'high';
    // A user's allow rule covers medium risk only, and (like auto-approve) not after reading external content.
    if (!needConfirm && risk === 'medium' && !input.tainted) {
      const rule = this.policy().allowRule?.(input.tool, input.args) ?? null;
      if (rule) return { allowed: true, risk, how: 'rule', rule };
    }
    // Inside the project folder she edits freely (like a coding agent's workspace); every change is journalled
    // and can be undone. Deleting and running commands are high risk and still ask every time.
    if (!needConfirm && risk === 'medium' && input.inProject) return { allowed: true, risk, how: 'project' };
    if (!needConfirm && risk === 'medium') {
      const auto = this.policy().autoApproveMedium && !input.tainted;
      needConfirm = !auto && !grants?.has(input.tool);
      if (!needConfirm) return { allowed: true, risk, how: auto ? 'auto' : 'task-grant' };
    }
    if (!needConfirm) return { allowed: true, risk, how: 'auto' };
    if (this.policy().isUnattended?.(input.taskId)) {
      return { allowed: false, risk, reason: '这是无人值守的定时任务，需要确认的步骤没有执行（等用户回来再决定）' };
    }

    const timeout = AbortSignal.timeout(this.confirmTimeoutMs);
    const signal = AbortSignal.any([input.signal, timeout]);
    let decision: ConfirmDecision;
    try {
      decision = await this.confirmer({
        taskId: input.taskId, tool: input.tool, title: input.title, risk,
        reason: input.reason ?? defaultReason(risk), preview: input.preview,
        afterExternalContent: input.tainted, canAllowForTask: risk === 'medium' && !input.alwaysConfirm,
      }, signal);
    } catch {
      decision = 'deny';
    }
    if (timeout.aborted && decision !== 'deny') decision = 'deny';
    if (decision === 'deny') {
      return { allowed: false, risk, reason: input.signal.aborted ? '任务已取消' : timeout.aborted ? '等待确认超时，已取消这一步' : '用户拒绝了这一步' };
    }
    // "Allow for this task" only ever applies to medium risk; high risk keeps asking.
    if (decision === 'allow_task' && risk === 'medium') {
      if (!this.taskGrants.has(input.taskId)) this.taskGrants.set(input.taskId, new Set());
      this.taskGrants.get(input.taskId)?.add(input.tool);
    }
    return { allowed: true, risk, how: 'confirmed' };
  }

  endTask(taskId: string): void { this.taskGrants.delete(taskId); }
}

function defaultReason(risk: RiskLevel): string {
  return risk === 'high' ? '这是高风险操作，每次都需要你确认' : '这一步会修改你的电脑，需要你确认';
}
