"use strict";

const { Notice, setIcon } = require("obsidian");

const STATUS_LABELS = Object.freeze({
  configured: "已配置",
  missing: "未配置",
  "not-required": "不需要",
  authorized: "已授权",
  locked: "未授权",
  connected: "已连接",
  connecting: "检测中",
  idle: "未检测",
  error: "异常",
  ready: "可用",
  unknown: "未知",
  unverified: "认证未验证",
  "requires-login": "需要重新登录",
  succeeded: "成功",
  failed: "失败",
  "timed-out": "超时",
  cancelled: "已停止",
  started: "进行中",
  unsupported: "不支持",
});

function labelForStatus(value) {
  return STATUS_LABELS[value] || value || "未知";
}

function formatTimestamp(value) {
  if (!value) return "尚无记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "尚无记录";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}

function statusClass(status) {
  if (["configured", "authorized", "connected", "ready", "succeeded", "not-required"].includes(status)) {
    return "is-ready";
  }
  if (["missing", "locked", "error", "failed", "timed-out", "requires-login"].includes(status)) return "is-error";
  if (status === "connecting") return "is-warning";
  return "is-neutral";
}

function createStatusRow(parent, label, value, detail = null) {
  const row = parent.createDiv({ cls: "xz-diagnostic-status-row" });
  row.createSpan({ cls: "xz-diagnostic-status-label", text: label });
  const copy = row.createDiv({ cls: "xz-diagnostic-status-value" });
  copy.createSpan({ cls: `xz-status-chip ${statusClass(value)}`, text: labelForStatus(value) });
  if (detail) copy.createEl("small", { text: detail });
  return row;
}

class ConnectionDiagnosticsPanel {
  constructor(options) {
    this.plugin = options.plugin;
    this.onClose = options.onClose;
    this.opened = false;

    this.scrim = options.root.createDiv({ cls: "xz-maintenance-scrim", attr: { hidden: "" } });
    this.scrim.addEventListener("click", () => this.close());
    this.drawer = options.root.createEl("aside", {
      cls: "xz-maintenance-drawer xz-connection-diagnostics",
      attr: {
        hidden: "",
        role: "dialog",
        "aria-modal": "false",
        "aria-labelledby": "xz-connection-diagnostics-title",
      },
    });
    const header = this.drawer.createDiv({ cls: "xz-maintenance-header" });
    const heading = header.createDiv();
    heading.createEl("span", { cls: "xz-eyebrow", text: "运行状态" });
    heading.createEl("h2", { text: "连接诊断", attr: { id: "xz-connection-diagnostics-title" } });
    this.closeButton = header.createEl("button", {
      cls: "xz-icon-button",
      attr: { type: "button", title: "关闭连接诊断", "aria-label": "关闭连接诊断" },
    });
    setIcon(this.closeButton, "x");
    this.closeButton.addEventListener("click", () => this.close());
    this.body = this.drawer.createDiv({ cls: "xz-maintenance-body" });
  }

  open() {
    this.opened = true;
    this.render();
    this.scrim.removeAttribute("hidden");
    this.drawer.removeAttribute("hidden");
    this.closeButton.focus();
  }

  close() {
    const wasOpen = this.opened;
    this.opened = false;
    this.scrim.setAttr("hidden", "");
    this.drawer.setAttr("hidden", "");
    if (wasOpen) this.onClose?.();
  }

  render() {
    if (!this.opened) return;
    this.body.empty();
    const intro = this.body.createEl("section", { cls: "xz-maintenance-intro" });
    intro.createEl("p", {
      text: "这里分别检查凭据、外部发送授权、端点连接和模型能力。重新检测只读取模型与 Skill 能力，不发送收费对话。",
    });
    let diagnostics = [];
    try {
      diagnostics = typeof this.plugin?.getConnectionDiagnostics === "function"
        ? this.plugin.getConnectionDiagnostics()
        : [];
    } catch (error) {
      intro.createEl("p", { cls: "xz-maintenance-error", text: error?.message || "连接状态读取失败" });
    }
    if (!diagnostics.length) {
      this.body.createEl("p", { cls: "xz-maintenance-empty", text: "当前没有可诊断的模型提供商。" });
      return;
    }

    const cards = this.body.createDiv({ cls: "xz-diagnostic-card-list" });
    diagnostics.forEach((diagnostic) => {
      const card = cards.createEl("section", { cls: "xz-diagnostic-card" });
      const head = card.createDiv({ cls: "xz-diagnostic-card-head" });
      const title = head.createDiv();
      title.createEl("h3", { text: diagnostic.label || diagnostic.providerId });
      title.createEl("small", { text: diagnostic.protocol || "未知协议" });
      const retry = head.createEl("button", {
        cls: "xz-secondary-button xz-diagnostic-retry",
        text: "重新检测",
        attr: { type: "button" },
      });
      retry.disabled = typeof this.plugin?.diagnoseProvider !== "function";
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        retry.setText("检测中…");
        try {
          await this.plugin.diagnoseProvider(diagnostic.providerId);
          new Notice(`${diagnostic.label || diagnostic.providerId} 检测完成`);
        } catch (error) {
          new Notice(`${diagnostic.label || diagnostic.providerId} 检测失败：${error?.message || "未知错误"}`);
        } finally {
          this.render();
        }
      });

      const statuses = card.createDiv({ cls: "xz-diagnostic-statuses" });
      createStatusRow(statuses, "凭据", diagnostic.credential?.status,
        diagnostic.credential?.source ? `来源：${diagnostic.credential.source}` : null);
      createStatusRow(statuses, "外部发送授权", diagnostic.authorization?.status);
      createStatusRow(statuses, "端点连接", diagnostic.connection?.status);
      createStatusRow(statuses, "模型能力", diagnostic.model?.status,
        diagnostic.model?.id ? `当前模型：${diagnostic.model.id}` : `发现模型：${diagnostic.model?.count || 0} 个`);
      createStatusRow(statuses, "最近真实回合", diagnostic.turn?.status,
        diagnostic.turn?.at
          ? `${formatTimestamp(diagnostic.turn.at)}${Number.isFinite(diagnostic.turn.latencyMs) ? ` · ${diagnostic.turn.latencyMs} ms` : ""}`
          : "尚无真实对话记录");
      createStatusRow(statuses, "模型发现", diagnostic.model?.discoveryStatus,
        diagnostic.model?.count ? `已读取 ${diagnostic.model.count} 个模型` : null);

      const metrics = card.createEl("dl", { cls: "xz-diagnostic-metrics" });
      [
        ["最近尝试", formatTimestamp(diagnostic.lastAttemptAt)],
        ["最近成功", formatTimestamp(diagnostic.lastSuccessAt)],
        ["最近延迟", Number.isFinite(diagnostic.latencyMs) ? `${diagnostic.latencyMs} ms` : "尚无记录"],
        ["连续失败", String(diagnostic.consecutiveFailures || 0)],
      ].forEach(([label, value]) => {
        metrics.createEl("dt", { text: label });
        metrics.createEl("dd", { text: value });
      });
      if (diagnostic.failure) {
        const failure = card.createDiv({ cls: "xz-diagnostic-failure" });
        failure.createEl("strong", { text: `失败阶段：${diagnostic.failure.phase || "未知"}` });
        failure.createEl("p", { text: diagnostic.failure.message || "未提供失败原因" });
      }
    });
  }
}

module.exports = { ConnectionDiagnosticsPanel };
