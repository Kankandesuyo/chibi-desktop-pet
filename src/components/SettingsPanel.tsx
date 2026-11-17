import { useEffect, useState, type JSX } from 'react';
import { SIZE_MAX, SIZE_MIN } from '../../shared/constants';
import type { Settings } from '../../shared/types';
import { useSettingsStore } from '../store/settingsStore';
import { AgentSettingsPanel } from './AgentSettingsPanel';
import type { MonologueLevel } from '../../shared/persona';
import { CHARACTER_IDS, CHARACTERS, THEME_IDS, THEME_LABELS, type CharacterId, type ThemeChoice } from '../../shared/characters';

const MONOLOGUE_LABELS: Record<MonologueLevel, string> = { off: '关闭', rare: '偶尔', normal: '适中', often: '经常' };

function PersonaSection(props: { settings: Settings }): JSX.Element {
  const update = useSettingsStore((s) => s.update);
  const [name, setName] = useState(props.settings.petName);
  const [traits, setTraits] = useState(props.settings.personaTraits);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setName(props.settings.petName); setTraits(props.settings.personaTraits); }, [props.settings.petName, props.settings.personaTraits]);
  const save = async (): Promise<void> => {
    await update({ petName: name, personaTraits: traits });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };
  return (
    <>
      <h2>她自己</h2>
      <label className="row"><span>角色</span>
        <select value={props.settings.character} onChange={(e) => void update({ character: e.target.value as CharacterId })}>
          {CHARACTER_IDS.map((id) => <option key={id} value={id}>{CHARACTERS[id].label}</option>)}
        </select>
      </label>
      <label className="row"><span>界面颜色</span>
        <select value={props.settings.theme} onChange={(e) => void update({ theme: e.target.value as ThemeChoice })}>
          {(['auto', ...THEME_IDS] as ThemeChoice[]).map((t) => <option key={t} value={t}>{THEME_LABELS[t]}</option>)}
        </select>
      </label>
      {CHARACTERS[props.settings.character].note && <div className="row"><small>{CHARACTERS[props.settings.character].note}</small></div>}
      <label className="row col"><span>名字</span>
        <input type="text" maxLength={12} value={name} onChange={(e) => setName(e.target.value)} placeholder="小橘" />
      </label>
      <label className="row col"><span>补充性格 / 设定（可选）</span>
        <textarea rows={6} style={{ resize: "vertical" }} value={traits} onChange={(e) => setTraits(e.target.value)}
          placeholder="例如：喜欢猫，说话带点关西腔，叫我“店长”" />
      </label>
      <label className="row"><span>自言自语<small>有人在电脑前时，她偶尔会自己冒一句心里话</small></span>
        <select value={props.settings.monologue} onChange={(e) => void update({ monologue: e.target.value as MonologueLevel })}>
          {(Object.keys(MONOLOGUE_LABELS) as MonologueLevel[]).map((k) => <option key={k} value={k}>{MONOLOGUE_LABELS[k]}</option>)}
        </select>
      </label>
      <div className="row">
        <small>她会记得自己来了多少天、今天被摸了几次、帮你做成了什么。被认真问到时，她会承认自己是 AI 驱动的角色。</small>
        <button type="button" onClick={() => void save()}>{saved ? '已保存 ✓' : '保存'}</button>
      </div>
    </>
  );
}

type NumberKey = 'size' | 'opacity' | 'speed' | 'autoMoveFrequency';
type BoolKey = 'autoMove' | 'allowDrag' | 'gravity' | 'alwaysOnTop' | 'sound' | 'aiEnabled' | 'launchAtLogin';

function Slider(props: { label: string; field: NumberKey; min: number; max: number; step: number; settings: Settings; format: (v: number) => string }): JSX.Element {
  const update = useSettingsStore((s) => s.update);
  const value = props.settings[props.field];
  return (
    <label className="row">
      <span>{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={value}
        onChange={(e) => void update({ [props.field]: Number(e.target.value) })} />
      <span className="value">{props.format(value)}</span>
    </label>
  );
}

function Toggle(props: { label: string; field: BoolKey; settings: Settings; hint?: string }): JSX.Element {
  const update = useSettingsStore((s) => s.update);
  return (
    <label className="row">
      <span>{props.label}{props.hint && <small>{props.hint}</small>}</span>
      <input type="checkbox" checked={props.settings[props.field]} onChange={(e) => void update({ [props.field]: e.target.checked })} />
    </label>
  );
}

export function SettingsPanel(): JSX.Element {
  const { settings, loaded, apply, updateAi } = useSettingsStore();
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);

  // Follow saved values (e.g. changed from the remote web page) instead of keeping the first ones.
  useEffect(() => { setBaseUrl(settings.ai.baseUrl); setModel(settings.ai.model); }, [settings.ai.baseUrl, settings.ai.model]);
  useEffect(() => {
    void window.petAPI.getInitialData().then((d) => {
      apply(d.settings);
      setBaseUrl(d.settings.ai.baseUrl);
      setModel(d.settings.ai.model);
    });
    return window.petAPI.onSettings(apply);
  }, [apply]);

  if (!loaded) return <div className="settings">加载中…</div>;
  const pct = (v: number): string => `${Math.round(v * 100)}%`;

  const saveAi = async (): Promise<void> => {
    // An empty key field means "keep the stored key".
    await updateAi(apiKey ? { baseUrl, model, apiKey } : { baseUrl, model });
    setApiKey('');
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  return (
    <div className="settings">
      <h2>外观与动作</h2>
      <Slider label="桌宠大小" field="size" min={SIZE_MIN} max={SIZE_MAX} step={0.05} settings={settings} format={pct} />
      <Slider label="透明度" field="opacity" min={0.3} max={1} step={0.05} settings={settings} format={pct} />
      <Slider label="动作速度" field="speed" min={0.5} max={2} step={0.1} settings={settings} format={(v) => `${v.toFixed(1)}×`} />
      <Slider label="自动活动频率" field="autoMoveFrequency" min={0} max={1} step={0.05} settings={settings} format={pct} />
      <Toggle label="自动走动" field="autoMove" settings={settings} />
      <Toggle label="允许拖动" field="allowDrag" settings={settings} />
      <Toggle label="松手后掉到屏幕底部" field="gravity" settings={settings} />
      <Toggle label="始终置顶" field="alwaysOnTop" settings={settings} />
      <Toggle label="音效" field="sound" settings={settings} />
      <Toggle label="开机启动" field="launchAtLogin" settings={settings} />

      <PersonaSection settings={settings} />

      <h2>AI 聊天</h2>
      <Toggle label="启用 AI" field="aiEnabled" settings={settings} hint="关闭时聊天用离线短句" />
      <label className="row col"><span>Base URL（OpenAI 兼容）</span>
        <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com" />
      </label>
      <label className="row col"><span>模型名称</span>
        <input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" />
      </label>
      <label className="row col"><span>API Key {settings.ai.hasApiKey ? '（已保存，留空表示不修改）' : '（未保存）'}</span>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" autoComplete="off" />
      </label>
      <div className="row">
        <small>Key 只保存在本机并由系统加密，聊天请求由主进程发出，页面拿不到它。</small>
        <button type="button" onClick={() => void saveAi()}>{saved ? '已保存 ✓' : '保存 AI 配置'}</button>
      </div>

      <AgentSettingsPanel settings={settings} />
    </div>
  );
}
