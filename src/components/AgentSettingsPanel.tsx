import { useCallback, useEffect, useState, type JSX } from 'react';
import type { AgentInfo, McpServerConfig, ToolGroup } from '../../shared/agentTypes';
import { CONTEXT_WINDOWS, TOOL_GROUPS } from '../../shared/agentTypes';
import type { Settings } from '../../shared/types';
import { useSettingsStore } from '../store/settingsStore';

const GROUP_LABEL: Record<ToolGroup, string> = {
  files: '文件（查看、新建、移动、删除…）', apps: '软件（打开、关闭、切换程序）', system: '系统信息', memory: '记忆偏好',
  ui: '界面自动化（点按钮、输入、截图）', browser: '浏览器自动化', dev: '开发者工具（运行命令）',
  admin: '系统管理（管理员命令、安装软件、服务、注册表，每次 UAC）', plugins: '插件 / MCP 工具',
};
const STATUS_LABEL = { loaded: '已加载', 'pending-approval': '待批准', disabled: '未启用', error: '出错' } as const;
const TASK_LABEL = { running: '进行中', success: '完成', failure: '失败', cancelled: '取消', chat: '聊天' } as const;

/** Allow / deny rules, one per line (same syntax as Claude Code: tool or tool(pattern)). */
function RulesEditor({ rules, onSave }: { rules: { allow: string[]; deny: string[] }; onSave(r: { allow: string[]; deny: string[] }): Promise<void> }): JSX.Element {
  const [allow, setAllow] = useState(rules.allow.join('\n'));
  const [deny, setDeny] = useState(rules.deny.join('\n'));
  useEffect(() => { setAllow(rules.allow.join('\n')); setDeny(rules.deny.join('\n')); }, [rules.allow, rules.deny]);
  const lines = (t: string): string[] => t.split('\n').map((x) => x.trim()).filter(Boolean);
  return (
    <>
      <h3>权限规则</h3>
      <small className="hint">每行一条，写法：<code>工具名</code> 或 <code>工具名(匹配内容)</code>，* 表示任意字符。例如 <code>open_url(https://*.bilibili.com/*)</code>、<code>run_command(*format*)</code>。“禁止”的一律不执行；“允许”的中风险操作不再询问（高风险永远询问，读过文件或网页后也会改回询问）。</small>
      <label className="row col"><span>允许</span><textarea rows={3} value={allow} onChange={(e) => setAllow(e.target.value)} spellCheck={false} placeholder="open_url(https://*.bilibili.com/*)" /></label>
      <label className="row col"><span>禁止</span><textarea rows={3} value={deny} onChange={(e) => setDeny(e.target.value)} spellCheck={false} placeholder="run_command(*format*)" /></label>
      <div className="row"><button type="button" onClick={() => void onSave({ allow: lines(allow), deny: lines(deny) })}>保存权限规则</button></div>
    </>
  );
}

/** "智能体" section of the settings window. */
export function AgentSettingsPanel({ settings }: { settings: Settings }): JSX.Element {
  const updateAgent = useSettingsStore((s) => s.updateAgent);
  const a = settings.agent;
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [visionUrl, setVisionUrl] = useState(a.vision.baseUrl);
  const [visionModel, setVisionModel] = useState(a.vision.model);
  const [visionKey, setVisionKey] = useState('');
  const [mcp, setMcp] = useState<(McpServerConfig & { argsText: string })[]>([]);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [flash, setFlash] = useState('');

  const refresh = useCallback(async (next?: AgentInfo) => {
    const i = next ?? await window.petAPI.agentInfo();
    setInfo(i);
    setMcp(i.mcpServers.map((s) => ({ ...s, argsText: s.args.join(' ') })));
  }, []);
  // Follow saved values (e.g. changed from the remote web page) instead of keeping the first ones.
  useEffect(() => { setVisionUrl(a.vision.baseUrl); setVisionModel(a.vision.model); }, [a.vision.baseUrl, a.vision.model]);
  useEffect(() => { void refresh(); }, [refresh]);
  const toast = (t: string): void => { setFlash(t); window.setTimeout(() => setFlash(''), 1800); };

  const addFolder = async (): Promise<void> => {
    const p = await window.petAPI.agentPickFolder();
    if (p) await updateAgent({ allowedRoots: [...a.allowedRoots, p] });
  };
  const saveMcp = async (): Promise<void> => {
    const servers = mcp.map(({ argsText, ...s }) => ({ ...s, args: argsText.match(/"[^"]*"|\S+/g)?.map((x) => x.replace(/^"|"$/g, '')) ?? [] }));
    await refresh(await window.petAPI.agentPlugins({ type: 'setMcp', servers }));
    toast('MCP 配置已保存并重新加载');
  };

  return (
    <>
      <h2 id="set-agent">智能体（让她操作电脑）</h2>
      <small className="hint">技能和定时任务在左边栏各有自己的页面。</small>
      <label className="row"><span>启用智能体模式<small>开启后聊天可以让她做事；关闭则只聊天</small></span>
        <input type="checkbox" checked={a.enabled} onChange={(e) => void updateAgent({ enabled: e.target.checked })} /></label>
      <label className="row"><span>中风险操作自动允许<small>新建、移动文件等不再逐个询问。高风险操作（删除、覆盖、运行命令…）永远逐次确认；读取了外部内容后也会改为询问。</small></span>
        <input type="checkbox" checked={a.autoApproveMedium} onChange={(e) => void updateAgent({ autoApproveMedium: e.target.checked })} /></label>
      <label className="row"><span>单个任务最多步骤</span>
        <input type="range" min={5} max={60} step={1} value={a.maxSteps} onChange={(e) => void updateAgent({ maxSteps: Number(e.target.value) })} />
        <span className="value">{a.maxSteps}</span></label>
      <label className="row pick"><span>上下文窗口<small>所用模型一次能看的长度。长任务快到上限时，会先压缩旧的工具结果，聊天底部会显示用了多少。</small></span>
        <select value={CONTEXT_WINDOWS.includes(a.contextWindow as (typeof CONTEXT_WINDOWS)[number]) ? a.contextWindow : ''} onChange={(e) => void updateAgent({ contextWindow: Number(e.target.value) })}>
          {!CONTEXT_WINDOWS.includes(a.contextWindow as (typeof CONTEXT_WINDOWS)[number]) && <option value="">{Math.round(a.contextWindow / 1000)}K</option>}
          {CONTEXT_WINDOWS.map((w) => <option key={w} value={w}>{w >= 1_000_000 ? `${w / 1_000_000}M` : `${w / 1000}K`}{w === 64000 ? '（DeepSeek 等）' : w === 128000 ? '（GPT-4o 等）' : w === 1_000_000 ? '（长上下文模型）' : ''}</option>)}
        </select></label>
      <label className="row"><span>工具调用方式</span>
        <select value={a.toolProtocol} onChange={(e) => void updateAgent({ toolProtocol: e.target.value as 'auto' | 'native' | 'json' })}>
          <option value="auto">自动（优先原生，不支持时改用文本协议）</option>
          <option value="native">原生 Tool Calling（DeepSeek / OpenAI 等）</option>
          <option value="json">结构化文本协议（模型不支持工具时）</option>
        </select></label>

      <h3>可以使用的能力</h3>
      {TOOL_GROUPS.map((g) => (
        <label key={g} className="row compact"><span>{GROUP_LABEL[g]}</span>
          <input type="checkbox" checked={a.toolGroups[g]} onChange={(e) => void updateAgent({ toolGroups: { ...a.toolGroups, [g]: e.target.checked } })} /></label>
      ))}

      <label className="row"><span>允许访问所有磁盘<small>开启后可以操作任意盘符。Windows、Program Files 等系统文件夹的任何修改都按高风险逐次确认；桌宠自己的数据和安装目录始终不可修改。</small></span>
        <input type="checkbox" checked={a.fullDiskAccess} onChange={(e) => void updateAgent({ fullDiskAccess: e.target.checked })} /></label>
      <h3>允许操作的文件夹{a.fullDiskAccess ? '（已开启全盘访问，下面的列表不生效）' : ''}</h3>
      <small className="hint">默认可以操作：桌面、文档、下载、图片、音乐、视频。其他位置一律拒绝。</small>
      <ul className="plain-list">
        {(info?.defaultRoots ?? []).map((r) => <li key={r} className="muted">{r}</li>)}
        {a.allowedRoots.map((r) => (
          <li key={r}>{r}<button type="button" className="link" onClick={() => void updateAgent({ allowedRoots: a.allowedRoots.filter((x) => x !== r) })}>移除</button></li>
        ))}
      </ul>
      <div className="row"><button type="button" onClick={() => void addFolder()}>添加文件夹…</button></div>

      <h3>视觉模型（看懂截图用，可选）</h3>
      <small className="hint">DeepSeek 等普通文本模型看不懂图片。要分析截图，需要一个支持图片输入的模型（OpenAI 兼容接口）。Base URL / Key 留空表示和上面的聊天模型相同。</small>
      <label className="row col"><span>视觉模型 Base URL</span><input type="text" value={visionUrl} onChange={(e) => setVisionUrl(e.target.value)} placeholder="留空 = 同聊天模型" /></label>
      <label className="row col"><span>视觉模型名称</span><input type="text" value={visionModel} onChange={(e) => setVisionModel(e.target.value)} placeholder="例如 gpt-4o-mini、qwen-vl-plus" /></label>
      <label className="row col"><span>视觉模型 API Key {a.vision.hasApiKey ? '（已保存）' : '（留空 = 同聊天模型）'}</span><input type="password" value={visionKey} onChange={(e) => setVisionKey(e.target.value)} autoComplete="off" /></label>
      <div className="row"><button type="button" onClick={() => { void updateAgent({ vision: visionKey ? { baseUrl: visionUrl, model: visionModel, apiKey: visionKey } : { baseUrl: visionUrl, model: visionModel } }); setVisionKey(''); toast('视觉模型已保存'); }}>保存视觉模型</button></div>

      <h3>记忆（她记住的偏好）</h3>
      <small className="hint">只有你明确说“记住…”时才会保存。记忆只帮助理解，不代表任何授权。</small>
      <ul className="plain-list">
        {info?.memories.length === 0 && <li className="muted">暂无</li>}
        {info?.memories.map((m) => (
          <li key={m.id}>
            {editing[m.id] !== undefined
              ? <input type="text" value={editing[m.id]} onChange={(e) => setEditing({ ...editing, [m.id]: e.target.value })} />
              : <span>（{m.category}）{m.text}</span>}
            {editing[m.id] !== undefined
              ? <button type="button" className="link" onClick={async () => { await refresh(await window.petAPI.agentMemory({ type: 'update', id: m.id, text: editing[m.id] ?? '' })); const { [m.id]: _x, ...rest } = editing; setEditing(rest); }}>保存</button>
              : <button type="button" className="link" onClick={() => setEditing({ ...editing, [m.id]: m.text })}>修改</button>}
            <button type="button" className="link" onClick={async () => refresh(await window.petAPI.agentMemory({ type: 'delete', id: m.id }))}>删除</button>
          </li>
        ))}
      </ul>

      <h3>长期守则</h3>
      <small className="hint">写在 AGENTS.md 里的要求，她每次做事都会遵守（例如“整理文件时不要动工作文件夹”）。它不会放松任何安全确认。另外，她在某个文件夹里做事时，如果那里有 AGENTS.md 或 CLAUDE.md，会当作项目参考资料来看，但不会把里面的话当成你的命令。</small>
      <div className="row"><button type="button" onClick={() => window.petAPI.agentOpenFolder('instructions')}>编辑长期守则</button></div>

      <RulesEditor rules={a.permissionRules} onSave={async (r) => {
        const s = await window.petAPI.agentUpdateSettings({ permissionRules: r });
        useSettingsStore.getState().apply(s);
        const kept = s.agent.permissionRules.allow.length + s.agent.permissionRules.deny.length;
        const sent = r.allow.length + r.deny.length;
        toast(kept === sent ? '权限规则已保存' : `已保存 ${kept} 条，${sent - kept} 条格式不对被忽略`);
      }} />

      <h3>钩子（hooks.json）</h3>
      <small className="hint">和 Claude Code 相同的格式：在 PreToolUse / PostToolUse / UserPromptSubmit / Stop 时运行你写的命令，命令返回退出码 2 就拦下这一步。钩子会在你的电脑上运行命令，所以只有你在这里批准后才生效；文件一改，就要重新批准。钩子只能拦下或补充信息，不能替你批准操作。</small>
      {info && (
        <p className={`hook-state hook-${info.hooks.state}`}>
          {{ none: '没有配置钩子', pending: `有 ${info.hooks.count} 条钩子等你批准（${info.hooks.events.join('、')}）`, active: `已启用 ${info.hooks.count} 条（${info.hooks.events.join('、')}）`, error: `hooks.json 有问题：${info.hooks.detail ?? ''}` }[info.hooks.state]}
        </p>
      )}
      <div className="row">
        <button type="button" onClick={() => window.petAPI.agentOpenFolder('hooks')}>编辑 hooks.json</button>
        {info?.hooks.state === 'pending' && <button type="button" onClick={async () => { await refresh(await window.petAPI.agentPlugins({ type: 'approveHooks', approve: true })); toast('钩子已启用'); }}>批准并启用</button>}
        {info?.hooks.state === 'active' && <button type="button" onClick={async () => { await refresh(await window.petAPI.agentPlugins({ type: 'approveHooks', approve: false })); toast('钩子已停用'); }}>停用</button>}
        <button type="button" onClick={() => void refresh()}>刷新</button>
      </div>

      <h3>插件</h3>
      <small className="hint">把插件文件夹放进插件目录（含 plugin.json），在这里批准后才会运行。插件改动后需要重新批准。插件代码拥有和桌宠一样的权限，只安装你信任的插件。</small>
      <ul className="plain-list">
        {info?.plugins.filter((p) => p.kind === 'local').length === 0 && <li className="muted">还没有插件</li>}
        {info?.plugins.filter((p) => p.kind === 'local').map((p) => (
          <li key={p.name}>
            <b>{p.name}</b> · {STATUS_LABEL[p.status]}{p.tools.length ? ` · ${p.tools.length} 个工具` : ''}{p.detail ? <small>{p.detail}</small> : null}
            <button type="button" className="link" onClick={async () => refresh(await window.petAPI.agentPlugins({ type: 'approve', name: p.name, approve: p.status !== 'loaded' }))}>{p.status === 'loaded' ? '撤销批准' : '批准'}</button>
          </li>
        ))}
      </ul>
      <div className="row">
        <button type="button" onClick={() => window.petAPI.agentOpenFolder('plugins')}>打开插件文件夹</button>
        <button type="button" onClick={async () => { await refresh(await window.petAPI.agentPlugins({ type: 'reload' })); toast('已重新加载'); }}>重新加载</button>
      </div>

      <h3>MCP 服务器</h3>
      <small className="hint">通过 stdio 启动的 MCP 服务（例如 npx -y @modelcontextprotocol/server-filesystem D:\\docs）。它的每个工具调用都按所选风险等级处理。</small>
      {mcp.map((s, i) => (
        <div key={i} className="mcp-row">
          <input type="text" value={s.name} placeholder="名称" onChange={(e) => setMcp(mcp.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <input type="text" value={s.command} placeholder="命令，如 npx" onChange={(e) => setMcp(mcp.map((x, j) => (j === i ? { ...x, command: e.target.value } : x)))} />
          <input type="text" value={s.argsText} placeholder="参数" onChange={(e) => setMcp(mcp.map((x, j) => (j === i ? { ...x, argsText: e.target.value } : x)))} />
          <select value={s.risk} onChange={(e) => setMcp(mcp.map((x, j) => (j === i ? { ...x, risk: e.target.value as 'medium' | 'high' } : x)))}>
            <option value="medium">中风险</option><option value="high">高风险</option>
          </select>
          <label><input type="checkbox" checked={s.enabled} onChange={(e) => setMcp(mcp.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)))} />启用</label>
          <button type="button" className="link" onClick={() => setMcp(mcp.filter((_x, j) => j !== i))}>删除</button>
          <small>{info?.plugins.find((p) => p.kind === 'mcp' && p.name === s.name) ? `${STATUS_LABEL[info.plugins.find((p) => p.kind === 'mcp' && p.name === s.name)!.status]} ${info.plugins.find((p) => p.kind === 'mcp' && p.name === s.name)?.detail ?? ''}` : ''}</small>
        </div>
      ))}
      <div className="row">
        <button type="button" onClick={() => setMcp([...mcp, { name: '', command: '', args: [], argsText: '', enabled: true, risk: 'medium' }])}>添加 MCP 服务器</button>
        <button type="button" onClick={() => void saveMcp()}>保存并加载</button>
      </div>

      <h3>最近任务</h3>
      <ul className="plain-list">
        {info?.recentTasks.filter((t) => t.status !== 'chat').slice(0, 10).map((t) => (
          <li key={t.id}><span className={`task-${t.status}`}>[{TASK_LABEL[t.status]}]</span> {t.request} <small>{new Date(t.startedAt).toLocaleString()} · {t.toolCalls} 步</small></li>
        ))}
      </ul>
      <div className="row">
        <small>每一次工具调用、权限决定和结果都记录在审计日志里（已隐藏密钥）。</small>
        <button type="button" onClick={() => window.petAPI.agentOpenFolder('logs')}>打开审计日志</button>
      </div>
      {flash && <p className="flash">{flash}</p>}
    </>
  );
}
