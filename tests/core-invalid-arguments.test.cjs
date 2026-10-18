'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createControlledSkillLoadAttempt } = require('../src/controlled-skill-load-attempt.cjs');
test('wrong argument types return a tool failure instead of throwing into the main answer', async () => {
  const attempt = createControlledSkillLoadAttempt({ attemptId: 'attempt', lookupSkill: () => null,
    readSkillBody: () => { throw new Error('Must not read'); } });
  const result = await attempt.request({ skillId: 123, reason: 'test' }, { toolCallId: 'call-1', channel: 'provider-api' });
  assert.equal(result.code, 'INVALID_ARGUMENTS');
});
