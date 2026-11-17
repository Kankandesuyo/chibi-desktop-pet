import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

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
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome156', chunkSizeWarningLimit: 900 },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as Parameters<typeof defineConfig>[0]);
