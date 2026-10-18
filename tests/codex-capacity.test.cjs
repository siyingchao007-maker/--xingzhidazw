'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { capacityFromCatalog } = require('../src/codex-model-capacity.cjs');
const now = Date.parse('2026-10-18T08:00:00Z');
const catalog = { fetched_at: '2026-10-18T07:50:00Z', identity: 'must-not-return',
  models: [{ slug: 'selected-model', context_window: 500000 }] };
test('native capacity uses exact fresh CLI catalog model and conservative effective override', () => {
  const result = capacityFromCatalog(catalog, { model_context_window: 200000 }, 'selected-model', now);
  assert.equal(result.contextWindowTokens, 180000);
  assert.equal(result.contextWindowSource, 'codex-cache-effective');
  assert.equal(JSON.stringify(result).includes('must-not-return'), false);
});
test('unknown, stale, custom-provider or invalid cache cannot claim native capacity', () => {
  assert.equal(capacityFromCatalog(catalog, {}, 'another-model', now), null);
  assert.equal(capacityFromCatalog(catalog, {}, 'selected-model', now + 3600000), null);
  assert.equal(capacityFromCatalog(catalog, { model_provider: 'custom' }, 'selected-model', now), null);
  assert.equal(capacityFromCatalog(catalog, { model_context_window: '1000' }, 'selected-model', now), null);
});
