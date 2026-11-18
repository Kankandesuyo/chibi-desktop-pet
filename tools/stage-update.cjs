#!/usr/bin/env node
/**
 * Stages a packaged build as an in-app update, but only after checking it is whole:
 *   - dist/index.html loads a main bundle that is inside the package, and it is the only one
 *     (a half-updated dist once shipped the old page next to the new code);
 *   - the build stamp (设置 → 关于) is this repository's current commit.
 * Usage: node tools/stage-update.cjs [--check-only]
 *   reads  release/win-unpacked/resources/app.asar
 *   writes ../resources/app.asar.new (the installed app offers it as "有新版本")
 */
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const built = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar');
const target = path.resolve(root, '..', 'resources', 'app.asar.new');
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

/** Reads one file straight from the archive via its header (extractFile trips over nested paths here). */
function readFromAsar(archive, rel) {
  const { header, headerSize } = asar.getRawHeader(archive);
  let node = header;
  for (const part of rel.split('/')) { node = node && node.files && node.files[part]; }
  if (!node || node.offset === undefined) return null;
  const fd = fs.openSync(archive, 'r');
  try {
    const buf = Buffer.alloc(node.size);
    fs.readSync(fd, buf, 0, node.size, 8 + headerSize + Number(node.offset));
    return buf;
  } finally { fs.closeSync(fd); }
}

if (!fs.existsSync(built)) fail(`no packaged build at ${built} (run npm run build, then electron-builder)`);
const files = asar.listPackage(built).map((f) => f.replace(/\\/g, '/').replace(/^\//, ''));
const html = (readFromAsar(built, 'dist/index.html') ?? fail('dist/index.html is missing')).toString('utf8');
const entry = /assets\/(index-[\w-]+\.js)/.exec(html)?.[1];
if (!entry) fail('dist/index.html does not load a main bundle');
const bundles = files.filter((f) => /^dist\/assets\/index-[\w-]+\.js$/.test(f));
if (!files.includes(`dist/assets/${entry}`)) fail(`index.html loads ${entry}, which is not in the package`);
if (bundles.length !== 1) fail(`the package has ${bundles.length} main bundles (${bundles.join(', ')}): dist was not rebuilt cleanly`);
const raw = readFromAsar(built, `dist/assets/${entry}`);
if (!raw) fail(`the package is damaged: ${entry} is listed but cannot be read; package again`);
const code = raw.toString('utf8');
// Minified, the stamp reads e.g. {version:`0.1.0`,commit:`d39bc80`,dirty:!0,time:`…`} (any quote style).
const stamp = /\bcommit["'`]?:["'`]([0-9a-f]+|unknown)["'`]/.exec(code)?.[1];
const head = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
if (!stamp) fail('the bundle has no build stamp');
if (stamp !== head) fail(`the bundle was built from ${stamp}, but HEAD is ${head}: rebuild before staging`);
const time = /\btime["'`]?:["'`](\d{4}-\d\d-\d\d \d\d:\d\d)["'`]/.exec(code)?.[1] ?? '?';
const dirty = /\bcommit["'`]?:["'`][0-9a-f]+["'`],dirty["'`]?:(true|!0)/.test(code);
console.log(`✓ ${entry} · build ${stamp}${dirty ? '+' : ''} · ${time} · ${(fs.statSync(built).size / 1048576).toFixed(1)} MB`);

if (process.argv.includes('--check-only')) process.exit(0);
fs.copyFileSync(built, target);
console.log(`✓ staged ${target}`);
