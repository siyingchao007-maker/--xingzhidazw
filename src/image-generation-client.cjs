"use strict";

const { resolveProviderEndpoint } = require("./provider-registry.cjs");

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_PROMPT_CHARACTERS = 8_000;
const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_DECODED_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_ENCODED_IMAGE_CHARACTERS = Math.ceil(MAX_DECODED_IMAGE_BYTES / 3) * 4;
const IMAGE_SIZES = new Set(["auto", "1024x1024", "1536x1024", "1024x1536"]);
const RESPONSE_FORMATS = new Set(["auto", "base64"]);
const FORBIDDEN_PROVIDER_FIELDS = ["apiKey", "accessToken", "authorization", "headers", "customHeaders"];

const ERROR_MESSAGES = Object.freeze({
  invalid_request: "图片生成请求参数无效",
  invalid_config: "图片生成配置无效",
  invalid_provider: "当前连接不能用于图片生成",
  unsafe_credentials: "连接配置不能包含明文密钥或自定义请求头",
  missing_fetch: "当前运行环境不支持图片生成连接",
  unsupported_response_stream: "当前连接不能逐步读取图片响应，已停止以避免超大内容占用内存",
  missing_secret: "无法读取图片生成连接密钥",
  timeout: "图片生成请求超过等待时限",
  cancelled: "图片生成请求已取消",
  network_error: "无法连接图片生成服务",
  redirect_refused: "图片生成服务返回重定向，已拒绝转发凭据",
  url_response_unsupported: "图片生成服务必须返回图片数据，不能返回远程图片地址",
  http_error: "图片生成服务请求失败",
  invalid_content_type: "图片生成服务返回了非 JSON 内容",
  response_too_large: "图片生成服务返回内容超过安全上限",
  invalid_json: "图片生成服务返回了无效 JSON",
  invalid_image: "图片生成服务没有返回有效的 PNG、JPEG 或 WebP 图片",
});

class ImageGenerationError extends Error {
  constructor(code, details = {}) {
    super(ERROR_MESSAGES[code] || "图片生成请求失败");
    this.name = "ImageGenerationError";
    this.code = ERROR_MESSAGES[code] ? code : "network_error";
    if (Number.isInteger(details.status) && details.status >= 100 && details.status <= 599) {
      this.status = details.status;
    }
  }
}

function configError() {
  return new ImageGenerationError("invalid_config");
}

function normalizeImageGenerationConfig(value) {
  if (value == null) value = {};
  if (typeof value !== "object" || Array.isArray(value)) throw configError();
  const allowed = new Set(["providerId", "model", "size", "responseFormat"]);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.has(key))) throw configError();

  const providerId = value.providerId === undefined ? "" : normalizeSettingText(value.providerId, 128);
  const model = value.model === undefined ? "" : normalizeSettingText(value.model, 300);
  if (/^(?:sk-|Bearer\s)/iu.test(model)) throw configError();
  const size = value.size === undefined ? "1024x1024" : value.size;
  const responseFormat = value.responseFormat === undefined ? "auto" : value.responseFormat;
  if (!IMAGE_SIZES.has(size) || !RESPONSE_FORMATS.has(responseFormat)) throw configError();
  return { providerId, model, size, responseFormat };
}

function normalizeSettingText(value, maximumBytes) {
  if (typeof value !== "string") throw configError();
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > maximumBytes || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw configError();
  }
  return normalized;
}

function validateProvider(provider) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
    throw new ImageGenerationError("invalid_provider");
  }
  if (FORBIDDEN_PROVIDER_FIELDS.some((field) => Object.hasOwn(provider, field))) {
    throw new ImageGenerationError("unsafe_credentials");
  }
  if (provider.protocol !== "openai-responses" && provider.protocol !== "openai-chat-completions") {
    throw new ImageGenerationError("invalid_provider");
  }
  if (provider.secretRef != null
    && (typeof provider.secretRef !== "string" || !/^[a-z][a-z0-9+.-]*:[^\s]+$/iu.test(provider.secretRef))) {
    throw new ImageGenerationError("invalid_provider");
  }

  let modelsEndpoint;
  try {
    modelsEndpoint = resolveProviderEndpoint(provider, "models");
  } catch {
    throw new ImageGenerationError("invalid_provider");
  }
  if (!modelsEndpoint.endsWith("/models")) throw new ImageGenerationError("invalid_provider");
  return {
    id: typeof provider.id === "string" ? provider.id : "",
    protocol: provider.protocol,
    secretRef: provider.secretRef || null,
    endpoint: `${modelsEndpoint.slice(0, -"/models".length)}/images/generations`,
  };
}

function abortError(signal) {
  return new ImageGenerationError(signal?.reason?.code === "timeout" ? "timeout" : "cancelled");
}

function awaitWithSignal(value, signal, onLateResolve = null) {
  const promise = Promise.resolve(value);
  if (!signal) return promise;
  if (signal.aborted) {
    promise.then((result) => onLateResolve?.(result), () => {});
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(result);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (result) => {
        if (settled || signal.aborted) {
          onLateResolve?.(result);
          return;
        }
        finish(resolve, result);
      },
      (error) => finish(reject, error),
    );
  });
}

function cancelBody(response) {
  try {
    const result = response?.body?.cancel?.();
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    // Cancellation is best-effort; public errors never include transport details.
  }
}

function cancelReader(reader) {
  try {
    Promise.resolve(reader.cancel()).then(
      () => { try { reader.releaseLock?.(); } catch { /* a pending read may still own the lock */ } },
      () => { try { reader.releaseLock?.(); } catch { /* best-effort cleanup */ } },
    );
  } catch {
    try { reader.releaseLock?.(); } catch { /* best-effort cleanup */ }
  }
}

function responseHeader(response, name) {
  try {
    return response?.headers?.get?.(name) || "";
  } catch {
    return "";
  }
}

async function readBoundedBody(response, maximum, signal) {
  const declared = responseHeader(response, "content-length");
  if (/^\d+$/u.test(declared) && Number(declared) > maximum) {
    cancelBody(response);
    throw new ImageGenerationError("response_too_large");
  }

  const body = response?.body;
  if (body?.getReader) {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const result = await awaitWithSignal(reader.read(), signal);
        if (result.done) break;
        const chunk = Buffer.from(result.value.buffer, result.value.byteOffset, result.value.byteLength);
        total += chunk.byteLength;
        if (total > maximum) {
          cancelReader(reader);
          throw new ImageGenerationError("response_too_large");
        }
        chunks.push(Buffer.from(chunk));
      }
    } catch (error) {
      if (signal.aborted) cancelReader(reader);
      throw error;
    } finally {
      try { reader.releaseLock?.(); } catch { /* a cancelled pending read may still own the lock */ }
    }
    const bytes = Buffer.concat(chunks, total);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ImageGenerationError("invalid_json");
    }
  }

  // Never buffer an unbounded body before checking its size.
  cancelBody(response);
  throw new ImageGenerationError("unsupported_response_stream");
}

function decodeImage(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || !Array.isArray(payload.data) || payload.data.length !== 1) {
    throw new ImageGenerationError("invalid_image");
  }
  const item = payload.data[0];
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new ImageGenerationError("invalid_image");
  }
  if (typeof item.b64_json !== "string" || item.b64_json.length === 0) {
    throw new ImageGenerationError(Object.hasOwn(item, "url") ? "url_response_unsupported" : "invalid_image");
  }

  const encoded = item.b64_json;
  if (encoded.length > MAX_ENCODED_IMAGE_CHARACTERS) throw new ImageGenerationError("response_too_large");
  if (encoded.length === 0 || encoded.length % 4 !== 0) {
    throw new ImageGenerationError("invalid_image");
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decodedLength = (encoded.length / 4) * 3 - padding;
  if (decodedLength > MAX_DECODED_IMAGE_BYTES) throw new ImageGenerationError("response_too_large");
  if (decodedLength <= 0) throw new ImageGenerationError("invalid_image");
  const dataLength = encoded.length - padding;
  if ((padding === 2 && dataLength % 4 !== 2) || (padding === 1 && dataLength % 4 !== 3)) {
    throw new ImageGenerationError("invalid_image");
  }
  for (let index = 0; index < dataLength; index += 1) {
    const code = encoded.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 43 || code === 47)) {
      throw new ImageGenerationError("invalid_image");
    }
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength !== decodedLength || bytes.toString("base64") !== encoded) {
    throw new ImageGenerationError("invalid_image");
  }
  if (bytes.byteLength > MAX_DECODED_IMAGE_BYTES) throw new ImageGenerationError("response_too_large");

  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { bytes, mimeType: "image/png", extension: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { bytes, mimeType: "image/jpeg", extension: "jpeg" };
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return { bytes, mimeType: "image/webp", extension: "webp" };
  }
  throw new ImageGenerationError("invalid_image");
}

function normalizeGenerateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ImageGenerationError("invalid_request");
  }
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0
    || Array.from(input.prompt).length > MAX_PROMPT_CHARACTERS
    || Buffer.byteLength(input.prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new ImageGenerationError("invalid_request");
  }
  let normalized;
  try {
    normalized = normalizeImageGenerationConfig({
      model: input.model,
      size: input.size,
      responseFormat: input.responseFormat,
    });
  } catch {
    throw new ImageGenerationError("invalid_request");
  }
  if (!normalized.model || normalized.model.length > 300) throw new ImageGenerationError("invalid_request");
  return { prompt: input.prompt, ...normalized, signal: input.signal };
}

class ImageGenerationClient {
  constructor(provider, options = {}) {
    this.provider = validateProvider(provider);
    if (typeof options.resolveSecret !== "function" && this.provider.secretRef) {
      throw new ImageGenerationError("missing_secret");
    }
    this.resolveSecret = options.resolveSecret;
    this.fetch = options.fetch || globalThis.fetch?.bind(globalThis);
    if (typeof this.fetch !== "function") throw new ImageGenerationError("missing_fetch");
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  }

  async generate(input) {
    const request = normalizeGenerateInput(input);
    const controller = new AbortController();
    const externalSignal = request.signal;
    const forwardAbort = () => controller.abort({ code: "cancelled" });
    if (externalSignal?.aborted) forwardAbort();
    else externalSignal?.addEventListener?.("abort", forwardAbort, { once: true });
    const timeout = setTimeout(() => controller.abort({ code: "timeout" }), this.timeoutMs);

    try {
      if (controller.signal.aborted) throw abortError(controller.signal);
      let secret = null;
      if (this.provider.secretRef) {
        let secretValue;
        try {
          secretValue = await awaitWithSignal(
            Promise.resolve().then(() => this.resolveSecret(this.provider.secretRef)),
            controller.signal,
          );
        } catch {
          if (controller.signal.aborted) throw abortError(controller.signal);
          throw new ImageGenerationError("missing_secret");
        }
        if (typeof secretValue !== "string" || secretValue.length === 0 || secretValue.length > 8_192 || /[\r\n]/u.test(secretValue)) {
          throw new ImageGenerationError("missing_secret");
        }
        secret = secretValue;
      }
      if (controller.signal.aborted) throw abortError(controller.signal);

      const body = {
        model: request.model,
        prompt: request.prompt,
        n: 1,
        size: request.size,
      };
      if (request.responseFormat === "base64") body.response_format = "b64_json";
      const headers = { Accept: "application/json", "Content-Type": "application/json" };
      if (secret) headers.Authorization = `Bearer ${secret}`;

      let response;
      try {
        response = await awaitWithSignal(this.fetch(this.provider.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          redirect: "manual",
          signal: controller.signal,
        }), controller.signal, cancelBody);
      } catch {
        if (controller.signal.aborted) throw abortError(controller.signal);
        throw new ImageGenerationError("network_error");
      }

      const status = Number(response?.status);
      if (status >= 300 && status < 400) {
        cancelBody(response);
        throw new ImageGenerationError("redirect_refused", { status });
      }
      if (response?.ok === false || (Number.isInteger(status) && (status < 200 || status >= 300))) {
        cancelBody(response);
        throw new ImageGenerationError("http_error", { status });
      }
      const contentType = responseHeader(response, "content-type");
      if (!/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|\s*$)/iu.test(contentType)) {
        cancelBody(response);
        throw new ImageGenerationError("invalid_content_type", { status });
      }

      const responseText = await readBoundedBody(response, MAX_RESPONSE_BYTES, controller.signal);
      let payload;
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new ImageGenerationError("invalid_json", { status });
      }
      return decodeImage(payload);
    } catch (error) {
      if (error instanceof ImageGenerationError) throw error;
      if (controller.signal.aborted) throw abortError(controller.signal);
      throw new ImageGenerationError("network_error");
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener?.("abort", forwardAbort);
    }
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  ImageGenerationClient,
  ImageGenerationError,
  MAX_DECODED_IMAGE_BYTES,
  MAX_PROMPT_BYTES,
  MAX_PROMPT_CHARACTERS,
  MAX_RESPONSE_BYTES,
  normalizeImageGenerationConfig,
};
