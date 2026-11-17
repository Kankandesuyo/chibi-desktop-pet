'use strict';
// Launching WeChat again can open a second login window while another session
// is already logged in. Window titles alone cannot establish login state.
const isWeChat = value => /^(?:wechat|weixin|微信)(?:\.exe|\.lnk)?$/i.test(String(value || '').trim());
function weChatTarget(target) {
  return isWeChat(String(target).split(/[\\/]/).pop());
}
function candidates(windows) {
  return windows.filter(w => isWeChat(w.processName || w.name) || isWeChat(w.title))
    .map(w => ({ pid: w.pid, handle: w.handle, title: w.title, processName: w.processName || w.name,
      loginState: 'unknown', next: '先检查此窗口；控件为空时用 computer_observe，不代表未登录' }));
}
async function guardWeChatLaunch(target, platform) {
  if (!weChatTarget(target)) return null;
  let windows, apps;
  try { [windows, apps] = await Promise.all([platform.ui.listWindows(), platform.listRunningApps()]); }
  catch { return { ok: false, summary: '无法确认现有微信窗口，未启动新的微信', error: '请先重新列出窗口，不能通过重复启动解决窗口枚举失败' }; }
  const existing = candidates(windows);
  const running = apps.filter(a => isWeChat(a.name));
  if (!existing.length && !running.length) return null;
  return { ok: true, summary: '微信已经在运行，未重复启动；请检查并复用已有窗口',
    data: { reusedExisting: true, windows: existing, running: running.map(a => ({ pid: a.pid, name: a.name, title: a.title })),
      instruction: '不要根据标题、窗口大小或空面板判断登录状态。多个微信窗口逐一检查，优先复用已显示聊天/联系人界面的窗口；不能操作就说明具体阻碍，不重新启动或切换到登录页。' } };
}
module.exports = { guardWeChatLaunch, candidates, weChatTarget };
