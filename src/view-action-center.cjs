"use strict";

const { Component, ItemView } = require("obsidian");
const { watchDailyReview } = require("./view-daily-refresh.cjs");
const {
  DailyReviewViewController,
  renderDailyReviewDashboard,
} = require("./view-daily-review.cjs");

// Keep the historical view type so saved Obsidian workspace layouts can still
// reopen this leaf after the user-visible Action List has been removed.
const VIEW_TYPE_XINGZHI_ACTION_CENTER = "xingzhi-action-center";

function dailyWorkspaceClass(Base) { return class DailyWorkspace extends Base {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.unsubscribe = null;
    this.dailyReview = new DailyReviewViewController(plugin, () => this.render());
  }

  getViewType() {
    return VIEW_TYPE_XINGZHI_ACTION_CENTER;
  }

  getDisplayText() {
    return "每日决策";
  }

  getIcon() {
    return "calendar-check-2";
  }

  async onOpen() {
    this.dailyClosed = false;
    this.contentEl.addClass("xz-action-center");
    this.render({ preserveScroll: false });
    this.unsubscribe = this.plugin?.subscribe?.(() => this.render()) || null;
    this.stopDailyRefresh = watchDailyReview(this, this.plugin, () => this.render());
  }

  async onClose() {
    this.dailyClosed = true;
    this.stopDailyRefresh?.();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.contentEl.removeClass("xz-action-center");
  }

  render({ preserveScroll = true } = {}) {
    const scrollTop = preserveScroll ? this.contentEl.scrollTop : 0;
    this.contentEl.empty();
    this.contentEl.addClass("xz-action-center");

    const page = this.contentEl.createDiv({ cls: "xz-action-page xz-action-center-page" });
    const header = page.createEl("header", {
      cls: "xz-action-header xz-action-center-header",
      attr: { "aria-label": "每日决策" },
    });
    const copy = header.createDiv({ cls: "xz-action-center-copy" });
    copy.createSpan({ cls: "xz-action-kicker", text: "本地知识回顾 · 按日期与记录变化刷新" });
    copy.createEl("h1", { text: "每日决策" });
    copy.createEl("p", {
      text: "检索知识、计划与推进记录，生成可追溯的今日判断；结果只供阅读和确认。",
    });

    renderDailyReviewDashboard(page, {
      state: this.dailyReview.state(),
      busy: this.dailyReview.busy,
      planLevel: this.dailyReview.planLevel,
      expandedCardIds: this.dailyReview.expandedCardIds,
      onGenerate: () => this.dailyReview.run(
        () => this.plugin.generateDailyReview(),
        "每日回顾已生成",
      ),
      onSave: () => {
        const reviewId = this.dailyReview.state().draft?.id;
        if (!reviewId) return;
        void this.dailyReview.run(
          () => this.plugin.saveDailyReviewSnapshot(reviewId),
          "本次每日回顾已保存",
        );
      },
      onOpenSource: (path) => this.dailyReview.openSource(path),
      onPlanLevelChange: (level) => this.dailyReview.selectPlanLevel(level),
      onToggleCard: (cardId) => this.dailyReview.toggleCard(cardId),
    });

    if (preserveScroll) this.contentEl.scrollTop = scrollTop;
  }
}; }
class XingzhiActionCenterView extends dailyWorkspaceClass(ItemView) {
  async onOpen() {
    this.dailyClosed = false;
    this.contentEl.createEl("p", { text: "正在恢复每日决策工作区…", attr: { role: "status" } });
    this.redirectTimer = setTimeout(() => {
      if (!this.dailyClosed) void this.plugin.migrateLegacyWorkspaces().catch(() => {});
    }, 0);
  }
  async onClose() { clearTimeout(this.redirectTimer); await super.onClose(); }
}
class DailyComponentHost extends Component {
  constructor(contentHost) { super(); this.contentEl = contentHost; }
  onunload() { if (!this.dailyClosed) void this.onClose(); }
}
const EmbeddedDailyWorkspace = dailyWorkspaceClass(DailyComponentHost);

module.exports = {
  VIEW_TYPE_XINGZHI_ACTION_CENTER,
  XingzhiActionCenterView,
  EmbeddedDailyWorkspace,
};
