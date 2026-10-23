"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createLoader } = require("./runtime-loader.cjs");
const load = createLoader({ globals: { console: { ...console, warn() {} } } });
const {
  DEFAULT_CAPABILITY_FILES, loadVaultCapabilityCatalog, loadVaultSkillInstructions,
} = load("./vault-capability-package.cjs");
const skillPath = "10_智能体与技能/技能/多元视角/SKILL.md";
const configPath = "10_智能体与技能/技能/多元视角/技能配置.yaml";
const templateRoot = path.resolve(__dirname, "../vault-template");

function fixture() {
  const markdown = fs.readFileSync(path.join(templateRoot, skillPath), "utf8");
  const config = fs.readFileSync(path.join(templateRoot, configPath), "utf8");
  const files = new Map(Object.entries(DEFAULT_CAPABILITY_FILES));
  files.set(skillPath, markdown);
  files.set(configPath, config);
  return {
    markdown,
    vault: {
      async read(name) {
        if (!files.has(name)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return files.get(name);
      },
      async exists(name) { return files.has(name); },
      async listMarkdown() { return [{ path: skillPath, content: markdown }]; },
    },
  };
}

test("multi-lens is discovered separately without changing the protected registry", async () => {
  const { vault } = fixture();
  const catalog = await loadVaultCapabilityCatalog(vault);
  const extension = catalog.skills.find(skill => skill.name === "multi-lens");
  assert.ok(extension);
  assert.equal(extension.label, "多元视角");
  assert.equal(extension.version, "3.1.0");
  assert.equal(extension.protected, false);
  assert.equal(extension.source, "extension");
  assert.equal(extension.path, skillPath);
  assert.equal(catalog.skills.filter(skill => skill.name === "multi-lens").length, 1);
  assert.ok(!catalog.issues.some(issue => issue.path === configPath));
});

test("a new extension remains disabled until the normal per-skill opt-in", async () => {
  const { vault } = fixture();
  const before = await loadVaultCapabilityCatalog(vault);
  assert.equal(before.skills.find(skill => skill.name === "multi-lens").enabled, false);
  const after = await loadVaultCapabilityCatalog(vault, {
    enabledExtensions: { skills: { "multi-lens": true } },
  });
  assert.equal(after.skills.find(skill => skill.name === "multi-lens").enabled, true);
});

test("enabled multi-lens stays a bounded task and grants no additional tools or reads", async () => {
  const { vault } = fixture();
  const catalog = await loadVaultCapabilityCatalog(vault, {
    enabledExtensions: { skills: { "multi-lens": true } },
  });
  const skill = catalog.skills.find(item => item.name === "multi-lens");
  assert.equal(skill.skillType, "task");
  assert.equal(skill.invocation, "implicit");
  assert.equal(skill.primaryEligible, true);
  assert.equal(skill.controlsFinalLayout, false);
  assert.equal(skill.riskLevel, "bounded");
  for (const key of ["requires", "readScopes", "toolRequests"]) {
    assert.equal(skill[key].length, 0);
  }
});

test("on-demand loading returns the entire uploaded instruction text", async () => {
  const { vault, markdown } = fixture();
  const catalog = await loadVaultCapabilityCatalog(vault);
  const skill = catalog.skills.find(item => item.name === "multi-lens");
  const loaded = await loadVaultSkillInstructions(vault, skill);
  assert.equal(loaded, markdown);
  assert.equal(Buffer.byteLength(loaded), skill.instructionBytes);
  assert.equal(crypto.createHash("sha256").update(loaded).digest("hex"), skill.instructionHash);
});

test("existing multi-perspective analysis keeps its distinct identity and instruction path", async () => {
  const { vault } = fixture();
  const catalog = await loadVaultCapabilityCatalog(vault);
  const existing = catalog.skills.find(item => item.name === "xingzhi-multi-perspective");
  assert.ok(existing);
  assert.equal(existing.label, "多视角分析");
  assert.notEqual(existing.path, skillPath);
  assert.equal(existing.protected, true);
  assert.equal(existing.enabled, true);
});

test("an enabled extension can be explicitly selected without selecting the existing analysis skill", async () => {
  const { vault } = fixture();
  const catalog = await loadVaultCapabilityCatalog(vault, {
    enabledExtensions: { skills: { "multi-lens": true } },
  });
  const { buildTurnCapabilityPlan } = load("./capability-orchestrator.cjs");
  const plan = buildTurnCapabilityPlan({
    text: "调用 multi-lens 检查这次选择遗漏了什么。",
    preferences: { skillMode: "manual" }, requestedSkills: ["multi-lens"],
    availableSkills: catalog.skills, availableAgents: catalog.agents,
  });
  assert.ok(plan.skills.some(skill => skill.name === "multi-lens"));
  assert.ok(!plan.skills.some(skill => skill.name === "xingzhi-multi-perspective"));
});

test("ordinary translation does not select multi-lens just because it is installed", async () => {
  const { vault } = fixture();
  const catalog = await loadVaultCapabilityCatalog(vault, {
    enabledExtensions: { skills: { "multi-lens": true } },
  });
  const { buildTurnCapabilityPlan } = load("./capability-orchestrator.cjs");
  const plan = buildTurnCapabilityPlan({
    text: "请把 hello 翻译成中文。", preferences: { skillMode: "auto" },
    availableSkills: catalog.skills, availableAgents: catalog.agents,
  });
  assert.ok(!plan.skills.some(skill => skill.name === "multi-lens"));
});

test("governance allows the opted-in task extension without forging a canonical lens id", async () => {
  const { vault } = fixture();
  const catalog = await loadVaultCapabilityCatalog(vault, {
    enabledExtensions: { skills: { "multi-lens": true } },
  });
  const extension = catalog.skills.find(skill => skill.name === "multi-lens");
  // Keep the concrete Map and the validator in the same realm.
  const { authorizeV2CapabilityPlan } = require("../src/v2-capability-catalog.cjs");
  const governance = {
    aliases: new Map([["agent-test", { canonicalId: "agent-test", kind: "agent", deprecated: false }]]),
    configs: { agent: new Map([["agent-test", { enabled: true,
      allowedSkillIds: [], allowedLensIds: [],
      runtime: { maxPrimarySkills: 1, maxAuxiliarySkills: 2, maxLenses: 2 },
    }]]) },
  };
  const input = { agent: { agentId: "agent-test" }, skills: [{ ...extension, outputRole: "primary" }] };
  const plan = authorizeV2CapabilityPlan(input, governance, { registeredExtensions: [extension] });
  assert.equal(plan.skills[0].canonicalCapabilityId, null);
  assert.equal(plan.v2RouteTrace.legacyExtensionIds[0], "multi-lens");
  assert.equal(plan.v2RouteTrace.promptMayExpandPermissions, false);
  assert.throws(() => authorizeV2CapabilityPlan(input, governance, {
    registeredExtensions: [{ ...extension, enabled: false }],
  }));
});
