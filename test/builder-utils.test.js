const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withTimeout, runWithConcurrency } = require('../src/builder');

test('withTimeout rejeita operação que passa do prazo', async () => {
  await assert.rejects(
    () => withTimeout(new Promise(resolve => setTimeout(resolve, 50)), 5, 'lento'),
    /timeout:lento/,
  );
});

test('runWithConcurrency processa todos os itens sem exceder limite', async () => {
  let active = 0;
  let maxActive = 0;
  const out = await runWithConcurrency([1, 2, 3, 4], 2, async item => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return item * 2;
  });

  assert.deepEqual(out, [2, 4, 6, 8]);
  assert.equal(maxActive, 2);
});
