const { createProviderConfig } = require("./contracts.cjs");
const { decorateProviderModels } = require("./provider-models.cjs");

const EXECUTION_LEVELS = Object.freeze({
  "full-execution": "完整执行：支持连续线程、命令与文件审批，并可调用本机 Codex 能力。",
  "controlled-tools": "受控执行：模型可以请求本地受控工具，但不能直接访问或修改 Vault。",
  "read-only-analysis": "只读分析：可以读取获准上下文并回答，但不能写入知识库。",
  "conversation-only": "仅对话：只提供模型对话，不声明工具、知识写入或本机执行能力。",
});

const BUILTIN_PROVIDERS = Object.freeze({
  codex: Object.freeze({
    id: "codex",
    name: "Codex",
    protocol: "codex-app-server",
    baseUrl: null,
    secretRef: null,
    executionLevel: "full-execution",
    modelDiscovery: "app-server",
    capabilities: Object.freeze({
      persistentThreads: true,
      streaming: true,
      tools: true,
      approvals: true,
      structuredOutput: true,
    }),
  }),
  openai: Object.freeze({
    id: "openai",
    name: "OpenAI API",
    protocol: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    secretRef: "env:OPENAI_API_KEY",
    executionLevel: "controlled-tools",
    modelDiscovery: "http-models",
    capabilities: Object.freeze({
      persistentThreads: false,
      streaming: true,
      tools: true,
      approvals: false,
      structuredOutput: true,
    }),
  }),
  deepseek: Object.freeze({
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-chat-completions",
    baseUrl: "https://api.deepseek.com",
    secretRef: "env:DEEPSEEK_API_KEY",
    executionLevel: "controlled-tools",
    modelDiscovery: "http-models",
    capabilities: Object.freeze({
      persistentThreads: false,
      streaming: true,
      tools: true,
      approvals: false,
      structuredOutput: "json-object",
    }),
  }),
  kimi: Object.freeze({
    id: "kimi",
    name: "Kimi",
    protocol: "openai-chat-completions",
    baseUrl: "https://api.moonshot.cn/v1",
    secretRef: "env:MOONSHOT_API_KEY",
    executionLevel: "controlled-tools",
    modelDiscovery: "http-models",
    capabilities: Object.freeze({
      persistentThreads: false,
      streaming: true,
      tools: true,
      approvals: false,
      structuredOutput: "tool-schema",
    }),
  }),
  custom: Object.freeze({
    id: "custom",
    name: "自定义兼容 API",
    protocol: "openai-chat-completions",
    baseUrl: null,
    secretRef: "env:XINGZHI_CUSTOM_API_KEY",
    executionLevel: "conversation-only",
    modelDiscovery: "optional",
    capabilities: Object.freeze({
      persistentThreads: false,
      streaming: false,
      tools: false,
      approvals: false,
      structuredOutput: false,
    }),
  }),
});

const PROVIDER_ORDER = Object.freeze(["codex", "openai", "deepseek", "kimi", "custom"]);
const ENDPOINTS = Object.freeze({
  "openai-responses": Object.freeze({ models: "models", chat: "responses" }),
  "openai-chat-completions": Object.freeze({ models: "models", chat: "chat/completions" }),
});

function listBuiltinProviders() {
  return PROVIDER_ORDER.map((id) => ({ ...BUILTIN_PROVIDERS[id] }));
}

function describeExecutionLevel(level) {
  const description = EXECUTION_LEVELS[level];
  if (!description) throw new Error(`不支持的执行能力：${level || "未知"}`);
  return description;
}

function createBuiltinProviderConfigs() {
  return PROVIDER_ORDER
    .filter((id) => id !== "custom")
    .map((id) => {
      const provider = BUILTIN_PROVIDERS[id];
      return createProviderConfig({
        id: provider.id,
        name: provider.name,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        secretRef: provider.secretRef,
        capabilities: {
          ...provider.capabilities,
          executionLevel: provider.executionLevel,
          modelDiscovery: provider.modelDiscovery,
        },
      });
    });
}

function normalizeModelList(response, providerId = null) {
  const data = Array.isArray(response?.data) ? response.data : [];
  const models = data
    .filter((model) => model && typeof model.id === "string" && model.id.trim() !== "")
    .map((model) => ({
      id: model.id.trim(),
      label: typeof model.displayName === "string" && model.displayName.trim()
        ? model.displayName.trim()
        : model.id.trim(),
      description: typeof model.description === "string" ? model.description.trim() : "",
      ...(Number.isSafeInteger(model.context_window ?? model.contextWindowTokens)
        && (model.context_window ?? model.contextWindowTokens) > 0
        && (model.context_window ?? model.contextWindowTokens) <= 100_000_000
        ? { contextWindowTokens: model.context_window ?? model.contextWindowTokens,
            contextWindowSource: "provider-metadata" } : {}),
      isDefault: model.isDefault === true,
      supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.filter((item) => typeof item === "string").slice(0, 12)
        : (Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts.filter((item) => typeof item === "string").slice(0, 12) : null),
    }));
  return providerId ? decorateProviderModels(providerId, models) : models;
}

function validateHttpBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("提供商 API 地址格式不正确");
  }
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error("外部 API 必须使用 HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("API 地址不能包含凭据、查询参数或片段");
  }
  return url;
}

function resolveProviderEndpoint(provider, operation) {
  if (provider?.protocol === "codex-app-server") {
    throw new Error("Codex App Server 不通过 HTTP 提供商端点运行");
  }
  const route = ENDPOINTS[provider?.protocol]?.[operation];
  if (!route) throw new Error(`不支持的提供商操作：${operation || "未知"}`);
  const baseUrl = validateHttpBaseUrl(provider?.baseUrl);
  const isEligibleCustomProvider = /^custom(?:-[0-9]{1,3})?$/u.test(String(provider?.id || ""))
    && (provider.protocol === "openai-responses" || provider.protocol === "openai-chat-completions");
  const shouldInsertV1 = isEligibleCustomProvider
    && baseUrl.protocol === "https:"
    && baseUrl.hostname === "max.ai-zjl.cc"
    && baseUrl.port === ""
    && baseUrl.pathname === "/";
  const normalizedBase = shouldInsertV1
    ? `${baseUrl.origin}/v1`
    : baseUrl.toString().replace(/\/$/u, "");
  return `${normalizedBase}/${route}`;
}

module.exports = {
  BUILTIN_PROVIDERS,
  EXECUTION_LEVELS,
  createBuiltinProviderConfigs,
  describeExecutionLevel,
  listBuiltinProviders,
  normalizeModelList,
  resolveProviderEndpoint,
};
