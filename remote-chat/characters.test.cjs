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
