export interface FileDropHost {
  hitTest(clientX: number, clientY: number): { hit: boolean };
  /** A file drag came over her body (once per drag). */
  onFileHover(): void;
  /** The drag left her without dropping. */
  onFileHoverEnd(): void;
  onFilesDropped(files: File[]): void;
}

/** Without a dragover for this long the drag is considered gone (dragleave is unreliable across windows). */
const STALE_MS = 400;

/**
 * Lets the user drop files from Explorer onto the character. Only her opaque pixels accept a drop; the
 * transparent rest of the window refuses it (and is click-through anyway). Never reads file contents.
 */
export class FileDropController {
  private over = false;
  private lastOver = 0;
  private staleTimer: number | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly host: FileDropHost) {
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void): void => {
      window.addEventListener(type, fn);
      this.cleanup.push(() => window.removeEventListener(type, fn));
    };
    on('dragenter', (e) => this.onOver(e));
    on('dragover', (e) => this.onOver(e));
    on('dragleave', (e) => { if (e.relatedTarget === null) this.end(); });
    on('drop', (e) => this.onDrop(e));
  }

  /** A file drag is over the window right now (so leaving the canvas must not turn click-through back on). */
  isActive(): boolean { return this.over && performance.now() - this.lastOver < STALE_MS; }

  private static hasFiles(e: DragEvent): boolean {
    return !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  }

  private onOver(e: DragEvent): void {
    if (!FileDropController.hasFiles(e)) return;
    const { hit } = this.host.hitTest(e.clientX, e.clientY);
    if (!hit) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      if (this.over) this.end();
      return;
    }
    e.preventDefault();                                   // accept the drop here
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    this.lastOver = performance.now();
    if (!this.over) { this.over = true; this.host.onFileHover(); }
    if (this.staleTimer !== null) window.clearTimeout(this.staleTimer);
    this.staleTimer = window.setTimeout(() => this.end(), STALE_MS);
  }

  private onDrop(e: DragEvent): void {
    e.preventDefault();                                   // never let the page navigate to the file
    const wasOver = this.over;
    this.over = false;
    if (this.staleTimer !== null) { window.clearTimeout(this.staleTimer); this.staleTimer = null; }
    if (!FileDropController.hasFiles(e) || !this.host.hitTest(e.clientX, e.clientY).hit) {
      if (wasOver) this.host.onFileHoverEnd();
      return;
    }
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) this.host.onFilesDropped(files);
    else if (wasOver) this.host.onFileHoverEnd();
  }

  private end(): void {
    if (this.staleTimer !== null) { window.clearTimeout(this.staleTimer); this.staleTimer = null; }
    if (!this.over) return;
    this.over = false;
    this.host.onFileHoverEnd();
  }

  destroy(): void {
    this.end();
    for (const fn of this.cleanup) fn();
    this.cleanup.length = 0;
  }
}
