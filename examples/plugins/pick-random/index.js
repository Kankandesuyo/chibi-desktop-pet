// 示例插件。把整个 pick-random 文件夹复制到 设置 → 智能体 → 插件 → “打开插件文件夹” 里，
// 再在设置里点“批准”，桌宠就能自动发现并使用 pick_random 这个工具。
// 插件工具的风险等级最低是“中”，默认每次运行前会问你。

module.exports = {
  tools: [
    {
      name: 'pick_random',
      description: '从给定的选项里随机挑选一个或几个，例如帮用户决定吃什么、抽签。',
      riskLevel: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          options: { type: 'array', items: { type: 'string', maxLength: 100 }, minItems: 1, maxItems: 100 },
          count: { type: 'integer', minimum: 1, maximum: 10, description: '挑几个，默认 1' },
        },
        required: ['options'],
      },
      async execute(args, api) {
        const pool = [...args.options];
        const n = Math.min(args.count || 1, pool.length);
        const picked = [];
        for (let i = 0; i < n; i++) picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
        api.log(`picked ${picked.join(', ')}`);
        return { ok: true, summary: `选中了：${picked.join('、')}`, data: { picked } };
      },
      // 可选：执行后的检查
      async verify(args, data) {
        const ok = data && data.picked.every((p) => args.options.includes(p));
        return { verified: ok, detail: ok ? '选中的都在选项里' : '结果不在选项里' };
      },
    },
  ],
};
