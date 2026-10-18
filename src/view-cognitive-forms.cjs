"use strict";
const { Modal, FuzzySuggestModal, Notice } = require("obsidian");
const { DECISIONS } = require("./cognitive-records.cjs");

class EvidencePicker extends FuzzySuggestModal {
  constructor(app, selected) { super(app); this.selected = selected; this.setPlaceholder("搜索要关联的依据笔记"); }
  getItems() { return this.app.vault.getMarkdownFiles().filter(f => /^(?:0[1-9]|11|12)_/u.test(f.path) && !f.path.endsWith("-索引.md")); }
  getItemText(file) { return `${file.basename} · ${file.parent?.name || ""}`; }
  onChooseItem(file) { this.selected(file.path, file.basename); }
}
class CognitiveRecordModal extends Modal {
  constructor(plugin, loop = null, onSaved = () => {}) { super(plugin.app); Object.assign(this, { plugin, loop, onSaved }); this.inputs = {}; this.sources = new Map(); this.busy = false; }
  field(parent, key, label, { required = false, type = "textarea", placeholder = "" } = {}) {
    const row = parent.createEl("label", { cls: "xz-cognitive-field" }); row.createSpan({ text: label + (required ? " *" : "") });
    const input = row.createEl(type === "textarea" ? "textarea" : "input", { attr: { ...(type === "textarea" ? { rows: "2" } : { type }), placeholder, ...(required ? { required: "" } : {}) } });
    this.inputs[key] = input; return input;
  }
  select(parent, key, label, options) {
    const row = parent.createEl("label", { cls: "xz-cognitive-field" }); row.createSpan({ text: label });
    const select = row.createEl("select");
    for (const [value, text] of options) select.createEl("option", { text, attr: { value } });
    this.inputs[key] = select; return select;
  }
  onOpen() {
    this.modalEl.addClass("xz-cognitive-modal"); this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.loop ? "记录实际反馈" : "从问题建立行动" });
    this.contentEl.createEl("p", { cls: "xz-cognitive-muted", text: this.loop ? `关联：${this.loop.title}。保留原判断，并用这次结果决定下一步。` : "把问题、当前判断、下一步和预期放在同一张记录中。" });
    const form = this.contentEl.createEl("form");
    if (this.loop) {
      const before = form.createDiv({ cls: "xz-cognitive-context" });
      before.createEl("p", { text: `原判断：${this.loop.judgment || "尚未形成"}` }); before.createEl("p", { text: `预期：${this.loop.expected}` });
      const latestSnapshot = this.loop.judgmentSnapshots?.at(-1);
      before.createEl("p", { cls: "xz-cognitive-muted", text: latestSnapshot
        ? `结果前快照：v${latestSnapshot.version} · ${latestSnapshot.confidence.level} 置信度 · ${latestSnapshot.capturedAt}`
        : "这是一条旧记录或未形成判断的记录，没有可追认的结果前判断快照。" });
      this.field(form, "actualAction", "实际做了什么", { required: true });
      this.field(form, "result", "观察到什么结果或反馈", { required: true });
      this.field(form, "userInterpretation", "你对结果的解释与其他可能解释");
      this.field(form, "impactOnJudgment", "这次结果对原判断有什么影响", { placeholder: "可以留空；结果好坏不会自动改变判断" });
      const row = form.createEl("label", { cls: "xz-cognitive-field" }); row.createSpan({ text: "下一步方向" });
      const select = row.createEl("select"); Object.entries(DECISIONS).forEach(([value, text]) => select.createEl("option", { text, attr: { value } })); select.value = "uncertain"; this.inputs.decision = select;
      this.field(form, "revisedJudgment", "如果需要修订判断，新的判断是什么", { placeholder: "留空表示保留原判断" });
      this.select(form, "revisedConfidenceLevel", "修订判断的置信度", [["unknown", "未知／暂不判断"], ["low", "低"], ["medium", "中"], ["high", "高"]]);
      this.field(form, "revisedConfidenceBasis", "修订置信度的依据");
      const calibration = form.createEl("details"); calibration.createEl("summary", { text: "判断校准与偏差来源（可选，需要本人确认）" });
      this.select(calibration, "calibrationStatus", "原判断的校准状态", [["", "暂不校准"], ["supported", "得到支持"], ["weakened", "被削弱"], ["falsified", "被证伪"], ["uncertain", "仍不确定"]]);
      this.field(calibration, "calibrationRationale", "校准依据", { placeholder: "说明预期、现实和证据之间的关系" });
      this.select(calibration, "decisionQuality", "当时判断质量", [["", "未知"], ["adequate", "当时信息下基本合理"], ["weak", "当时判断存在明显缺陷"]]);
      this.select(calibration, "predictionAccuracy", "预测准确度", [["", "未知"], ["accurate", "准确"], ["mixed", "部分准确"], ["inaccurate", "不准确"]]);
      this.select(calibration, "executionFidelity", "执行与原计划的一致性", [["", "未知"], ["aligned", "一致"], ["partial", "部分执行"], ["diverged", "明显偏离"]]);
      this.select(calibration, "environmentShift", "环境是否发生重要变化", [["", "未知"], ["none-observed", "未观察到重要变化"], ["material", "存在重要变化"]]);
      const confirmed = calibration.createEl("label", { cls: "xz-cognitive-checkbox" }); this.inputs.calibrationConfirmed = confirmed.createEl("input", { attr: { type: "checkbox" } }); confirmed.createSpan({ text: "确认以上校准是我的当前判断，并写入反馈记录" });
      this.field(form, "occurredAt", "实际发生时间", { type: "datetime-local" }).value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      const completed = form.createEl("label", { cls: "xz-cognitive-checkbox" }); this.inputs.completed = completed.createEl("input", { attr: { type: "checkbox" } }); completed.createSpan({ text: "这次行动已经完成（仅完成部分时不勾选）" });
    } else {
      this.field(form, "title", "这件事叫什么", { required: true, type: "text" });
      this.field(form, "problem", "当前要解决的问题", { required: true });
      this.field(form, "goal", "它服务于什么目标");
      this.field(form, "judgment", "当前判断", { placeholder: "尚未形成判断时可以留空" });
      this.field(form, "action", "下一步具体做什么", { required: true });
      this.field(form, "expected", "预期观察到什么", { required: true });
      const details = form.createEl("details"); details.createEl("summary", { text: "补充判断依据、验证信号和停止条件" });
      this.select(details, "confidenceLevel", "当前判断的置信度", [["unknown", "未知／暂不判断"], ["low", "低"], ["medium", "中"], ["high", "高"]]);
      this.field(details, "confidenceBasis", "置信度依据");
      this.field(details, "assumptions", "当前判断依赖的假设", { placeholder: "每行一项" });
      this.field(details, "unknowns", "当前仍不知道什么", { placeholder: "每行一项" });
      this.field(details, "hypothesis", "这项行动要验证的假设", { placeholder: "没有明确判断时，可以单独填写待验证假设" });
      this.field(details, "successSignal", "什么结果算支持预期");
      this.field(details, "failureSignal", "什么结果算没有达到预期");
      this.field(details, "observationWindow", "观察窗口", { placeholder: "例如：发布后七天" });
      this.field(details, "counterEvidence", "反证或关键未知"); this.field(details, "changeCondition", "什么新证据会改变判断");
      this.field(details, "reviewAt", "什么时候复查", { type: "date" }); this.field(details, "stopCondition", "什么情况下暂停或停止");
    }
    const evidence = form.createDiv({ cls: "xz-cognitive-evidence" }); evidence.createSpan({ text: "关联已有依据（可选）" });
    const selected = evidence.createDiv({ cls: "xz-cognitive-source-chips" });
    const drawSources = () => { selected.empty(); this.sources.forEach((title, path) => { const b = selected.createEl("button", { text: `${title} ×`, attr: { type: "button", "aria-label": `移除依据 ${title}` } }); b.onclick = () => { this.sources.delete(path); drawSources(); }; }); };
    const choose = evidence.createEl("button", { text: "选择依据笔记", attr: { type: "button" } }); choose.onclick = () => new EvidencePicker(this.app, (path, name) => { this.sources.set(path, name); drawSources(); }).open();
    this.errorEl = form.createEl("p", { cls: "xz-cognitive-error", attr: { role: "alert" } });
    const actions = form.createDiv({ cls: "xz-cognitive-actions" });
    this.submit = actions.createEl("button", { text: this.loop ? "保存反馈并更新关联记录" : "保存行动计划", cls: "mod-cta", attr: { type: "submit" } });
    const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } }); cancel.onclick = () => { if (!this.busy) this.close(); };
    form.addEventListener("submit", event => { event.preventDefault(); void this.save(); });
    this.contentEl.querySelector("input, textarea")?.focus();
  }
  async save() {
    if (this.busy) return;
    this.busy = true; this.submit.disabled = true; this.errorEl.textContent = "";
    try {
      const input = Object.fromEntries(Object.entries(this.inputs).map(([key, field]) => [key, field.type === "checkbox" ? field.checked : field.value]));
      input.evidencePaths = [...this.sources.keys()];
      const result = this.loop ? await this.plugin.recordCognitiveFeedback(this.loop.path, input, this.loop.hash) : await this.plugin.createCognitiveLoop(input);
      this.onSaved(result); this.close(); new Notice(this.loop ? "反馈已保存，关联行动与成长记录已更新" : "行动计划已保存，尚未标为完成");
    } catch (error) { this.errorEl.textContent = error.message || "保存失败，填写内容仍保留在表单中"; }
    finally { this.busy = false; this.submit.disabled = false; }
  }
}
module.exports = { CognitiveRecordModal, EvidencePicker };
