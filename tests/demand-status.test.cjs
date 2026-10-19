'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoader } = require('./runtime-loader.cjs');
const { __controlledSkillTest } = createLoader()('./workbench-runtime.cjs');

test('work panel summary preserves the automatic Skill request and refusal evidence', () => {
  const summary = __controlledSkillTest.normalizeWorkPanelSummary({
    conversationId: 'conversation',
    demandSkill: {
      status: 'BUDGET_EXCEEDED',
      requestedSkillId: 'xingzhi-product-business-validation',
      reasonCode: 'CONTEXT_HEADROOM_INSUFFICIENT',
      reason: '模型申请了主 Skill，但上下文预算不足或尚未确认；本轮未读取正文。',
    },
  }, 'conversation');
  assert.equal(JSON.stringify(summary.demandSkill), JSON.stringify({
    status: 'BUDGET_EXCEEDED',
    requestedSkillId: 'xingzhi-product-business-validation',
    reasonCode: 'CONTEXT_HEADROOM_INSUFFICIENT',
    reason: '模型申请了主 Skill，但上下文预算不足或尚未确认；本轮未读取正文。',
  }));
});

test('work panel summary bounds untrusted automatic Skill fields', () => {
  const summary = __controlledSkillTest.normalizeWorkPanelSummary({
    demandSkill: { status: 'made-up', requestedSkillId: 'x'.repeat(500),
      reasonCode: 'y'.repeat(500), reason: 'z'.repeat(2000) },
  }, 'conversation');
  assert.equal(summary.demandSkill.status, 'unknown');
  assert.equal(summary.demandSkill.requestedSkillId.length, 128);
  assert.equal(summary.demandSkill.reasonCode.length, 100);
  assert.equal(summary.demandSkill.reason.length, 600);
});
