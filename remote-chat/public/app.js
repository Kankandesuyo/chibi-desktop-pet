'use strict';
const $ = id => document.getElementById(id);
const { catalog: characters, characterId } = globalThis.PetCharacters;
let currentCharacter = 'orange';
function applyCharacter(value) {
  currentCharacter = characterId(value); const character = characters[currentCharacter];
  document.documentElement.dataset.character = currentCharacter;
  for (const img of document.querySelectorAll('[data-pet-image]')) { img.src = character.image; img.alt = character.label; }
  for (const img of document.querySelectorAll('.empty img')) img.src = character.welcomeImage;
  $('brand-symbol').textContent = character.symbol;
  document.querySelector('meta[name="theme-color"]').content = character.color;
  document.querySelector('link[rel="icon"]').href = character.image;
  try { localStorage.setItem('pet-character', currentCharacter); } catch {}
}
try { applyCharacter(localStorage.getItem('pet-character')); } catch { applyCharacter('orange'); }
let csrf = '', state = null, polling = null, pending = false, confirmationId = '';
let loadedSettingsRevision = -1;
let selectedImage = null;
let visionHasSeparateKey = false;
function notice(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
function connection(text, good = false) { $('status').textContent = text; $('status-dot').classList.toggle('connected', good); }
async function api(url, data, signal) {
  const res = await fetch(url, { method: data === undefined ? 'GET' : 'POST', headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: data === undefined ? undefined : JSON.stringify(data), signal, credentials: 'same-origin', cache: 'no-store' });
  let result;
  try { result = JSON.parse(await res.text()); }
  catch { const err = new Error('网络连接暂时中断，请稍后重试。'); err.status = res.status >= 400 ? res.status : 503; throw err; }
  if (!res.ok) { const err = new Error(result.error || '连接失败'); err.status = res.status; throw err; }
  return result;
}
function showLogin() {
  polling?.abort(); polling = null; csrf = ''; state = null; confirmationId = '';
  $('messages').replaceChildren(); $('draft').textContent = ''; $('steps').replaceChildren(); $('preview').textContent = '';
  $('task').hidden = true; $('confirm').hidden = true;
  $('login').hidden = false; $('conversation').hidden = true; $('logout').hidden = true;
  $('settings-open').hidden = true; $('settings-dialog').close(); $('settings-form').reset();
  clearSelectedImage();
  connection('等待连接');
}
function render(next) {
  const list = $('messages'); const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 90;
  const changedMessages = JSON.stringify(next.messages) !== JSON.stringify(state?.messages);
  state = next;
  applyCharacter(next.character);
  if ($('settings-dialog').open && next.settingsRevision > loadedSettingsRevision) settingsNotice('设置已在另一端更改。点击“重新加载”查看最新设置，未保存的内容会被替换。');
  $('pet-name').textContent = next.name || '桌宠'; document.title = `${next.name || '桌宠'} · 远程聊天`;
  if (changedMessages) {
    list.replaceChildren();
    if (!next.messages.length) {
      const el = document.createElement('div'); el.className = 'empty';
      const img = document.createElement('img'); img.src = characters[currentCharacter].welcomeImage; img.alt = '';
      const title = document.createElement('h2'); title.textContent = '你来啦，想聊些什么？';
      const text = document.createElement('p'); text.textContent = '在外面，也能继续和电脑上的我聊天。';
      el.append(img, title, text); list.append(el);
    }
    for (const m of next.messages) {
      const row = document.createElement('article'); row.className = `message ${m.role === 'user' ? 'user' : 'assistant'}${m.failed ? ' failed' : ''}`;
      const meta = document.createElement('small'); meta.textContent = `${m.role === 'user' ? '我' : next.name || '桌宠'} · ${m.time ? new Date(m.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '历史消息'}`;
      const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = m.content;
      row.append(meta);
      if (m.image && /^[a-f0-9]{64}$/.test(m.image.id)) {
        const img = document.createElement('img'); img.className = 'message-image'; img.src = `/api/images/${m.image.id}`; img.alt = m.image.name || '已发送图片'; img.loading = 'lazy';
        img.addEventListener('load', () => { if (nearBottom) list.scrollTop = list.scrollHeight; }); row.append(img);
      }
      row.append(bubble); list.append(row);
    }
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }
  const a = next.active;
  $('task').hidden = !a;
  $('phase').textContent = a?.mode === 'vision' ? '正在看图…' : a?.confirm ? '等待你的确认' : a?.steps?.length ? '正在处理任务…' : '正在思考…';
  $('draft').textContent = (a?.text || '').replace(/\[\[emotion:[\s\S]*$/, '');
  $('interim').textContent = a?.interim || '';
  $('steps').replaceChildren();
  for (const s of [...(a?.plan || []), ...(a?.steps || [])]) {
    const el = document.createElement('div'); el.className = 'step';
    el.textContent = `${['done','ok','success'].includes(s.status) ? '✓' : ['failed','denied'].includes(s.status) ? '×' : '·'} ${s.title || s.text || s.tool || ''}${s.summary ? ' — ' + s.summary : ''}`;
    $('steps').append(el);
  }
  const c = a?.confirm;
  confirmationId = c?.confirmId || '';
  $('confirm').hidden = !c;
  $('confirm').classList.toggle('high', c?.risk === 'high');
  if (c) {
    $('confirm-title').textContent = c.title || c.tool;
    $('risk').textContent = c.risk === 'high' ? '高风险' : '需要确认';
    $('reason').textContent = c.reason || '';
    $('preview').textContent = typeof c.preview === 'string' ? c.preview : JSON.stringify(c.preview ?? {}, null, 2);
  }
  $('send').disabled = !!a || pending;
  $('image-pick').disabled = !!a || pending;
}
async function startPolling() {
  polling?.abort(); const controller = new AbortController(); polling = controller;
  $('login').hidden = true; $('conversation').hidden = false; $('logout').hidden = false;
  $('settings-open').hidden = false;
  let version = -1;
  while (!controller.signal.aborted) {
    try {
      const next = await api(`/api/state?version=${version}`, undefined, controller.signal);
      if (controller.signal.aborted) break;
      connection('已连接 · 电脑桌宠在线', true); version = next.version; render(next);
    } catch (err) {
      if (controller.signal.aborted) break;
      if (err.status === 401) { showLogin(); notice('登录已过期，请重新输入访问口令。'); break; }
      connection('连接中断 · 正在重连');
      await new Promise(resolve => setTimeout(resolve, 2500));
    }
  }
}
$('login-form').addEventListener('submit', async e => {
  e.preventDefault(); const button = e.submitter; button.disabled = true; notice();
  try { const r = await api('/api/login', { password: $('password').value.trim() }); csrf = r.csrf; $('password').value = ''; void startPolling(); }
  catch (err) { notice(err.message); } finally { button.disabled = false; }
});
$('message-form').addEventListener('submit', async e => {
  e.preventDefault(); const text = $('message').value.trim(); if ((!text && !selectedImage) || pending || state?.active) return;
  pending = true; $('send').disabled = true; notice();
  try {
    // Slash commands (/status, /resume, /new …) are answered by the pet without a model turn.
    if (!selectedImage && /^\/\S/.test(text)) {
      const r = await api('/api/command', { text });
      if (!r.notCommand) {
        $('message').value = ''; $('message').style.height = ''; notice(r.reply);
        if (r.action === 'send' && r.prompt) await api('/api/message', { text: r.prompt });
        return;
      }
    }
    await api('/api/message', { text, ...(selectedImage ? { image: { name: selectedImage.name, dataUrl: selectedImage.dataUrl } } : {}) }); $('message').value = ''; $('message').style.height = ''; clearSelectedImage();
  }
  catch (err) { notice(err.message); }
  finally { pending = false; $('send').disabled = !!state?.active; $('image-pick').disabled = !!state?.active; }
});
$('message').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('message-form').requestSubmit(); } });
$('message').addEventListener('input', () => { $('message').style.height = 'auto'; $('message').style.height = Math.min(120, $('message').scrollHeight + 3) + 'px'; });
$('logout').addEventListener('click', async () => { try { await api('/api/logout', {}); showLogin(); notice(); } catch (err) { notice(err.message); } });
$('abort').addEventListener('click', async () => { try { await api('/api/abort', {}); } catch (err) { notice(err.message); } });
for (const decision of ['allow', 'deny']) $(decision).addEventListener('click', async () => {
  $('allow').disabled = $('deny').disabled = true;
  try { await api('/api/confirm', { id: confirmationId, decision }); notice(); }
  catch (err) { notice(err.message); }
  finally { $('allow').disabled = $('deny').disabled = false; }
});
void (async () => { try { const r = await api('/api/session'); csrf = r.csrf; void startPolling(); } catch { showLogin(); } })();

const settingsFields = [
  ['persona', 'petName', '桌宠名称', 'text', { maxlength: 12, required: true }],
  ['persona', 'personaTraits', '人格描述', 'textarea', { maxlength: 16000, rows: 9, placeholder: '希望她如何说话、思考和陪伴你…' }],
  ['persona', 'monologue', '自言自语', 'select', [['off', '关闭'], ['rare', '偶尔'], ['normal', '正常'], ['often', '经常']]],
  ['appearance', 'character', '桌宠形象', 'select', Object.entries(characters).map(([id, c]) => [id, c.label])],
  ['appearance', 'size', '桌宠大小', 'range', { min: .4, max: 1.4, step: .05 }],
  ['appearance', 'opacity', '透明度', 'range', { min: .3, max: 1, step: .05 }],
  ['appearance', 'speed', '动作速度', 'range', { min: .5, max: 2, step: .1 }],
  ['appearance', 'autoMoveFrequency', '自动活动频率', 'range', { min: 0, max: 1, step: .05 }],
  ...[['autoMove', '自动走动'], ['allowDrag', '允许拖动'], ['gravity', '松手后掉到底部'], ['alwaysOnTop', '始终置顶'], ['sound', '音效']].map(([key, label]) => ['appearance', key, label, 'checkbox', {}]),
  ['model', 'aiEnabled', '启用 AI 聊天', 'checkbox', {}],
  ['model', 'baseUrl', '服务地址（Base URL）', 'url', { required: true, maxlength: 500, placeholder: 'https://api.deepseek.com' }],
  ['model', 'model', '模型名称', 'text', { required: true, maxlength: 100, placeholder: 'deepseek-chat' }],
  ['model', 'apiKey', 'API Key', 'password', { maxlength: 400, autocomplete: 'new-password', placeholder: '留空保留已有密钥' }],
  ['vision', 'visionModel', '视觉模型名称', 'text', { maxlength: 100, placeholder: 'deepseek-flash（留空关闭视觉）' }],
  ['vision', 'visionBaseUrl', '视觉服务地址', 'url', { maxlength: 500, placeholder: '留空使用聊天服务地址' }],
  ['vision', 'visionUseChatKey', '使用聊天服务的密钥', 'checkbox', {}],
  ['vision', 'visionApiKey', '独立视觉 API Key', 'password', { maxlength: 400, autocomplete: 'new-password', placeholder: '使用独立服务时填写，留空保留' }],
  ['agent', 'agentEnabled', '启用智能体模式', 'checkbox', {}],
  ['agent', 'computerUseEnabled', '启用 Computer Use 电脑操作', 'checkbox', {}],
  ['agent', 'maxSteps', '单次任务最多步骤', 'number', { min: 3, max: 60, step: 1, required: true }],
  ['agent', 'toolProtocol', '工具调用协议', 'select', [['auto', '自动兼容'], ['native', '原生工具调用'], ['json', 'JSON 兼容模式']]],
];
const settingsHints = {
  persona: '名称和人格会用于两端的聊天，以及电脑桌宠的自言自语。',
  appearance: '保存后，电脑桌宠和网页一起切换形象。人格、模型和聊天记录继续共用。',
  model: '已有密钥不会返回网页。更换服务地址时，请同时填写新服务的密钥。',
  vision: 'DeepSeek 可填写 deepseek-flash。共用聊天服务时无需重复填写地址和密钥。上传图片会发送给此视觉模型；电脑截图仍需单次确认。',
  agent: '智能体可以调用电脑工具。Computer Use 支持看窗口、定位目标、点击、输入、按键、滚动与拖动，并检查结果；每次视觉观察和操作都需确认。目前仅支持主屏幕内的窗口，UAC 和验证码需由你处理。',
};
for (const [section, title] of [['persona', '人格'], ['appearance', '外观'], ['model', '模型'], ['vision', '视觉'], ['agent', '智能体']]) {
  const panel = document.createElement('section'); panel.dataset.panel = section; panel.id = `settings-${section}`; panel.setAttribute('role', 'tabpanel'); panel.hidden = section !== 'persona';
  const tabButton = document.createElement('button'); tabButton.type = 'button'; tabButton.textContent = title; tabButton.dataset.section = section;
  tabButton.id = `settings-tab-${section}`; tabButton.setAttribute('role', 'tab'); tabButton.setAttribute('aria-controls', panel.id); tabButton.setAttribute('aria-selected', String(section === 'persona')); panel.setAttribute('aria-labelledby', tabButton.id);
  tabButton.addEventListener('click', () => {
    for (const p of $('settings-body').children) p.hidden = p.dataset.panel !== section;
    for (const b of $('settings-tabs').children) b.setAttribute('aria-selected', String(b === tabButton));
  });
  $('settings-tabs').append(tabButton);
  const hint = document.createElement('p'); hint.className = 'setting-hint'; hint.textContent = settingsHints[section]; panel.append(hint);
  for (const [, key, label, type, options] of settingsFields.filter(f => f[0] === section)) {
    const wrapper = document.createElement('label'); wrapper.className = type === 'checkbox' ? 'setting-switch' : 'setting-field'; wrapper.textContent = label;
    const field = document.createElement(type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input');
    field.name = key; field.id = `setting-${key}`;
    if (type === 'select') for (const [value, text] of options) { const option = document.createElement('option'); option.value = value; option.textContent = text; field.append(option); }
    else { if (type !== 'textarea') field.type = type; for (const [attr, value] of Object.entries(options)) field.setAttribute(attr, value === true ? '' : String(value)); }
    if (type === 'range') { const output = document.createElement('output'); output.htmlFor = field.id; wrapper.append(output); }
    wrapper.append(field); panel.append(wrapper);
  }
  if (section === 'model') { const hint = document.createElement('p'); hint.id = 'key-status'; hint.className = 'setting-hint'; panel.append(hint); }
  if (section === 'vision') { const hint = document.createElement('p'); hint.id = 'vision-key-status'; hint.className = 'setting-hint'; panel.append(hint); }
  if (section === 'appearance') {
    const preview = document.createElement('div'); preview.className = 'character-preview';
    const img = document.createElement('img'); img.id = 'character-preview-image'; img.alt = '';
    const text = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('p');
    title.id = 'character-preview-title'; detail.id = 'character-preview-detail'; text.append(title, detail); preview.append(img, text);
    panel.querySelector('select[name=character]').closest('label').after(preview);
  }
  $('settings-body').append(panel);
}
function previewCharacter() {
  const value = characterId($('settings-form').elements.namedItem('character').value), c = characters[value];
  $('character-preview-image').src = c.image; $('character-preview-image').alt = c.label;
  $('character-preview-title').textContent = c.label; $('character-preview-detail').textContent = `${c.note}。保存后同步生效。`;
  $('character-preview-image').parentElement.dataset.character = value;
}
function settingsNotice(text) { $('settings-notice').textContent = text; }
function updateRangeOutputs() {
  for (const field of $('settings-form').querySelectorAll('input[type=range]')) field.previousElementSibling.textContent = field.name === 'speed' ? `${Number(field.value).toFixed(1)}×` : `${Math.round(Number(field.value) * 100)}%`;
}
function fillSettings(result) {
  loadedSettingsRevision = result.revision;
  const v = result.settings.vision || {};
  visionHasSeparateKey = !!v.hasApiKey;
  const values = { ...result.settings, ...result.settings.ai, apiKey: '', visionModel: v.model || '', visionBaseUrl: v.baseUrl || '', visionUseChatKey: v.useChatKey !== false, visionApiKey: '' };
  for (const [, key, , type] of settingsFields) {
    const field = $('settings-form').elements.namedItem(key);
    if (type === 'checkbox') field.checked = !!values[key]; else field.value = values[key] ?? '';
  }
  $('key-status').textContent = result.settings.ai.hasApiKey ? '电脑端已有 API Key，留空即可继续使用。' : '电脑端尚未配置 API Key。';
  $('vision-key-status').textContent = v.hasApiKey ? '电脑端已有独立视觉密钥，不会显示在网页中。' : '当前共用聊天服务密钥。';
  updateRangeOutputs(); updateVisionKeyControl(); previewCharacter(); applyCharacter(result.settings.character); settingsNotice('');
}
async function reloadSettings() {
  $('settings-save').disabled = true; $('settings-body').inert = true; settingsNotice('正在加载…');
  let loaded = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fillSettings(await api('/api/settings')); loaded = true; break; }
    catch (err) {
      if (attempt === 0 && ![401, 403].includes(err.status)) { await new Promise(resolve => setTimeout(resolve, 400)); continue; }
      settingsNotice(`${err.message} 点击“重新加载”可再试一次。`);
    }
  }
  $('settings-save').disabled = !loaded; $('settings-body').inert = !loaded;
}
$('settings-open').addEventListener('click', async () => { $('settings-dialog').showModal(); await reloadSettings(); });
$('settings-close').addEventListener('click', () => $('settings-dialog').close());
$('settings-dialog').addEventListener('close', () => { $('settings-form').elements.namedItem('apiKey').value = ''; $('settings-form').elements.namedItem('visionApiKey').value = ''; });
$('settings-reload').addEventListener('click', reloadSettings);
function updateVisionKeyControl() { $('settings-form').elements.namedItem('visionApiKey').disabled = $('settings-form').elements.namedItem('visionUseChatKey').checked; }
$('settings-form').addEventListener('input', () => { updateRangeOutputs(); updateVisionKeyControl(); previewCharacter(); });
$('settings-form').addEventListener('submit', async e => {
  e.preventDefault(); const settings = { ai: {}, vision: {} };
  for (const [section, key, , type] of settingsFields) {
    const field = $('settings-form').elements.namedItem(key);
    const value = type === 'checkbox' ? field.checked : ['range', 'number'].includes(type) ? Number(field.value) : field.value;
    if (section === 'vision') {
      if (key === 'visionModel') settings.vision.model = value;
      if (key === 'visionBaseUrl') settings.vision.baseUrl = value;
      if (key === 'visionApiKey' && value.trim()) settings.vision.apiKey = value;
    } else if (['baseUrl', 'model', 'apiKey'].includes(key)) { if (key !== 'apiKey' || value.trim()) settings.ai[key] = value; }
    else settings[key] = value;
  }
  if ($('settings-form').elements.namedItem('visionUseChatKey').checked) settings.vision.apiKey = '';
  else if (!visionHasSeparateKey && !settings.vision.apiKey) { settingsNotice('请填写独立视觉 API Key，或勾选“使用聊天服务的密钥”。'); return; }
  $('settings-save').disabled = true; settingsNotice('正在保存…');
  try { fillSettings(await api('/api/settings', { revision: loadedSettingsRevision, settings })); settingsNotice('已保存，电脑端与网页已同步。'); }
  catch (err) { settingsNotice(err.message); }
  finally { $('settings-save').disabled = false; }
});

function clearSelectedImage() {
  if (selectedImage?.previewUrl) URL.revokeObjectURL(selectedImage.previewUrl);
  selectedImage = null; $('image-file').value = ''; $('image-preview').hidden = true; $('image-preview-img').removeAttribute('src');
}
$('image-pick').addEventListener('click', () => {
  if (!state?.visionModel) { notice('请先在“设置 → 视觉”填写视觉模型。'); return; }
  $('image-file').click();
});
$('image-remove').addEventListener('click', clearSelectedImage);
$('image-file').addEventListener('change', async () => {
  const file = $('image-file').files[0]; if (!file) return;
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 5 * 1024 * 1024) { notice('请选择不超过 5 MB 的 PNG 或 JPG 图片。'); $('image-file').value = ''; return; }
  try {
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file); });
    clearSelectedImage(); selectedImage = { name: file.name, dataUrl, previewUrl: URL.createObjectURL(file) };
    $('image-name').textContent = file.name; $('image-preview-img').src = selectedImage.previewUrl;
    $('image-send-note').textContent = `点击“发送”后，图片将发送给 ${state.visionModel} 分析。`;
    $('image-preview').hidden = false; notice();
  } catch (err) { notice(err.message); }
});
