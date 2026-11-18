import { useEffect, useState, type JSX } from 'react';
import { HOTKEY_CHOICES, SIZE_MAX, SIZE_MIN } from '../../shared/constants';
import type { Settings, UiMode } from '../../shared/types';
import { useSettingsStore } from '../store/settingsStore';
import { AgentSettingsPanel } from './AgentSettingsPanel';
import { LANGS, isLang } from '../../shared/i18n';
import { tNow, useT } from '../i18n';
import type { MonologueLevel } from '../../shared/persona';
import {
  CHARACTER_IDS, CHARACTERS, characterMeta, THEME_IDS, THEME_LABELS,
  type CharacterId, type CustomCharacterInfo, type ThemeChoice,
} from '../../shared/characters';
import { resolveCharacterArt } from '../config/characters';

/** Copies the current character (manifest + every picture) into a new folder the user can edit. */
async function copyAsTemplate(character: CharacterId, custom: readonly CustomCharacterInfo[], name: string): Promise<{ id?: CharacterId; error?: string }> {
  const art = resolveCharacterArt(character, custom);
  const meta = characterMeta(art.character, custom);
  const files = await Promise.all([...art.urlByFile].map(async ([file, url]) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(tNow('读取 {file} 失败', { file }));
    return { name: file, data: new Uint8Array(await res.arrayBuffer()) };
  }));
  const manifest = { ...structuredClone(art.manifest), label: name, appearance: meta.appearance, theme: meta.theme };
  delete (manifest as Record<string, unknown>).icon;              // the icon of a built-in character is not in its folder
  return window.petAPI.createCharacter(name, manifest, files);
}

/** Character picker: built-in characters plus the user's own folders, and the tools to make one. */
function CharacterSection(props: { settings: Settings }): JSX.Element {
  const t = useT();
  const update = useSettingsStore((s) => s.update);
  const current = props.settings.character;
  const [custom, setCustom] = useState<CustomCharacterInfo[]>([]);
  const [newName, setNewName] = useState(tNow('我的角色'));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const refresh = async (): Promise<CustomCharacterInfo[]> => { const list = await window.petAPI.listCharacters(); setCustom(list); return list; };
  useEffect(() => { void refresh(); }, []);
  const meta = characterMeta(current, custom);
  const listed = custom.some((c) => c.id === current) || CHARACTER_IDS.some((id) => id === current);
  const broken = custom.filter((c) => c.error);

  const makeTemplate = async (): Promise<void> => {
    setBusy(true); setMessage('');
    try {
      const r = await copyAsTemplate(current, custom, newName.trim());
      if (r.error || !r.id) { setMessage(r.error ?? t('创建失败')); return; }
      await refresh();
      await update({ character: r.id });
      setMessage(t('已创建并切换。点「打开角色文件夹」替换里面的图片，再点「重新载入形象」。'));
      window.petAPI.openCharactersFolder();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t('创建失败'));
    } finally { setBusy(false); }
  };

  return (
    <>
      <label className="row"><span>{t('角色')}</span>
        <select value={current} onChange={(e) => void update({ character: e.target.value as CharacterId })}>
          {CHARACTER_IDS.map((id) => <option key={id} value={id}>{t(CHARACTERS[id].label)}</option>)}
          {custom.filter((c) => !c.error).map((c) => <option key={c.id} value={c.id}>{c.label}{t('（自定义）')}</option>)}
          {!listed && <option value={current}>{meta.label}{t('（找不到）')}</option>}
        </select>
      </label>
      {meta.note && <div className="row"><small>{meta.note}</small></div>}
      <div className="row buttons">
        <button type="button" onClick={() => window.petAPI.openCharactersFolder()}>{t('打开角色文件夹')}</button>
        <button type="button" onClick={() => void refresh().then((l) => setMessage(t('找到 {n} 个自定义角色', { n: l.filter((c) => !c.error).length })))}>{t('刷新列表')}</button>
        <button type="button" onClick={() => window.petAPI.reloadPet()}>{t('重新载入形象')}</button>
      </div>
      <div className="row buttons">
        <input type="text" maxLength={40} value={newName} onChange={(e) => setNewName(e.target.value)} aria-label={t('新角色名字')} />
        <button type="button" disabled={busy || !newName.trim()} onClick={() => void makeTemplate()}>{busy ? t('复制中…') : t('用当前角色做模板')}</button>
      </div>
      <div className="row"><small>{t('想换成自己的形象：先用当前角色做一个模板，把文件夹里的图片换成你的（文件名不变），再点「重新载入形象」。')}</small></div>
      {broken.map((c) => <div key={c.id} className="row"><small>{t('「{folder}」不能用：{error}', { folder: c.folder, error: c.error ?? '' })}</small></div>)}
      {message && <div className="row"><small>{message}</small></div>}
    </>
  );
}

const MONOLOGUE_LABELS: Record<MonologueLevel, string> = { off: '关闭', rare: '偶尔', normal: '适中', often: '经常' };

function PersonaSection(props: { settings: Settings }): JSX.Element {
  const t = useT();
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
      <h2 id="set-her">{t('她自己')}</h2>
      <CharacterSection settings={props.settings} />
      <label className="row"><span>{t('界面颜色')}</span>
        <select value={props.settings.theme} onChange={(e) => void update({ theme: e.target.value as ThemeChoice })}>
          {(['auto', ...THEME_IDS] as ThemeChoice[]).map((id) => <option key={id} value={id}>{t(THEME_LABELS[id])}</option>)}
        </select>
      </label>
      <label className="row col"><span>{t('名字')}</span>
        <input type="text" maxLength={12} value={name} onChange={(e) => setName(e.target.value)} placeholder="小橘" />
      </label>
      <label className="row col"><span>{t('补充性格 / 设定（可选）')}</span>
        <textarea rows={6} style={{ resize: "vertical" }} value={traits} onChange={(e) => setTraits(e.target.value)}
          placeholder={t('例如：喜欢猫，说话带点关西腔，叫我“店长”')} />
      </label>
      <label className="row"><span>{t('自言自语')}<small>{t('有人在电脑前时，她偶尔会自己冒一句心里话')}</small></span>
        <select value={props.settings.monologue} onChange={(e) => void update({ monologue: e.target.value as MonologueLevel })}>
          {(Object.keys(MONOLOGUE_LABELS) as MonologueLevel[]).map((k) => <option key={k} value={k}>{t(MONOLOGUE_LABELS[k])}</option>)}
        </select>
      </label>
      <div className="row">
        <small>{t('她会记得自己来了多少天、今天被摸了几次、帮你做成了什么。被认真问到时，她会承认自己是 AI 驱动的角色。')}</small>
        <button type="button" onClick={() => void save()}>{saved ? t('已保存 ✓') : t('保存')}</button>
      </div>
    </>
  );
}

type NumberKey = 'size' | 'opacity' | 'speed' | 'autoMoveFrequency';
/** The global shortcut, with whether Windows actually gave it to us (another program may own it). */
function HotkeyRow({ settings }: { settings: Settings }): JSX.Element {
  const t = useT();
  const [status, setStatus] = useState<{ accelerator: string; ok: boolean } | null>(null);
  useEffect(() => { void window.petAPI.hotkeyStatus().then(setStatus); }, [settings.globalHotkey]);
  const taken = status && status.accelerator === settings.globalHotkey && settings.globalHotkey && !status.ok;
  return (
    <label className="row"><span>{t('呼出她的快捷键')}<small>{taken ? t('⚠ {key} 已经被别的软件占用了，请换一个。', { key: settings.globalHotkey }) : t('在任何地方按下，她会出现并打开聊天框，可以直接打字。')}</small></span>
      <select value={settings.globalHotkey} onChange={(e) => void useSettingsStore.getState().update({ globalHotkey: e.target.value })}>
        {HOTKEY_CHOICES.map((k) => <option key={k} value={k}>{k || t('关闭')}</option>)}
      </select></label>
  );
}

type BoolKey = 'autoMove' | 'allowDrag' | 'gravity' | 'alwaysOnTop' | 'sound' | 'aiEnabled' | 'launchAtLogin';

function Slider(props: { label: string; field: NumberKey; min: number; max: number; step: number; settings: Settings; format: (v: number) => string }): JSX.Element {
  const t = useT();
  const update = useSettingsStore((s) => s.update);
  const value = props.settings[props.field];
  return (
    <label className="row">
      <span>{t(props.label)}</span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={value}
        onChange={(e) => void update({ [props.field]: Number(e.target.value) })} />
      <span className="value">{props.format(value)}</span>
    </label>
  );
}

function Toggle(props: { label: string; field: BoolKey; settings: Settings; hint?: string }): JSX.Element {
  const t = useT();
  const update = useSettingsStore((s) => s.update);
  return (
    <label className="row">
      <span>{t(props.label)}{props.hint && <small>{t(props.hint)}</small>}</span>
      <input type="checkbox" checked={props.settings[props.field]} onChange={(e) => void update({ [props.field]: e.target.checked })} />
    </label>
  );
}

export type SettingsSection = 'set-look' | 'set-her' | 'set-ai' | 'set-agent';

function Category({ id, active, children }: { id: SettingsSection; active: SettingsSection; children: React.ReactNode }): JSX.Element {
  return (
    <section id={id + '-page'} className="page-body" hidden={id !== active} aria-labelledby={id}>
      <div className="page-narrow"><div className="settings">{children}</div></div>
    </section>
  );
}

export function SettingsPanel({ active }: { active: SettingsSection }): JSX.Element {
  const t = useT();
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

  if (!loaded) return <div className="settings">{t('加载中…')}</div>;
  const pct = (v: number): string => `${Math.round(v * 100)}%`;

  const saveAi = async (): Promise<void> => {
    // An empty key field means "keep the stored key".
    await updateAi(apiKey ? { baseUrl, model, apiKey } : { baseUrl, model });
    setApiKey('');
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  return (
    <>
      <Category id="set-look" active={active}>
        <h2 id="set-look">{t('外观与动作')}</h2>
        <label className="row"><span>{t('语言')} / Language<small>{t('整个桌宠的语言，她也会用这个语言和你说话')}</small></span>
          <select value={settings.language} onChange={(e) => { if (isLang(e.target.value)) void useSettingsStore.getState().update({ language: e.target.value }); }}>
            {LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select></label>
        <label className="row"><span>{t('窗口外观')}<small>{t('主窗口的浅色 / 深色（左下角的按钮也能切换）')}</small></span>
          <select value={settings.uiMode} onChange={(e) => void useSettingsStore.getState().update({ uiMode: e.target.value as UiMode })}>
            <option value="system">{t('跟随系统')}</option><option value="light">{t('浅色')}</option><option value="dark">{t('深色')}</option>
          </select></label>
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
        <HotkeyRow settings={settings} />

      </Category>
      <Category id="set-her" active={active}><PersonaSection settings={settings} /></Category>
      <Category id="set-ai" active={active}>

        <h2 id="set-ai">{t('AI 聊天')}</h2>
        <Toggle label="启用 AI" field="aiEnabled" settings={settings} hint="关闭时聊天用离线短句" />
        <label className="row col"><span>{t('Base URL（OpenAI 兼容）')}</span>
          <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com" />
        </label>
        <label className="row col"><span>{t('模型名称')}</span>
          <input type="text" value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" />
        </label>
        <label className="row col"><span>API Key {settings.ai.hasApiKey ? t('（已保存，留空表示不修改）') : t('（未保存）')}</span>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" autoComplete="off" />
        </label>
        <div className="row">
          <small>{t('Key 只保存在本机并由系统加密，聊天请求由主进程发出，页面拿不到它。')}</small>
          <button type="button" onClick={() => void saveAi()}>{saved ? t('已保存 ✓') : t('保存 AI 配置')}</button>
        </div>

      </Category>
      <Category id="set-agent" active={active}><AgentSettingsPanel settings={settings} /></Category>
    </>
  );
}
