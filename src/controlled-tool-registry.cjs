"use strict";

const crypto = require("node:crypto");

const TOOL_PERMISSIONS = new Set(["read", "propose", "write", "delete", "external", "execute"]);
const TOOL_CONFIRMATIONS = new Set(["never", "policy", "required"]);
const HIGH_RISK_PERMISSIONS = new Set(["write", "delete", "external", "execute"]);
const MAX_AUDIT_EVENTS = 100;

function safeText(value, maximum = 200) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function normalizeToolDefinition(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("工具定义无效");
  const allowed = new Set([
    "id", "label", "description", "permission", "confirmation", "rateLimit",
    "rollback", "inputSchema",
  ]);
  const extra = Object.keys(raw).filter((key) => !allowed.has(key));
  if (extra.length) throw new Error(`工具定义包含不允许的字段：${extra.join("、")}`);
  const id = safeText(raw.id, 128);
  if (!/^[a-z0-9][a-z0-9_-]{1,127}$/u.test(id)) throw new Error("工具编号无效");
  if (!TOOL_PERMISSIONS.has(raw.permission)) throw new Error(`工具权限无效：${id}`);
  if (!TOOL_CONFIRMATIONS.has(raw.confirmation)) throw new Error(`工具确认策略无效：${id}`);
  if (!Number.isSafeInteger(raw.rateLimit) || raw.rateLimit < 1 || raw.rateLimit > 100) {
    throw new Error(`工具每轮限额无效：${id}`);
  }
  if (HIGH_RISK_PERMISSIONS.has(raw.permission) && raw.confirmation !== "required") {
    throw new Error(`高风险工具必须逐轮确认：${id}`);
  }
  return Object.freeze({
    id,
    label: safeText(raw.label, 160) || id,
    description: safeText(raw.description, 800),
    permission: raw.permission,
    confirmation: raw.confirmation,
    rateLimit: raw.rateLimit,
    rollback: raw.rollback === true,
    inputSchema: raw.inputSchema && typeof raw.inputSchema === "object" ? raw.inputSchema : null,
  });
}

function appendAudit(context, event) {
  if (!context || typeof context !== "object") return;
  if (!Array.isArray(context.toolAuditEvents)) context.toolAuditEvents = [];
  context.toolAuditEvents.push(Object.freeze(event));
  if (context.toolAuditEvents.length > MAX_AUDIT_EVENTS) {
    context.toolAuditEvents.splice(0, context.toolAuditEvents.length - MAX_AUDIT_EVENTS);
  }
}

class ControlledToolRegistry {
  constructor(definitions = []) {
    this.definitions = new Map();
    for (const raw of definitions) {
      const definition = normalizeToolDefinition(raw);
      if (this.definitions.has(definition.id)) throw new Error(`工具编号重复：${definition.id}`);
      this.definitions.set(definition.id, definition);
    }
  }

  list() {
    return [...this.definitions.values()].map((definition) => ({ ...definition }));
  }

  get(id) {
    const definition = this.definitions.get(safeText(id, 128));
    return definition ? { ...definition } : null;
  }

  async execute(id, args, context = {}, handler) {
    const toolId = safeText(id, 128);
    const definition = this.definitions.get(toolId);
    if (!definition) throw new Error(`工具未注册，已拒绝调用：${toolId || "未提供"}`);
    if (Array.isArray(context.allowedToolIds) && !context.allowedToolIds.includes(toolId)) {
      throw new Error(`本轮没有允许该工具：${toolId}`);
    }
    if (definition.confirmation === "required"
      && (!Array.isArray(context.confirmedToolIds) || !context.confirmedToolIds.includes(toolId))) {
      throw new Error(`工具需要本轮明确确认：${toolId}`);
    }
    if (typeof handler !== "function") throw new Error(`工具缺少受控处理器：${toolId}`);
    if (!context.toolCallCounts || typeof context.toolCallCounts !== "object") {
      context.toolCallCounts = Object.create(null);
    }
    const count = Number.isSafeInteger(context.toolCallCounts[toolId]) ? context.toolCallCounts[toolId] : 0;
    if (count >= definition.rateLimit) throw new Error(`工具已达到本轮调用限额：${toolId}`);
    context.toolCallCounts[toolId] = count + 1;
    const startedAt = new Date().toISOString();
    const argumentHash = crypto.createHash("sha256")
      .update(JSON.stringify(args ?? null), "utf8")
      .digest("hex")
      .slice(0, 24);
    try {
      const result = await handler();
      appendAudit(context, {
        toolId,
        permission: definition.permission,
        status: result?.success === false || result?.isError === true ? "failed" : "succeeded",
        argumentHash,
        rollbackAvailable: definition.rollback,
        startedAt,
        completedAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      appendAudit(context, {
        toolId,
        permission: definition.permission,
        status: "failed",
        argumentHash,
        rollbackAvailable: definition.rollback,
        startedAt,
        completedAt: new Date().toISOString(),
        error: safeText(error?.message || error, 500),
      });
      throw error;
    }
  }
}

function createDefaultControlledToolRegistry(toolSpecs = []) {
  const schemas = new Map((Array.isArray(toolSpecs) ? toolSpecs : [])
    .filter((item) => item && typeof item.name === "string")
    .map((item) => [item.name, item.inputSchema || null]));
  return new ControlledToolRegistry([
    {
      id: "xingzhi_load_primary_skill",
      label: "主 Skill 按需加载",
      description: "只读本轮冻结候选中的一个方法正文；不扩展其他工具或读写权限。",
      permission: "read", confirmation: "never", rateLimit: 2, rollback: false,
      inputSchema: schemas.get("xingzhi_load_primary_skill") || null,
    },
    {
      id: "xingzhi_read_conversation_messages",
      label: "当前会话原文回读",
      description: "按精确消息编号只读当前会话的有界片段，不读取任意转录文件。",
      permission: "read", confirmation: "never", rateLimit: 4, rollback: false,
      inputSchema: schemas.get("xingzhi_read_conversation_messages") || null,
    },
    {
      id: "xingzhi_search_knowledge",
      label: "本地知识检索",
      description: "只读检索本轮获准的本地正式知识。",
      permission: "read",
      confirmation: "never",
      rateLimit: 8,
      rollback: false,
      inputSchema: schemas.get("xingzhi_search_knowledge") || null,
    },
    {
      id: "xingzhi_web_search",
      label: "联网检索",
      description: "由行知联网桥接执行真实网页搜索并返回可引用来源；仅在联网权限开启的外部模型通道可用。",
      permission: "external",
      confirmation: "required",
      rateLimit: 2,
      rollback: false,
      inputSchema: schemas.get("xingzhi_web_search") || null,
    },
    {
      id: "xingzhi_submit_knowledge_candidates",
      label: "提交知识候选",
      description: "只在受控归档阶段提交候选，实际写入继续由知识策略、确认和事务层裁决。",
      permission: "propose",
      confirmation: "policy",
      rateLimit: 8,
      rollback: true,
      inputSchema: schemas.get("xingzhi_submit_knowledge_candidates") || null,
    },
  ]);
}

module.exports = {
  ControlledToolRegistry,
  createDefaultControlledToolRegistry,
  normalizeToolDefinition,
};
