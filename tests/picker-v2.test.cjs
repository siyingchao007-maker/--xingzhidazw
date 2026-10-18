"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createLoader } = require("./runtime-loader.cjs");
const plain = value => JSON.parse(JSON.stringify(value));
const walk = node => [node, ...node.children.flatMap(walk)];

class Element {
  constructor(tag = "div", options = {}, parent = null) {
    this.tag = tag; this.parent = parent; this.children = []; this.listeners = new Map();
    this.attributes = { ...(options.attr || {}) }; this.classes = new Set(String(options.cls || "").split(/\s+/u).filter(Boolean));
    this.text = options.text || ""; this.disabled = false; this.checked = false;
  }
  createEl(tag, options = {}) { const child = new Element(tag, options, this); this.children.push(child); return child; }
  createDiv(options) { return this.createEl("div", options); }
  createSpan(options) { return this.createEl("span", options); }
  addClass(value) { this.classes.add(value); }
  toggleClass(value, on) { if (on) this.classes.add(value); else this.classes.delete(value); }
  setText(value) { this.text = value; this.children = []; }
  setAttr(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  empty() { this.children = []; this.text = ""; }
  focus() { this.focused = true; }
  addEventListener(event, callback) { const listeners = this.listeners.get(event) || []; listeners.push(callback); this.listeners.set(event, listeners); }
  querySelectorAll(selector) {
    if (selector === "label[data-choice]") return walk(this).filter(node => node.tag === "label" && node.attributes["data-choice"]);
    if (selector === "[data-choice-label]") return walk(this).filter(node => node.attributes["data-choice-label"]);
    if (selector === "input:not(:disabled)") return walk(this).filter(node => node.tag === "input" && !node.disabled);
    return [];
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  async change() {
    if (this.disabled) return;
    let root = this; while (root.parent) root = root.parent;
    if (this.attributes.type === "radio") for (const node of walk(root)) {
      if (node.attributes.name === this.attributes.name) node.checked = node === this;
    }
    else this.checked = !this.checked;
    for (const callback of this.listeners.get("change") || []) await callback({ target: this });
  }
  async click() { if (!this.disabled) for (const callback of this.listeners.get("click") || []) await callback({ target: this }); }
}

const notices = [];
class Modal {
  constructor(app) { this.app = app; this.modalEl = new Element(); this.titleEl = this.modalEl.createEl("h2"); this.contentEl = this.modalEl.createDiv(); }
  open() { Modal.last = this; this.onOpen(); }
  close() { this.closed = true; }
}
const host = { Modal, Notice: class { constructor(message) { notices.push(message); } }, ItemView: class {}, Component: class {} };
const baseLoad = createLoader();
function sourceModule(name, require) {
  const filename = path.resolve(__dirname, "../src", name);
  const module = { exports: {} };
  const factory = vm.runInNewContext(`(function(module,exports,require){${fs.readFileSync(filename, "utf8")}\n})`, {
    Buffer, console, setTimeout: callback => callback(), clearTimeout, URL,
  }, { filename });
  factory(module, module.exports, require);
  return module.exports;
}
const pickerModule = sourceModule("view-skill-picker.cjs", id => id === "obsidian" ? host : baseLoad(id));
const { XingzhiSkillPickerModal } = pickerModule;
const { XingzhiWorkbenchView } = sourceModule("workbench-view.cjs", id => {
  if (id === "obsidian") return host;
  if (id === "./view-skill-picker.cjs") return pickerModule;
  return baseLoad(id);
});

const skills = [
  { name: "candidate", skillType: "task", displayName: "候选方法", enabled: true },
  { name: "invocation", skillType: "task", displayName: "固定方法", enabled: true },
  { name: "candidate-lens", skillType: "cognitive-lens", displayName: "候选透镜", enabled: true },
  { name: "invocation-lens", skillType: "cognitive-lens", displayName: "固定透镜", enabled: true },
];
const v2 = { skillPreferenceSchemaVersion: 2, skillMode: "auto", controlledSkillLoading: true,
  selectedSkills: ["legacy-snapshot"], fixedCandidateIds: ["candidate"], fixedInvocationIds: ["invocation"] };
const input = (modal, name, value) => walk(modal.contentEl).find(node => node.tag === "input" && node.attributes.name === name && (value === undefined || node.attributes.value === value));
const saveButton = modal => walk(modal.contentEl).find(node => node.tag === "button" && /^保存/u.test(node.text));
const allText = node => walk(node).map(child => child.text).join(" ");

test("schema2 picker preserves both fixed sets when switching modes and saves a compatibility snapshot", async () => {
  let saved;
  const modal = new XingzhiSkillPickerModal({}, { ...v2, skills, onSave: async result => { saved = plain(result); } });
  modal.open();
  assert.equal(input(modal, "xz-skill-choice-candidate", "fixed").checked, true);
  assert.match(allText(modal.contentEl), /固定调用.*切换/u);
  for (const mode of ["manual", "recommend", "auto"]) {
    await input(modal, "xz-skill-modal-mode", mode).change();
    assert.equal(input(modal, `xz-skill-choice-${mode === "auto" ? "candidate" : "invocation"}`, "fixed").checked, true);
  }
  await saveButton(modal).click();
  assert.equal(saved.skillPreferenceSchemaVersion, 2);
  assert.deepEqual(saved.fixedCandidateIds, ["candidate"]);
  assert.deepEqual(saved.fixedInvocationIds, ["invocation"]);
  assert.deepEqual(saved.selectedSkills.sort(), ["candidate", "invocation"]);
  assert.equal(saved.controlledSkillLoading, true);
});

test("schema2 edits the active fixed set without erasing the other mode's choices", async () => {
  let saved;
  const modal = new XingzhiSkillPickerModal({}, { ...v2, skills, onSave: async result => { saved = plain(result); } });
  modal.open();
  await input(modal, "xz-skill-choice-candidate", "automatic").change();
  await input(modal, "xz-skill-modal-mode", "manual").change();
  await input(modal, "xz-skill-choice-candidate", "fixed").change();
  await saveButton(modal).click();
  assert.deepEqual(saved.fixedCandidateIds, []);
  assert.deepEqual(saved.fixedInvocationIds.sort(), ["candidate", "invocation"]);
});

test("schema2 controlled loading switch starts from saved value and can be disabled", async () => {
  let saved;
  const modal = new XingzhiSkillPickerModal({}, { ...v2, skills, onSave: async result => { saved = plain(result); } });
  modal.open();
  const toggle = input(modal, "xz-controlled-skill-loading");
  assert.ok(toggle); assert.equal(toggle.checked, true);
  await toggle.change();
  await saveButton(modal).click();
  assert.equal(saved.controlledSkillLoading, false);
});

test("legacy picker keeps legacy saving semantics and hides controlled loading", async () => {
  let saved;
  const modal = new XingzhiSkillPickerModal({}, { skillMode: "auto", selectedSkills: ["candidate"], skills,
    onSave: async result => { saved = plain(result); } });
  modal.open();
  assert.equal(input(modal, "xz-controlled-skill-loading"), undefined);
  await input(modal, "xz-skill-modal-mode", "manual").change();
  await saveButton(modal).click();
  assert.deepEqual(saved.selectedSkills, ["candidate"]);
  for (const name of ["skillPreferenceSchemaVersion", "fixedCandidateIds", "fixedInvocationIds", "controlledSkillLoading"]) assert.equal(Object.hasOwn(saved, name), false);
});

test("schema2 disabled state retains the other fixed set without claiming invocation", async () => {
  let saved;
  const modal = new XingzhiSkillPickerModal({}, { ...v2, skills, onSave: async result => { saved = plain(result); } });
  modal.open();
  await input(modal, "xz-skill-choice-invocation", "disabled").change();
  assert.match(allText(modal.contentEl), /保留固定调用设置，当前已禁用/u);
  assert.doesNotMatch(allText(modal.contentEl), /仍按明确选择调用/u);
  await saveButton(modal).click();
  assert.deepEqual(saved.fixedInvocationIds, ["invocation"]);
  assert.deepEqual(saved.disabledSkills, ["invocation"]);
});

test("locked schema2 picker exposes state without changing or saving it", async () => {
  let saves = 0;
  const modal = new XingzhiSkillPickerModal({}, { ...v2, skills, locked: true, onSave: async () => { saves += 1; } });
  modal.open();
  await input(modal, "xz-controlled-skill-loading").change();
  await input(modal, "xz-skill-modal-mode", "manual").change();
  await saveButton(modal).click();
  assert.equal(modal.skillMode, "auto");
  assert.equal(modal.controlledSkillLoading, true);
  assert.equal(saves, 0);
});

test("a rejected save leaves schema2 state editable for a retry", async () => {
  let saves = 0;
  const modal = new XingzhiSkillPickerModal({}, { ...v2, skills, onSave: async () => {
    saves += 1; if (saves === 1) throw new Error("TEST_SAVE_REJECTED");
  } });
  modal.open();
  const save = saveButton(modal);
  await save.click();
  assert.equal(modal.closed, undefined);
  assert.equal(save.disabled, false);
  assert.match(notices.at(-1), /TEST_SAVE_REJECTED/u);
  await save.click();
  assert.equal(modal.closed, true);
  assert.equal(saves, 2);
});

function viewFixture(settings = v2) {
  const effects = [];
  const stored = plain(settings);
  const view = Object.create(XingzhiWorkbenchView.prototype);
  Object.assign(view, { app: {}, nextTurnSkillSelections: new Map(), plugin: { state: { settings: stored, runtime: { skills: plain(skills) } }, updateSettings() {} },
    getActiveConversation: () => ({ id: "conversation" }), turnForConversation: () => null,
    ensureCapabilitiesEnabled: async ids => { effects.push(["enable", [...ids]]); return []; },
    updateSettings: async patch => { effects.push(["save", plain(patch)]); Object.assign(stored, plain(patch)); }, renderSkillPicker() {},
  });
  return { view, stored, effects };
}

test("view passes both categories and enables selected methods before persisting merged schema2 fields", async () => {
  const f = viewFixture({ ...v2, fixedCandidateIds: ["candidate", "candidate-lens"], fixedInvocationIds: ["invocation", "invocation-lens"] });
  f.view.openSkillPicker("skill");
  const modal = Modal.last;
  assert.deepEqual([...modal.fixedCandidateIds], ["candidate"]);
  assert.deepEqual([...modal.fixedInvocationIds], ["invocation"]);
  await saveButton(modal).click();
  assert.equal(f.effects[0][0], "enable"); assert.equal(f.effects[1][0], "save");
  assert.deepEqual(f.stored.fixedCandidateIds.sort(), ["candidate", "candidate-lens"]);
  assert.deepEqual(f.stored.fixedInvocationIds.sort(), ["invocation", "invocation-lens"]);
  assert.equal(f.stored.controlledSkillLoading, true);
  assert.equal(f.stored.skillPreferenceSchemaVersion, 2);
  assert.deepEqual(f.effects[0][1].sort(), ["candidate", "invocation"]);
});

test("lens changes preserve task settings, both fixed sets, and the controlled loading flag", async () => {
  const f = viewFixture({ ...v2, fixedCandidateIds: ["candidate", "candidate-lens"], fixedInvocationIds: ["invocation", "invocation-lens"] });
  f.view.openSkillPicker("lens");
  const modal = Modal.last;
  await input(modal, "xz-skill-choice-candidate-lens", "automatic").change();
  await saveButton(modal).click();
  assert.deepEqual(f.stored.fixedCandidateIds, ["candidate"]);
  assert.deepEqual(f.stored.fixedInvocationIds.sort(), ["invocation", "invocation-lens"]);
  assert.equal(f.stored.controlledSkillLoading, true);
});

test("view removes refused capabilities from both v2 lists and one-turn selection", async () => {
  const f = viewFixture();
  f.view.ensureCapabilitiesEnabled = async () => [{ id: "invocation", label: "固定方法", reason: "不可用" }];
  f.view.openSkillPicker("skill");
  await saveButton(Modal.last).click();
  assert.deepEqual(f.stored.fixedCandidateIds, ["candidate"]);
  assert.deepEqual(f.stored.fixedInvocationIds, []);
  assert.deepEqual(f.stored.selectedSkills, ["candidate"]);
});

test("view summary shows existing fixed invocation in auto mode and ignores the legacy snapshot", () => {
  const f = viewFixture();
  f.view.renderSkillPicker = XingzhiWorkbenchView.prototype.renderSkillPicker;
  f.view.refs = Object.fromEntries(["skillSummaryText", "lensSummaryText", "skillPickerSummary", "lensPickerSummary", "skillPicker", "lensPicker"]
    .map(name => [name, new Element()]));
  f.view.renderSkillPicker();
  assert.match(f.view.refs.skillSummaryText.text, /固定候选 1.*固定调用 1/u);
  assert.doesNotMatch(f.view.refs.skillSummaryText.text, /legacy/u);
});

test("saving a disabled stored invocation does not enable its global capability", async () => {
  const f = viewFixture({ ...v2, disabledSkills: ["invocation"] });
  f.view.openSkillPicker("skill");
  await saveButton(Modal.last).click();
  assert.deepEqual(f.effects[0][1], ["candidate"]);
  assert.deepEqual(f.stored.fixedInvocationIds, ["invocation"]);
  assert.deepEqual(f.stored.disabledSkills, ["invocation"]);
});

test("switching conversations during capability enable prevents the settings write", async () => {
  const f = viewFixture();
  f.view.ensureCapabilitiesEnabled = async () => { f.view.getActiveConversation = () => ({ id: "different-conversation" }); return []; };
  f.view.openSkillPicker("skill");
  const modal = Modal.last;
  await saveButton(modal).click();
  assert.equal(f.effects.some(([kind]) => kind === "save"), false);
  assert.equal(modal.closed, undefined);
  assert.match(notices.at(-1), /当前对话已经切换/u);
});
