const { test } = require('node:test');
const assert = require('node:assert/strict');

test('simpleCallAI usa limite de saida adequado para curadoria', async () => {
  process.env.AI_BASE_URL = 'https://example.test/v1';
  process.env.AI_API_KEY = 'key';
  delete require.cache[require.resolve('../src/llm')];
  const { simpleCallAI } = require('../src/llm');
  let body;
  const originalFetch = global.fetch;
  global.fetch = async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { json: async () => ({ choices: [{ message: { content: '{"items":[]}' } }] }) };
  };

  try {
    await simpleCallAI('system', 'user');
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(body.max_tokens, 6000);
});
