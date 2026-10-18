"use strict";

const ACTION_COPY = Object.freeze({
  publish: Object.freeze({ preview: "预览发布", confirm: "确认发布", running: "发布中", done: "已发布草稿版本" }),
  activate: Object.freeze({ preview: "预览激活", confirm: "确认激活", running: "激活中", done: "已激活发布版本" }),
  rollback: Object.freeze({ preview: "预览回退", confirm: "确认回退", running: "回退中", done: "已回退到最后有效版本" }),
});

function shortHash(value) {
  const text = typeof value === "string" ? value : "";
  if (!text) return "无";
  const raw = text.startsWith("sha256:") ? text.slice(7) : text;
  return `${raw.slice(0, 10)}…`;
}

function identityRow(parent, label, version, hash) {
  const row = parent.createDiv({ cls: "xz-capability-release-row" });
  row.createSpan({ text: label });
  const value = row.createDiv();
  value.createEl("strong", { text: version || "无" });
  value.createEl("code", { text: shortHash(hash), attr: { title: hash || "没有可用哈希" } });
}

function renderReleaseStatus(parent, release) {
  if (!release?.status) return null;
  const status = parent.createSpan({
    cls: `xz-capability-release-status is-${release.status.tone || "neutral"}`,
    text: release.status.label || "未知",
  });
  status.setAttr("aria-label", `版本状态：${release.status.label || "未知"}`);
  return status;
}

function renderReleaseMeta(parent, release) {
  if (!release) return;
  parent.createSpan({ text: `草稿 ${shortHash(release.draft?.hash)}` });
  parent.createSpan({ text: `活动 ${release.active?.version || "无"}` });
  parent.createSpan({ text: `有效 ${release.lastKnownGood?.version || "无"}` });
}

function renderReleaseDetails(parent, release) {
  if (!release) return;
  const section = parent.createDiv({ cls: "xz-capability-release-details" });
  section.createEl("strong", { text: "版本与发布状态" });
  const source = section.createDiv({ cls: "xz-capability-release-source" });
  source.createSpan({ text: "人工编辑源" });
  source.createEl("code", { text: release.sourcePath || "未登记" });
  identityRow(section, "草稿", release.draft?.version || (release.draft?.valid === false ? "校验失败" : "无"), release.draft?.hash);
  identityRow(section, "活动", release.active?.version, release.active?.hash);
  identityRow(section, "最后有效", release.lastKnownGood?.version, release.lastKnownGood?.hash);
  const evaluation = section.createDiv({ cls: "xz-capability-release-evaluation" });
  evaluation.createSpan({ text: "发布评测" });
  if (!release.evaluation) {
    evaluation.createEl("strong", { text: "等待有效草稿" });
  } else {
    evaluation.createEl("strong", {
      text: release.evaluation.passed
        ? `通过 ${release.evaluation.qualifyingCases}/${release.evaluation.requiredCases}`
        : `未通过 ${release.evaluation.qualifyingCases}/${release.evaluation.requiredCases}`,
    });
  }
}

function renderReleaseFeedback(parent, { release, preview, operationError } = {}) {
  if (operationError?.id === release?.skillId) {
    const issue = parent.createDiv({ cls: "xz-capability-release-alert is-error", attr: { role: "alert" } });
    issue.createEl("strong", { text: "版本操作未完成" });
    issue.createEl("p", { text: operationError.message || "请检查草稿后重试。" });
    const locationText = `${operationError.path || release.sourcePath || "未知文件"} · ${operationError.field || "未知字段"}`;
    issue.createEl("code", { text: locationText, attr: { title: locationText } });
  } else if (release?.validation?.passed === false && release.validation.error) {
    const issue = parent.createDiv({ cls: "xz-capability-release-alert is-error", attr: { role: "status" } });
    issue.createEl("strong", { text: "草稿校验失败" });
    issue.createEl("p", { text: release.validation.error.message });
    issue.createEl("code", { text: `${release.validation.error.path} · ${release.validation.error.field}` });
  }
  if (!preview || preview.skillId !== release?.skillId) return;
  const copy = ACTION_COPY[preview.action];
  const box = parent.createDiv({ cls: "xz-capability-release-preview", attr: { role: "status" } });
  box.createEl("strong", { text: `${copy?.preview || "版本变更"}确认` });
  box.createEl("p", {
    text: `${preview.label || preview.skillId}：${preview.fromVersion || "无活动版"} → ${preview.toVersion || "无"}。`,
  });
  if (preview.evaluation) {
    box.createEl("p", {
      text: `行为评测：${preview.evaluation.passed ? "通过" : "未通过"} ${preview.evaluation.qualifyingCases}/${preview.evaluation.requiredCases}；套件 ${preview.evaluation.suiteVersion || "未登记"}。`,
    });
  }
  if (preview.action === "publish") {
    box.createEl("p", {
      text: `将更新 ${preview.artifactChanges?.filter((item) => item.changed).length || 0} 个生成文件；人工 MD 保持为唯一编辑源。`,
    });
  } else if (preview.action === "activate") {
    box.createEl("p", { text: "激活后新回合固定使用该快照；完成一次使用该版本的回合后确认健康。" });
  } else if (preview.action === "rollback") {
    box.createEl("p", { text: "只切换活动快照，当前人工 MD 草稿保持原样。" });
  }
}

function renderReleaseActions(parent, {
  release,
  preview,
  disabled = false,
  onValidate,
  onPreview,
  onApply,
} = {}) {
  if (!release) return;
  const validate = parent.createEl("button", {
    text: "校验草稿",
    attr: { type: "button", "aria-label": `校验 ${release.label || release.skillId} 的人工 MD 草稿` },
  });
  validate.disabled = disabled;
  validate.addEventListener("click", () => onValidate?.());

  for (const action of ["publish", "activate", "rollback"]) {
    const confirming = preview?.skillId === release.skillId && preview.action === action;
    if (!release.can?.[action] && !confirming) continue;
    const copy = ACTION_COPY[action];
    const button = parent.createEl("button", {
      text: confirming ? copy.confirm : copy.preview,
      cls: confirming ? "mod-cta" : "",
      attr: {
        type: "button",
        "aria-label": confirming
          ? `${copy.confirm} ${release.label || release.skillId}`
          : `${copy.preview} ${release.label || release.skillId}`,
      },
    });
    button.disabled = disabled;
    button.addEventListener("click", () => {
      if (confirming) onApply?.();
      else onPreview?.(action);
    });
  }
}

module.exports = {
  ACTION_COPY,
  renderReleaseActions,
  renderReleaseDetails,
  renderReleaseFeedback,
  renderReleaseMeta,
  renderReleaseStatus,
  shortHash,
};
