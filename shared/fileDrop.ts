/**
 * Files dropped on the pet: what the menu offers and the request each choice turns into.
 * Pure (no fs, no Electron) so the main process, the chat window and tests share one definition.
 *
 * A choice never runs anything by itself: it becomes an ordinary chat request from the user, and the
 * agent then does the work through the normal tools, permission checks and confirmations.
 */

export const MAX_DROP_ITEMS = 30;

export interface DroppedItem { path: string; kind: 'file' | 'dir'; allowed: boolean }

export interface DropSummary {
  items: DroppedItem[];
  /** Dropped but not used (missing, not absolute, or over MAX_DROP_ITEMS). */
  skipped: number;
}

/** main -> chat window: start a request about these files, or attach them and let the user type. */
export interface ChatCompose {
  paths: string[];
  /** Send this right away. */
  prompt?: string;
  /** Otherwise: placeholder hint for the input. */
  hint?: string;
}

export interface DropAction { id: string; label: string; compose: ChatCompose }

export function formatPathList(paths: string[]): string {
  return paths.map((p) => `- ${p}`).join('\n');
}

/** What gets sent when the user types something with files attached. */
export function withAttachments(text: string, paths: string[]): string {
  const t = text.trim();
  if (paths.length === 0) return t;
  return `${t}\n\n${paths.length === 1 ? '文件' : '这些文件'}：\n${formatPathList(paths)}`;
}

export function dropHeader(s: DropSummary): string {
  const files = s.items.filter((i) => i.kind === 'file').length;
  const dirs = s.items.length - files;
  const name = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  let head: string;
  if (s.items.length === 1) head = `收到${dirs ? '文件夹' : ''}「${name(s.items[0]!.path)}」`;
  else head = `收到 ${[files ? `${files} 个文件` : '', dirs ? `${dirs} 个文件夹` : ''].filter(Boolean).join('、')}`;
  if (s.skipped) head += `（另有 ${s.skipped} 个没收）`;
  return head;
}

export function dropActions(s: DropSummary): DropAction[] {
  const usable = s.items.filter((i) => i.allowed);
  if (usable.length === 0) return [];
  const paths = usable.map((i) => i.path);
  const list = formatPathList(paths);
  const files = usable.filter((i) => i.kind === 'file');
  const dirs = usable.filter((i) => i.kind === 'dir');
  const out: DropAction[] = [];
  const send = (id: string, label: string, prompt: string): void => { out.push({ id, label, compose: { paths, prompt } }); };

  if (dirs.length === 1 && files.length === 0) {
    send('peek', '看看里面有什么', `看看这个文件夹里有什么，简单告诉我：\n${list}`);
    send('organize', '按类型整理里面的文件', `帮我整理这个文件夹：把里面的文件按类型分到子文件夹里（图片、文档、压缩包等）。\n${list}`);
  } else {
    if (files.length > 0 && files.length <= 5 && dirs.length === 0) {
      send('summary', files.length === 1 ? '看看写了什么' : '看看这些写了什么', `帮我看看${files.length === 1 ? '这个文件' : '这些文件'}里写了什么，简单总结一下：\n${list}`);
    }
    if (files.length >= 2 && dirs.length === 0) {
      send('organize', '按类型整理', `帮我把这些文件按类型整理：在它们所在的文件夹里建子文件夹（图片、文档、压缩包等），把文件分进去。\n${list}`);
    }
  }
  send('zip', '打包成 zip', `帮我把${paths.length === 1 ? '它' : '这些'}打包成一个 zip 压缩包，放在${paths.length === 1 ? '它' : '它们'}所在的文件夹里：\n${list}`);
  if (files.length >= 2) out.push({ id: 'rename', label: '批量重命名…', compose: { paths, hint: '说说重命名规则，比如：按修改日期改成 2026-01-01_序号' } });
  out.push({ id: 'ask', label: '告诉她要做什么…', compose: { paths, hint: '想让她对这些文件做什么？' } });
  return out;
}
