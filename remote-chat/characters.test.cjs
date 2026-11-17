'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { catalog, characterId } = require('./public/characters.js');
const { readSettings, validateSettings } = require('./web-settings.cjs');
test('character settings fall back for old configs and only accept packaged character IDs', () => {
  const config = { getSettings: () => ({ petName: 'test' }), getAgentSettings: () => ({}), getAiEndpoint: () => ({}), getApiKey: () => '' };
  assert.equal(readSettings(config).character, 'orange');
  assert.equal(validateSettings({ character: 'deepseek' }, config).basic.character, 'deepseek');
  for (const value of ['__proto__','https://example.com/x.png','../private', null, {}, 'unknown']) assert.throws(() => validateSettings({ character: value }, config));
  assert.equal(characterId('missing'), 'orange');
  assert.notEqual(catalog.deepseek.image, catalog.orange.image);
});
test('saving from the web keeps a custom character chosen on the desktop', () => {
  const config = { getSettings: () => ({ petName: 'test', character: 'custom:我的角色' }), getAgentSettings: () => ({}), getAiEndpoint: () => ({}), getApiKey: () => '' };
  assert.equal(readSettings(config).character, 'orange');
  assert.equal(Object.hasOwn(validateSettings({ character: 'orange', petName: '新名字' }, config).basic, 'character'), false);
  assert.equal(validateSettings({ character: 'deepseek' }, config).basic.character, 'deepseek');
});
