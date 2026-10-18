"use strict";
const { hashContent } = require("./knowledge-writer.cjs");
const { parseKnowledgeRecord } = require("./knowledge-record-schema.cjs");
const { createLoop, applyFeedback, renderLoop, renderFeedback, parseLoop, loopPath, feedbackPath, LOOP_ROOT,
  HOLDS_PATH, emptyHolds, parseHolds, renderHolds, applyHoldAction } = require("./cognitive-records.cjs");
const { GROWTH_EVENTS_PATH, GROWTH_PATH_PATH, extractGrowthPathEvents, buildGrowthPathMarkdown } = require("./user-continuity.cjs");
const { appendGrowthEvents } = require("./user-continuity-service.cjs");
const { readGrowthEvents } = require("./growth-records.cjs");

class CognitiveWorkspace {
  constructor({ vault, writer, commitPlan, assertWritable = () => {}, clock = () => new Date().toISOString(), changed = async () => {} }) {
    Object.assign(this, { vault, writer, assertWritable, clock, changed });
    this.commitPlan = commitPlan || (plan => writer.commit(plan)); this.chain = Promise.resolve();
  }
  enqueue(task) { const next = this.chain.catch(() => {}).then(task); this.chain = next.catch(() => {}); return next; }
  async read(path) { return await this.vault.exists(path) ? this.vault.read(path) : ""; }
  async assertEvidence(paths) { for (const path of paths) if (!await this.vault.exists(path)) throw new Error(`关联依据已不存在：${path}`); }
  async mutation(path, content, expectedHash) {
    const before = await this.read(path);
    if (expectedHash && hashContent(before) !== expectedHash) throw new Error("记录已发生变化，当前表单过期；请重新读取后再保存");
    return before ? { operation: "replace", path, content, expectedHash: hashContent(before) } : { operation: "create", path, content };
  }
  async eventMutations(events, now) {
    const before = await this.read(GROWTH_EVENTS_PATH);
    const old = readGrowthEvents(before);
    const additions = events.filter(e => !old.some(x => x.id === e.id));
    if (!additions.length) return [];
    const journal = appendGrowthEvents(before, additions, additions[0].occurredAt);
    const priorSource = await this.read(GROWTH_PATH_PATH);
    const priorView = extractGrowthPathEvents(priorSource);
    const all = [...new Map([...priorView, ...old, ...additions].map(e => [e.id, e])).values()];
    return [await this.mutation(GROWTH_EVENTS_PATH, journal, hashContent(before)), await this.mutation(GROWTH_PATH_PATH, buildGrowthPathMarkdown(all, { generatedAt: now }), hashContent(priorSource))];
  }
  async commit(mutations) {
    this.assertWritable();
    const transaction = await this.commitPlan(this.writer.plan(mutations));
    await this.changed(transaction);
    return transaction.id;
  }
  create(input) {
    return this.enqueue(async () => {
      this.assertWritable(); const now = this.clock(); const loop = createLoop(input, now); const path = loopPath(loop.id);
      await this.assertEvidence(loop.evidencePaths);
      const event = { id: `growth-${loop.id}`, title: loop.title, summary: `用户新建行动计划：${loop.action}；实际结果尚未记录。`,
        eventType: "goal", occurredAt: now, sourceMessageId: loop.id, sourcePath: path, relatedPath: path,
        sourceRole: "user-record", evidenceQuote: loop.action, confidence: 1 };
      const transactionId = await this.commit([await this.mutation(path, renderLoop(loop)), ...await this.eventMutations([event], now)]);
      return { loop, path, transactionId, hash: hashContent(renderLoop(loop)) };
    });
  }
  feedback(path, input, expectedHash) {
    return this.enqueue(async () => {
      this.assertWritable();
      if (typeof path !== "string" || !path.startsWith(LOOP_ROOT + "/")) throw new Error("反馈必须关联当前行动记录");
      if (!/^[a-f0-9]{64}$/u.test(String(expectedHash || ""))) throw new Error("缺少记录版本，请重新读取");
      const before = await this.read(path);
      if (hashContent(before) !== expectedHash) throw new Error("记录已发生变化，当前表单过期；请重新读取");
      const loop = parseLoop({ path, content: before }); if (!loop) throw new Error("未找到可关联的行动");
      if (renderLoop(loop).replace(/\r\n/gu, "\n") !== before.replace(/\r\n/gu, "\n")) throw new Error("记录正文已被直接编辑，请先核对原文；未覆盖修改");
      const now = this.clock(); const next = applyFeedback(loop, input, now); const feedback = next.feedbacks.at(-1); const sourcePath = feedbackPath(feedback.id);
      await this.assertEvidence(feedback.evidencePaths);
      const event = { id: `growth-${feedback.id}`, title: `${loop.title} · 反馈`, summary: feedback.result,
        eventType: "feedback", occurredAt: feedback.occurredAt, sourceMessageId: feedback.id, sourcePath, relatedPath: path,
        sourceRole: "user-record", evidenceQuote: feedback.result, confidence: 1 };
      const events = [event];
      if (feedback.revisedJudgment && feedback.revisedJudgment !== feedback.previousJudgment) events.push({ ...event, id: `${event.id}-judgment`, title: `${loop.title} · 判断修订`, eventType: "judgment", summary: feedback.revisedJudgment, evidenceQuote: feedback.revisedJudgment });
      const transactionId = await this.commit([await this.mutation(path, renderLoop(next), expectedHash),
        await this.mutation(sourcePath, renderFeedback(next, feedback)), ...await this.eventMutations(events, now)]);
      return { loop: next, path, feedbackPath: sourcePath, transactionId, hash: hashContent(renderLoop(next)) };
    });
  }
  holds(action, payload = {}, expectedHash = "") {
    return this.enqueue(async () => {
      this.assertWritable();
      const before = await this.read(HOLDS_PATH);
      let data = emptyHolds();
      if (before) {
        if (hashContent(before) !== expectedHash) throw new Error("所守记录已发生变化，当前表单过期；请刷新后再保存");
        const parsed = parseHolds(before);
        if (!parsed) throw new Error(`「${HOLDS_PATH}」不是行知生成的所守记录，未覆盖；请改名或移走后再试`);
        if (renderHolds(parsed).replace(/\r\n/gu, "\n") !== before.replace(/\r\n/gu, "\n")) throw new Error("所守记录正文已被直接编辑，请先核对原文；未覆盖修改");
        data = parsed;
      }
      const next = applyHoldAction(data, action, payload, this.clock());
      const content = renderHolds(next);
      const transactionId = await this.commit([await this.mutation(HOLDS_PATH, content, before ? expectedHash : undefined)]);
      return { holds: next, path: HOLDS_PATH, transactionId, hash: hashContent(content) };
    });
  }
  async snapshot() {
    const roots = ["01_当前的我", "05_目标与项目", "06_判断与决策", "07_行动", "08_结果与反馈"];
    const notes = await this.vault.listMarkdown(roots, { maxFiles: 5000, maxFileBytes: 4 * 1024 * 1024, maxTotalBytes: 24 * 1024 * 1024 });
    const loops = [], records = [], issues = [];
    let holds = { ...emptyHolds(), path: HOLDS_PATH, hash: "", exists: false, foreign: false };
    for (const note of notes) {
      try {
        if (note.path === HOLDS_PATH) {
          holds = { ...holds, exists: true, hash: hashContent(note.content) };
          const parsed = parseHolds(note.content);
          if (parsed) holds = { ...holds, ...parsed };
          else if (note.content.trim()) holds.foreign = true;
          continue;
        }
        const loop = parseLoop(note);
        if (loop) { loops.push({ ...loop, path: note.path, hash: hashContent(note.content) }); continue; }
        const record = parseKnowledgeRecord(note);
        if (record && record.retrievalEligible) records.push({ id: record.entityId, title: record.title, summary: record.summary.slice(0, 300),
          path: note.path, type: record.knowledgeType, epistemicStatus: record.epistemicStatus, updatedAt: record.updatedAt,
          sourcePath: record.source?.conversationPath || record.source?.documents?.[0] || "" });
      } catch (error) { issues.push({ path: note.path, reason: error.message }); }
    }
    loops.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    records.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    return { generatedAt: this.clock(), loops, goals: records.filter(r => r.path.startsWith("05_")).slice(0, 12),
      judgments: records.filter(r => r.path.startsWith("06_")).slice(0, 12), self: records.filter(r => r.path.startsWith("01_")).slice(0, 12),
      actions: records.filter(r => r.path.startsWith("07_")).slice(0, 12), feedback: records.filter(r => r.path.startsWith("08_")).slice(0, 12),
      values: records.filter(r => r.path.startsWith("01_") && ["value-priority", "behavior-pattern"].includes(r.type)).slice(0, 24),
      allGoals: records.filter(r => r.path.startsWith("05_")).slice(0, 40), holds, issues };
  }
}
module.exports = { CognitiveWorkspace };
