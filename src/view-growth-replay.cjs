"use strict";
const { Modal, Notice } = require("obsidian");
const { displayTime, statusLabel } = require("./growth-status.cjs");
class GrowthReplayModal extends Modal {
  constructor(plugin, updated) { super(plugin.app); this.plugin = plugin; this.updated = updated; this.selected = new Map(); }
  async onOpen() {
    this.modalEl.addClass("xz-cognitive-modal"); this.contentEl.createEl("h2", { text: "检查历史记录" });
    this.contentEl.createEl("p", { text: "选择起始日期和具体消息，每批最多 5 条。使用当前模型重新检查已保存的用户原话，可能产生模型费用；不保证生成成长事件。" });
    const range = this.contentEl.createEl("label", { cls: "xz-cognitive-field" }); range.createSpan({ text: "从哪一天开始" }); this.date = range.createEl("input", { attr: { type: "date" } }); this.date.value = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const show = this.contentEl.createEl("label", { cls: "xz-cognitive-checkbox" }); this.include = show.createEl("input", { attr: { type: "checkbox" } }); show.createSpan({ text: "包括已经完成检查的消息" });
    this.list = this.contentEl.createDiv({ cls: "xz-growth-replay-list" }); this.status = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
    this.date.onchange = this.include.onchange = () => void this.preview();
    this.run = this.contentEl.createEl("button", { cls: "mod-cta", text: "重新检查所选记录", attr: { type: "button" } }); this.run.onclick = () => void this.start();
    this.cancel = this.contentEl.createEl("button", { text: "停止后续处理", attr: { type: "button" } }); this.cancel.hidden = true; this.cancel.onclick = () => { this.plugin.cancelGrowthReplay(); this.status.textContent = "将在当前记录处理完后停止"; };
    await this.preview();
  }
  async preview() {
    if (this.busy) return; this.selected.clear(); this.list.empty(); this.run.disabled = true;
    try {
      const result = await this.plugin.getGrowthReplayPreview({ since: new Date(`${this.date.value}T00:00:00`).toISOString(), includeProcessed: this.include.checked });
      this.status.textContent = `找到 ${result.total} 条可选记录，显示最近 ${result.items.length} 条。`;
      for (const item of result.items) { const row = this.list.createEl("label", { cls: "xz-growth-replay-row" }); const input = row.createEl("input", { attr: { type: "checkbox" } }); const copy = row.createDiv(); copy.createEl("strong", { text: `${item.title} · ${displayTime(item.occurredAt)}` }); copy.createEl("p", { text: item.summary }); copy.createSpan({ text: statusLabel(item.previousStatus) }); const key = `${item.conversationId}:${item.sourceMessageId}`;
        input.onchange = () => { if (input.checked && this.selected.size >= 5) { input.checked = false; new Notice("每批最多选择 5 条记录"); return; } input.checked ? this.selected.set(key, item) : this.selected.delete(key); this.run.disabled = !this.selected.size; this.run.textContent = `重新检查所选 ${this.selected.size} 条记录`; };
      }
    } catch (error) { this.status.textContent = error.message; }
  }
  async start() {
    if (this.busy || !this.selected.size) return; this.busy = true; this.run.disabled = true; this.date.disabled = this.include.disabled = true; this.cancel.hidden = false;
    this.list.querySelectorAll("input").forEach(e => { e.disabled = true; }); this.status.textContent = "正在重新检查，请等待当前模型返回…";
    try { const result = await this.plugin.replayGrowthRecords([...this.selected.values()]); this.status.textContent = `本批已处理 ${result.completed}/${result.total} 条。` + result.results.map(r => statusLabel(r.status)).join("、"); await this.updated?.(); }
    catch (error) { this.status.textContent = error.message; }
    finally { this.busy = false; this.date.disabled = this.include.disabled = false; this.cancel.hidden = true; this.run.textContent = "重新选择日期以检查下一批"; }
  }
  onClose() { if (this.busy) this.plugin.cancelGrowthReplay(); }
}
module.exports = { GrowthReplayModal };
