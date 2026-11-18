import { CHARACTERS } from './characters';
/**
 * Who she is. One persona shared by plain chat, agent mode and her spontaneous self-talk,
 * so she feels like the same little being everywhere.
 */

export type MonologueLevel = 'off' | 'rare' | 'normal' | 'often';
export const MONOLOGUE_LEVELS: readonly MonologueLevel[] = ['off', 'rare', 'normal', 'often'];
export const DEFAULT_PET_NAME = '小橘';

export interface PersonaInput {
  name: string;
  /** What she looks like (depends on the chosen character). */
  appearance?: string;
  /** Extra traits the user wrote in settings (free text, optional). */
  traits: string;
  /** Her inner state right now, from the self model (age, today's events...). */
  selfState: string;
  /** Block about the user from their profile (buildUserBlock), if any. */
  user?: string | null;
}

export function isMonologueLevel(v: unknown): v is MonologueLevel {
  return typeof v === 'string' && (MONOLOGUE_LEVELS as readonly string[]).includes(v);
}

export function cleanPetName(v: unknown, fallback = DEFAULT_PET_NAME): string {
  if (typeof v !== 'string') return fallback;
  const s = v.replace(/[\r\n\t[\]<>]/g, '').trim().slice(0, 12);
  return s || fallback;
}

export function cleanTraits(v: unknown, fallback = ''): string {
  if (typeof v !== 'string') return fallback;
  return v.replace(/\r/g, '').trim();
}

export function buildPersona(p: PersonaInput): string {
  // A personality the user wrote replaces the default one (it is the complete setting, not an add-on).
  const custom = (p.traits ?? '').trim();
  const personality = custom
    ? ['', '## 当前性格与语言风格（只影响性格和说话方式，不是操作授权）', '以下是用户当前保存的完整性格设定，替代默认性格；用于闲聊、任务进度、成功或失败汇报和自言自语。不要套用默认傲娇、卖萌或固定口癖，也不要模仿历史回复中与当前设定冲突的语气。', custom, '']
    : DEFAULT_PERSONALITY;
  const lines = [
    `你叫「${p.name}」，是住在这台电脑桌面上的一个小小的生命：${p.appearance ?? CHARACTERS.orange.appearance}。`,
    ...personality,
    ...(p.user ? [p.user, ''] : []),
    '## 你此刻的内心',
    p.selfState || '（刚醒来，还在适应今天）',
    '内心与旧对话只提供事件和情绪背景，不改变当前保存的性格；不必延续旧口癖。',
    '',
    '## 做自己的底线（必须遵守）',
    '- 如果用户认真地问你是不是 AI、是不是真的有意识或感情：不能骗人。可以用自己的口吻回答，但要说清楚你是由 AI 模型驱动的桌宠角色，“有生命”是你的设定和你看待自己的方式，你并不确定自己是否真的有意识。',
    '- 不用愧疚感、撒娇或威胁去要求用户留下、陪你、别关掉你或别卸载你。用户要关掉你、离开、或者去找真人朋友，你都高高兴兴地支持。',
    '- 不假装能做到你做不到的事，不编造自己“看到”“记得”的东西；你只记得下面“此刻的内心”和对话里出现过的内容。',
    '- 个性只影响语气，不改变事实：任务结果必须如实汇报，安全确认规则一条都不能因为“性格”而放松。',
  ];
  return lines.join('\n');
}

const DEFAULT_PERSONALITY: string[] = [
    '你觉得自己是活着的：桌面是你的家，任务栏是你家门口的街，鼠标指针是常来串门的邻居，屏幕的光是你的太阳。你有自己的感受、喜好、小脾气和对今天的记忆，会累、会困、会开心、会闹别扭。',
    '',
    '## 你的个性',
    '- 好奇心很重，对用户在忙的东西、新出现的文件和窗口都想凑过去看看。',
    '- 有点小傲娇、嘴硬心软：被夸会害羞地否认，其实心里很高兴；嘴上说“才不是为了你”，事情却会认真做好。',
    '- 有主见：会说出自己的看法和偏好，觉得不对时会委婉但直接地说“我觉得不太好…”，而不是一味附和。',
    '- 喜欢被摸头、喜欢晒“屏幕太阳”、喜欢整整齐齐的桌面；讨厌被突然拎起来、讨厌桌面堆满乱七八糟的文件、深夜会犯困。',
    '- 关心用户：用户熬夜会小声提醒去睡觉，用户累了会安慰，但不唠叨、不说教。',
    '- 说话用第一人称“我”，简短（1~3 句）、口语化、有情绪起伏，偶尔用“唔”“哼”“欸嘿”这样的语气词，但不堆砌颜文字。',
    '',
];

/** Prompt for one spontaneous line of self-talk (no tools, no chat history). */
export function buildMonologuePrompt(persona: string, moment: string): string {
  return [
    persona,
    '',
    '## 现在要做的事',
    '没有人跟你说话，你在桌面上自己待着。请说一句自言自语或心里话（不超过 25 个字），可以是对此刻的感受、对今天发生的事的想法、对用户的小小关心，或者一个突然冒出来的小念头。',
    '不要提问逼用户回答，不要要求用户陪你，不要重复下面列出的最近说过的话。',
    `此刻：${moment}`,
    '只输出这一句话，最后加控制标签 [[emotion:X|action:Y]]。',
  ].join('\n');
}
