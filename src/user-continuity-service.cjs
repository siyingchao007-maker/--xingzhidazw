"use strict";

const {
  CURRENT_PROFILE_PATH,
  GROWTH_EVENTS_PATH,
  GROWTH_PATH_PATH,
  appendInteractionEvent,
  applyProfileObservations,
  buildGrowthPathMarkdown,
  buildInteractionEvent,
  extractGrowthPathEvents,
  extractProfileEntries,
  interactionLedgerPath,
  isSensitiveProfileStatement,
  profileRevisionPath,
  renderCurrentProfileMarkdown,
} = require("./user-continuity.cjs");
const { hashContent } = require("./knowledge-writer.cjs");
const { encodeGrowthRecord, readGrowthEvents } = require("./growth-records.cjs");

const REVISION_MARKER = "xingzhi-profile-revision";
const GROWTH_EVENT_MARKER = "xingzhi-growth-event";

function timestampParts(timestamp) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/u.exec(String(timestamp || ""));
  if (!match) throw new Error("画像服务时间无效");
  return { year: match[1], month: match[2], day: match[3], hour: match[4], minute: match[5] };
}

function appendRecords(existing, records, { kind, title, period, describe }) {
  let content = String(existing || "");
  if (!content.trim()) {
    content = [
      "---",
      `type: ${kind}`,
      ...(period ? [`period: ${period}`] : []),
      "privacy: private",
      "---",
      "",
      `# ${title}`,
      "",
    ].join("\n");
  }
  for (const record of records) {
    const markerName = kind === "profile-revision-log" ? REVISION_MARKER : GROWTH_EVENT_MARKER;
    const marker = `<!-- ${markerName}:${record.id} -->`;
    if (content.includes(marker)) continue;
    content = [content.trimEnd(), "", describe(record), "", marker, ""].join("\n");
  }
  return content;
}

function appendProfileRevisions(existing, records) {
  const first = records[0];
  const { year, month } = timestampParts(first?.occurredAt);
  return appendRecords(existing, records, {
    kind: "profile-revision-log",
    title: `${year}-${month} 用户画像演变`,
    period: `${year}-${month}`,
    describe: (record) => [
      `## ${String(record.occurredAt).replace("T", " ").slice(0, 16)} · ${record.change}`,
      "",
      `- 内容：${record.statement}`,
      `- 画像编号：\`${record.profileId}\``,
      `- 来源消息：\`${record.sourceMessageId}\``,
    ].join("\n"),
  });
}

function appendGrowthEvents(existing, records, occurredAt) {
  const next = appendRecords(existing, records, {
    kind: "growth-event-log",
    title: "成长路径事件",
    describe: (record) => [
      `## ${String(occurredAt).replace("T", " ").slice(0, 16)} · ${record.title}`,
      "",
      `- 类型：${record.eventType}`,
      `- 摘要：${record.summary}`,
      record.sourceRole === "user-record" ? "- 来源属性：用户填写，未作独立核实" : `- 系统参考值：${Math.round(Number(record.confidence || 0) * 100)}%（未经经验校准）`,
      `- 来源消息：\`${record.sourceMessageId}\``,
      ...(record.sourcePath ? [`- 原始依据：[[${record.sourcePath}${record.sourceMessageId?.startsWith("msg-") ? `#^${record.sourceMessageId}` : ""}|打开来源]]`] : []),
      ...(record.evidenceQuote ? [`- 原话摘录：${JSON.stringify(record.evidenceQuote)}`] : []),
      encodeGrowthRecord({ ...record, occurredAt }),
    ].join("\n"),
  });
  if (!records.length) return next;
  if (/^status:\s*empty\s*$/mu.test(next)) return next.replace(/^status:\s*empty\s*$/mu, "status: active");
  if (/^---\r?\n/u.test(next) && !/^status:/mu.test(next)) {
    return next.replace(/^---\r?\n/u, "---\nstatus: active\n");
  }
  return next;
}

class UserContinuityService {
  constructor({ vault, writer, commitPlan = null, clock = () => new Date().toISOString() } = {}) {
    if (!vault || typeof vault.exists !== "function" || typeof vault.read !== "function") {
      throw new Error("用户连续性服务缺少 Vault");
    }
    if (!writer || typeof writer.plan !== "function" || typeof writer.commit !== "function") {
      throw new Error("用户连续性服务缺少受控知识写入器");
    }
    this.vault = vault;
    this.writer = writer;
    this.commitPlan = typeof commitPlan === "function"
      ? commitPlan : (plan) => this.writer.commit(plan);
    this.clock = clock;
  }

  async _read(path) {
    return await this.vault.exists(path) ? this.vault.read(path) : "";
  }

  async _upsertMutation(path, content, source) {
    const current = source === undefined ? await this._read(path) : source;
    if (current === content) return null;
    return current
      ? { operation: "replace", path, content, expectedHash: hashContent(current) }
      : { operation: "create", path, content };
  }

  async recordInteraction(turn, { canRecord = null } = {}) {
    const event = buildInteractionEvent(turn);
    const path = interactionLedgerPath(event.occurredAt);
    const current = await this._read(path);
    const content = appendInteractionEvent(current, event);
    if (content === current) {
      return { status: "already-recorded", event, path, transactionId: null, undoAvailable: false };
    }
    const mutation = await this._upsertMutation(path, content, current);
    if (typeof canRecord === "function" && canRecord() !== true) {
      return { status: "skipped-read-only", event, path: null, transactionId: null, undoAvailable: false };
    }
    const transaction = await this.commitPlan(this.writer.plan([mutation]));
    return {
      status: "written",
      event,
      path,
      transactionId: transaction.id,
      undoAvailable: Boolean(transaction.undoToken),
    };
  }

  async applyAnalysis({ interactionEvent, analysis, automaticOrganization, canApply = null }) {
    if (!interactionEvent?.sourceMessageId || !interactionEvent?.occurredAt) {
      throw new Error("画像分析缺少可信交互事件");
    }
    const writeAllowed = () => typeof canApply !== "function" || canApply() === true;
    const withheld = () => ({
      status: "recorded-only", written: 0, pending: 0, blocked: [],
      ignored: [], growthEventsWritten: 0, paths: [], transactionId: null, undoAvailable: false,
      reason: "处理期间整理设置、权限或对话状态已改变；未更新画像或成长档案，原始交互记录保留。",
    });
    if (!writeAllowed()) return withheld();
    const observations = Array.isArray(analysis?.observations) ? analysis.observations : [];
    const growthEvents = Array.isArray(analysis?.growthEvents) ? analysis.growthEvents : [];
    const blocked = [];
    const safeObservations = [];
    for (const observation of observations) {
      let reason = null;
      if (isSensitiveProfileStatement(observation?.statement)) reason = "sensitive-inference";
      else if (observation?.relation === "contradicts" || observation?.relation === "replaces") reason = "profile-conflict";
      else if (observation?.epistemicStatus === "inference" || observation?.epistemicStatus === "unknown") reason = "unverified-inference";
      else if (!Number.isFinite(observation?.confidence) || observation.confidence < 0.7) reason = "low-confidence";
      if (reason) blocked.push({ statement: String(observation?.statement || "").slice(0, 400), reason });
      else safeObservations.push(observation);
    }
    const safeGrowthEvents = growthEvents.filter((event) => {
      const safe = Number.isFinite(event?.confidence) && event.confidence >= 0.8
        && !isSensitiveProfileStatement(`${event?.title || ""} ${event?.summary || ""}`);
      if (!safe) blocked.push({ statement: String(event?.title || "成长事件").slice(0, 400), reason: "growth-event-review" });
      return safe;
    }).map(event => ({ ...event, sourcePath: interactionEvent.sourcePath || "", sourceRole: "user-statement", occurredAt: interactionEvent.occurredAt }));
    const pending = blocked.length + safeObservations.length + safeGrowthEvents.length;
    if (automaticOrganization !== true) {
      return {
        status: pending ? "pending-confirmation" : "completed",
        written: 0,
        pending,
        blocked,
        ignored: Array.isArray(analysis?.ignored) ? analysis.ignored : [],
        paths: [],
        transactionId: null,
        undoAvailable: false,
      };
    }
    if (!safeObservations.length && !safeGrowthEvents.length) {
      return {
        status: blocked.length ? "pending-confirmation" : "completed",
        written: 0,
        pending: blocked.length,
        blocked,
        ignored: Array.isArray(analysis?.ignored) ? analysis.ignored : [],
        paths: [],
        transactionId: null,
        undoAvailable: false,
      };
    }

    const generatedAt = this.clock();
    const currentProfileSource = await this._read(CURRENT_PROFILE_PATH);
    const existingEntries = extractProfileEntries(currentProfileSource);
    const profileResult = applyProfileObservations(existingEntries, safeObservations, {
      observedAt: interactionEvent.occurredAt,
    });
    const mutations = [];
    const profileChanged = JSON.stringify(profileResult.entries) !== JSON.stringify(existingEntries);
    if (profileChanged) {
      const profileMarkdown = renderCurrentProfileMarkdown(profileResult.entries, { generatedAt });
      mutations.push(await this._upsertMutation(CURRENT_PROFILE_PATH, profileMarkdown, currentProfileSource));
    }

    const revisionPath = profileRevisionPath(interactionEvent.occurredAt);
    const revisionSource = profileResult.revisions.length ? await this._read(revisionPath) : "";
    const newRevisions = profileResult.revisions.filter((revision) => (
      !revisionSource.includes(`<!-- ${REVISION_MARKER}:${revision.id} -->`)
    ));
    if (newRevisions.length) {
      const revisionMarkdown = appendProfileRevisions(revisionSource, newRevisions);
      mutations.push(await this._upsertMutation(revisionPath, revisionMarkdown, revisionSource));
    }
    const growthEventSource = safeGrowthEvents.length ? await this._read(GROWTH_EVENTS_PATH) : "";
    const existingGrowthEvents = readGrowthEvents(growthEventSource);
    const newGrowthEvents = [];
    for (const event of safeGrowthEvents) {
      const duplicate = [...existingGrowthEvents, ...newGrowthEvents].some(old => old.id === event.id || (old.sourceMessageId === event.sourceMessageId && old.eventType === event.eventType && ((old.evidenceQuote && old.evidenceQuote === event.evidenceQuote) || old.title === event.title)));
      if (!duplicate) newGrowthEvents.push(event);
    }
    if (newGrowthEvents.length) {
      const growthEventMarkdown = appendGrowthEvents(
        growthEventSource,
        newGrowthEvents,
        interactionEvent.occurredAt,
      );
      mutations.push(await this._upsertMutation(GROWTH_EVENTS_PATH, growthEventMarkdown, growthEventSource));
    }
    const growthPathSource = await this._read(GROWTH_PATH_PATH);
    const priorTimeline = extractGrowthPathEvents(growthPathSource);
    const priorTimelineIds = new Set(priorTimeline.map((event) => event?.id).filter(Boolean));
    const timelineAdditions = newGrowthEvents.map((event) => ({
      ...event,
      occurredAt: interactionEvent.occurredAt,
      statement: event.title,
      change: "growth-event",
    })).filter((event) => !priorTimelineIds.has(event.id));
    if (timelineAdditions.length) {
      const archivedEvents = readGrowthEvents(growthEventSource);
      const nextTimeline = [...new Map([...priorTimeline, ...archivedEvents, ...timelineAdditions].map(event => [event.id, event])).values()];
      const growthPathMarkdown = buildGrowthPathMarkdown(nextTimeline, { generatedAt });
      mutations.push(await this._upsertMutation(GROWTH_PATH_PATH, growthPathMarkdown, growthPathSource));
    }

    const planned = mutations.filter(Boolean);
    if (!planned.length) {
      return {
        status: blocked.length ? "pending-confirmation" : "completed",
        written: 0,
        pending: blocked.length,
        blocked,
        ignored: Array.isArray(analysis?.ignored) ? analysis.ignored : [],
        growthEventsWritten: 0,
        paths: [],
        transactionId: null,
        undoAvailable: false,
      };
    }
    // Reads and planning can outlive the user's authorization. An already
    // started transaction keeps the writer's existing atomic/rollback semantics.
    if (!writeAllowed()) return withheld();
    const transaction = await this.commitPlan(this.writer.plan(planned));
    return {
      status: blocked.length ? "written-with-pending" : "written",
      written: profileChanged ? safeObservations.length : 0,
      pending: blocked.length,
      blocked,
      ignored: Array.isArray(analysis?.ignored) ? analysis.ignored : [],
      growthEventsWritten: newGrowthEvents.length,
      paths: planned.map((mutation) => mutation.path),
      transactionId: transaction.id,
      undoAvailable: Boolean(transaction.undoToken),
    };
  }
}

module.exports = {
  UserContinuityService,
  appendGrowthEvents,
  appendProfileRevisions,
};
