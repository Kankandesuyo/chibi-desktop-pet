'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// One authoritative conversation for Electron and every authenticated web client.
function createConversation({ config, dataDir, save, onChange }) {
  const file = path.join(dataDir, 'shared-history.json');
  const normalize = values => (Array.isArray(values) ? values : []).filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string').map(m => ({ ...m, id: m.id || crypto.randomUUID(), time: m.time || null })).slice(-200);
  let messages;
  if (fs.existsSync(file)) {
    // Do not silently discard a damaged authoritative history.
    messages = normalize(JSON.parse(fs.readFileSync(file, 'utf8')).messages);
  } else {
    const local = normalize(config.getChatHistory?.() || []);
    let remote = [];
    try { remote = normalize(JSON.parse(fs.readFileSync(path.join(dataDir, 'history.json'), 'utf8'))); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    save(path.join(dataDir, 'before-sync-migration.json'), { desktop: local, web: remote });
    const same = (a, b) => a.role === b.role && a.content === b.content;
    let overlap = 0;
    for (let n = 1; n <= Math.min(local.length, remote.length); n++) if (local.slice(-n).every((m, i) => same(m, remote[i]))) overlap = n;
    // Old desktop messages have no timestamps: retain their order, then the web
    // conversation, eliminating only an exact shared boundary, not repeated text.
    messages = normalize([...local, ...remote.slice(overlap)]);
    save(file, { schema: 2, messages });
  }
  const persist = () => {
    save(file, { schema: 2, messages });
    config.setChatHistory?.(messages.map(({ role, content }) => ({ role, content })).slice(-40));
    config.flush?.();
  };
  return {
    get messages() { return messages; },
    append(message) { messages = normalize([...messages, message]); persist(); onChange(); },
    clear() { messages = []; persist(); onChange(); },
    persist,
  };
}
module.exports = { createConversation };
