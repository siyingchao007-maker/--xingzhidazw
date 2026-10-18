"use strict";

const { analysisPathCardModel } = require("./turn-analysis-path.cjs");

function renderMetric(parent, label, value, detail = "") {
  const row = parent.createDiv({ cls: "xz-analysis-path-metric" });
  row.createSpan({ cls: "xz-analysis-path-metric__label", text: label });
  const valueStack = row.createDiv({ cls: "xz-analysis-path-metric__value" });
  valueStack.createEl("strong", { text: value });
  if (detail) valueStack.createSpan({ text: detail });
  return row;
}

function renderTurnAnalysisPathCard(parent, rawPath) {
  const model = analysisPathCardModel(rawPath);
  if (!model) return null;

  const card = parent.createEl("section", {
    cls: `xz-analysis-path-card is-${model.status.id}`,
    attr: { "aria-label": model.title },
  });
  const header = card.createDiv({ cls: "xz-analysis-path-header" });
  const heading = header.createDiv({ cls: "xz-analysis-path-heading" });
  heading.createEl("h3", { text: model.title });
  heading.createSpan({ cls: "xz-analysis-path-evidence", text: model.evidenceBadge });
  header.createSpan({ cls: `xz-analysis-path-status is-${model.status.id}`, text: model.status.label });

  const primary = card.createDiv({ cls: "xz-analysis-path-primary" });
  primary.createSpan({ text: model.primary.label });
  const primaryValue = primary.createDiv();
  primaryValue.createEl("strong", { text: model.primary.value });
  primaryValue.createSpan({ text: model.primary.meta });

  if (model.lenses.length) {
    const lensSection = card.createDiv({ cls: "xz-analysis-path-lenses" });
    const lensHeading = lensSection.createDiv({ cls: "xz-analysis-path-section-heading" });
    lensHeading.createEl("h4", { text: "已调用认知透镜" });
    lensHeading.createSpan({ text: String(model.lenses.length) });
    for (const lens of model.lenses) {
      const item = lensSection.createEl("article", { cls: "xz-analysis-path-lens" });
      const lensTitle = item.createDiv({ cls: "xz-analysis-path-lens__title" });
      lensTitle.createEl("strong", { text: lens.label });
      lensTitle.createSpan({ text: lens.meta });
      item.createDiv({ cls: "xz-analysis-path-lens__reason", text: lens.reason });
      const impact = item.createDiv({ cls: "xz-analysis-path-impact" });
      impact.createSpan({ text: lens.impact });
      impact.createEl("small", { text: lens.impactDetail });
    }
  }

  if (model.filtered.count) {
    const filtered = card.createEl("details", { cls: "xz-analysis-path-filtered" });
    filtered.createEl("summary", { text: `查看已过滤的 ${model.filtered.count} 个候选透镜` });
    const list = filtered.createDiv({ cls: "xz-analysis-path-filtered__list" });
    for (const item of model.filtered.items) {
      const row = list.createDiv({ cls: "xz-analysis-path-filtered__item" });
      const itemTitle = row.createDiv();
      itemTitle.createEl("strong", { text: item.label });
      itemTitle.createSpan({ text: item.version });
      row.createEl("small", { text: item.reason });
    }
  }

  const measurements = card.createDiv({ cls: "xz-analysis-path-measurements" });
  renderMetric(measurements, "未解决分歧", model.disagreement.value);
  renderMetric(measurements, model.confidence.label, model.confidence.value);
  renderMetric(
    measurements,
    model.routingStrength.label,
    model.routingStrength.value,
    model.routingStrength.detail,
  );

  if (model.issues.count) {
    const issues = card.createDiv({ cls: "xz-analysis-path-issues" });
    issues.createEl("strong", { text: "Skill 状态" });
    const list = issues.createEl("ul");
    for (const issue of model.issues.items) list.createEl("li", { text: issue });
  }

  card.createDiv({ cls: "xz-analysis-path-provenance", text: model.provenance });
  return card;
}

module.exports = { renderTurnAnalysisPathCard };
