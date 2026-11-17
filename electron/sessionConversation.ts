import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChatRecord, SessionStore } from './agent/SessionStore';
import type { TaskRecaps } from './agent/TaskRecap';
import type { ChatMessage } from '../shared/types';

/**
 * The shared desktop/web conversation, backed by the session log (it used to live in
 * remote-chat/shared-history.json). Same interface remote-chat/server.cjs expects from its conversation.
 *
 * "Clear" starts a new session: the old one stays in the session list instead of being thrown away.
 */
export interface SessionConversation {
  readonly messages: ChatRecord[];
  append(message: Partial<ChatRecord> & { role: 'user' | 'assistant'; content: string }): void;
  clear(): void;
  persist(): void;
}

export interface ConversationDeps {
  sessions: SessionStore;
  recaps: TaskRecaps;
  /** Mirrors the last messages into config.json (older code paths read them from there). */
  setChatHistory?(history: ChatMessage[]): void;
  /** The old remote-chat/shared-history.json, imported once into the session log. */
  legacyHistoryFile?: string;
  /** Used when there is no shared-history.json: the desktop chat history kept in config.json. */
  legacyDesktopHistory?(): ChatMessage[];
}

export function createSessionConversation(d: ConversationDeps) {
  importLegacyOnce(d);
  return (onChange: () => void): SessionConversation => {
    const mirror = (): void => d.setChatHistory?.(d.sessions.chat().map(({ role, content }) => ({ role, content })).slice(-40));
    d.sessions.onSwitch(() => { mirror(); onChange(); });
    return {
      get messages() { return d.sessions.chat(); },
      append(message) {
        d.sessions.addChat({ ...message, id: message.id || crypto.randomUUID(), time: message.time ?? Date.now() } as ChatRecord);
        mirror();
        onChange();
      },
      clear() {
        d.sessions.newSession();                     // notifies onSwitch → mirror + onChange
        d.recaps.clear();
      },
      persist: mirror,
    };
  };
}

/** Moves the conversation kept in shared-history.json into the session log, once (marker file). */
function importLegacyOnce(d: ConversationDeps): void {
  const file = d.legacyHistoryFile;
  const marker = path.join(d.sessions.dir, '.imported-shared-history');
  if (fs.existsSync(marker)) return;
  try {
    const hasFile = !!file && fs.existsSync(file);
    const raw = hasFile ? (JSON.parse(fs.readFileSync(file as string, 'utf8')) as { messages?: unknown }) : { messages: d.legacyDesktopHistory?.() ?? [] };
    const messages = (Array.isArray(raw.messages) ? raw.messages : [])
      .filter((m): m is ChatRecord => !!m && typeof m === 'object' && ['user', 'assistant'].includes((m as ChatRecord).role) && typeof (m as ChatRecord).content === 'string')
      .map((m) => ({ ...m, id: m.id || crypto.randomUUID(), time: m.time ?? null }));
    if (messages.length) {
      // Into the current session if it has no conversation yet, otherwise into a session of its own.
      if (d.sessions.chat().length) d.sessions.newSession();
      d.sessions.importChat(messages);
    }
    fs.writeFileSync(marker, `imported ${messages.length} messages from ${hasFile ? file : 'config.json'} at ${new Date().toISOString()}\n`);
  } catch (err) {
    // A damaged old history is left untouched (it stays on disk) and not imported.
    console.error('[conversation] could not import shared-history.json', err);
  }
}
