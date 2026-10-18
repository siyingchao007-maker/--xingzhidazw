"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { REASONING_OPERATOR_ORDER } = require("./reasoning-operator-registry.cjs");

const SKILL_SOURCE_SCHEMA_VERSION = "xingzhi-skill/v1";
const SKILL_TYPES = Object.freeze([
  "task",
  "orchestrator",
  "cognitive-lens",
  "workflow",
]);
const SKILL_TYPE_SET = new Set(SKILL_TYPES);
const SKILL_ROOT = "10_智能体与技能/技能/";
const MAX_SKILL_SOURCE_BYTES = 128 * 1024;
const MIN_DECLARED_INSTRUCTION_BYTES = 512;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const TOP_LEVEL_FIELDS = new Set(["name", "description", "metadata"]);
const METADATA_FIELDS = new Set([
  "version",
  "short-description",
  "xingzhi_schema_version",
  "xingzhi_label",
  "xingzhi_skill_type",
  "xingzhi_operators",
  "xingzhi_user_explicit",
  "xingzhi_agent_routed",
  "xingzhi_primary_eligible",
  "xingzhi_controls_final_layout",
  "xingzhi_returns_structured_result",
  "xingzhi_maximum_instruction_bytes",
]);

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function boundedString(value, label, maximum) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
  if (byteLength(value) > maximum) throw new Error(`${label}超过安全上限`);
  return value.trim();
}

function parseScalar(raw, label) {
  const value = String(raw || "").trim();
  if (!value) throw new Error(`${label}不能为空`);
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed !== "string") throw new Error();
      return parsed;
    } catch {
      throw new Error(`${label}字符串格式无效`);
    }
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/u.test(value)) return Number(value);
  if (value === "null" || value.startsWith("[") || value.startsWith("{")) {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`${label} JSON 格式无效`);
    }
  }
  return value;
}

function normalizeSkillSourceText(markdown) {
  if (typeof markdown !== "string" || !markdown.trim()) throw new Error("SKILL.md 不能为空");
  if (byteLength(markdown) > MAX_SKILL_SOURCE_BYTES) throw new Error("SKILL.md 大小超过安全上限");
  return markdown.replace(/^\uFEFF/u, "").replaceAll("\r\n", "\n");
}

function splitSkillMarkdown(markdown) {
  const normalized = normalizeSkillSourceText(markdown);
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(normalized);
  if (!match) throw new Error("SKILL.md YAML frontmatter 头部不完整");
  const body = normalized.slice(match[0].length).trim();
  if (!body) throw new Error("SKILL.md 正文不能为空");
  return { frontmatter: match[1], body, normalized };
}

function assignOnce(target, key, value, label) {
  if (Object.hasOwn(target, key)) throw new Error(`${label}字段重复：${key}`);
  target[key] = value;
}

function parseFrontmatter(frontmatter) {
  const top = Object.create(null);
  const metadata = Object.create(null);
  let section = null;
  for (const [index, rawLine] of frontmatter.split("\n").entries()) {
    if (!rawLine.trim()) continue;
    const topMatch = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u.exec(rawLine);
    if (topMatch) {
      const [, key, rawValue = ""] = topMatch;
      if (!TOP_LEVEL_FIELDS.has(key)) throw new Error(`SKILL.md 包含不允许的字段：${key}`);
      if (key === "metadata") {
        if (rawValue.trim()) throw new Error("metadata 必须使用缩进字段");
        if (Object.hasOwn(top, key)) throw new Error("SKILL.md 字段重复：metadata");
        top.metadata = metadata;
        section = "metadata";
      } else {
        assignOnce(top, key, parseScalar(rawValue, `SKILL.md ${key}`), "SKILL.md ");
        section = null;
      }
      continue;
    }
    const metadataMatch = /^ {2}([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u.exec(rawLine);
    if (section === "metadata" && metadataMatch) {
      const [, key, rawValue = ""] = metadataMatch;
      if (!METADATA_FIELDS.has(key)) throw new Error(`metadata 包含不允许的字段：${key}`);
      assignOnce(metadata, key, parseScalar(rawValue, `metadata.${key}`), "metadata ");
      continue;
    }
    throw new Error(`SKILL.md frontmatter 第 ${index + 1} 行格式无效`);
  }
  if (!Object.hasOwn(top, "metadata")) throw new Error("SKILL.md 缺少 metadata");
  return { top, metadata };
}

function requiredBoolean(metadata, key) {
  if (typeof metadata[key] !== "boolean") throw new Error(`metadata.${key} 必须是布尔值`);
  return metadata[key];
}

function requiredInteger(metadata, key, minimum, maximum) {
  const value = metadata[key];
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`metadata.${key} 大小或数值上限无效`);
  }
  return value;
}

function normalizeOperators(value, knownOperatorIds) {
  let operators = value;
  if (typeof operators === "string") {
    try {
      operators = JSON.parse(operators);
    } catch {
      throw new Error("metadata.xingzhi_operators 必须是 operator JSON 数组");
    }
  }
  if (!Array.isArray(operators) || operators.length > 8) {
    throw new Error("metadata.xingzhi_operators 推理方法格式无效");
  }
  const known = new Set(knownOperatorIds);
  const seen = new Set();
  return operators.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("operator 映射必须是对象");
    }
    const extra = Object.keys(item).filter((key) => !new Set(["id", "mode"]).has(key));
    if (extra.length) throw new Error(`operator 映射包含不允许的字段：${extra.join("、")}`);
    const id = boundedString(item.id, "operator 编号", 64);
    const mode = boundedString(item.mode, "operator 模式", 64);
    if (!ID_PATTERN.test(id)) throw new Error(`operator 编号无效：${id}`);
    if (!ID_PATTERN.test(mode)) throw new Error(`operator 模式无效：${mode}`);
    if (!known.has(id)) throw new Error(`未知推理方法 operator：${id}`);
    const identity = `${id}\u0000${mode}`;
    if (seen.has(identity)) throw new Error(`operator 映射重复：${id}/${mode}`);
    seen.add(identity);
    return { id, mode };
  });
}

function assertSourcePath(sourcePath) {
  if (typeof sourcePath !== "string" || !sourcePath || sourcePath.includes("\\")
    || sourcePath.includes("..") || path.posix.isAbsolute(sourcePath)
    || /^[A-Za-z]:\//u.test(sourcePath) || sourcePath.length > 240
    || !sourcePath.startsWith(SKILL_ROOT) || !sourcePath.endsWith("/SKILL.md")
    || sourcePath.includes("/.obsidian/")) {
    throw new Error(`Skill 来源路径无效：${String(sourcePath || "未提供")}`);
  }
  return sourcePath;
}

function assertTypeBoundaries(skillType, invocation, output, operators) {
  if (skillType === "cognitive-lens") {
    if (invocation.primaryEligible) throw new Error("认知透镜不能成为主要 Skill");
    if (output.controlsFinalLayout) throw new Error("认知透镜不能控制最终回答格式 layout");
    if (!output.returnsStructuredResult) throw new Error("认知透镜必须返回结构化结果");
    if (!operators.length) throw new Error("认知透镜至少需要一个 operator 映射");
  }
  if (skillType === "workflow") {
    if (invocation.primaryEligible) throw new Error("后台 workflow 不能成为主要 Skill");
    if (output.controlsFinalLayout) throw new Error("后台 workflow 不能控制最终回答格式 layout");
  }
}

function parseSkillSource(markdown, {
  sourcePath,
  knownOperatorIds = REASONING_OPERATOR_ORDER,
} = {}) {
  const safeSourcePath = assertSourcePath(sourcePath);
  const { frontmatter, body, normalized } = splitSkillMarkdown(markdown);
  const { top, metadata } = parseFrontmatter(frontmatter);
  const name = boundedString(top.name, "Skill 编号 name", 64);
  if (!ID_PATTERN.test(name)) throw new Error(`Skill 编号 name 无效：${name}`);
  const description = boundedString(top.description, "Skill description", 2_000);
  const version = boundedString(metadata.version, "Skill 版本 version", 64);
  if (!VERSION_PATTERN.test(version)) throw new Error(`Skill 版本 version 无效：${version}`);
  const schemaVersion = boundedString(metadata.xingzhi_schema_version, "Skill Schema", 64);
  if (schemaVersion !== SKILL_SOURCE_SCHEMA_VERSION) {
    throw new Error(`Skill Schema 无效：${schemaVersion}`);
  }
  const label = boundedString(metadata.xingzhi_label, "Skill 名称", 200);
  const skillType = boundedString(metadata.xingzhi_skill_type, "Skill 类型", 64);
  if (!SKILL_TYPE_SET.has(skillType)) throw new Error(`Skill 类型无效：${skillType}`);
  const operators = normalizeOperators(metadata.xingzhi_operators, knownOperatorIds);
  const invocation = {
    userExplicit: requiredBoolean(metadata, "xingzhi_user_explicit"),
    agentRouted: requiredBoolean(metadata, "xingzhi_agent_routed"),
    primaryEligible: requiredBoolean(metadata, "xingzhi_primary_eligible"),
  };
  const output = {
    controlsFinalLayout: requiredBoolean(metadata, "xingzhi_controls_final_layout"),
    returnsStructuredResult: requiredBoolean(metadata, "xingzhi_returns_structured_result"),
  };
  const limits = {
    maximumInstructionBytes: requiredInteger(
      metadata,
      "xingzhi_maximum_instruction_bytes",
      MIN_DECLARED_INSTRUCTION_BYTES,
      MAX_SKILL_SOURCE_BYTES,
    ),
  };
  if (byteLength(normalized) > limits.maximumInstructionBytes) {
    throw new Error(`SKILL.md 大小超过声明的 ${limits.maximumInstructionBytes} 字节上限`);
  }
  assertTypeBoundaries(skillType, invocation, output, operators);
  return {
    schemaVersion,
    name,
    label,
    description,
    version,
    skillType,
    operators,
    invocation,
    output,
    limits,
    body,
    sourcePath: safeSourcePath,
    sourceBytes: byteLength(normalized),
    sourceHash: crypto.createHash("sha256").update(normalized, "utf8").digest("hex"),
  };
}

module.exports = {
  MAX_SKILL_SOURCE_BYTES,
  SKILL_SOURCE_SCHEMA_VERSION,
  SKILL_TYPES,
  normalizeSkillSourceText,
  parseSkillSource,
};
