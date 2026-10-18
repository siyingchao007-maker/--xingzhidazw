"use strict";
const { isInternalSkill, normalizedSkillType } = require("./capability-surface.cjs");
const { getReasoningOperator } = require("./reasoning-operator-registry.cjs");
const { SKILL_MODE_LABELS } = require("./skill-call-state.cjs");

const { Modal, Notice } = require("obsidian");

const SKILL_MODE_OPTIONS = Object.freeze([
  Object.freeze({ id: "auto", label: "被动建议", hint: "系统可匹配简短方法候选，但不会加载完整 Skill 正文，也不会让模板接管回答。明确点名或设为“仅下一轮”才会完整调用。从推荐/手动切到此模式后，已有固定调用会降为被动候选，这是预期行为。" }),
  Object.freeze({ id: "recommend", label: "先推荐后调用", hint: "系统新推荐的 Skill 会先展示给你确认；你已固定到本对话的 Skill 属于明确选择，每轮直接加载完整正文，不再重复确认。从自动模式切来时，已有固定候选会升级为固定调用，这是预期行为。" }),
  Object.freeze({ id: "manual", label: "完全手动", hint: "只按你的明确选择加载完整 Skill 正文；固定项每轮调用，下一轮项只调用一次。从自动模式切来时，已有固定候选会升级为固定调用，这是预期行为。" }),
].map(option => Object.freeze({ ...option, label: SKILL_MODE_LABELS[option.id] })));

const CONTROLLED_MODE_HINTS = Object.freeze({
  auto: "开启按需加载时，模型每轮最多选一个主 Skill；固定候选只作优先参考，已有固定调用保留。",
  recommend: "新推荐需确认；已固定调用按明确选择执行，固定候选保留。",
  manual: "只调用明确固定或仅下一轮的方法；固定候选保留。",
});

// Skill 按 PATH 四阶段归组，让 14 条不再平铺成一面墙。
// 未登记的 Skill 落到「其他能力」，新增 Skill 不会消失。
const SKILL_GROUPS = Object.freeze([
  Object.freeze({ title: "观境", note: "看清当前处境", ids: Object.freeze([
    "xingzhi-current-state-synthesis", "xingzhi-document-synthesis", "xingzhi-multi-perspective",
  ]) }),
  Object.freeze({ title: "立心", note: "定方向与判断", ids: Object.freeze([
    "xingzhi-judgment-calibration", "xingzhi-career-path-validation",
    "xingzhi-product-business-validation", "xingzhi-personal-business-opportunity-audit",
    "adaptive-sales-coach",
  ]) }),
  Object.freeze({ title: "践真", note: "推动行动落地", ids: Object.freeze([
    "xingzhi-path-runtime", "xingzhi-training-response", "xingzhi-action-feedback",
  ]) }),
  Object.freeze({ title: "知变", note: "复盘与沉淀", ids: Object.freeze([
    "xingzhi-periodic-review", "xingzhi-knowledge-organization", "xingzhi-knowledge-packaging",
  ]) }),
]);

const CHOICE_OPTIONS = Object.freeze([
  Object.freeze({ id: "automatic", short: "自动", lensShort: "按需" }),
  Object.freeze({ id: "fixed", short: "固定", title: "固定到本对话" }),
  Object.freeze({ id: "next", short: "下一轮", title: "仅下一轮使用" }),
  Object.freeze({ id: "disabled", short: "禁用", title: "本对话禁用" }),
]);

function operatorLabels(skill) {
  const ids = Array.isArray(skill?.recommendedOperators) ? skill.recommendedOperators
    : Array.isArray(skill?.operatorIds) ? skill.operatorIds : [];
  return [...new Set(ids.map((id) => {
    const operator = getReasoningOperator(String(id || "").trim());
    return String(operator?.label || "").trim();
  }).filter(Boolean))];
}

function normalizedNames(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean))];
}

function skillId(skill) {
  return String(skill?.name || skill?.id || "").trim();
}

function skillLabel(skill, fallback) {
  return String(skill?.displayName || skill?.label || skill?.title || fallback || "Skill").trim();
}

class XingzhiSkillPickerModal extends Modal {
  constructor(app, options = {}) {
    super(app);
    this.category = options.category === "lens" ? "lens" : "skill";
    this.skillMode = SKILL_MODE_OPTIONS.some((item) => item.id === options.skillMode)
      ? options.skillMode : "auto";
    this.skills = Array.isArray(options.skills) ? options.skills : [];
    this.skillPreferenceSchemaVersion = options.skillPreferenceSchemaVersion === 2 ? 2 : null;
    this.fixedCandidateIds = new Set(normalizedNames(options.fixedCandidateIds));
    this.fixedInvocationIds = new Set(normalizedNames(options.fixedInvocationIds));
    this.controlledSkillLoading = options.controlledSkillLoading === true;
    this.skillChoiceRows = [];
    this.selectedSkills = new Set(normalizedNames(options.selectedSkills));
    this.disabledSkills = new Set(normalizedNames(options.disabledSkills));
    this.nextTurnSkills = new Set(normalizedNames(options.nextTurnSkills));
    this.locked = options.locked === true;
    this.onSave = typeof options.onSave === "function" ? options.onSave : async () => {};
  }

  onOpen() {
    const lens = this.category === "lens";
    this.modalEl.addClass("xz-skill-picker-modal");
    if (lens) this.modalEl.addClass("is-lens");
    this.titleEl.setText(lens ? "选择认知透镜" : "选择本轮 Skill");

    this.contentEl.createEl("p", {
      cls: `xz-skill-picker-status${this.locked ? " is-locked" : ""}`,
      text: this.locked
        ? "当前回复正在进行，设置仅供查看；回复结束后可修改。"
        : "设置会作用于当前对话；“仅下一轮使用”会在下一条消息发送后自动清除。",
      attr: { role: "status" },
    });

    if (!lens) {
      const modeGroup = this.contentEl.createEl("fieldset", { cls: "xz-skill-mode-group" });
      modeGroup.createEl("legend", { text: "调用方式" });
      const track = modeGroup.createDiv({ cls: "xz-skill-mode-track" });
      const hint = this.contentEl.createEl("p", { cls: "xz-skill-mode-hint" });
      const paintHint = () => {
        const active = SKILL_MODE_OPTIONS.find((item) => item.id === this.skillMode);
        hint.setText(active ? this._modeHint(active) : "");
      };
      for (const mode of SKILL_MODE_OPTIONS) {
        const row = track.createEl("label", { cls: "xz-skill-mode-card", attr: { title: this._modeHint(mode) } });
        const input = row.createEl("input", {
          attr: { type: "radio", name: "xz-skill-modal-mode", value: mode.id },
        });
        input.checked = this.skillMode === mode.id;
        input.disabled = this.locked;
        row.createSpan({ text: mode.label });
        input.addEventListener("change", () => {
          if (!input.checked) return;
          this.skillMode = mode.id;
          paintHint();
          this._paintModeChoices();
          this._paintSummary();
        });
      }
      paintHint();
      if (this.skillPreferenceSchemaVersion === 2) {
        const controlled = modeGroup.createEl("label", { cls: "xz-skill-picker-help" });
        const input = controlled.createEl("input", {
          attr: { type: "checkbox", name: "xz-controlled-skill-loading", "aria-label": "允许按需加载主 Skill" },
        });
        input.checked = this.controlledSkillLoading;
        input.disabled = this.locked;
        controlled.createSpan({ text: "允许按需加载主 Skill" });
        modeGroup.createEl("p", { cls: "xz-skill-picker-help", text: "被动模式适用时，每轮最多加载一个。关闭后保留简短候选。" });
        input.addEventListener("change", () => {
          this.controlledSkillLoading = input.checked;
          this._paintSummary();
        });
      }
    } else {
      const lensHelp = this.skillMode === "auto"
        ? "自动/按需状态下，透镜只作被动候选；即使固定到本对话也不会加载完整正文。设为“仅下一轮”时才完整调用一次。"
        : this.skillMode === "recommend"
          ? "你已固定到本对话的透镜属于明确选择，每轮完整调用，不再重复确认；系统新推荐的透镜仍需你确认。设为“仅下一轮”则只调用本轮。"
          : "你固定到本对话的透镜会在每轮完整调用；设为“仅下一轮”则只调用本轮。未选择的透镜保持被动候选。";
      this.contentEl.createEl("p", {
        cls: "xz-skill-picker-help",
        text: this.skillPreferenceSchemaVersion === 2
          ? "固定候选与固定调用独立保留，切换模式不改变它们的含义。透镜不参与主 Skill 的按需加载。"
          : lensHelp,
      });
    }

    const section = this.contentEl.createEl("section", { cls: "xz-skill-selection-section" });
    const availableSkills = this.skills.filter((skill) => skillId(skill) && !isInternalSkill(skill)
      && (normalizedSkillType(skill) === "cognitive-lens") === lens);
    section.createEl("h3", {
      text: `${lens ? "可用透镜" : "可用 Skill"}（${availableSkills.length}）`,
    });
    section.createEl("p", {
      cls: "xz-skill-picker-help",
      text: this.skillPreferenceSchemaVersion === 2
        ? "固定候选与固定调用分别保存；禁用优先，“下一轮”只调用一次。"
        : lens
        ? this.skillMode === "auto"
          ? "每个透镜只能处于一种状态；自动与固定候选都不会加载完整正文，只有“下一轮”会完整调用一次。"
          : this.skillMode === "recommend"
            ? "每个透镜只能处于一种状态；明确固定的透镜每轮调用，系统新推荐项仍需确认，“下一轮”只调用一次。"
            : "每个透镜只能处于一种状态；明确固定的透镜每轮调用，“下一轮”只调用一次。"
        : "每个 Skill 只能处于一种状态；选「自动」即按上面的被动建议方式处理。",
    });
    const list = section.createDiv({ cls: "xz-skill-modal-list" });
    if (!availableSkills.length) {
      list.createEl("p", { cls: "xz-skill-modal-empty", text: `尚未读取到可用${lens ? "透镜" : " Skill"}，请先运行连接诊断。` });
    } else if (lens) {
      for (const skill of availableSkills) this._renderSkill(list, skill);
    } else {
      const remaining = new Map(availableSkills.map((skill) => [skillId(skill), skill]));
      for (const group of SKILL_GROUPS) {
        const members = group.ids.map((id) => remaining.get(id)).filter(Boolean);
        if (!members.length) continue;
        for (const member of members) remaining.delete(skillId(member));
        const heading = list.createEl("p", { cls: "xz-skill-modal-group-label", text: group.title });
        heading.createSpan({ text: group.note });
        for (const skill of members) this._renderSkill(list, skill);
      }
      if (remaining.size) {
        const heading = list.createEl("p", { cls: "xz-skill-modal-group-label", text: "其他能力" });
        heading.createSpan({ text: "未归入 PATH 阶段" });
        for (const skill of remaining.values()) this._renderSkill(list, skill);
      }
    }

    this.summaryEl = this.contentEl.createEl("p", { cls: "xz-skill-picker-summary" });
    this._paintSummary();

    const actions = this.contentEl.createDiv({ cls: "modal-button-container xz-skill-modal-actions" });
    const cancel = actions.createEl("button", {
      text: this.locked ? "关闭" : "取消",
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => this.close());
    const save = actions.createEl("button", {
      cls: "mod-cta",
      text: lens ? "保存透镜设置" : "保存 Skill 设置",
      attr: { type: "button" },
    });
    save.disabled = this.locked;
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await this.onSave({
          skillMode: this.skillMode,
          selectedSkills: this.skillPreferenceSchemaVersion === 2
            ? [...new Set([...this.fixedCandidateIds, ...this.fixedInvocationIds])] : [...this.selectedSkills],
          disabledSkills: [...this.disabledSkills],
          nextTurnSkills: [...this.nextTurnSkills],
          ...(this.skillPreferenceSchemaVersion === 2 ? {
            skillPreferenceSchemaVersion: 2,
            fixedCandidateIds: [...this.fixedCandidateIds],
            fixedInvocationIds: [...this.fixedInvocationIds],
            controlledSkillLoading: this.controlledSkillLoading,
          } : {}),
        });
        this.close();
      } catch (error) {
        save.disabled = false;
        new Notice(`${lens ? "透镜" : "Skill"}设置保存失败：${String(error?.message || error || "未知错误")}`);
      }
    });
    setTimeout(() => (this.locked ? cancel : this.contentEl.querySelector("input:not(:disabled)"))?.focus(), 0);
  }

  _paintSummary() {
    if (!this.summaryEl) return;
    const lens = this.category === "lens";
    const noun = lens ? "透镜" : "Skill";
    this.summaryEl.empty();
    const parts = [
      ...(this.skillPreferenceSchemaVersion === 2 ? [
        ["固定候选", this.fixedCandidateIds.size], ["固定调用", this.fixedInvocationIds.size],
      ] : [
      [this.skillMode === "auto" ? "固定候选" : "固定调用", this.selectedSkills.size],
      ]),
      ["下一轮完整调用", this.nextTurnSkills.size],
      ["禁用", this.disabledSkills.size],
    ].filter(([, count]) => count > 0);
    if (!parts.length) {
      if (this.skillPreferenceSchemaVersion === 2) {
        this.summaryEl.setText(this.skillMode === "auto" && this.controlledSkillLoading && !lens
          ? "当前没有固定项；模型可按需加载一个适用的主 Skill，也可以直接回答。"
          : "当前没有固定项；按当前调用方式处理。");
        return;
      }
      this.summaryEl.setText(lens
        ? this.skillMode === "auto"
          ? "当前没有手动设置：透镜作为被动候选，不加载完整正文。"
          : this.skillMode === "recommend"
            ? "当前没有固定透镜；系统新推荐的透镜会先等你确认。"
            : "当前没有固定透镜；手动模式下不会加载透镜正文。"
        : this.skillMode === "auto"
          ? "当前没有手动设置：系统只提供被动候选，不加载完整 Skill 正文。"
          : "当前没有手动设置，Skill 按上面的调用方式处理。");
      return;
    }
    this.summaryEl.createSpan({ text: `本对话${noun}设置：` });
    for (const [label, count] of parts) {
      const item = this.summaryEl.createSpan({ text: `${label} ` });
      item.createEl("b", { text: String(count) });
    }
  }

  _choicePresentation(optionId, lens) {
    if (optionId === "automatic") {
      if (this.skillMode === "manual") {
        return {
          short: "不调用",
          title: "手动模式下，未明确固定或设为下一轮时不调用此能力。",
        };
      }
      if (this.skillMode === "recommend") {
        return {
          short: "推荐候选",
          title: `系统新推荐的${lens ? "透镜" : "Skill"}会先等你确认；确认前不加载完整正文。`,
        };
      }
      return {
        short: lens ? "按需" : "自动",
        title: this.skillPreferenceSchemaVersion === 2 && !lens
          ? "作为默认候选；允许按需加载时，模型可选择一个适用主 Skill。"
          : lens ? "作为被动透镜候选；不加载完整正文。" : "作为被动候选；不加载完整 Skill 正文。",
      };
    }
    if (optionId === "fixed") {
      if (this.skillMode === "auto") {
        return {
          short: "固定候选",
          title: this.skillPreferenceSchemaVersion === 2
            ? "固定为优先参考候选；不等于固定调用。"
            : `固定为本对话被动候选；不会加载完整${lens ? "透镜" : "Skill"}正文。`,
        };
      }
      if (this.skillMode === "recommend") {
        return {
          short: "固定调用",
          title: `明确固定到本对话；每轮完整调用。系统新推荐的${lens ? "透镜" : "Skill"}仍需确认。`,
        };
      }
      return {
        short: "固定调用",
        title: `明确固定到本对话；每轮加载完整${lens ? "透镜" : "Skill"}正文。`,
      };
    }
    if (optionId === "next") {
      return {
        short: "下一轮",
        title: `仅下一轮完整调用${lens ? "对应透镜方法" : "完整 Skill 正文"}。`,
      };
    }
    return {
      short: "禁用",
      title: "本对话禁用",
    };
  }

  _paintModeChoices() {
    const lens = this.category === "lens";
    this.contentEl.querySelectorAll("label[data-choice]").forEach((label) => {
      const optionId = String(label.getAttribute("data-choice") || "");
      const presentation = this._choicePresentation(optionId, lens);
      label.setAttr("title", presentation.title);
      const text = label.querySelector("[data-choice-label]");
      if (text) text.setText(presentation.short);
    });
    if (this.skillPreferenceSchemaVersion === 2) {
      for (const row of this.skillChoiceRows) this._paintSkillChoice(row);
    }
  }

  _modeHint(mode) {
    return this.skillPreferenceSchemaVersion === 2 ? CONTROLLED_MODE_HINTS[mode.id] : mode.hint;
  }

  _activeFixedSkills() {
    return this.skillPreferenceSchemaVersion === 2
      ? this.skillMode === "auto" ? this.fixedCandidateIds : this.fixedInvocationIds
      : this.selectedSkills;
  }

  _currentChoice(id) {
    return this.disabledSkills.has(id) ? "disabled" : this._activeFixedSkills().has(id) ? "fixed"
      : this.nextTurnSkills.has(id) ? "next" : "automatic";
  }

  _paintSkillChoice(row) {
    const state = this._currentChoice(row.id);
    row.card.toggleClass("is-active", state === "fixed" || state === "next");
    row.card.toggleClass("is-off", state === "disabled");
    for (const [id, input] of row.inputs) input.checked = state === id;
    if (row.otherEl) {
      const candidates = this.skillMode !== "auto";
      const stored = candidates ? this.fixedCandidateIds : this.fixedInvocationIds;
      row.otherEl.setText(!stored.has(row.id) ? "" : this.disabledSkills.has(row.id)
        ? `保留${candidates ? "固定候选" : "固定调用"}设置，当前已禁用；切换模式可修改。`
        : candidates
        ? "另有固定候选；切换到被动模式可修改。"
        : "已设固定调用；仍按明确选择调用，切换到手动模式可修改。" );
    }
  }

  _renderSkill(parent, skill) {
    const id = skillId(skill);
    const lens = this.category === "lens";
    const card = parent.createEl("article", { cls: "xz-skill-modal-item" });
    const header = card.createDiv({ cls: "xz-skill-modal-item-header" });
    header.createEl("strong", { text: skillLabel(skill, id) });
    const description = String(skill?.description || skill?.summary || "").trim();
    if (description) header.createEl("p", { text: description });
    if (lens) {
      for (const label of operatorLabels(skill)) {
        header.createSpan({ cls: "xz-skill-modal-item-operator", text: label });
      }
    }
    // 「尚未启用」对用户没意义：选中保存时会自动启用，所以这里说清楚结果而不是当前状态。
    // 真正用不了的（Codex 没发现、版本不可用）才保留警告样式。
    if (skill?.enabled === false && skill?.unavailableReason) {
      const pending = String(skill.unavailableReason) === "扩展能力尚未启用";
      header.createEl("span", {
        cls: pending ? "xz-skill-pending-enable" : "xz-skill-unavailable",
        text: pending ? "选中后自动启用" : String(skill.unavailableReason),
      });
    }

    const otherEl = this.skillPreferenceSchemaVersion === 2
      ? header.createEl("p", { cls: "xz-skill-picker-help" }) : null;
    const choices = card.createDiv({ cls: "xz-skill-choice-grid" });
    const current = this._currentChoice(id);
    const choiceRow = { id, card, otherEl, inputs: new Map() };
    const paintCard = (state) => {
      card.toggleClass("is-active", state === "fixed" || state === "next");
      card.toggleClass("is-off", state === "disabled");
    };
    paintCard(current);
    for (const option of CHOICE_OPTIONS) {
      const presentation = this._choicePresentation(option.id, lens);
      const label = choices.createEl("label", {
        attr: { "data-choice": option.id, title: presentation.title },
      });
      const input = label.createEl("input", {
        attr: { type: "radio", name: `xz-skill-choice-${id}`, value: option.id },
      });
      input.checked = current === option.id;
      input.disabled = this.locked;
      choiceRow.inputs.set(option.id, input);
      label.createSpan({ attr: { "data-choice-label": "true" }, text: presentation.short });
      input.addEventListener("change", () => {
        if (!input.checked) return;
        this._activeFixedSkills().delete(id);
        this.disabledSkills.delete(id);
        this.nextTurnSkills.delete(id);
        if (option.id === "fixed") this._activeFixedSkills().add(id);
        else if (option.id === "disabled") this.disabledSkills.add(id);
        else if (option.id === "next") this.nextTurnSkills.add(id);
        paintCard(option.id);
        if (this.skillPreferenceSchemaVersion === 2) this._paintSkillChoice(choiceRow);
        this._paintSummary();
      });
    }
    this.skillChoiceRows.push(choiceRow);
    if (this.skillPreferenceSchemaVersion === 2) this._paintSkillChoice(choiceRow);
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = {
  SKILL_MODE_OPTIONS,
  XingzhiSkillPickerModal,
  normalizedNames,
};