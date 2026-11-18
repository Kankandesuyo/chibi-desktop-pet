import { create } from 'zustand';
import type { AgentEvent, AgentStepView, ConfirmDecision, ConfirmRequest, PlanStepView } from '../../shared/agentTypes';
import { isEmotion, isPetAction, stripPartialTag } from '../../shared/aiProtocol';
import type { AiStreamEvent, ChatMessage, PetStats, SharedChatSnapshot } from '../../shared/types';
import { offlineReply } from '../ai/offlineReplies';
import { tNow } from '../i18n';

/** A chat message plus, for agent replies, what was done to produce it (display only, never sent to the model). */
export interface UiMessage extends ChatMessage { steps?: AgentStepView[]; outcome?: 'success' | 'failure' | 'chat' }

export type ChatMode = 'offline' | 'chat' | 'agent';

interface ChatState {
  messages: UiMessage[];
  /** Text of the answer currently streaming in (already stripped of the control tag). */
  streaming: string | null;
  requestId: string | null;
  mode: ChatMode;
  notice: string | null;
  // live agent task
  steps: AgentStepView[];
  plan: PlanStepView[];
  interim: string[];
  confirms: ConfirmRequest[];
  /** Marker the remote-chat installer looks for: this build already speaks the shared conversation. */
  __sharedChatV2: true;
  /** Version of the last shared snapshot applied; older snapshots are ignored. */
  sharedVersion: number;
  /** The current session and its run stats (from the shared snapshot). */
  session: NonNullable<SharedChatSnapshot['session']> | null;
  load(history: ChatMessage[]): void;
  /** Replace the view with the shared conversation (remote-chat add-on only). */
  sync(snapshot: SharedChatSnapshot): void;
  send(text: string, mode: ChatMode, stats: PetStats): void;
  handleStream(event: AiStreamEvent): void;
  handleAgent(event: AgentEvent): void;
  answer(confirmId: string, decision: ConfirmDecision): void;
  stop(): void;
  clear(): void;
}

let rawBuffer = '';
const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const plain = (m: UiMessage[]): ChatMessage[] => m.map(({ role, content }) => ({ role, content }));

export const useChatStore = create<ChatState>((set, get) => {
  const finish = (reply: string, notice: string | null, extra: Partial<UiMessage> = {}): void => {
    const messages: UiMessage[] = reply || extra.steps?.length ? [...get().messages, { role: 'assistant', content: reply || tNow('（没有回复）'), ...extra }] : get().messages;
    set({ messages, streaming: null, requestId: null, notice, steps: [], plan: [], interim: [], confirms: [] });
    window.petAPI.saveChatHistory(plain(messages));
  };

  return {
    messages: [],
    streaming: null,
    requestId: null,
    mode: 'chat',
    notice: null,
    steps: [],
    plan: [],
    interim: [],
    confirms: [],
    __sharedChatV2: true,
    sharedVersion: -1,
    session: null,
    load: (history) => set({ messages: history }),

    sync: (s) => {
      if (s.error || s.version < get().sharedVersion) return;
      const a = s.active;
      rawBuffer = a?.text ?? '';
      set({
        sharedVersion: s.version,
        session: s.session ?? null,
        messages: s.messages,
        streaming: a ? stripPartialTag(rawBuffer) : null,
        requestId: a?.id ?? null,
        mode: a?.mode === 'agent' ? 'agent' : 'chat',
        steps: a?.steps ?? [],
        plan: a?.plan ?? [],
        interim: a?.interim ? [a.interim] : [],
        confirms: a?.confirm ? [a.confirm] : [],
        notice: null,
      });
    },

    send: (text, mode, stats) => {
      const content = text.trim();
      if (!content || get().requestId) return;
      const api = window.petAPI;
      if (api.sharedSend) {
        // Shared conversation: main runs the request and pushes snapshots back through sync().
        api.sharedSend(content).then((r) => { if (r.error) set({ notice: r.error }); }).catch((e: Error) => set({ notice: e.message }));
        return;
      }
      const messages: UiMessage[] = [...get().messages, { role: 'user', content }];
      if (mode === 'offline') {
        // No AI configured: answer locally so the pet stays usable offline.
        const local = offlineReply(content);
        set({ messages });
        window.petAPI.notifyPet(local);
        finish(local.reply, null);
        return;
      }
      const requestId = newId();
      rawBuffer = '';
      set({ messages, streaming: '', requestId, mode, notice: null, steps: [], plan: [], interim: [], confirms: [] });
      if (mode === 'agent') {
        window.petAPI.agentRun(requestId, plain(messages), stats);
      } else {
        window.petAPI.notifyPet({ talking: true });
        window.petAPI.aiChat(requestId, plain(messages), stats);
      }
    },

    handleStream: (event) => {
      if (event.requestId !== get().requestId) return;          // stale or cancelled request
      if (event.type === 'delta') {
        rawBuffer += event.text;
        set({ streaming: stripPartialTag(rawBuffer) });
      } else if (event.type === 'done') {
        window.petAPI.notifyPet(event.result);
        finish(event.result.reply, null);
      } else {
        // The API failed: keep whatever arrived, tell the user, and let the pet carry on.
        window.petAPI.notifyPet({ talking: false });
        finish(stripPartialTag(rawBuffer).trim(), tNow('AI 出错：{message}', { message: event.message }));
      }
    },

    handleAgent: (event) => {
      if (event.requestId !== get().requestId) return;
      switch (event.type) {
        case 'delta':
          rawBuffer += event.text;
          set({ streaming: stripPartialTag(rawBuffer) });
          break;
        case 'interim':
          // Text the model said before acting: shown as a note, never as the result.
          rawBuffer = '';
          set({ streaming: '', interim: event.text ? [...get().interim, event.text] : get().interim });
          break;
        case 'step': {
          const steps = get().steps.filter((s) => s.stepId !== event.step.stepId);
          const idx = get().steps.findIndex((s) => s.stepId === event.step.stepId);
          if (idx >= 0) steps.splice(idx, 0, event.step); else steps.push(event.step);
          set({ steps });
          break;
        }
        case 'plan': set({ plan: event.steps }); break;
        case 'confirm': set({ confirms: [...get().confirms, event.request] }); break;
        case 'confirm-closed': set({ confirms: get().confirms.filter((c) => c.confirmId !== event.confirmId) }); break;
        case 'phase': break;
        case 'done': {
          const emotion = isEmotion(event.emotion) ? event.emotion : 'neutral';
          const action = isPetAction(event.action) ? event.action : 'none';
          window.petAPI.notifyPet({ reply: event.reply, emotion, action });
          finish(event.reply, null, { steps: get().steps.filter((s) => s.tool !== 'update_plan'), outcome: event.outcome });
          break;
        }
        case 'error':
          window.petAPI.notifyPet({ talking: false });
          finish(stripPartialTag(rawBuffer).trim(), event.message === '已取消' ? tNow('已停止') : tNow('出错了：{message}', { message: event.message }), { steps: get().steps.filter((s) => s.tool !== 'update_plan'), outcome: 'failure' });
          break;
      }
    },

    answer: (confirmId, decision) => {
      window.petAPI.agentConfirm(confirmId, decision);
      set({ confirms: get().confirms.filter((c) => c.confirmId !== confirmId) });
    },

    stop: () => {
      if (window.petAPI.sharedAbort) { void window.petAPI.sharedAbort(); return; }
      const id = get().requestId;
      if (!id) return;
      if (get().mode === 'agent') { window.petAPI.agentAbort(id); return; }     // the 'error: 已取消' event finishes it
      window.petAPI.aiAbort(id);
      window.petAPI.notifyPet({ talking: false });
      finish(stripPartialTag(rawBuffer).trim(), null);
    },

    clear: () => {
      if (window.petAPI.sharedClear) {
        window.petAPI.sharedClear().then((r) => { if (r.error) set({ notice: r.error }); }).catch((e: Error) => set({ notice: e.message }));
        return;
      }
      get().stop();
      set({ messages: [], notice: null });
      window.petAPI.saveChatHistory([]);
    },
  };
});
