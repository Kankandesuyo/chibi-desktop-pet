import { defineTool, type AnyTool } from '../types';

/** load_skill: the full instructions of one skill. save_skill: keep a workflow the user taught as a skill. */
const loadSkill = defineTool<{ name: string }>({
  name: 'load_skill', group: 'internal', riskLevel: 'low', requiresConfirmation: false, concurrencySafe: true,
  description: '读取一个技能的完整做法（技能列表见系统提示里的“你会的技能”）。读完后按做法用其他工具执行。',
  inputSchema: { type: 'object', properties: { name: { type: 'string', maxLength: 40 } }, required: ['name'] },
  title: (a) => `读取技能「${a.name}」`,
  execute: async (a, ctx) => {
    const skill = ctx.services.skills?.load(a.name);
    if (!skill) {
      const names = ctx.services.skills?.list().map((s) => s.name) ?? [];
      return { ok: false, summary: '没有这个技能', error: names.length ? `可用的技能：${names.join('、')}` : '目前没有任何技能' };
    }
    return { ok: true, summary: `已读取技能「${skill.info.name}」`, data: { name: skill.info.name, source: skill.info.source, instructions: skill.text } };
  },
});

const saveSkill = defineTool<{ name: string; description: string; instructions: string }>({
  name: 'save_skill', group: 'memory', riskLevel: 'medium', requiresConfirmation: true,
  description: '把用户教的一套做法保存成技能，以后遇到类似请求可以用 load_skill 取出来照做。只有用户明确要求保存时才用。同名的用户技能会被替换。',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: 40, description: '简短的技能名，例如 整理截图' },
      description: { type: 'string', maxLength: 200, description: '一句话：什么时候用这个技能' },
      instructions: { type: 'string', maxLength: 20000, description: 'Markdown 写的具体做法：步骤、注意事项、要用的工具' },
    },
    required: ['name', 'description', 'instructions'],
  },
  title: (a) => `保存技能「${a.name}」`,
  assess: (a, ctx) => {
    const existing = ctx.services.skills?.get(a.name);
    return {
      risk: 'medium',
      reason: existing?.source === 'user' ? `会替换已有的技能「${existing.name}」。技能会影响她以后怎么做事，请看一下内容` : '技能会影响她以后怎么做事，请看一下内容',
      preview: [`名称：${a.name}`, `什么时候用：${a.description}`, '做法：', ...a.instructions.split('\n').slice(0, 30)],
    };
  },
  execute: async (a, ctx) => {
    if (!ctx.services.skills) return { ok: false, summary: '技能功能不可用', error: '没有技能库' };
    const s = ctx.services.skills.save(a.name, a.description, a.instructions);
    return { ok: true, summary: `已保存技能「${s.name}」`, data: { name: s.name } };
  },
  verify: async (a, _r, ctx) => (ctx.services.skills?.get(a.name)?.source === 'user'
    ? { verified: true, detail: '技能文件已写入' }
    : { verified: false, detail: '没有找到保存的技能' }),
});

export const skillTools: AnyTool[] = [loadSkill, saveSkill];
