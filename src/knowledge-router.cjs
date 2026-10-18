const { canonicalKnowledgeContent } = require("./knowledge-lifecycle.cjs");
const { detectMaterialContentChange } = require("./entity-knowledge-engine.cjs");
const { routeEnvironmentSubtype } = require("./environment-policy-engine.cjs");

const ROUTES = Object.freeze({
  "basic-info": { directory: "01_当前的我/基本信息", label: "基本信息" },
  "current-state": { directory: "01_当前的我/当前状态", label: "当前状态" },
  "value-priority": { directory: "01_当前的我/价值排序", label: "价值排序" },
  "ability-hypothesis": { directory: "01_当前的我/能力假设", label: "能力假设" },
  "identity-role": { directory: "01_当前的我/身份与角色", label: "身份与角色" },
  "behavior-pattern": { directory: "01_当前的我/行为模式", label: "行为模式" },
  history: { directory: "02_我的历史/历史时间线", label: "我的历史" },
  environment: { directory: "03_环境", label: "环境" },
  relationship: { directory: "04_关系/关系事件", label: "关系" },
  goal: { directory: "05_目标与项目/阶段目标", label: "目标" },
  project: { directory: "05_目标与项目/进行中项目", label: "项目" },
  decision: { directory: "06_判断与决策/判断记录", label: "判断与决策" },
  action: { directory: "07_行动/行动记录", label: "行动" },
  result: { directory: "08_结果与反馈/结果记录", label: "结果" },
  feedback: { directory: "08_结果与反馈/校正记录", label: "反馈" },
  "cognitive-asset": { directory: "09_认知资产/待验证认知", label: "认知资产" },
  evidence: { directory: "11_证据与来源/个人原始记录", label: "证据与来源" },
});

const SUBTYPE_ROUTES = Object.freeze({
  history: Object.freeze({
    "life-stage": "人生阶段", "key-experience": "关键经历", education: "教育经历",
    career: "职业经历", "turning-point": "重要转折", timeline: "历史时间线",
  }),
  environment: Object.freeze({
    rules: "规则与制度", policy: "规则与制度", institution: "规则与制度",
    regional: "区域环境", technology: "技术环境", social: "社会环境",
    market: "市场环境", organization: "组织环境", industry: "行业环境",
  }),
  relationship: Object.freeze({
    family: "家庭关系", intimate: "亲密关系", friend: "朋友关系", professional: "职业关系",
    cooperation: "合作关系", event: "关系事件",
  }),
  goal: Object.freeze({ "long-term": "长期方向", stage: "阶段目标" }),
  project: Object.freeze({
    active: "进行中项目", waiting: "等待中项目", completed: "已完成项目", stopped: "已停止项目",
  }),
  decision: Object.freeze({
    "pending-question": "待判断问题", judgment: "判断记录", decision: "决策记录",
    "hypothesis-validation": "假设与验证", "risk-failure-condition": "风险与失败条件",
    "decision-review": "决策复盘",
  }),
  action: Object.freeze({
    "next-action": "下一步行动", plan: "行动计划", record: "行动记录",
    habit: "习惯与例行", "blocker-response": "阻碍与应对",
  }),
  result: Object.freeze({
    result: "结果记录", "expectation-vs-actual": "预期与实际", "external-feedback": "外部反馈",
    "variance-analysis": "偏差分析", correction: "校正记录",
  }),
  feedback: Object.freeze({
    result: "结果记录", "expectation-vs-actual": "预期与实际", "external-feedback": "外部反馈",
    "variance-analysis": "偏差分析", correction: "校正记录",
  }),
  "cognitive-asset": Object.freeze({
    "topic-knowledge": "主题知识", principle: "原则", "pending-cognition": "待验证认知",
    "thinking-model": "思维模型", "method-process": "方法与流程", lesson: "经验与教训",
  }),
  evidence: Object.freeze({
    "personal-raw-record": "个人原始记录", "external-source": "外部来源",
    "conversation-interview": "对话与访谈", "data-metric": "数据与指标",
    "file-material": "文件与资料", "evidence-index": "证据索引",
  }),
});

function normalizedToken(value) {
  return typeof value === "string" ? value.trim().toLowerCase().replaceAll("_", "-") : "";
}

function normalizedIdentityKey(value) {
  return String(value || "").trim().normalize("NFKC").toLocaleLowerCase("zh-CN");
}

function subtypeFor(candidate) {
  if (!candidate || typeof candidate !== "object") return "";
  if (candidate.knowledgeType === "history") return normalizedToken(candidate.area || candidate.eventType);
  if (candidate.knowledgeType === "environment" || candidate.knowledgeType === "relationship"
    || candidate.knowledgeType === "cognitive-asset" || candidate.knowledgeType === "evidence") {
    return normalizedToken(candidate.area);
  }
  if (candidate.knowledgeType === "goal") return normalizedToken(candidate.horizon);
  if (candidate.knowledgeType === "project") return normalizedToken(candidate.status);
  if (candidate.knowledgeType === "decision" || candidate.knowledgeType === "action") {
    return normalizedToken(candidate.stage);
  }
  if (candidate.knowledgeType === "result") return normalizedToken(candidate.resultType);
  if (candidate.knowledgeType === "feedback") return normalizedToken(candidate.feedbackType);
  return "";
}

function routeKnowledgeCandidate(candidate) {
  const route = ROUTES[candidate?.knowledgeType];
  if (!route) throw new Error(`不支持的知识类型：${candidate?.knowledgeType || "未知"}`);
  if (candidate?.knowledgeType === "environment") {
    const environmentRoute = routeEnvironmentSubtype(subtypeFor(candidate));
    if (!environmentRoute.known) {
      return {
        ...route,
        requiresSubtypeConfirmation: true,
        reasonCode: environmentRoute.reasonCode,
        subtype: "unknown",
      };
    }
    return {
      directory: environmentRoute.directory,
      label: route.label,
      subtype: environmentRoute.subtype,
      requiresSubtypeConfirmation: false,
      reasonCode: null,
    };
  }
  const subtypeDirectory = SUBTYPE_ROUTES[candidate.knowledgeType]?.[subtypeFor(candidate)];
  if (!subtypeDirectory) return { ...route };
  const root = route.directory.split("/")[0];
  return { directory: `${root}/${subtypeDirectory}`, label: route.label };
}

function canonicalContent(value) {
  return canonicalKnowledgeContent(value);
}

function parseTime(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function nonOverlappingPeriods(previous, candidate) {
  const previousUntil = parseTime(previous.effectiveUntil);
  const candidateFrom = parseTime(candidate.effectiveFrom);
  return previousUntil !== null && candidateFrom !== null && previousUntil < candidateFrom;
}

function differentExplicitContexts(previous, candidate) {
  return typeof previous.context === "string" && previous.context.trim()
    && typeof candidate.context === "string" && candidate.context.trim()
    && canonicalContent(previous.context) !== canonicalContent(candidate.context);
}

function sameExplicitEffectivePeriod(previous, candidate) {
  return typeof previous?.effectiveFrom === "string" && previous.effectiveFrom.trim()
    && typeof candidate?.effectiveFrom === "string" && candidate.effectiveFrom.trim()
    && previous.effectiveFrom.trim() === candidate.effectiveFrom.trim();
}

function detectCandidateConflict({ candidate, existing = [] }) {
  const rawKey = String(candidate?.knowledgeKey || candidate?.key || candidate?.candidateKey || candidate?.title || "").trim();
  const key = normalizedIdentityKey(rawKey);
  const relation = normalizedToken(candidate?.relation || candidate?.mutationIntent);
  const matches = existing.filter((item) => item
    && (item.recordClass && candidate?.recordClass
      ? item.recordClass === candidate.recordClass
      : item.knowledgeType === candidate?.knowledgeType)
    && normalizedIdentityKey(item.knowledgeKey || item.key || item.title) === key
    && !["historical", "superseded", "rejected"].includes(item.status));
  if (matches.length === 0) return { hasConflict: false, action: "write", question: null, matches: [] };

  if (matches.length > 1) {
    const allDistinctContexts = matches.every((item) => (
      differentExplicitContexts(item, candidate)
      && canonicalContent(item.content) !== canonicalContent(candidate.content)
      && !nonOverlappingPeriods(item, candidate)
    ));
    if (allDistinctContexts) {
      return { hasConflict: false, action: "different-context", question: null, matches };
    }
    const examples = matches.slice(0, 2)
      .map((item) => `“${String(item.content || "").replace(/\s+/gu, " ").trim().slice(0, 160)}”`)
      .join("、");
    return {
      hasConflict: true,
      action: "clarify",
      matches,
      question: `关于“${rawKey}”，知识库里有 ${matches.length} 条仍有效的同键知识（例如 ${examples}），其中存在重复、时间或场景关系歧义。请先在知识生命周期中整理这些旧知识，再确认本次内容适用的时间和场景。`,
    };
  }

  const duplicate = matches.find((item) => canonicalContent(item.content) === canonicalContent(candidate.content));
  if (duplicate) return { hasConflict: false, action: "deduplicate", question: null, matches: [duplicate] };

  if (new Set(["extends", "continues"]).has(relation)) {
    if (detectMaterialContentChange(candidate, matches[0])) {
      if (sameExplicitEffectivePeriod(matches[0], candidate)) {
        return {
          hasConflict: true,
          action: "clarify",
          matches: [matches[0]],
          question: `关于“${rawKey}”，同一生效期内的数字、公式或状态发生了变化，不能按“补充”自动合并。请核验哪一版有效。`,
        };
      }
      return {
        hasConflict: false,
        action: "temporal-successor",
        question: null,
        matches: [matches[0]],
      };
    }
    if (differentExplicitContexts(matches[0], candidate)) {
      return { hasConflict: false, action: "different-context", question: null, matches: [matches[0]] };
    }
    return {
      hasConflict: true,
      action: "clarify",
      matches: [matches[0]],
      question: `关于“${rawKey}”，模型把不同正文标成了“补充”，但本地无法机械证明新内容不会改写、限制或否定当前规则。请确认这是替代、不同场景，还是确实兼容的补充。`,
    };
  }
  if (relation === "replaces") {
    return { hasConflict: false, action: "temporal-successor", question: null, matches: [matches[0]] };
  }

  const temporal = matches.find((item) => nonOverlappingPeriods(item, candidate));
  if (temporal) return { hasConflict: false, action: "temporal-successor", question: null, matches: [temporal] };

  const contextual = matches.find((item) => differentExplicitContexts(item, candidate));
  if (contextual) return { hasConflict: false, action: "different-context", question: null, matches: [contextual] };

  const previous = matches[0];
  return {
    hasConflict: true,
    action: "clarify",
    matches,
    question: `关于“${rawKey}”，知识库目前记录为“${previous.content}”，你这次说的是“${candidate.content}”。这是情况发生了变化，还是两种说法适用于不同场景？`,
  };
}

module.exports = {
  ROUTES,
  SUBTYPE_ROUTES,
  detectCandidateConflict,
  routeKnowledgeCandidate,
};
