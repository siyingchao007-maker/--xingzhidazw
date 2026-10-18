"use strict";

const { Modal, FuzzySuggestModal, Notice } = require("obsidian");

function addButton(parent, label, action, { primary = false, id = "" } = {}) {
  const element = parent.createEl("button", { text: label, cls: primary ? "button primary" : "button", attr: { type: "button" } });
  if (id) element.dataset.action = id;
  element.addEventListener("click", () => Promise.resolve().then(action).catch(error => new Notice(error?.message || "操作未完成")));
  return element;
}

class HomeDialog extends Modal {
  constructor(home, title, render) { super(home.app); this.home = home; this.heading = title; this.renderContent = render; }
  onOpen() {
    this.contentEl.addClass("xz-home-modal");
    this.contentEl.createEl("h2", { text: this.heading });
    this.renderContent(this.contentEl, this);
  }
  onClose() { this.contentEl.empty(); }
}

function openList(home, title, records, { description = "", empty = "暂时没有相关记录。", choose } = {}) {
  new HomeDialog(home, title, (body, modal) => {
    if (description) body.createEl("p", { cls: "dialog-note", text: description });
    if (!records.length) body.createEl("p", { cls: "empty-text", text: empty });
    for (const record of records.slice(0, 100)) {
      const row = addButton(body, "", async () => { await choose(record); modal.close(); });
      row.addClass("dialog-list-button");
      row.createEl("strong", { text: record.title || "未命名记录" });
      const detail = record.summary || record.problem || record.reason;
      if (detail) row.createEl("small", { text: String(detail).slice(0, 250) });
    }
    if (records.length > 100) body.createEl("p", { cls: "dialog-note", text: "这里显示最近 100 条，请从知识库查看完整记录。" });
  }).open();
}

class HomeSearch extends FuzzySuggestModal {
  constructor(home) {
    super(home.app); this.home = home;
    this.setPlaceholder("搜索当前问题、目标与近期认知记录…");
  }
  getItems() {
    const model = this.home.model;
    return [...new Map([...model.loops, ...model.records].filter(item => item.path).map(item => [item.path, item])).values()];
  }
  getItemText(item) { return `${item.title || "未命名记录"} ${item.summary || item.problem || ""}`; }
  onChooseItem(item) { Promise.resolve(this.home.plugin.openVaultPath(item.path)).catch(error => new Notice(error.message)); }
}

function openQuestion(home, prefill = "") {
  const dialog = new HomeDialog(home, "此刻，你想理清什么？", (body, modal) => {
    body.createEl("p", { cls: "dialog-note", text: "从一个真实问题开始。会沿用当前模型、记忆范围和授权设置，进入行知对话继续分析。" });
    const label = body.createEl("label", { cls: "field", attr: { for: "xz-home-question" } });
    label.createSpan({ text: "写下当前问题、已知事实或正在犹豫的选择" });
    const input = label.createEl("textarea", { attr: { id: "xz-home-question", rows: "5", maxlength: "12000", placeholder: "我正在面对什么？什么还不确定？" } });
    input.value = prefill || home.questionDraft || "";
    input.addEventListener("input", () => { home.questionDraft = input.value; });
    const error = body.createEl("p", { cls: "form-error", attr: { role: "alert" } });
    const footer = body.createDiv({ cls: "dialog-actions" });
    addButton(footer, "稍后再想", () => modal.close());
    const send = addButton(footer, "开始分析", async () => {
      const content = input.value.trim();
      if (!content) { error.textContent = "请先写下一个具体问题。"; input.focus(); return; }
      send.disabled = true; error.textContent = "";
      try {
        await home.beginAnalysis(content);
        home.questionDraft = "";
        modal.close();
      } catch (failure) {
        error.textContent = failure?.message || "未能打开对话，问题内容已保留。";
        send.disabled = false;
      }
    }, { primary: true, id: "begin-analysis" });
    input.focus();
  });
  dialog.open();
}

function openPathGuide(home) {
  const steps = [
    ["P", "观境", "Place Yourself in Context", "此时此地，我身处何境，有何可为？"],
    ["A", "立心", "Anchor Your Choices", "我愿意走向哪里，什么值得我坚守和承担？"],
    ["T", "践真", "Take Action and Learn", "真正走进去后，现实与原来的理解是否一样？"],
    ["H", "知变", "Hone Your Judgment", "面对新的真实，什么应当改变，什么值得坚持？"],
  ];
  new HomeDialog(home, "观境 · 立心 · 践真 · 知变", body => {
    body.createEl("p", { cls: "dialog-note", text: "PATH 允许来回探索。它是一组可以反复调用的问题，不是固定进度，也没有必须解锁的关卡。" });
    for (const [letter, name, english, question] of steps) {
      const row = body.createDiv({ cls: "method-item" });
      row.createSpan({ cls: "method-letter", text: letter });
      const copy = row.createDiv(); copy.createEl("h3", { text: name });
      copy.createEl("small", { text: english }); copy.createEl("p", { text: question });
    }
  }).open();
}

function openFocus(home, loop) {
  if (!loop) { home.createAction(); return; }
  new HomeDialog(home, loop.title || "当前问题", (body, modal) => {
    body.createEl("p", { cls: "dialog-note", text: `记录状态：${home.statusLabel(loop.status)}。计划与实际结果分别保留。` });
    for (const [label, value] of [["当前问题", loop.problem], ["目前的判断", loop.judgment], ["下一步行动", loop.action], ["原有预期", loop.expected]]) {
      const section = body.createDiv({ cls: "dialog-section" });
      section.createEl("h3", { text: label }); section.createEl("p", { text: value || "尚未填写" });
    }
    if (loop.evidencePaths?.length) {
      const section = body.createDiv({ cls: "dialog-section" }); section.createEl("h3", { text: "关联依据" });
      for (const path of loop.evidencePaths.slice(0, 12)) addButton(section, path.split("/").at(-1), () => home.plugin.openVaultPath(path));
    }
    const footer = body.createDiv({ cls: "dialog-actions" });
    if (home.preferences.selectedLoopId !== loop.id) addButton(footer, "设为当前关注", () => { home.setPreference({ selectedLoopId: loop.id }); modal.close(); }, { id: "choose-focus" });
    addButton(footer, "查看完整记录", () => home.plugin.openVaultPath(loop.path));
    addButton(footer, "记录真实反馈", () => { modal.close(); home.createAction(loop); }, { primary: true, id: "feedback" });
  }).open();
}

function openConfirmations(home) {
  openList(home, "待你确认的理解与写入", home.model.pending, {
    description: "这些内容仍待确认。打开来源对话，查看完整依据、写入范围与审核选项。",
    empty: "目前没有等待确认的内容。",
    choose: async item => {
      await home.plugin.selectConversation(item.conversationId);
      await home.plugin.activateWorkbench("chat");
    },
  });
}

module.exports = { HomeDialog, HomeSearch, addButton, openList, openQuestion, openPathGuide, openFocus, openConfirmations };