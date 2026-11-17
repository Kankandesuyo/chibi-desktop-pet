'use strict';
const { catalog, characterId } = require('./public/characters.js');
const BASIC = ['petName', 'personaTraits', 'character', 'monologue', 'aiEnabled', 'size', 'opacity', 'speed', 'autoMoveFrequency', 'autoMove', 'allowDrag', 'gravity', 'alwaysOnTop', 'sound'];
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
function readSettings(config) {
  const s = { ...config.getSettings(), character: characterId(config.getSettings().character) }, a = config.getAgentSettings();
  const ep = config.getAiEndpoint(), vision = a.vision || {};
  return { ...Object.fromEntries(BASIC.map(k => [k, s[k]])), ai: { baseUrl: ep.baseUrl, model: ep.model, hasApiKey: !!config.getApiKey() }, vision: { baseUrl: vision.baseUrl || '', model: vision.model || '', hasApiKey: !!config.getVisionKey?.(), useChatKey: !config.getVisionKey?.() }, computerUseEnabled: config.getComputerUseSettings?.().enabled ?? false, agentEnabled: a.enabled, maxSteps: a.maxSteps, toolProtocol: a.toolProtocol };
}
function validateSettings(input, config) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('设置格式不正确');
  const allowed = new Set([...BASIC, 'ai', 'vision', 'computerUseEnabled', 'agentEnabled', 'maxSteps', 'toolProtocol']);
  if (Object.keys(input).some(k => !allowed.has(k))) fail('包含不支持的设置项');
  const basic = {}, agent = {}; let ai;
  const ranges = { size: [.4, 1.4], opacity: [.3, 1], speed: [.5, 2], autoMoveFrequency: [0, 1] };
  for (const key of BASIC) if (Object.hasOwn(input, key)) {
    const v = input[key];
    if (ranges[key]) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < ranges[key][0] || v > ranges[key][1]) fail('外观数值超出范围');
    } else if (key === 'character') {
      // The web page only knows the packaged characters and shows a desktop custom character as the default one.
      // Saving that unchanged default must not replace the custom character chosen on the desktop.
      const current = config.getSettings().character;
      if (v === characterId(current) && v !== current) continue;
      if (typeof v !== 'string' || !Object.hasOwn(catalog, v)) fail('请选择橙发女孩或 DeepSeek 鲸鱼妹');
    } else if (key === 'petName') {
      if (typeof v !== 'string' || !v.trim() || v.length > 12 || /[\r\n\t[\]<>]/.test(v)) fail('桌宠名称应为 1～12 字，不能包含特殊标签');
    } else if (key === 'personaTraits') {
      if (typeof v !== 'string' || v.length > 16000) fail('人格描述过长');
    } else if (key === 'monologue') {
      if (!['off', 'rare', 'normal', 'often'].includes(v)) fail('自言自语频率无效');
    } else if (typeof v !== 'boolean') fail('开关设置格式不正确');
    basic[key] = v;
  }
  if ('agentEnabled' in input) { if (typeof input.agentEnabled !== 'boolean') fail('聊天模式无效'); agent.enabled = input.agentEnabled; }
  if ('maxSteps' in input) { if (!Number.isInteger(input.maxSteps) || input.maxSteps < 3 || input.maxSteps > 60) fail('任务步骤应为 3～60'); agent.maxSteps = input.maxSteps; }
  if ('toolProtocol' in input) { if (!['auto', 'native', 'json'].includes(input.toolProtocol)) fail('工具协议无效'); agent.toolProtocol = input.toolProtocol; }
  if ('ai' in input) {
    const v = input.ai;
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['baseUrl', 'model', 'apiKey'].includes(k))) fail('模型设置格式不正确');
    ai = {};
    if ('baseUrl' in v) {
      if (typeof v.baseUrl !== 'string' || v.baseUrl.length > 500) fail('服务地址无效');
      let url; try { url = new URL(v.baseUrl); } catch { fail('服务地址需为完整的 https:// 地址'); }
      if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) fail('请使用 HTTPS 地址，本机模型可用 HTTP；地址不能包含密钥或查询参数');
      ai.baseUrl = v.baseUrl.trim();
      if (ai.baseUrl !== config.getAiEndpoint().baseUrl && !v.apiKey?.trim()) fail('更换服务地址时请同时填写对应的 API Key，避免把旧密钥发送到新服务');
    }
    if ('model' in v) { if (typeof v.model !== 'string' || !v.model.trim() || v.model.length > 100) fail('请填写有效的模型名称'); ai.model = v.model.trim(); }
    if ('apiKey' in v) { if (typeof v.apiKey !== 'string' || !v.apiKey.trim() || v.apiKey.length > 400) fail('API Key 格式不正确'); ai.apiKey = v.apiKey.trim(); }
  }
  if ('vision' in input) {
    const v = input.vision;
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['baseUrl', 'model', 'apiKey'].includes(k))) fail('视觉设置格式不正确');
    const old = config.getAgentSettings().vision || {};
    const next = { ...old };
    if ('model' in v) { if (typeof v.model !== 'string' || v.model.length > 100) fail('视觉模型名称无效'); next.model = v.model.trim(); }
    if ('baseUrl' in v) {
      if (typeof v.baseUrl !== 'string' || v.baseUrl.length > 500) fail('视觉服务地址无效');
      next.baseUrl = v.baseUrl.trim();
    }
    const chatUrl = ai?.baseUrl || config.getAiEndpoint().baseUrl;
    const effective = next.baseUrl || chatUrl;
    let url, chat;
    try { url = new URL(effective); chat = new URL(chatUrl); } catch { fail('视觉服务地址需为完整地址'); }
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) fail('视觉服务请使用 HTTPS，本机服务可用 HTTP');
    const useChatKey = v.apiKey === '' || (!('apiKey' in v) && !config.getVisionKey?.());
    if (useChatKey && url.origin !== chat.origin) fail('不同服务不能共用聊天密钥，请填写独立的视觉 API Key');
    if (!useChatKey && effective !== (old.baseUrl || config.getAiEndpoint().baseUrl) && !v.apiKey?.trim()) fail('更换视觉服务地址时，请同时填写对应的新密钥');
    if ('apiKey' in v) { if (typeof v.apiKey !== 'string' || v.apiKey.length > 400) fail('视觉 API Key 格式无效'); next.apiKey = v.apiKey.trim(); }
    agent.vision = next;
  }
  // A chat endpoint change must not silently move a vision model's inherited key.
  if (ai?.baseUrl && !('vision' in input)) {
    const v = config.getAgentSettings().vision;
    if (v?.model && v.baseUrl && !config.getVisionKey?.() && new URL(v.baseUrl).origin !== new URL(ai.baseUrl).origin) fail('请同时更新视觉配置：独立视觉服务不能继承另一家服务的密钥');
  }
  if ('computerUseEnabled' in input && (typeof input.computerUseEnabled !== 'boolean' || !config.updateComputerUseSettings)) fail('电脑操作功能不可用或开关无效');
  return { basic, agent, ai, computerUseEnabled: input.computerUseEnabled };
}
module.exports = { readSettings, validateSettings };
