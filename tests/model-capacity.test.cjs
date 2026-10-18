'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoader } = require('./runtime-loader.cjs');
const { normalizeModelList } = createLoader()('./provider-registry.cjs');
test('model discovery retains only explicit valid context capacity metadata', () => {
  const models = normalizeModelList({ data: [
    { id: 'known', context_window: 128000 }, { id: 'unknown' },
    { id: 'bad', context_window: '128000' }, { id: 'negative', context_window: -1 },
  ] });
  assert.equal(models[0].contextWindowTokens, 128000);
  assert.equal(models[0].contextWindowSource, 'provider-metadata');
  for (const model of models.slice(1)) assert.equal(model.contextWindowTokens, undefined);
});
