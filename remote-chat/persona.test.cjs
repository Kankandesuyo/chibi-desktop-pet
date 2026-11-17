'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
function loadPatched(file) {
  const root = path.join(__dirname, '..');
  const source = execFileSync('python', ['-c', "import sys,pathlib;sys.path.insert(0,'remote-chat');from desktop_patch import patch;p=sys.argv[1];d=patch(p,pathlib.Path('remote-chat/app-source',p).read_bytes());assert patch(p,d)==d;sys.stdout.buffer.write(d)", file], { cwd: root, encoding: 'utf8' });
  const module = { exports: {} };
  vm.runInNewContext('(function(require,module,exports){' + source + '\n})', {})(createRequire(path.join(__dirname, 'app-source', file)), module, module.exports);
  return module.exports;
}
const persona = loadPatched('dist-electron/shared/persona.js');
const protocol = loadPatched('dist-electron/shared/aiProtocol.js');
test('custom traits replace default personality while retaining truth and authorization boundaries', () => {
  const traits = '温文尔雅，知性聪慧；不刻意卖萌。';
  const result = persona.buildPersona({ name: '测试', traits, selfState: '今天处理过一个任务' });
  assert.ok(result.includes(traits));
  assert.equal(result.split(traits).length - 1, 1);
  assert.ok(!result.includes('有点小傲娇、嘴硬心软'));
  assert.ok(!result.includes('哼”“欸嘿'));
  assert.ok(result.includes('安全确认规则一条都不能'));
  assert.ok(result.includes('不假装能做到'));
  assert.ok(result.includes('今天处理过一个任务'));
});
test('empty traits keep the original default character', () => {
  assert.ok(persona.buildPersona({ name: '测试', traits: '  ' }).includes('有点小傲娇、嘴硬心软'));
});
test('fresh persona reflects edited settings without inheriting old traits', () => {
  assert.ok(persona.buildPersona({ name: '测试', traits: '严肃简洁' }).includes('严肃简洁'));
  const next = persona.buildPersona({ name: '测试', traits: '温雅知性' });
  assert.ok(next.includes('温雅知性')); assert.ok(!next.includes('严肃简洁'));
});
test('plain chat and spontaneous speech preserve current style and output controls', () => {
  const current = persona.buildPersona({ name: '测试', traits: '温雅知性' });
  const prompt = protocol.buildSystemPrompt({ mood: 'happy', affection: 50, energy: 50 }, current);
  assert.ok(prompt.includes('温雅知性')); assert.ok(!prompt.includes('可爱但不腻'));
  assert.ok(prompt.includes('[[emotion:X|action:Y]]'));
  assert.ok(persona.buildMonologuePrompt(current, '测试时刻').includes('温雅知性'));
});
