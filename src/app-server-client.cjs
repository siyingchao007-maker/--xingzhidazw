const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { promises: fs } = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { resolveAppServerEnvironment } = require("./app-server-proxy.cjs");

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);
const APPROVAL_DECISIONS = Object.freeze(["accept", "acceptForSession", "decline", "cancel"]);
const APPROVAL_DECISION_SET = new Set(APPROVAL_DECISIONS);
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;
const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_APP_SERVER_CONFIG_OVERRIDES = 24;
const MAX_APP_SERVER_CONFIG_OVERRIDE_CHARS = 1_000;
const IMAGE_DATA_URL_PATTERN = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/u;
const CHILD_ENV_ALLOWLIST = Object.freeze([
  "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "PATH", "TEMP", "TMP",
  "LOCALAPPDATA", "APPDATA", "USERPROFILE", "USERNAME", "USERDOMAIN",
  "HOMEDRIVE", "HOMEPATH", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
  "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "LANG", "LC_ALL", "TERM",
  "TERM_PROGRAM", "WT_SESSION", "CODEX_HOME", "HTTPS_PROXY", "HTTP_PROXY",
  "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);

function buildCodexChildEnvironment(environment = process.env) {
  const result = Object.create(null);
  const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = environment?.[name];
    if (typeof value === "string" && value) result[name] = value;
  }
  for (const name of proxyKeys) {
    const value = environment?.[name] ?? environment?.[name.toLowerCase()];
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

function normalizeAppServerConfigOverrides(overrides = []) {
  if (!Array.isArray(overrides) || overrides.length > MAX_APP_SERVER_CONFIG_OVERRIDES) {
    throw new Error("App Server 配置覆盖数量无效");
  }
  return overrides.map((value) => {
    if (typeof value !== "string" || !value.trim()
      || value.length > MAX_APP_SERVER_CONFIG_OVERRIDE_CHARS
      || /[\r\n\0]/u.test(value)) {
      throw new Error("App Server 配置覆盖格式无效");
    }
    return value.trim();
  });
}

function buildAppServerArgs(webSearchMode = "live", configOverrides = []) {
  const args = webSearchMode === "disabled"
    ? ["app-server", "--stdio", "-c", 'web_search="disabled"']
    : ["app-server", "--stdio", "-c", 'web_search="live"', "-c", 'tools.web_search.context_size="high"'];
  for (const override of normalizeAppServerConfigOverrides(configOverrides)) {
    args.push("-c", override);
  }
  return args;
}

function getCodexBinaryCandidates(preferredBinary = "codex", environment = process.env, platform = process.platform) {
  const candidates = [];
  if (preferredBinary && preferredBinary !== "codex") candidates.push(preferredBinary);
  if (platform === "win32" && environment.USERPROFILE) {
    candidates.push(path.join(environment.USERPROFILE, ".codex", ".sandbox-bin", "codex.exe"));
  }
  if (platform === "win32" && environment.APPDATA) {
    candidates.push(path.join(
      environment.APPDATA,
      "npm",
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe",
    ));
  }
  candidates.push(platform === "win32" ? "codex.exe" : "codex");
  return [...new Set(candidates)];
}

async function defaultResolveBinary(preferredBinary = "codex") {
  const candidates = getCodexBinaryCandidates(preferredBinary);
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue to the next known installation location.
    }
  }
  return candidates.at(-1);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}不能为空`);
  }
  return value;
}

function requireAbsoluteRoots(roots) {
  if (!Array.isArray(roots) || roots.length === 0 || roots.some((root) => typeof root !== "string" || !path.isAbsolute(root))) {
    throw new Error("执行模式必须提供至少一个绝对写入根目录");
  }
  return roots;
}

function normalizeRuntimeWorkspaceRoots(roots) {
  if (roots === undefined) return undefined;
  return [...new Set(requireAbsoluteRoots(roots).map((root) => path.resolve(root)))];
}

function normalizeTurnInput(input) {
  const items = typeof input === "string" ? [{ type: "text", text: input }] : input;
  if (!Array.isArray(items) || items.length === 0) throw new Error("回合输入不能为空");
  return items.map((item) => {
    if (!item || typeof item !== "object" || typeof item.type !== "string") throw new Error("回合输入格式无效");
    if (item.type === "text") {
      return { ...item, text: requireNonEmptyString(item.text, "文本输入"), text_elements: Array.isArray(item.text_elements) ? item.text_elements : [] };
    }
    if (item.type === "image") {
      const url = requireNonEmptyString(item.url, "图片输入");
      if (!IMAGE_DATA_URL_PATTERN.test(url) || Buffer.byteLength(url, "utf8") > MAX_IMAGE_INPUT_BYTES) {
        throw new Error("图片输入必须是受支持且未超过安全上限的 data: 图片");
      }
      return { type: "image", url };
    }
    if (item.type === "localImage") {
      const imagePath = requireNonEmptyString(item.path, "本地图片路径");
      if (!path.isAbsolute(imagePath)) throw new Error("本地图片必须使用绝对路径");
      return { type: "localImage", path: imagePath };
    }
    if (item.type === "skill") {
      requireNonEmptyString(item.name, "Skill名称");
      requireNonEmptyString(item.path, "Skill路径");
    }
    return { ...item };
  });
}

function buildThreadSandbox(mode) {
  if (mode === undefined || mode === "dialogue") return "read-only";
  if (mode === "execute") return "workspace-write";
  throw new Error(`不支持的工作模式：${mode}`);
}

function buildTurnSandboxPolicy(mode, writableRoots, networkAccess = false) {
  const allowNetwork = networkAccess === true;
  if (mode === undefined || mode === "dialogue") return { type: "readOnly", networkAccess: allowNetwork };
  if (mode !== "execute") throw new Error(`不支持的工作模式：${mode}`);
  return {
    type: "workspaceWrite",
    writableRoots: requireAbsoluteRoots(writableRoots),
    networkAccess: allowNetwork,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

class CodexAppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.resolveBinary = options.resolveBinary || defaultResolveBinary;
    this.spawnProcess = options.spawnProcess || spawn;
    this.preferredBinary = options.preferredBinary || "codex";
    this.webSearchMode = options.webSearchMode === "disabled" ? "disabled" : "live";
    this.configOverrides = normalizeAppServerConfigOverrides(options.configOverrides || []);
    this.environment = buildCodexChildEnvironment(options.environment || process.env);
    this.resolveEnvironment = options.resolveEnvironment || resolveAppServerEnvironment;
    this.clientInfo = options.clientInfo || { name: "xingzhi_workbench", title: "行知工作台", version: "0.17.6" };
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.child = null;
    this.decoder = null;
    this.stdoutBuffer = "";
    this.stderr = "";
    this.stderrTruncated = false;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.nextRequestId = 1;
    this.generation = 0;
    this.starting = false;
    this.started = false;
    this.stopped = false;
    this.failed = false;
  }

  async start() {
    if (this.stopped) throw new Error("已停止的 App Server 客户端不能重新启动");
    if (this.starting || this.started) throw new Error("App Server 已经启动");

    const generation = this.generation + 1;
    this.generation = generation;
    this.starting = true;
    this.failed = false;
    this.child = null;
    this.decoder = null;
    this.stdoutBuffer = "";
    this.stderr = "";
    this.stderrTruncated = false;
    this._rejectAll(new Error("App Server 正在重新启动"));
    this.serverRequests.clear();

    try {
      const binary = await this.resolveBinary(this.preferredBinary);
      const environment = await this.resolveEnvironment(this.environment);
      if (this.stopped || generation !== this.generation) {
        throw new Error("App Server 启动已取消");
      }
      const appServerArgs = buildAppServerArgs(this.webSearchMode, this.configOverrides);
      const child = this.spawnProcess(binary, appServerArgs, {
        env: environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      this.decoder = new StringDecoder("utf8");
      this.started = true;
      this._bindProcess(child, generation);
      const result = await this._request("initialize", {
        clientInfo: this.clientInfo,
        // Dynamic knowledge tools are exposed by the current Codex App Server as
        // standardTools and are guarded by the experimentalApi capability. We do
        // not opt into experimental history modes, but the capability itself must
        // be declared before a thread containing dynamicTools can be created.
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this._send({ method: "initialized" });
      this.starting = false;
      return result;
    } catch (error) {
      if (!this.stopped && generation === this.generation) {
        this._terminate(error, true, generation);
      }
      throw error;
    }
  }

  listModels(params = {}, requestOptions) {
    return this._request("model/list", params, requestOptions);
  }

  readModelCapacity(model) {
    return require("./codex-model-capacity.cjs").readCodexModelCapacity(this, model);
  }

  listSkills(params = {}, requestOptions) {
    return this._request("skills/list", params, requestOptions);
  }

  setSkillExtraRoots(extraRoots, requestOptions) {
    if (!Array.isArray(extraRoots) || extraRoots.some((root) => typeof root !== "string" || !path.isAbsolute(root))) {
      throw new Error("Skill 额外根目录必须全部是绝对路径");
    }
    return this._request("skills/extraRoots/set", { extraRoots }, requestOptions);
  }

  startThread(options = {}, requestOptions) {
    const runtimeWorkspaceRoots = normalizeRuntimeWorkspaceRoots(options.runtimeWorkspaceRoots);
    const params = {
      ...(options.model ? { model: options.model } : {}),
      ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ephemeral: options.ephemeral === true,
      // Installed codex-cli 0.160.0 ThreadStartParams.config supports this override.
      // Sandbox networkAccess alone does not disable hosted web search.
      ...(options.webSearchMode ? { config: { web_search: options.webSearchMode } } : {}),
      approvalPolicy: options.approvalPolicy || "on-request",
      approvalsReviewer: options.approvalsReviewer || "user",
      sandbox: buildThreadSandbox(options.mode),
      ...(runtimeWorkspaceRoots ? { runtimeWorkspaceRoots } : {}),
      ...(options.baseInstructions ? { baseInstructions: options.baseInstructions } : {}),
      ...(options.developerInstructions ? { developerInstructions: options.developerInstructions } : {}),
      ...(options.dynamicTools ? { dynamicTools: options.dynamicTools } : {}),
    };
    return this._request("thread/start", params, requestOptions);
  }

  resumeThread(threadId, options = {}, requestOptions) {
    requireNonEmptyString(threadId, "threadId");
    const runtimeWorkspaceRoots = normalizeRuntimeWorkspaceRoots(options.runtimeWorkspaceRoots);
    const params = {
      threadId,
      ...(options.model ? { model: options.model } : {}),
      ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      ...(options.approvalsReviewer ? { approvalsReviewer: options.approvalsReviewer } : {}),
      sandbox: buildThreadSandbox(options.mode),
      ...(runtimeWorkspaceRoots ? { runtimeWorkspaceRoots } : {}),
    };
    return this._request("thread/resume", params, requestOptions);
  }

  startTurn(threadId, input, options = {}, requestOptions) {
    requireNonEmptyString(threadId, "threadId");
    const runtimeWorkspaceRoots = normalizeRuntimeWorkspaceRoots(options.runtimeWorkspaceRoots);
    const sandboxPolicy = buildTurnSandboxPolicy(
      options.mode,
      options.writableRoots,
      options.networkAccess,
    );
    const params = {
      threadId,
      input: normalizeTurnInput(input),
      ...(options.clientUserMessageId ? { clientUserMessageId: options.clientUserMessageId } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
      ...(options.approvalsReviewer ? { approvalsReviewer: options.approvalsReviewer } : {}),
      sandboxPolicy,
      ...(runtimeWorkspaceRoots ? { runtimeWorkspaceRoots } : {}),
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
    };
    // This timeout only covers the immediate turn/start acknowledgement. The turn itself
    // remains event-driven and intentionally has no client-side completion timeout.
    return this._request("turn/start", params, requestOptions);
  }

  interruptTurn(threadId, turnId, requestOptions) {
    requireNonEmptyString(threadId, "threadId");
    requireNonEmptyString(turnId, "turnId");
    return this._request("turn/interrupt", { threadId, turnId }, requestOptions);
  }

  respondServerRequest(id, result) {
    if (!this.serverRequests.has(id)) throw new Error(`找不到待处理的服务端请求：${id}`);
    this.serverRequests.delete(id);
    this._send({ id, result });
  }

  rejectServerRequest(id, code = -32601, message = "不支持该服务端请求") {
    if (!this.serverRequests.has(id)) throw new Error(`找不到待处理的服务端请求：${id}`);
    this.serverRequests.delete(id);
    this._send({ id, error: { code, message: String(message).slice(0, 1_000) } });
  }

  respondToApproval(id, decision) {
    if (!APPROVAL_DECISION_SET.has(decision)) throw new Error(`不支持的审批决定：${decision}`);
    const request = this.serverRequests.get(id);
    if (!request || !APPROVAL_METHODS.has(request.method)) throw new Error(`找不到待处理的审批请求：${id}`);
    this.respondServerRequest(id, { decision });
  }

  getDiagnostics() {
    return { stderr: this.stderr, stderrTruncated: this.stderrTruncated };
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.generation += 1;
    this.starting = false;
    this.started = false;
    this.failed = false;
    this._rejectAll(new Error("App Server 已停止"));
    this.serverRequests.clear();
    const child = this.child;
    this.child = null;
    this.decoder = null;
    this.stdoutBuffer = "";
    if (child) {
      try { child.stdin.end(); } catch { /* Best effort. */ }
      try { child.kill(); } catch { /* Best effort. */ }
    }
  }

  _bindProcess(child, generation) {
    child.stdout.on("data", (chunk) => this._onStdout(chunk, generation));
    child.stderr.on("data", (chunk) => this._onStderr(chunk, generation));
    child.on("error", (error) => {
      this._terminate(new Error(`App Server 启动或运行失败：${error.message}`), true, generation);
    });
    child.on("exit", (code, signal) => {
      this._terminate(
        new Error(`App Server 已退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`),
        false,
        generation,
      );
    });
  }

  _request(method, params, options = {}) {
    this._ensureRunning();
    const id = this.nextRequestId++;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} 请求超时（${timeoutMs}ms）`));
        }, timeoutMs);
      }
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this._send({ method, id, params });
      } catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });
  }

  _send(message) {
    this._ensureRunning();
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _ensureRunning() {
    if (!this.started || this.stopped || this.failed || !this.child) {
      throw new Error("App Server 尚未启动或已经停止");
    }
  }

  _onStdout(chunk, generation = this.generation) {
    if (generation !== this.generation || this.failed || this.stopped) return;
    this.stdoutBuffer += this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > this.maxBufferBytes && !this.stdoutBuffer.includes("\n")) {
      this._terminate(new Error(`App Server JSONL 缓冲区超过 ${this.maxBufferBytes} 字节`));
      return;
    }
    let newline;
    while ((newline = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
        this._terminate(new Error(`App Server JSONL 单行超过 ${this.maxLineBytes} 字节`));
        return;
      }
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this._terminate(new Error(`App Server 返回了无效 JSONL：${error.message}`));
        return;
      }
      this._handleMessage(message);
      if (this.failed || this.stopped) return;
    }
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > this.maxBufferBytes) {
      this._terminate(new Error(`App Server JSONL 缓冲区超过 ${this.maxBufferBytes} 字节`));
    }
  }

  _onStderr(chunk, generation = this.generation) {
    if (generation !== this.generation || this.failed || this.stopped || this.stderrTruncated) return;
    const remaining = this.maxStderrBytes - Buffer.byteLength(this.stderr, "utf8");
    if (remaining <= 0) {
      this.stderrTruncated = true;
      return;
    }
    const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const accepted = source.subarray(0, remaining);
    this.stderr += accepted.toString("utf8");
    if (accepted.length < source.length) this.stderrTruncated = true;
  }

  _handleMessage(message) {
    if (!message || typeof message !== "object") {
      this._terminate(new Error("App Server 返回了无效消息"));
      return;
    }

    // Server-initiated requests also carry ids, and their id namespace may collide
    // with client request ids. A message with both method and id is always a server request.
    if (Object.hasOwn(message, "id") && typeof message.method === "string") {
      this.serverRequests.set(message.id, message);
      this.emit("serverRequest", message);
      return;
    }

    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.emit("orphanResponse", message);
        return;
      }
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(`${pending.method} 请求失败：${message.error.message || "未知错误"}`);
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== "string") {
      this.emit("protocolWarning", message);
      return;
    }
    this.emit("notification", message);
    // EventEmitter reserves the bare "error" event and throws when it has no
    // listener. App Server uses "error" as an ordinary retry/status
    // notification, so expose it under a non-reserved application event.
    if (message.method === "error") this.emit("serverError", message.params);
    else this.emit(message.method, message.params);
    if (message.method === "item/agentMessage/delta") this.emit("agentDelta", message.params);
    if (message.method === "turn/completed") this.emit("turnCompleted", message.params);
  }

  _rejectAll(error) {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  _terminate(error, kill = true, generation = this.generation) {
    if (generation !== this.generation || this.failed || this.stopped) return;
    const child = this.child;
    this.child = null;
    this.decoder = null;
    this.stdoutBuffer = "";
    this.starting = false;
    this.started = false;
    this.failed = true;
    this._rejectAll(error);
    this.serverRequests.clear();
    this.emit("failure", error);
    if (kill && child) {
      try { child.kill(); } catch { /* Best effort. */ }
    }
  }
}

module.exports = {
  APPROVAL_DECISIONS,
  CodexAppServerClient,
  buildAppServerArgs,
  buildCodexChildEnvironment,
  buildThreadSandbox,
  buildTurnSandboxPolicy,
  defaultResolveBinary,
  getCodexBinaryCandidates,
  normalizeTurnInput,
};
