import { globalShortcut } from 'electron';

/**
 * One system-wide shortcut that brings her back and opens the chat with the cursor in the input box.
 * Re-registered whenever the setting changes; another program already using the keys makes it fail
 * quietly (the settings page says so).
 */
let current = '';
let lastOk = true;

export function applyHotkey(accelerator: string, onPress: () => void): boolean {
  if (accelerator === current && lastOk) return true;
  if (current) globalShortcut.unregister(current);
  current = '';
  if (!accelerator) { lastOk = true; return true; }
  try { lastOk = globalShortcut.register(accelerator, onPress); } catch { lastOk = false; }
  if (lastOk) current = accelerator;
  else console.warn(`[hotkey] ${accelerator} is taken by another program`);
  return lastOk;
}

/** Did the last registration work? (false = another program already uses those keys) */
export function hotkeyOk(): boolean { return lastOk; }

export function clearHotkey(): void { globalShortcut.unregisterAll(); current = ''; }
