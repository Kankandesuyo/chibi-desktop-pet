import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EndpointConfig } from './agent/llm';

/**
 * Bridge to the remote-chat runtime (remote-chat/*.cjs, packaged inside the app next to dist-electron/).
 * It used to be injected into the built app by remote-chat/install.py; now the app starts it itself.
 *
 * remote-chat provides: the web chat server on 127.0.0.1:17861 (login, CSRF, long-poll), the one shared
 * desktop/web conversation, image upload analysis, web settings, the vision client and Computer Use.
 */

export interface VisionOptions { json?: boolean }

/** What the running remote-chat server offers the app. */
export interface RemoteChat {
  close(): void;
  /** Starts a request in the shared conversation; false when she is busy. */
  send?(text: string, source: string, runOptions?: { readOnly?: boolean; unattended?: boolean; scheduleId?: string }): boolean;
}

type DescribeImage = (cfg: EndpointConfig, png: Buffer, question: string, signal: AbortSignal, options?: VisionOptions) => Promise<string>;

const dir = (): string => path.join(app.getAppPath(), 'remote-chat');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const load = <T>(file: string): T => require(path.join(dir(), file)) as T;

let vision: DescribeImage | null = null;

export const remote = {
  /** Vision requests (screenshots, uploads, Computer Use grounding): retries, JSON mode, no thinking for DeepSeek. */
  describeImage(cfg: EndpointConfig, png: Buffer, question: string, signal: AbortSignal, options?: VisionOptions): Promise<string> {
    vision ??= load<{ describeImage: DescribeImage }>('vision-adapter.cjs').describeImage;
    return vision(cfg, png, question, signal, options ?? {});
  },

  /** Starts the web chat + shared conversation. A failure is logged and never takes the pet down. */
  start(opts: Record<string, unknown>): RemoteChat | null {
    try {
      const { startRemoteChat } = load<{ startRemoteChat(o: Record<string, unknown>): RemoteChat }>('server.cjs');
      return startRemoteChat({ ...opts, describeImage: remote.describeImage });
    } catch (err) {
      console.error('[remote-chat] failed to start', err);
      try {
        const out = path.join(app.getPath('userData'), 'remote-chat');
        fs.mkdirSync(out, { recursive: true });
        fs.writeFileSync(path.join(out, 'start-error.txt'), String(err instanceof Error ? err.stack : err));
      } catch { /* nothing more to do */ }
      return null;
    }
  },
};
