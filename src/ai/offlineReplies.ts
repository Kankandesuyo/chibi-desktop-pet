import type { AiReplyMeta } from '../../shared/types';

/** Canned answers so the chat bubble still works with no API configured or no network. */
const RULES: [RegExp, AiReplyMeta][] = [
  [/你好|嗨|hello|hi\b|在吗/i, { reply: '我在这儿～有什么事吗？', emotion: 'happy', action: 'wave' }],
  [/累|困|好烦|不想/, { reply: '辛苦啦，休息一下吧，我陪着你。', emotion: 'shy', action: 'none' }],
  [/喜欢你|可爱|好看|漂亮/, { reply: '诶…突然这么说，会害羞的啦。', emotion: 'shy', action: 'shy' }],
  [/笨|讨厌|丑/, { reply: '哼，不理你了。', emotion: 'angry', action: 'angry' }],
  [/晚安|睡觉|睡了/, { reply: '晚安～做个好梦。', emotion: 'sleepy', action: 'sleep' }],
  [/代码|bug|报错|作业|论文/i, { reply: '这种问题双击托盘里的“打开 Claude 桌面版”问 Claude 更靠谱哦！', emotion: 'happy', action: 'wink' }],
];
const FALLBACK: AiReplyMeta[] = [
  { reply: '嗯嗯，我在听～', emotion: 'neutral', action: 'none' },
  { reply: '（还没配置 AI，我只会说几句简单的话…可以去“设置”里填 API）', emotion: 'neutral', action: 'lookAround' },
  { reply: '今天也要加油呀！', emotion: 'happy', action: 'jump' },
];

export function offlineReply(text: string, rng: () => number = Math.random): AiReplyMeta {
  for (const [pattern, reply] of RULES) if (pattern.test(text)) return reply;
  return FALLBACK[Math.floor(rng() * FALLBACK.length)] as AiReplyMeta;
}
