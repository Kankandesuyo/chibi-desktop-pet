const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createVisionClient } = require('./vision-client.cjs');
const config = { baseUrl: 'https://api.deepseek.com', apiKey: 'fixture-secret-key', model: 'deepseek-flash' };
const image = Buffer.from('synthetic-test-image');
function client(responses) {
  const requests = [], events = [];
  const run = createVisionClient({ diagnostic: e => events.push(e), fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body)); const response = responses.shift();
    if (response instanceof Error) throw response;
    return new Response(JSON.stringify(response.body || { choices: [{ finish_reason: response.finish || 'stop', message: { content: response.text ?? null, ...(response.reasoning ? { reasoning_content: response.reasoning } : {}) } }] }), { status: response.status || 200 });
  } });
  return { run, requests, events };
}
test('DeepSeek vision disables thinking and budgets structured output explicitly', async () => {
  const c = client([{ text: '{"summary":"ok","targets":[]}' }]);
  await c.run(config, image, '返回 JSON', new AbortController().signal, { json: true });
  assert.deepEqual(c.requests[0].thinking, { type: 'disabled' });
  assert.deepEqual(c.requests[0].response_format, { type: 'json_object' });
  assert.equal(c.requests[0].max_tokens, 4096);
  assert.ok(!JSON.stringify(c.events).includes('fixture-secret-key')); assert.ok(!JSON.stringify(c.events).includes('synthetic-test-image'));
});
test('truncated JSON is not used; the same image is read again with a larger budget', async () => {
  const c = client([{ finish: 'length', text: '{"targets":[{"label":"截断"' }, { text: '{"targets":[{"label":"搜索框","x":500,"y":100}]}' }]);
  const result = await c.run(config, image, '定位', new AbortController().signal, { json: true });
  assert.equal(JSON.parse(result).targets[0].label, '搜索框'); assert.equal(c.requests.length, 2); assert.equal(c.requests[1].max_tokens, 8192);
  assert.equal(c.requests[0].messages[0].content[1].image_url.url, c.requests[1].messages[0].content[1].image_url.url);
});
test('reasoning-only response is never treated as the final answer', async () => {
  const c = client([{ reasoning: 'private hidden thought' }, { text: '实际可见的窗口' }]);
  assert.equal(await c.run(config, image, '看图', new AbortController().signal), '实际可见的窗口');
  assert.ok(!JSON.stringify(c.events).includes('private hidden thought'));
});
test('two reasoning-only responses produce a specific failure and stop', async () => {
  const c = client([{ reasoning: 'secret thought' }, { reasoning: 'secret thought again' }]);
  await assert.rejects(c.run(config, image, '看图', new AbortController().signal), /没有最终回答/); assert.equal(c.requests.length, 2);
});
test('malformed JSON is retried but never repaired into guessed coordinates', async () => {
  const c = client([{ text: '{"targets":[INVALID}' }, { text: '{"targets":[STILL INVALID}' }]);
  await assert.rejects(c.run(config, image, '定位', new AbortController().signal, { json: true }), /JSON 不完整或格式无效/);
  assert.equal(c.requests.length, 2);
});
test('JSON-mode compatibility fallback still enforces valid JSON', async () => {
  const c = client([{ status: 400, body: { error: { message: 'response_format json_object is unsupported' } } }, { text: '{"targets":[]}' }]);
  await c.run(config, image, '定位', new AbortController().signal, { json: true });
  assert.equal(c.requests[1].response_format, undefined);
});
test('permission and authentication failures are not retried', async () => {
  const c = client([{ status: 401, body: { error: { message: 'invalid key: fixture-secret-key' } } }]);
  await assert.rejects(c.run(config, image, '看图', new AbortController().signal), e => /HTTP 401/.test(e.message) && !e.message.includes('fixture-secret-key'));
  assert.equal(c.requests.length, 1);
});
test('a cancelled request never starts network work', async () => {
  const c = client([]), controller = new AbortController(); controller.abort();
  await assert.rejects(c.run(config, image, '看图', controller.signal), /已取消/); assert.equal(c.requests.length, 0);
});
test('non-DeepSeek compatibility endpoints receive no proprietary thinking parameter', async () => {
  const c = client([{ text: 'ok' }]); await c.run({ ...config, baseUrl: 'https://example.com/v1' }, image, '看图', new AbortController().signal);
  assert.equal(c.requests[0].thinking, undefined);
});
