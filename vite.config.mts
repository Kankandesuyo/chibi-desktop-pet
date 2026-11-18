import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/** Which build this is (shown in 设置 → 关于): package version, git commit (+ if there were uncommitted edits), time. */
function buildInfo(): { version: string; commit: string; dirty: boolean; time: string } {
  const git = (cmd: string): string => { try { return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
  const d = new Date();
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return {
    version: pkg.version, commit: git('rev-parse --short HEAD') || 'unknown', dirty: git('status --porcelain').length > 0,
    time: `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`,
  };
}

/** Production only: lock the page down. (The dev server needs inline scripts for hot reload.) */
function cspPlugin(): Plugin {
  const csp = [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'",
  ].join('; ');
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`),
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), cspPlugin()],
  define: { __BUILD__: JSON.stringify(buildInfo()) },
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome156', chunkSizeWarningLimit: 900 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as Parameters<typeof defineConfig>[0]);
