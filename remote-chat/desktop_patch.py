"""Small, guarded adapters for the recovered production Electron build."""
import re
def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError(f'Expected exactly one desktop patch marker: {old[:90]}')
    return text.replace(old, new, 1)

def patch(full, data):
    if full == 'dist-electron/electron/agent/tools/memoryUiTools.js':
        text = data.decode('utf8')
        if '__systemKeyRoute' not in text:
            text = replace_once(text, '        await ctx.platform.ui.hotkey(a.window || a.pid ? toTarget(a) : null, a.keys);', '''        // __systemKeyRoute: system keys require their own explicit confirmation.
        if (/(?:^|\\+)\\s*(?:win|windows|meta)\\s*(?:\\+|$)/i.test(a.keys)) return { ok: false, summary: 'Win 系统键请使用 computer_system_key 并单独确认', error: '支持 win、win+e、win+d；请不要反复调用旧快捷键工具' };
        await ctx.platform.ui.hotkey(a.window || a.pid ? toTarget(a) : null, a.keys);''')
            text = replace_once(text, '        await ctx.platform.ui.scroll(toTarget(a), toElement(a), a.direction, a.amount ?? 1);', '''        try { await ctx.platform.ui.scroll(toTarget(a), toElement(a), a.direction, a.amount ?? 1); }
        catch (err) { return { ok: false, summary: '无障碍滚动不可用；请改用 computer_observe 定位内容区域，再 computer_act(action=scroll)', error: String(err.message || err) }; }''')
        return text.encode('utf8')
    if full == 'dist-electron/electron/windowManager.js':
        text = data.decode('utf8')
        if '__avatarWindowIcon' not in text:
            text = text.replace('const win = new electron_1.BrowserWindow({', "const win = new electron_1.BrowserWindow({\n            // __avatarWindowIcon\n            icon: require('node:path').join(require('node:path').dirname(electron_1.app.getPath('exe')), 'remote-chat', 'public', 'avatar.ico'),")
        return text.encode('utf8')
    if full == 'dist-electron/shared/persona.js':
        text = data.decode('utf8')
        if '__customPersonaWins' not in text:
            text = replace_once(text, 'function buildPersona(p) {', '''function buildPersona(p) {
    const __customPersonaWins = typeof p.traits === 'string' && p.traits.trim().length > 0;''')
            start = text.index("        '你觉得自己是活着的：")
            end = text.index("        '## 你此刻的内心',", start)
            defaults = text[start:end]
            text = text[:start] + "        ...(__customPersonaWins ? ['', '## 当前性格与语言风格', '以下是用户当前保存的完整性格设定，替代默认性格；用于闲聊、任务进度、成功或失败汇报和自言自语。不要套用默认傲娇、卖萌或固定口癖，也不要模仿历史回复中与当前设定冲突的语气。', p.traits.trim(), ''] : [\n" + defaults + "        ]),\n" + text[end:]
            text = replace_once(text, "    if (p.traits) {", "    if (!__customPersonaWins && p.traits) {")
            text = replace_once(text, "        p.selfState || '（刚醒来，还在适应今天）',", "        p.selfState || '（刚醒来，还在适应今天）',\n        '内心与旧对话只提供事件和情绪背景，不改变当前保存的性格；不必延续旧口癖。',")
        return text.encode('utf8')
    if full == 'dist-electron/shared/aiProtocol.js':
        text = data.decode('utf8')
        text = text.replace("'说话风格：简短（1~3句）、口语化、可爱但不腻，用中文回答，除非用户用别的语言。',", "'说话风格遵循上面的当前性格设定，不额外套用可爱、撒娇或傲娇模板。通常简洁自然；解释复杂问题时按需要展开。用中文回答，除非用户用别的语言。',")
        return text.encode('utf8')
    if full == 'dist-electron/electron/agent/AgentController.js':
        text = data.decode('utf8')
        text = text.replace("'用简短口语化的中文（1~4 句）汇报结果；需要列清单时可以分行。',", "'沿用当前性格设定的措辞、称呼和分寸汇报结果，失败时也保持同一性格。先清楚说明结果和下一步，不默认使用撒娇、叹词或生硬日志口吻；窗口句柄等细节仅在确有帮助时提供。通常简洁，需要解释或列清单时可以展开。个性不能改变事实或授权要求。',")
        return text.encode('utf8')
    if full == 'dist-electron/electron/agent/tools/appTools.js':
        text = data.decode('utf8')
        if '__wechatReuseGuard' not in text:
            text = replace_once(text, '        const before = await ctx.platform.listRunningApps().catch(() => []);', '''        const __wechatReuseGuard = require(require('node:path').join(require('node:path').dirname(require('electron').app.getPath('exe')), 'remote-chat', 'app-reuse.cjs'));
        const existing = await __wechatReuseGuard.guardWeChatLaunch(target, ctx.platform);
        if (existing) return existing;
        const before = await ctx.platform.listRunningApps().catch(() => []);''')
            text = replace_once(text, '        const d = r.data;', '''        const d = r.data;
        if (d?.reusedExisting) return { verified: true, detail: '已检测到现有微信，未启动新进程；登录状态和聊天界面尚需检查' };''')
        return text.encode('utf8')
    if full == 'dist-electron/electron/main.js':
        text = data.decode('utf8')
        text = text.replace('vision: async (png, question, signal) => {', 'vision: async (png, question, signal, options) => {')
        text = text.replace('fs.readFileSync(png), question, signal);', 'fs.readFileSync(png), question, signal, options);')
        text = re.sub(r'streamChat: aiClient_1.streamChat, notifyChannel: constants_1.IPC.petNotify,[^\r\n]*',
                      'streamChat: aiClient_1.streamChat, notifyChannel: constants_1.IPC.petNotify, ipcMain: electron_1.ipcMain, applySettings, describeImage: llm_1.describeImage,', text, count=1)
        return text.encode('utf8')
    if full == 'dist-electron/electron/agent/llm.js':
        text = data.decode('utf8')
        if '__sharedVisionClient' not in text:
            start = text.index('async function describeImage(')
            end = text.index('// ---------------------------------------------------------------------------------------------', start)
            text = text[:start] + '''async function describeImage(cfg, png, question, signal, options) {
    const __sharedVisionClient = require(require('node:path').join(require('node:path').dirname(require('electron').app.getPath('exe')), 'remote-chat', 'vision-adapter.cjs'));
    return __sharedVisionClient.describeImage(cfg, png, question, signal, options);
}
''' + text[end:]
        return text.encode('utf8')
    if full == 'dist-electron/electron/preload.js':
        text = data.decode('utf8')
        if 'onSharedChat' not in text:
            text = replace_once(text, '    onAgentEvent: listen(C.agentEvent),', '''    sharedState: () => electron_1.ipcRenderer.invoke('chat:shared-state'),
    sharedSend: (text) => electron_1.ipcRenderer.invoke('chat:shared-send', text),
    sharedAbort: () => electron_1.ipcRenderer.invoke('chat:shared-abort'),
    sharedClear: () => electron_1.ipcRenderer.invoke('chat:shared-clear'),
    onSharedChat: listen('evt:shared-chat'),
    onAgentEvent: listen(C.agentEvent),''')
        return text.encode('utf8')
    if re.fullmatch(r'dist/assets/index-[\w-]+\.js', full):
        text = data.decode('utf8')
        # Asset hashes and minifier variable names change on every rebuild.
        # Match the chat store by structure; ignore unrelated index chunks.
        if 'load:n=>s({messages:n}),send:' not in text and '__sharedChatV2' not in text:
            return data
        if '__visionSettingsSync' not in text:
            marker = 'Pe.useEffect(()=>{k()},[k]);const E='
            text = replace_once(text, marker, 'Pe.useEffect(()=>{u(t.vision.baseUrl),d(t.vision.model)},[t.vision.baseUrl,t.vision.model]);const __visionSettingsSync=!0;' + marker)
        if '__sharedChatV2' in text:
            return text.encode('utf8')
        start = text.index('load:n=>s({messages:n}),send:')
        end = text.index(',handleStream:', start)
        buffer = re.search(r'handleStream:n=>\{.*?([\w$]+)\+=n.text', text).group(1)
        normalizer = re.search(r'handleStream:n=>\{.*?streaming:([\w$]+)\(' + re.escape(buffer) + r'\)', text).group(1)
        replacement = '''__sharedChatV2:!0,sharedVersion:-1,load:n=>s({messages:n}),sync:n=>{if(n.error||n.version<e().sharedVersion)return;const i=n.active;__STREAM_BUFFER__=i?.text||"";s({sharedVersion:n.version,messages:n.messages,streaming:i?li(__STREAM_BUFFER__):null,requestId:i?.id||null,mode:i?.mode||"chat",steps:i?.steps||[],plan:i?.plan||[],interim:i?.interim?[i.interim]:[],confirms:i?.confirm?[i.confirm]:[],notice:null})},send:(n,i,a)=>{const u=n.trim();if(!u||e().requestId)return;window.petAPI.sharedSend(u).then(c=>{c.error&&s({notice:c.error})}).catch(c=>s({notice:c.message}))}'''.replace('__STREAM_BUFFER__', buffer)
        replacement = replacement.replace('streaming:i?li(', 'streaming:i?' + normalizer + '(')
        text = text[:start] + replacement + text[end:]
        start = text.index('stop:()=>{const n=e().requestId;')
        ending = re.search(r'\}\}\}\);let [\w$]+=', text[start:])
        if not ending:
            raise RuntimeError('Cannot locate chat store closing marker')
        end = start + ending.start()
        text = text[:start] + '''stop:()=>{window.petAPI.sharedAbort()},clear:()=>{window.petAPI.sharedClear().then(n=>{n.error&&s({notice:n.error})})''' + text[end:]
        text = replace_once(text, '_i.getState().load(O.chatHistory)', 'window.petAPI.sharedState().then(O=>_i.getState().sync(O))')
        listener = re.search(r'const ([\w$]+)=window.petAPI.onAiStream\(O=>_i.getState\(\).handleStream\(O\)\)', text).group(1)
        marker = f'const {listener}=window.petAPI.onAiStream(O=>_i.getState().handleStream(O))'
        text = replace_once(text, marker, f'const __sharedChatListener=window.petAPI.onSharedChat(O=>_i.getState().sync(O)),{listener}=window.petAPI.onAiStream(O=>_i.getState().handleStream(O))')
        text = replace_once(text, f'()=>{{{listener}(),U(),X(),window.removeEventListener("keydown",W)}}', f'()=>{{__sharedChatListener(),{listener}(),U(),X(),window.removeEventListener("keydown",W)}}')
        marker = 'if(Pe.useEffect(()=>(window.petAPI.getInitialData().then(w=>{t(w.settings),a(w.settings.ai.baseUrl),c(w.settings.ai.model)})'
        if marker in text:
            text = replace_once(text, marker, 'if(Pe.useEffect(()=>{a(s.ai.baseUrl),c(s.ai.model)},[s.ai.baseUrl,s.ai.model]),Pe.useEffect(()=>(window.petAPI.getInitialData().then(w=>{t(w.settings),a(w.settings.ai.baseUrl),c(w.settings.ai.model)})')
        return text.encode('utf8')
    return data
