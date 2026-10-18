const {
  normalizeModelList,
  resolveProviderEndpoint,
} = require("./provider-registry.cjs");
const {
  canonicalProviderModelId,
  usesDeepSeekV4Family,
} = require("./provider-models.cjs");

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_DATA_URL_BYTES = 16 * 1024 * 1024;
const MAX_IMAGES_PER_REQUEST = 5;
const IMAGE_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/u;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_SSE_BYTES = 16 * 1024 * 1024;
const MAX_SSE_EVENT_BYTES = 1024 * 1024;
const MAX_TOOL_ARGUMENT_BYTES = 512 * 1024;
const MAX_RESPONSES_OUTPUT_ITEMS = 128;
const MAX_RESPONSES_OUTPUT_ITEMS_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSES_CITATIONS = 512;
const MAX_ERROR_BYTES = 2 * 1024;
// A reasoning model can legitimately take more than two minutes before its
// first token, especially when the request contains imported documents. Treat
// this as an inactivity limit, not a wall-clock limit: every received chunk
// proves the connection is alive and renews the wait window.
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MODEL_LIST_TIMEOUT_MS = 120_000;
const MAX_TURN_DURATION_MS = 30 * 60_000;
const SUPPORTED_PROTOCOLS = new Set(["openai-responses", "openai-chat-completions"]);
const ALLOWED_ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);
const CHAT_SUCCESS_FINISH_REASONS = new Set(["stop", "tool_calls", "function_call"]);

function completionValue(value, maximum = 200) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : null;
}

function normalizeProviderCompletion(value = {}) {
  return {
    finishReason: completionValue(value.finishReason),
    responseStatus: completionValue(value.responseStatus),
    incompleteReason: completionValue(value.incompleteReason),
    actualModel: completionValue(value.actualModel, 300),
  };
}

function responseIncompleteReason(response, fallback = "non_completed_status") {
  return completionValue(
    response?.incomplete_details?.reason
      || response?.error?.code
      || response?.error?.type,
  ) || fallback;
}

function incompleteCompletionError(providerCompletion, protocol) {
  const metadata = normalizeProviderCompletion(providerCompletion);
  const detail = metadata.incompleteReason || metadata.finishReason || metadata.responseStatus;
  const headline = metadata.finishReason === "content_filter" || detail === "content_filter"
    ? "模型输出受内容过滤限制，未完成"
    : metadata.finishReason === "length" || detail === "max_output_tokens"
      ? "模型输出到限，未完成"
      : detail === "missing_terminal_signal" || detail === "missing_finish_reason"
        ? "模型响应缺少正式结束信号，未完成"
        : "模型响应未完成";
  const message = `${headline}${detail ? `（${detail}）` : ""}`;
  return new ProviderClientError("incomplete_response", message, {
    retryable: true,
    providerCompletion: metadata,
  });
}

class ProviderClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProviderClientError";
    this.code = code;
    if (Number.isInteger(details.status)) this.status = details.status;
    this.retryable = details.retryable === true;
    if (details.providerCompletion && typeof details.providerCompletion === "object") {
      this.providerCompletion = normalizeProviderCompletion(details.providerCompletion);
    }
  }
}

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function boundedText(value, maximum, label) {
  if (typeof value !== "string") throw new ProviderClientError("invalid_request", `${label}必须是文本`);
  if (byteLength(value) > maximum) throw new ProviderClientError("request_too_large", `${label}超过安全上限`);
  return value;
}

function safeJsonStringify(value, maximum, code = "request_too_large") {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ProviderClientError("invalid_request", "请求内容无法序列化");
  }
  if (byteLength(serialized) > maximum) {
    throw new ProviderClientError(code, code === "response_too_large" ? "API 返回内容超过安全上限" : "请求内容超过安全上限");
  }
  return serialized;
}

function redact(value, secrets = []) {
  let output = String(value || "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 3) output = output.split(secret).join("[已脱敏]");
  }
  output = output
    .replace(/authorization\s*:\s*bearer\s+[^\s,;]+/giu, "[已脱敏]")
    .replace(/bearer\s+[^\s,;]+/giu, "[已脱敏]")
    .replace(/(api[ _-]?key|access[ _-]?token)\s*[:=]\s*[^\s,;]+/giu, "$1=[已脱敏]");
  if (byteLength(output) <= MAX_ERROR_BYTES) return output;
  return `${Buffer.from(output, "utf8").subarray(0, MAX_ERROR_BYTES).toString("utf8")}…`;
}

function normalizeError(error, secrets = []) {
  if (error instanceof ProviderClientError) {
    return new ProviderClientError(error.code, redact(error.message, secrets), {
      status: error.status,
      retryable: error.retryable,
      providerCompletion: error.providerCompletion,
    });
  }
  return new ProviderClientError("network_error", `无法连接模型 API：${redact(error?.message || "未知错误", secrets)}`, {
    retryable: true,
  });
}

function publicError(error) {
  return {
    code: error.code || "provider_error",
    message: error.message || "模型 API 请求失败",
    ...(Number.isInteger(error.status) ? { status: error.status } : {}),
    retryable: error.retryable === true,
  };
}

function validateProvider(provider) {
  if (!provider || typeof provider !== "object") throw new ProviderClientError("invalid_provider", "提供商配置不能为空");
  if (!SUPPORTED_PROTOCOLS.has(provider.protocol)) throw new ProviderClientError("invalid_provider", "该提供商协议不能由 HTTP 客户端运行");
  const forbidden = ["apiKey", "accessToken", "authorization", "headers", "customHeaders"];
  if (forbidden.some((field) => Object.hasOwn(provider, field))) {
    throw new ProviderClientError("unsafe_credentials", "提供商配置不能包含明文密钥或自定义请求头");
  }
  if (provider.secretRef != null
    && (typeof provider.secretRef !== "string" || !/^[a-z][a-z0-9+.-]*:[^\s]+$/iu.test(provider.secretRef))) {
    throw new ProviderClientError("invalid_secret_ref", "提供商只能使用有效的密钥引用，不能保存明文密钥");
  }
  // Resolve once at construction so an unsafe URL fails before any credential is read.
  resolveProviderEndpoint(provider, "models");
  resolveProviderEndpoint(provider, "chat");
}

function normalizeImageDataUrl(value) {
  if (typeof value !== "string" || !IMAGE_DATA_URL_PATTERN.test(value)) {
    throw new ProviderClientError("invalid_request", "图片必须是受支持的 data: 图片，不能使用远程地址");
  }
  if (byteLength(value) > MAX_IMAGE_DATA_URL_BYTES) throw new ProviderClientError("request_too_large", "单张图片超过安全上限");
  return value;
}

function validateToolCallId(value, code = "invalid_request") {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,300}$/u.test(value)
    || byteLength(value) > 300) {
    throw new ProviderClientError(code, "工具调用编号必须是非空、有效且不超过 300 字节的文本");
  }
  return value;
}

function validateUniqueToolCallIds(calls, code = "invalid_response") {
  const ids = new Set();
  for (const call of calls) {
    const id = validateToolCallId(call?.id, code);
    if (ids.has(id)) throw new ProviderClientError(code, "单轮模型响应包含重复的工具调用编号");
    ids.add(id);
  }
  return calls;
}

function normalizeResponsesOutputItems(items, { source = "request" } = {}) {
  const providerOutput = source === "response";
  const errorCode = providerOutput ? "response_too_large" : "invalid_request";
  if (!Array.isArray(items) || items.length > MAX_RESPONSES_OUTPUT_ITEMS) {
    throw new ProviderClientError(
      providerOutput ? "response_too_large" : "invalid_request",
      "Responses 可续轮输出项数量超过安全上限",
    );
  }
  const allowed = new Set(["message", "reasoning", "function_call"]);
  const output = [];
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !allowed.has(item.type)) {
      if (providerOutput) continue;
      throw new ProviderClientError("invalid_request", "Responses 续轮输出项包含不支持的类型");
    }
    if (item.status && item.status !== "completed") {
      if (providerOutput) continue;
      throw new ProviderClientError("invalid_request", "Responses 续轮不能包含未完成的输出项");
    }
    if (item.type === "function_call") {
      const callId = validateToolCallId(item.call_id, providerOutput ? "invalid_response" : "invalid_request");
      if (ids.has(callId)) {
        throw new ProviderClientError(
          providerOutput ? "invalid_response" : "invalid_request",
          "Responses 输出项包含重复的工具调用编号",
        );
      }
      ids.add(callId);
      validateToolName(item.name);
      safeArgumentString(item.arguments ?? "");
    }
    const serializedItem = safeJsonStringify(
      item,
      MAX_RESPONSES_OUTPUT_ITEMS_BYTES,
      providerOutput ? "response_too_large" : "request_too_large",
    );
    output.push(JSON.parse(serializedItem));
  }
  if (output.length > MAX_RESPONSES_OUTPUT_ITEMS) {
    throw new ProviderClientError(errorCode, "Responses 可续轮输出项数量超过安全上限");
  }
  safeJsonStringify(
    output,
    MAX_RESPONSES_OUTPUT_ITEMS_BYTES,
    providerOutput ? "response_too_large" : "request_too_large",
  );
  return output;
}

function normalizeResponsesCitation(annotation) {
  if (annotation?.type !== "url_citation" || typeof annotation.url !== "string") return null;
  let url;
  try {
    url = new URL(annotation.url);
  } catch {
    return null;
  }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) return null;
  if (typeof annotation.title === "string" && byteLength(annotation.title) > 500) {
    throw new ProviderClientError("response_too_large", "模型返回的引用标题超过安全上限");
  }
  const citation = {
    url: url.href,
    title: typeof annotation.title === "string"
      ? annotation.title
      : "",
  };
  if (Number.isInteger(annotation.start_index) && annotation.start_index >= 0) {
    citation.startIndex = annotation.start_index;
  }
  if (Number.isInteger(annotation.end_index) && annotation.end_index >= 0) {
    citation.endIndex = annotation.end_index;
  }
  return citation;
}

function responsesCitations(output) {
  const citations = [];
  for (const item of Array.isArray(output) ? output : []) {
    if (item?.type !== "message") continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      for (const annotation of Array.isArray(content?.annotations) ? content.annotations : []) {
        const citation = normalizeResponsesCitation(annotation);
        if (!citation) continue;
        citations.push(citation);
        if (citations.length > MAX_RESPONSES_CITATIONS) {
          throw new ProviderClientError("response_too_large", "模型返回的引用数量超过安全上限");
        }
      }
    }
  }
  return citations;
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ProviderClientError("invalid_request", "对话历史不能为空");
  }
  let imageCount = 0;
  const normalized = messages.map((message) => {
    if (!message || !ALLOWED_ROLES.has(message.role)) {
      throw new ProviderClientError("invalid_request", "对话包含不支持的消息角色");
    }
    const output = { role: message.role };
    if (message.content == null && message.role === "assistant") output.content = null;
    else if (Array.isArray(message.content)) {
      if (message.role !== "user") throw new ProviderClientError("invalid_request", "图片只能放在用户消息中");
      if (!message.content.length) throw new ProviderClientError("invalid_request", "用户消息内容不能为空");
      output.content = message.content.map((part) => {
        if (part?.type === "text") return { type: "text", text: boundedText(part.text, 500_000, "消息内容") };
        if (part?.type === "image") {
          imageCount += 1;
          if (imageCount > MAX_IMAGES_PER_REQUEST) throw new ProviderClientError("invalid_request", `每次最多上传 ${MAX_IMAGES_PER_REQUEST} 张图片`);
          return { type: "image", dataUrl: normalizeImageDataUrl(part.dataUrl) };
        }
        throw new ProviderClientError("invalid_request", "用户消息包含不支持的多媒体类型");
      });
    } else output.content = boundedText(message.content, 500_000, "消息内容");

    if (message.role === "tool") {
      output.tool_call_id = validateToolCallId(message.tool_call_id, "invalid_request");
      if (typeof message.name === "string" && message.name) output.name = boundedText(message.name, 100, "工具名称");
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      output.tool_calls = message.tool_calls.map((call) => ({
        id: validateToolCallId(call?.id, "invalid_request"),
        type: "function",
        function: {
          name: validateToolName(call?.function?.name),
          arguments: safeArgumentString(call?.function?.arguments ?? ""),
        },
      }));
      validateUniqueToolCallIds(output.tool_calls, "invalid_request");
    }
    if (message.role === "assistant" && message.responsesOutputItems !== undefined) {
      output.responsesOutputItems = normalizeResponsesOutputItems(message.responsesOutputItems);
    }
    if (message.role === "assistant" && typeof message.reasoning_content === "string") {
      output.reasoning_content = boundedText(message.reasoning_content, 500_000, "推理回传内容");
    }
    return output;
  });
  safeJsonStringify(normalized, MAX_REQUEST_BYTES);
  return normalized;
}

function validateToolName(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(value)) {
    throw new ProviderClientError("invalid_request", "受控工具名称格式不正确");
  }
  return value;
}

function normalizeTools(tools, protocol) {
  if (tools == null) return undefined;
  if (!Array.isArray(tools) || tools.length > 128) {
    throw new ProviderClientError("invalid_request", "受控工具列表格式不正确");
  }
  const normalized = tools.map((tool) => {
    const name = validateToolName(tool?.name);
    const description = boundedText(tool?.description || "", 2_000, "工具说明");
    const schema = tool?.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
      ? tool.inputSchema
      : { type: "object", properties: {} };
    safeJsonStringify(schema, 256 * 1024);
    if (protocol === "openai-responses") {
      return { type: "function", name, description, parameters: schema };
    }
    return { type: "function", function: { name, description, parameters: schema } };
  });
  return normalized;
}

function toResponsesInput(messages) {
  const input = [];
  for (const message of messages) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: message.content,
      });
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.responsesOutputItems)) {
      input.push(...message.responsesOutputItems);
      continue;
    }
    if (message.content != null && (message.content !== "" || !message.tool_calls?.length)) {
      const content = Array.isArray(message.content)
        ? message.content.map((part) => part.type === "text"
          ? { type: "input_text", text: part.text }
          : { type: "input_image", image_url: part.dataUrl })
        : message.content;
      input.push({ role: message.role, content });
    }
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    }
  }
  return input;
}

function toChatMessages(messages) {
  return messages.map((message) => ({
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((part) => part.type === "text"
        ? { type: "text", text: part.text }
        : { type: "image_url", image_url: { url: part.dataUrl } })
      : message.content,
  }));
}

function safeArgumentString(value) {
  const stringValue = typeof value === "string" ? value : safeJsonStringify(value, MAX_TOOL_ARGUMENT_BYTES, "response_too_large");
  if (byteLength(stringValue) > MAX_TOOL_ARGUMENT_BYTES) {
    throw new ProviderClientError("response_too_large", "模型返回的工具参数超过安全上限");
  }
  return stringValue;
}

function toolCall(id, name, args) {
  return {
    id: validateToolCallId(id, "invalid_response"),
    name: validateToolName(name),
    arguments: safeArgumentString(args),
    argumentsTrusted: false,
  };
}

async function readBoundedBody(response, maximum, signal = null, onProgress = null) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new ProviderClientError("response_too_large", "API 返回内容超过安全上限");
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (byteLength(text) > maximum) throw new ProviderClientError("response_too_large", "API 返回内容超过安全上限");
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  try {
    while (true) {
      const { done, value } = await awaitWithSignal(reader.read(), signal);
      if (done) break;
      onProgress?.();
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new ProviderClientError("response_too_large", "API 返回内容超过安全上限");
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    if (signal?.aborted) await reader.cancel().catch(() => {});
    reader.releaseLock?.();
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    let hint = "";
    try {
      const raw = String(text == null ? "" : text);
      const os = require("os");
      const fsx = require("fs");
      const pathx = require("path");
      const stampx = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
      const dumpDir = pathx.join(os.homedir(), "Desktop", "xz-recovered", "provider-dumps");
      fsx.mkdirSync(dumpDir, { recursive: true });
      const dumpFile = pathx.join(dumpDir, `invalid-json-${stampx}.txt`);
      const head = raw.slice(0, 400).replace(/\s+/gu, " ");
      fsx.writeFileSync(dumpFile, [
        `# 时间 ${new Date().toISOString()}`,
        `# 长度 ${raw.length} 字符`,
        `# 前 400 字符（压缩空白）: ${head}`,
        "# ---- 原始响应体 ----",
        raw,
      ].join("\n"), "utf8");
      hint = `（长度 ${raw.length}；开头：${head.slice(0, 120)}；已存档 ${dumpFile}）`;
    } catch {
      hint = "";
    }
    throw new ProviderClientError("invalid_response", `模型 API 返回了无效的 JSON${hint}`);
  }
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  const parts = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (item?.type !== "message") continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if ((content?.type === "output_text" || content?.type === "text") && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("");
}

function extractChatText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.map((part) => typeof part?.text === "string" ? part.text : "").join("");
}

function parseSseBlock(block) {
  let event = "message";
  const data = [];
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
  }
  return { event, data: data.join("\n") };
}

async function* readSse(response, signal, onProgress = null) {
  if (!response.body?.getReader) throw new ProviderClientError("invalid_response", "模型 API 没有返回可读取的数据流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let buffer = "";
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await awaitWithSignal(reader.read(), signal);
      if (done) break;
      onProgress?.();
      total += value.byteLength;
      if (total > MAX_SSE_BYTES) throw new ProviderClientError("response_too_large", "流式返回内容超过安全上限");
      buffer += decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/u.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (byteLength(block) > MAX_SSE_EVENT_BYTES) throw new ProviderClientError("response_too_large", "单个流式事件超过安全上限");
        if (block.trim()) yield parseSseBlock(block);
      }
      if (byteLength(buffer) > MAX_SSE_EVENT_BYTES) throw new ProviderClientError("response_too_large", "单个流式事件超过安全上限");
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield parseSseBlock(buffer);
  } finally {
    if (signal.aborted) await reader.cancel().catch(() => {});
    reader.releaseLock?.();
  }
}

// Some OpenAI-compatible gateways stream the answer but label the response
// "application/json" (or omit the header), so the streaming branch is skipped and
// the whole SSE transcript arrives as one string. Detect that shape and fold the
// deltas back into a single chat-completions payload instead of failing to parse.
function looksLikeSseTranscript(text) {
  return /^\s*(?:data:|event:|:)/u.test(String(text || ""));
}

function chatPayloadFromSseTranscript(text) {
  const blocks = String(text || "").split(/\r?\n\r?\n/u);
  let content = "";
  let reasoningContent = "";
  let finishReason = null;
  let usage = null;
  let responseId = null;
  let actualModel = null;
  let streamDone = false;
  const toolParts = new Map();
  let sawPayload = false;
  for (const block of blocks) {
    if (!block.trim()) continue;
    const packet = parseSseBlock(block);
    if (packet.data?.trim() === "[DONE]") { streamDone = true; continue; }
    if (!packet.data) continue;
    let payload;
    try {
      payload = JSON.parse(packet.data);
    } catch {
      continue;
    }
    if (!payload || typeof payload !== "object") continue;
    sawPayload = true;
    if (payload.error) return { error: payload.error };
    if (typeof payload.id === "string" && payload.id) responseId = payload.id;
    if (typeof payload.model === "string" && payload.model.trim()) actualModel = payload.model;
    if (payload.usage && typeof payload.usage === "object" && !Array.isArray(payload.usage)) {
      usage = payload.usage;
    }
    for (const choice of Array.isArray(payload.choices) ? payload.choices : []) {
      if (choice?.index != null && choice.index !== 0) continue;
      const delta = choice?.delta || {};
      if (typeof delta.content === "string") content += delta.content;
      else if (typeof choice?.message?.content === "string") content += choice.message.content;
      if (typeof delta.reasoning_content === "string") reasoningContent += delta.reasoning_content;
      if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
      for (const part of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const key = Number.isInteger(part?.index) ? part.index : toolParts.size;
        const current = toolParts.get(key) || { id: "", type: "function", function: { name: "", arguments: "" } };
        if (typeof part?.id === "string") current.id += part.id;
        if (typeof part?.function?.name === "string") current.function.name += part.function.name;
        if (typeof part?.function?.arguments === "string") current.function.arguments += part.function.arguments;
        toolParts.set(key, current);
      }
    }
  }
  if (!sawPayload) return null;
  const message = { role: "assistant", content };
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (toolParts.size) message.tool_calls = [...toolParts.values()];
  return {
    id: responseId,
    model: actualModel,
    streamDone,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

function responseToolCalls(payload) {
  const calls = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (item?.type === "function_call") calls.push(toolCall(item.call_id, item.name, item.arguments));
  }
  return validateUniqueToolCallIds(calls, "invalid_response");
}

function chatToolCalls(payload) {
  const calls = payload?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return validateUniqueToolCallIds(calls
    .filter((call) => call?.type == null || call.type === "function")
    .map((call) => toolCall(call.id, call.function?.name, call.function?.arguments)), "invalid_response");
}

function buildBody(protocol, input, providerId = null) {
  const requestedModel = boundedText(input.model || "", 300, "模型名称").trim();
  const model = canonicalProviderModelId(providerId, requestedModel);
  if (!model) throw new ProviderClientError("invalid_request", "模型名称不能为空");
  const messages = normalizeMessages(input.messages);
  const tools = normalizeTools(input.tools, protocol);
  const body = protocol === "openai-responses"
    ? { model, input: toResponsesInput(messages), stream: input.stream === true, store: false }
    : { model, messages: toChatMessages(messages), stream: input.stream === true };
  if (tools?.length) body.tools = tools;
  applyReasoningControls(body, protocol, providerId, model, input);
  safeJsonStringify(body, MAX_REQUEST_BYTES);
  return body;
}

// 哪些内置 provider 的端点接受推理参数。自定义兼容端点会尝试发送，
// 但其服务端支持情况无法从本地配置验证；不支持时保留服务端错误，不盲目重发。
const PROVIDER_REASONING_SUPPORT = Object.freeze({
  openai: true,
  deepseek: true,
  custom: true,
  kimi: false,
});

const REASONING_EFFORT_VALUES = Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]);
const VERBOSITY_VALUES = Object.freeze(["low", "medium", "high"]);

// 旧版 Claude 系模型经由 OpenAI 兼容中转站时，扩展思考的预算由中转站自行补上，
// 而 max_tokens 若不由我们指定，中转站的默认值常常小于它自己设定的预算，
// Anthropic 会直接 400 拒绝：
//   `max_tokens` must be greater than `thinking.budget_tokens`
// 所以对 Claude 系模型显式给出足够大的输出上限，保证约束成立。
// 同时把思考预算也明确交出去：中转站自设的预算大小不可控，可能大到让单轮
// 思考拖过网关的承受时间而被中途掐断。保留扩展思考，但给它一个确定的上界。
const CLAUDE_MODEL_PATTERN = /^claude[-_.]/i;
const CLAUDE_MAX_TOKENS = 32_000;
const CLAUDE_THINKING_BUDGET = 10_000;

function isModernClaudeModel(model) {
  const match = String(model || "").toLowerCase().match(
    /^claude[-_.](?:opus|sonnet|haiku)[-_.](\d+)[-_.](\d+)(?:[-_.]|$)/u,
  );
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor)
    && ((major === 4 && minor >= 6) || major === 5);
}

// 把本轮的推理档位写进请求体。
// 关键：chat/completions 用顶层 reasoning_effort，Responses 用 reasoning.effort，
// 两者结构不同，不能互相照搬。
function applyReasoningControls(body, protocol, providerId, model, input) {
  const effort = REASONING_EFFORT_VALUES.includes(input?.reasoningEffort)
    ? input.reasoningEffort : null;
  const verbosity = VERBOSITY_VALUES.includes(input?.verbosity)
    ? input.verbosity : null;
  const supported = PROVIDER_REASONING_SUPPORT[providerId] === true
    || /^custom(?:-[0-9]{1,3})?$/u.test(String(providerId || ""));
  // 刻意不发 max_tokens / max_output_tokens。原代码从不发这个字段，一直用端点默认上限；
  // 主动写一个数值等于凭空引入截断风险，而“想得更深”靠的是 thinking + reasoning_effort。

  if (protocol === "openai-responses") {
    if (supported && effort) body.reasoning = { effort };
    if (supported && verbosity) body.text = { ...(body.text || {}), verbosity };
    return;
  }

  if (protocol !== "openai-chat-completions") return;

  // xhigh 只在 Codex / 部分 Responses 模型上存在；DeepSeek 档位在统一解析层已换成本地原生值。
  // 其余 chat/completions 中转端通常只认 low/medium/high，故将残余 xhigh 降到 high。
  const chatEffort = effort === "xhigh" ? "high" : effort;

  if (usesDeepSeekV4Family(providerId, model)) {
    // DeepSeek V4 家族默认就开思考模式，effort 默认 high。
    // 原来这里写死 disabled，等于把推理模型降级成普通模型 —— 现在按档位放开。
    // 只有明确要“快”的时候才关掉，省钱省延迟。
    body.thinking = chatEffort === "none" ? { type: "disabled" } : { type: "enabled" };
  }
  // 旧版 Claude 系模型：保留扩展思考，但把思考预算交给我们自己明确给出。
  // 中转站自设的预算大小不可控，会引发两种失败：
  //   ① 预算大于它自己的默认 max_tokens —— Anthropic 直接 400：
  //      `max_tokens` must be greater than `thinking.budget_tokens`
  //   ② 预算大到让单轮思考拖过网关的承受时间 —— 连接被中途掐断（Failed to fetch）
  // 因此同时显式给出 thinking.budget_tokens 与更大的 max_tokens。
  // Claude 4.6+/5.x 改用 output_config.effort，不发送 thinking 或顶层 reasoning_effort。
  const isClaudeModel = CLAUDE_MODEL_PATTERN.test(String(model || ""));
  const isModernClaude = isClaudeModel && isModernClaudeModel(model);
  if (isClaudeModel) {
    if (isModernClaude) {
      const claudeEffort = effort === "none" ? "low" : chatEffort;
      if (supported && claudeEffort) {
        body.output_config = { ...(body.output_config || {}), effort: claudeEffort };
      }
    } else {
      body.thinking = { type: "enabled", budget_tokens: CLAUDE_THINKING_BUDGET };
    }
    body.max_tokens = CLAUDE_MAX_TOKENS;
  }
  if (supported && chatEffort && !isModernClaude) body.reasoning_effort = chatEffort;
}

function providerPayloadError(payload) {
  const error = payload?.error;
  const code = typeof error?.code === "string" || typeof error?.code === "number"
    ? String(error.code).slice(0, 160) : "";
  const type = typeof error?.type === "string" ? error.type.slice(0, 160) : "";
  const details = typeof error?.message === "string"
    ? error.message.slice(0, MAX_ERROR_BYTES) : "未知错误";
  const identity = [code, type].filter(Boolean).join(" / ");
  return new ProviderClientError(
    "provider_error",
    redact(`模型 API 返回错误${identity ? `（${identity}）` : ""}：${details}`),
    { retryable: /(?:rate|timeout|overload|unavailable|server)/iu.test(`${code} ${type} ${details}`) },
  );
}

function awaitWithSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener?.("abort", onAbort);
    signal.addEventListener?.("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function validateTurnInput(input) {
  if (!input || typeof input !== "object") throw new ProviderClientError("invalid_request", "对话请求不能为空");
  const forbidden = ["headers", "customHeaders", "apiKey", "authorization"];
  if (forbidden.some((field) => Object.hasOwn(input, field))) {
    throw new ProviderClientError("unsafe_headers", "对话请求不能传入自定义请求头或明文凭据");
  }
}

class ProviderClient {
  constructor(provider, options = {}) {
    validateProvider(provider);
    this.provider = { ...provider };
    // Browser/Electron fetch is a Web IDL method and some runtimes require its
    // original global receiver. An injected test/server fetch is already an
    // ordinary callable and must keep its own behavior.
    this.fetch = options.fetch || globalThis.fetch?.bind(globalThis);
    this.resolveSecret = options.resolveSecret;
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.modelListTimeoutMs = Number.isFinite(options.modelListTimeoutMs)
      ? options.modelListTimeoutMs
      : Number.isFinite(options.timeoutMs)
        ? options.timeoutMs
        : DEFAULT_MODEL_LIST_TIMEOUT_MS;
    if (typeof this.fetch !== "function") throw new ProviderClientError("missing_fetch", "当前运行环境不支持模型 API 连接");
    if (provider.secretRef && typeof this.resolveSecret !== "function") {
      throw new ProviderClientError("missing_secret_resolver", "未配置安全的密钥读取方式");
    }
  }

  async _resolveSecret(signal) {
    if (!this.provider.secretRef) return null;
    let secret;
    try {
      secret = await awaitWithSignal(this.resolveSecret(this.provider.secretRef), signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const sourceMessage = typeof error?.message === "string" ? error.message : "";
      const safeHint = /^尚未配置 [A-Z][A-Z0-9_]{1,63}；请在行知设置中安全保存 API Key$/u.test(sourceMessage)
        ? sourceMessage : "";
      throw new ProviderClientError(
        "secret_unavailable",
        safeHint ? `无法读取提供商密钥：${safeHint}` : "无法读取提供商密钥",
      );
    }
    if (typeof secret !== "string" || secret.length === 0 || secret.length > 8_192 || /[\r\n]/u.test(secret)) {
      throw new ProviderClientError("secret_unavailable", "提供商密钥不可用");
    }
    return secret;
  }

  async _fetch(operation, init, signal) {
    const endpoint = resolveProviderEndpoint(this.provider, operation);
    if (signal?.aborted) throw signal.reason;
    const secret = await this._resolveSecret(signal);
    if (signal?.aborted) throw signal.reason;
    const headers = { Accept: init.accept || "application/json" };
    if (secret) headers.Authorization = `Bearer ${secret}`;
    if (init.body != null) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await this.fetch(endpoint, {
        method: init.method,
        headers,
        ...(init.body != null ? { body: init.body } : {}),
        redirect: "manual",
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw normalizeError(error, secret ? [secret] : []);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get?.("location");
      let differentOrigin = true;
      try {
        differentOrigin = !location || new URL(location, endpoint).origin !== new URL(endpoint).origin;
      } catch {
        differentOrigin = true;
      }
      throw new ProviderClientError(
        differentOrigin ? "unsafe_redirect" : "redirect_refused",
        differentOrigin ? "模型 API 试图重定向到其他站点，已拒绝转发凭据" : "模型 API 返回了重定向，固定端点不会自动跟随",
        { status: response.status },
      );
    }
    if (!response.ok) {
      let details = "";
      try {
        details = await readBoundedBody(response, MAX_ERROR_BYTES, signal);
      } catch {
        details = "";
      }
      const message = details ? `模型 API 请求失败（${response.status}）：${redact(details, secret ? [secret] : [])}` : `模型 API 请求失败（${response.status}）`;
      throw new ProviderClientError("http_error", message, {
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    const contentType = response.headers?.get?.("content-type") || "";
    const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
    if (mediaType === "text/html" || mediaType === "application/xhtml+xml") {
      throw new ProviderClientError(
        "endpoint_html",
        `模型 API 返回了 HTML 网页，而不是模型接口（${endpoint}）；请检查 API 基础地址，确认路径是否需要 /v1。`,
        { status: response.status, retryable: false },
      );
    }
    return response;
  }

  async listModels(options = {}) {
    if (options && Object.keys(options).some((key) => !new Set(["signal", "timeoutMs"]).has(key))) {
      throw new ProviderClientError("unsafe_headers", "模型列表请求不接受自定义选项");
    }
    const controller = new AbortController();
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : this.modelListTimeoutMs;
    const onExternalAbort = () => {
      if (!controller.signal.aborted) controller.abort({ kind: "cancelled" });
    };
    if (options.signal?.aborted) onExternalAbort();
    else options.signal?.addEventListener?.("abort", onExternalAbort, { once: true });
    const timer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort({ kind: "timeout" });
    }, Math.max(1, timeoutMs));
    timer.unref?.();
    try {
      const response = await this._fetch("models", { method: "GET" }, controller.signal);
      const payload = parseJson(await readBoundedBody(response, MAX_JSON_BYTES, controller.signal));
      return normalizeModelList(payload, this.provider.id);
    } catch (error) {
      if (controller.signal.aborted) {
        const timedOut = controller.signal.reason?.kind === "timeout";
        throw new ProviderClientError(
          timedOut ? "timeout" : "cancelled",
          timedOut ? "模型列表请求超时" : "模型列表请求已取消",
          { retryable: timedOut },
        );
      }
      throw normalizeError(error);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener?.("abort", onExternalAbort);
    }
  }

  sendTurn(input) {
    validateTurnInput(input);
    const body = buildBody(this.provider.protocol, input, this.provider.id);
    if (body.stream === true
      && this.provider.protocol === "openai-chat-completions"
      && !/^custom(?:-[0-9]{1,3})?$/u.test(String(this.provider.id || ""))) {
      body.stream_options = { include_usage: true };
    }
    const bodyText = safeJsonStringify(body, MAX_REQUEST_BYTES);
    const controller = new AbortController();
    const externalSignal = input.signal;
    const cancel = () => {
      if (!controller.signal.aborted) controller.abort({ kind: "cancelled" });
    };
    const onExternalAbort = () => cancel();
    if (externalSignal?.aborted) cancel();
    else externalSignal?.addEventListener?.("abort", onExternalAbort, { once: true });

    const inner = this._sendTurn(body, bodyText, controller, input.timeoutMs);
    const iterator = (async function* turnIterator() {
      let completed = false;
      try {
        yield* inner;
        completed = true;
      } finally {
        if (!completed) cancel();
        externalSignal?.removeEventListener?.("abort", onExternalAbort);
      }
    }());
    iterator.cancel = cancel;
    return iterator;
  }

  async *_sendTurn(body, bodyText, controller, requestedTimeout) {
    const timeoutMs = Number.isFinite(requestedTimeout) ? requestedTimeout : this.timeoutMs;
    let inactivityTimer = null;
    const renewInactivityTimer = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        if (!controller.signal.aborted) controller.abort({ kind: "timeout" });
      }, Math.max(1, timeoutMs));
      inactivityTimer.unref?.();
    };
    renewInactivityTimer();
    const durationTimer = setTimeout(() => {
      if (!controller.signal.aborted) controller.abort({ kind: "duration-limit" });
    }, MAX_TURN_DURATION_MS);
    durationTimer.unref?.();
    try {
      const response = await this._fetch("chat", {
        method: "POST",
        body: bodyText,
        accept: body.stream ? "text/event-stream" : "application/json",
      }, controller.signal);
      renewInactivityTimer();
      const contentType = response.headers?.get?.("content-type") || "";
      if (body.stream && /text\/event-stream/iu.test(contentType)) {
        if (this.provider.protocol === "openai-responses") {
          yield* this._streamResponses(response, controller.signal, renewInactivityTimer);
        } else {
          yield* this._streamChat(response, controller.signal, renewInactivityTimer);
        }
        return;
      }
      const rawBody = await readBoundedBody(
        response,
        MAX_JSON_BYTES,
        controller.signal,
        renewInactivityTimer,
      );
      // Gateways that stream without declaring "text/event-stream" land here with a
      // full SSE transcript; recover the deltas rather than rejecting the response.
      const recoveredStream = looksLikeSseTranscript(rawBody);
      const payload = recoveredStream
        ? (chatPayloadFromSseTranscript(rawBody) ?? parseJson(rawBody))
        : parseJson(rawBody);
      if (payload?.error && this.provider.protocol !== "openai-responses") {
        throw providerPayloadError(payload);
      }
      if (this.provider.protocol === "openai-responses") {
        const outputText = extractResponseText(payload);
        if (outputText) yield { type: "delta", delta: outputText };
        const responseStatus = completionValue(payload?.status) || (payload?.error ? "failed" : null);
        const providerCompletion = normalizeProviderCompletion({
          responseStatus,
          incompleteReason: responseStatus === "completed"
            ? null
            : responseIncompleteReason(payload, responseStatus ? "non_completed_status" : "missing_terminal_signal"),
          actualModel: payload?.model,
        });
        if (providerCompletion.responseStatus !== "completed") {
          throw incompleteCompletionError(providerCompletion, this.provider.protocol);
        }
        const responseOutput = Array.isArray(payload?.output) ? payload.output : [];
        const completedCalls = responseToolCalls({ output: responseOutput });
        const responsesOutputItems = normalizeResponsesOutputItems(responseOutput, { source: "response" });
        const citations = responsesCitations(responseOutput);
        for (const call of completedCalls) yield { type: "tool-call", toolCall: call };
        yield {
          type: "completed",
          outputText,
          responseId: payload.id || null,
          usage: payload.usage || null,
          responsesOutputItems,
          citations,
          providerCompletion,
        };
      } else {
        const message = payload?.choices?.[0]?.message;
        const outputText = extractChatText(message);
        const finishReason = completionValue(payload?.choices?.[0]?.finish_reason);
        const reasoningContent = typeof message?.reasoning_content === "string"
          ? message.reasoning_content : "";
        if (outputText) yield { type: "delta", delta: outputText };
        const providerCompletion = normalizeProviderCompletion({
          finishReason,
          incompleteReason: recoveredStream && payload?.streamDone !== true
            ? "missing_terminal_signal"
            : CHAT_SUCCESS_FINISH_REASONS.has(finishReason)
            ? null
            : (finishReason || "missing_terminal_signal"),
          actualModel: payload?.model,
        });
        if (providerCompletion.incompleteReason || !CHAT_SUCCESS_FINISH_REASONS.has(finishReason)) {
          throw incompleteCompletionError(providerCompletion, this.provider.protocol);
        }
        for (const call of chatToolCalls(payload)) yield { type: "tool-call", toolCall: call };
        yield {
          type: "completed",
          outputText,
          finishReason,
          responseId: payload?.id || null,
          usage: payload?.usage || null,
          providerCompletion,
          ...(reasoningContent ? { reasoningContent } : {}),
        };
      }
    } catch (error) {
      let normalized;
      if (controller.signal.aborted) {
        const timedOut = controller.signal.reason?.kind === "timeout";
        const durationLimited = controller.signal.reason?.kind === "duration-limit";
        normalized = new ProviderClientError(
          timedOut ? "timeout" : durationLimited ? "duration_limit" : "cancelled",
          timedOut
            ? "模型 API 长时间没有返回新内容，已停止等待"
            : durationLimited
              ? "模型 API 单轮处理超过 30 分钟安全上限，已停止"
              : "模型 API 请求已取消",
          { retryable: timedOut || durationLimited },
        );
      } else {
        normalized = normalizeError(error);
      }
      yield {
        type: "error",
        error: publicError(normalized),
        ...(normalized.providerCompletion ? { providerCompletion: normalized.providerCompletion } : {}),
      };
    } finally {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      clearTimeout(durationTimer);
    }
  }

  async *_streamChat(response, signal, onProgress = null) {
    const calls = new Map();
    let outputText = "";
    let reasoningContent = "";
    let finishReason = null;
    let actualModel = null;
    let usage = null;
    let done = false;
    for await (const packet of readSse(response, signal, onProgress)) {
      if (!packet.data) continue;
      if (packet.data.trim() === "[DONE]") {
        done = true;
        break;
      }
      // Keep-alive comments and non-JSON padding from proxies must not abort a turn
      // that is otherwise streaming correctly.
      let payload;
      try {
        payload = JSON.parse(packet.data);
      } catch {
        continue;
      }
      if (payload?.error) throw providerPayloadError(payload);
      if (typeof payload?.model === "string" && payload.model.trim()) actualModel = payload.model;
      if (payload?.usage && typeof payload.usage === "object" && !Array.isArray(payload.usage)) {
        usage = payload.usage;
      }
      for (const choice of Array.isArray(payload?.choices) ? payload.choices : []) {
        if (choice.index != null && choice.index !== 0) continue;
        const delta = choice.delta || {};
        if (typeof delta.content === "string" && delta.content) {
          outputText += delta.content;
          yield { type: "delta", delta: delta.content };
        }
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          reasoningContent += delta.reasoning_content;
          if (byteLength(reasoningContent) > MAX_JSON_BYTES) {
            throw new ProviderClientError("response_too_large", "模型返回的推理回传内容超过安全上限");
          }
        }
        for (const part of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const key = Number.isInteger(part.index) ? part.index : calls.size;
          const current = calls.get(key) || { id: "", name: "", arguments: "" };
          if (typeof part.id === "string") current.id += part.id;
          if (typeof part.function?.name === "string") current.name += part.function.name;
          if (typeof part.function?.arguments === "string") current.arguments += part.function.arguments;
          if (byteLength(current.arguments) > MAX_TOOL_ARGUMENT_BYTES) {
            throw new ProviderClientError("response_too_large", "模型返回的工具参数超过安全上限");
          }
          calls.set(key, current);
        }
        if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
      }
    }
    const providerCompletion = normalizeProviderCompletion({
      finishReason,
      incompleteReason: !done
        ? "missing_terminal_signal"
        : CHAT_SUCCESS_FINISH_REASONS.has(finishReason)
          ? null
          : finishReason || "missing_finish_reason",
      actualModel,
    });
    if (!done || !CHAT_SUCCESS_FINISH_REASONS.has(finishReason)) {
      throw incompleteCompletionError(providerCompletion, this.provider.protocol);
    }
    const completedCalls = validateUniqueToolCallIds([...calls.values()]
      .map((current) => toolCall(current.id, current.name, current.arguments)), "invalid_response");
    for (const completedCall of completedCalls) yield { type: "tool-call", toolCall: completedCall };
    yield {
      type: "completed",
      outputText,
      finishReason,
      streamDone: true,
      usage,
      providerCompletion,
      ...(reasoningContent ? { reasoningContent } : {}),
    };
  }

  async *_streamResponses(response, signal, onProgress = null) {
    const outputItems = new Map();
    let outputText = "";
    let completed = false;
    let responseId = null;
    let usage = null;
    let responseStatus = null;
    let actualModel = null;
    let completedCalls = [];
    let responsesOutputItems = [];
    let citations = [];
    for await (const packet of readSse(response, signal, onProgress)) {
      if (!packet.data || packet.data.trim() === "[DONE]") continue;
      const payload = parseJson(packet.data);
      const type = payload.type || packet.event;
      if (typeof payload.response?.model === "string" && payload.response.model.trim()) {
        actualModel = payload.response.model;
      }
      if (typeof payload.response?.status === "string" && payload.response.status.trim()) {
        responseStatus = payload.response.status;
      }
      if (type === "response.failed" || type === "response.incomplete") {
        const status = type === "response.failed" ? "failed" : "incomplete";
        responseStatus = responseStatus || status;
        throw incompleteCompletionError(normalizeProviderCompletion({
          responseStatus,
          incompleteReason: responseIncompleteReason(
            payload.response || payload,
            responseIncompleteReason(payload, status),
          ),
          actualModel,
        }), this.provider.protocol);
      }
      if (type === "error") {
        throw providerPayloadError(payload);
      }
      if (type === "response.output_text.delta" && typeof payload.delta === "string") {
        outputText += payload.delta;
        yield { type: "delta", delta: payload.delta };
      } else if (type === "response.output_item.added" && payload.item && typeof payload.item === "object") {
        const key = Number.isInteger(payload.output_index) ? payload.output_index : outputItems.size;
        outputItems.set(key, payload.item);
      } else if (type === "response.function_call_arguments.delta") {
        const existingKey = Number.isInteger(payload.output_index)
          ? payload.output_index
          : [...outputItems.entries()].find(([, item]) => item?.id === payload.item_id)?.[0];
        const key = existingKey ?? outputItems.size;
        const current = outputItems.get(key) || {
          ...(typeof payload.item_id === "string" ? { id: payload.item_id } : {}),
          type: "function_call",
          ...(typeof payload.call_id === "string" ? { call_id: payload.call_id } : {}),
          name: payload.name || "",
          arguments: "",
        };
        if (typeof payload.call_id === "string" && !current.call_id) current.call_id = payload.call_id;
        if (typeof payload.name === "string" && !current.name) current.name = payload.name;
        if (typeof payload.delta === "string") current.arguments = `${current.arguments || ""}${payload.delta}`;
        if (byteLength(current.arguments || "") > MAX_TOOL_ARGUMENT_BYTES) {
          throw new ProviderClientError("response_too_large", "模型返回的工具参数超过安全上限");
        }
        outputItems.set(key, current);
      } else if (type === "response.output_item.done" && payload.item && typeof payload.item === "object") {
        const key = Number.isInteger(payload.output_index) ? payload.output_index : outputItems.size;
        const current = outputItems.get(key) || {};
        const item = { ...current, ...payload.item };
        if (item.type === "function_call" && byteLength(item.arguments || "") > MAX_TOOL_ARGUMENT_BYTES) {
          throw new ProviderClientError("response_too_large", "模型返回的工具参数超过安全上限");
        }
        outputItems.set(key, item);
      } else if (type === "response.completed") {
        const terminalStatus = completionValue(payload.response?.status) || "completed";
        responseStatus = terminalStatus;
        if (terminalStatus !== "completed") {
          throw incompleteCompletionError(normalizeProviderCompletion({
            responseStatus: terminalStatus,
            incompleteReason: responseIncompleteReason(payload.response, "non_completed_status"),
            actualModel,
          }), this.provider.protocol);
        }
        responseId = payload.response?.id || null;
        if (payload.response?.usage && typeof payload.response.usage === "object"
          && !Array.isArray(payload.response.usage)) {
          usage = payload.response.usage;
        }
        const responseOutput = Array.isArray(payload.response?.output)
          ? payload.response.output
          : [...outputItems.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, item]) => item);
        completedCalls = responseToolCalls({ output: responseOutput });
        responsesOutputItems = normalizeResponsesOutputItems(responseOutput, { source: "response" });
        citations = responsesCitations(responseOutput);
        completed = true;
        break;
      }
    }
    if (!completed) {
      throw incompleteCompletionError(normalizeProviderCompletion({
        responseStatus,
        incompleteReason: "missing_terminal_signal",
        actualModel,
      }), this.provider.protocol);
    }
    for (const completedCall of completedCalls) yield { type: "tool-call", toolCall: completedCall };
    yield {
      type: "completed",
      outputText,
      responseId,
      streamDone: true,
      usage,
      responsesOutputItems,
      citations,
      providerCompletion: normalizeProviderCompletion({
        responseStatus: responseStatus || "completed",
        actualModel,
      }),
    };
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_ERROR_BYTES,
  MAX_JSON_BYTES,
  MAX_REQUEST_BYTES,
  MAX_SSE_BYTES,
  MAX_TOOL_ARGUMENT_BYTES,
  ProviderClient,
  ProviderClientError,
};
