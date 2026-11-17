import { EMOTIONS, PET_ACTIONS, type AiReplyMeta, type Emotion, type PetAction, type PetStats } from './types';

/**
 * The model answers in plain text and may finish with one control tag:
 *     [[emotion:happy|action:wave]]
 * A trailing tag streams cleanly (JSON would have to be complete before it can be shown),
 * and it is only ever *read* — never executed. Unknown values fall back to safe defaults.
 */
const TAG_RE = /\[\[\s*emotion\s*:\s*([a-zA-Z]+)\s*(?:\|\s*action\s*:\s*([a-zA-Z]+)\s*)?\]\]\s*$/;

export function isEmotion(v: unknown): v is Emotion {
  return typeof v === 'string' && (EMOTIONS as readonly string[]).includes(v);
}
export function isPetAction(v: unknown): v is PetAction {
  return typeof v === 'string' && (PET_ACTIONS as readonly string[]).includes(v);
}

export function parseAiReply(raw: string): AiReplyMeta {
  const m = TAG_RE.exec(raw);
  let emotion: Emotion = 'neutral';
  let action: PetAction = 'none';
  let reply = raw;
  if (m) {
    reply = raw.slice(0, m.index);
    if (isEmotion(m[1])) emotion = m[1];
    if (isPetAction(m[2])) action = m[2];
  }
  return { reply: stripPartialTag(reply).trim(), emotion, action };
}

/** Text that is safe to show while streaming: hides a control tag that is still being typed. */
export function stripPartialTag(text: string): string {
  const i = text.lastIndexOf('[[');
  if (i >= 0 && !text.slice(i).includes(']]')) return text.slice(0, i);
  if (text.endsWith('[')) return text.slice(0, -1);
  return text.replace(TAG_RE, '');
}

export function buildSystemPrompt(stats: PetStats, persona?: string): string {
  return [
    persona ?? '你是一个住在用户电脑桌面上的Q版桌宠女孩：橙色长发，戴着橙色花朵发饰，穿白、橙、黑相间的裙子。',
    '说话风格：简短（1~3句）、口语化、可爱但不腻，用中文回答，除非用户用别的语言。',
    `你现在的状态：心情=${stats.mood}，好感度=${Math.round(stats.affection)}/100，精力=${Math.round(stats.energy)}/100。`,
    '回答的最后单独加一个控制标签，格式严格为 [[emotion:X|action:Y]]。',
    `X 只能是：${EMOTIONS.join(', ')}。Y 只能是：${PET_ACTIONS.join(', ')}。`,
    '标签之外不要解释标签，也不要输出代码或命令来控制程序。',
  ].join('\n');
}
