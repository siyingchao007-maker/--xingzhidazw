"use strict";
const { EmbeddedCognitiveWorkspace } = require("./view-cognitive-home.cjs");
const { EmbeddedDailyWorkspace } = require("./view-action-center.cjs");
const { PAGES, applyChatArt } = require("./reference-ui.cjs");
const { Menu } = require("obsidian");

// A persistent conversation plus a lazily mounted business host. Navigation
// never changes the leaf type, rebuilds chat, or sends a model request.
class UnifiedWorkspace {
  constructor(owner, host) {
    this.owner = owner; this.host = host; this.page = "chat";
    this.closed = false; this.opening = null; this.cognitive = null; this.daily = null;
    this.body = host.createDiv({ cls: "xz-unified-page-body" });
    this.status = host.createEl("p", { cls: "xz-unified-page-status", attr: { role: "status", hidden: "" } });
    this.tools = host.createEl("nav", { cls: "xz-unified-page-tools", attr: { "aria-label": "页面工具" } });
    // Tools precede content in the DOM as well as visually.
    host.prepend(this.tools);
  }
  setVisibility(page) {
    const owner = this.owner, chat = page === "chat";
    if (this.page === "chat" && !chat) {
      this.chatScroll = owner.captureMessageScrollAnchor();
      this.chatConversationId = owner.getActiveConversation()?.id;
      this.chatFollowing = owner.messageScrollFollowLatest;
      owner.invalidateMessageScrollRestore();
    }
    this.page = page; owner.section = page;
    owner.refs.contextDetails?.removeAttribute("open");
    this.host.hidden = chat;
    owner.refs.workspace.toggleClass("is-business-page", !chat);
    owner.refs.messageStage.hidden = !chat; owner.refs.composer.hidden = !chat;
    for (const element of [owner.refs.messageStage, owner.refs.composer]) element.inert = !chat;
    owner.refs.contextStatus.hidden = !chat;
    for (const button of owner.refs.sidebar.querySelectorAll("[data-ui-page]")) {
      const selected = button.dataset.uiPage === (page === "action-center" ? "tune" : page);
      button.toggleAttribute("aria-current", selected);
      if (selected) button.setAttribute("aria-current", "page");
    }
    if (!chat) {
      const meta = PAGES.find(p => p.id === page);
      owner.refs.topicTitle.setText(meta?.label || "每日决策");
      owner.refs.topicTitle.setAttr("title", meta?.label || "每日决策");
      owner.refs.topicMeta.setText("同一工作台 · 对话和未发送内容已保留");
      owner.refs.topicBadges.empty();
    }
    if (owner.historyOpen) { owner.historyOpen = false; owner.syncResponsiveState(); }
  }
  showChat({ focus = true } = {}) {
    if (this.closed) return;
    const wasChat = this.page === "chat";
    this.setVisibility("chat");
    this.owner.renderState();
    if (!wasChat && this.chatConversationId === this.owner.getActiveConversation()?.id) {
      this.owner.messageScrollFollowLatest = this.chatFollowing;
      this.owner.applyMessageScrollAnchor(this.chatScroll, { followLatest: false });
    }
    if (focus) this.owner.refs.composerInput?.focus({ preventScroll: true });
  }
  async open(page) {
    if (this.closed) return;
    if (!PAGES.some(p => p.id === page && page !== "chat") && page !== "action-center") throw new Error("未知页面");
    this.setVisibility(page);
    this.renderTools(page);
    this.status.hidden = false; this.status.setText("正在读取本地页面…");
    try {
      // First mount is shared, so fast navigation cannot create duplicate
      // subscriptions or let an old asynchronous open replace the newer page.
      if (!this.opening) this.opening = this.mount(page).finally(() => { this.opening = null; });
      await this.opening;
      if (this.closed || this.page === "chat") return;
      const latest = this.page;
      if (latest === "action-center") {
        await this.ensureDaily();
        if (this.closed || this.page !== latest) return;
      } else {
        if (!this.cognitive) await this.ensureCognitive(latest);
        if (this.closed || this.page !== latest) return;
        this.cognitive.wbGo(latest);
      }
      this.renderTools(latest);
      if (latest !== "action-center") this.cognitive.wbRenderChrome();
      this.cognitiveHost && (this.cognitiveHost.hidden = latest === "action-center");
      this.dailyHost && (this.dailyHost.hidden = latest !== "action-center");
      applyChatArt(this.owner);
      this.status.hidden = true;
      this.body.querySelector("h1")?.focus?.({ preventScroll: true });
    } catch (error) {
      if (this.closed || this.page === "chat") return;
      this.status.setText(`页面未能完成读取：${error?.message || "未知错误"}。可切回对话，原输入未被删除。`);
      throw error;
    }
  }
  async mount(page) {
    if (page === "action-center") return this.ensureDaily();
    return this.ensureCognitive(page);
  }
  async ensureCognitive(page) {
    if (this.cognitive) return;
    this.cognitiveHost = this.body.createDiv({ cls: "xz-unified-cognitive-host" });
    const view = this.cognitive = new EmbeddedCognitiveWorkspace(this.cognitiveHost, this.owner.plugin);
    view.workbenchOwner = this.owner; view.wbPage = page;
    view.initialDrafts = this.owner.legacyCognitiveDrafts;
    this.owner.addChild(view);
    await view.setState(this.owner.cognitivePreferences || {});
    if (this.closed) return;
    await view.onOpen();
    if (this.closed) return;
    this.owner.legacyCognitiveDrafts = null;
  }
  async ensureDaily() {
    if (this.daily) return;
    this.dailyHost = this.body.createDiv({ cls: "xz-unified-daily-host" });
    this.daily = new EmbeddedDailyWorkspace(this.dailyHost, this.owner.plugin);
    this.owner.addChild(this.daily);
    await this.daily.onOpen();
  }
  renderTools(page) {
    this.alertButton = null;
    this.tools.empty();
    const add = (text, action) => {
      const b = this.tools.createEl("button", { text, attr: { type: "button" } });
      b.addEventListener("click", () => { Promise.resolve().then(action).catch(e => {
        this.status.hidden = false; this.status.setText(e?.message || "操作未完成");
      }); });
      return b;
    };
    add("返回对话", () => this.owner.navigate("chat"));
    if (this.owner.legacyWorkspaceDrafts?.length) {
      const restore = add("恢复旧页面草稿", () => {
        const menu = new Menu();
        this.owner.legacyWorkspaceDrafts.forEach((entry, index) => menu.addItem(item => item.setTitle(entry.label || `旧页面草稿 ${index + 1}`).onClick(async () => {
          if (!this.cognitive) await this.ensureCognitive("anchor");
          this.cognitive.restoreDrafts(entry.drafts);
          this.cognitive.buildLayout(); // Synchronize the form with restored state.
          await this.open(entry.drafts?.wbPerceiveDraft ? "perceive" : "anchor");
        })));
        menu.showAtPosition({ x: restore.getBoundingClientRect().left, y: restore.getBoundingClientRect().bottom });
      });
    }
    if (page === "tune" || page === "action-center") {
      this.owner.refs.actionButton = add("每日决策", () => this.owner.navigate("action-center"));
      this.owner.refs.growthButton = add("我的成长", () => this.owner.openUserGrowth());
    }
    if (page === "archive") {
      this.owner.refs.healthButton = add("知识中心", () => this.owner.openKnowledgeHealth());
      this.owner.refs.structureButton = add("知识结构", () => this.owner.openKnowledgeStructure());
    }
    if (this.cognitive && page !== "action-center") {
      this.alertButton = add("待确认与回看", () => this.cognitive.wbOpenAlerts());
      add("新建记录", () => this.cognitive.openNewMenu());
    }
  }
  async dispose() {
    this.closed = true;
    for (const view of [this.cognitive, this.daily]) if (view) {
      await view.onClose(); this.owner.removeChild(view);
    }
    this.cognitive = null; this.daily = null;
  }
}
module.exports = { UnifiedWorkspace };
