"use strict";

const {
  appendOperationEvent,
  buildConnectionDiagnostics,
  sanitizeErrorMessage,
} = require("./operation-events.cjs");

function selectedModelByProvider(state, providerId) {
  if (providerId === state.settings?.providerId) return state.settings?.model || null;
  return state.conversations?.find((conversation) => (
    conversation?.providerId === providerId && !conversation.deletedAt && conversation.model
  ))?.model || state.settings?.providerConfigs?.[providerId]?.model || null;
}

class ConnectionDiagnosticsService {
  constructor(options = {}) {
    if (typeof options.getState !== "function" || typeof options.probeProvider !== "function") {
      throw new Error("连接诊断服务缺少状态或探测器");
    }
    this.getState = options.getState;
    this.probeProvider = options.probeProvider;
    this.credentialStatus = typeof options.credentialStatus === "function"
      ? options.credentialStatus
      : () => ({ configured: false, source: null });
    this.hasAuthorization = typeof options.hasAuthorization === "function"
      ? options.hasAuthorization
      : () => false;
    this.save = typeof options.save === "function" ? options.save : async () => {};
    this.notify = typeof options.notify === "function" ? options.notify : () => {};
    this.now = typeof options.now === "function" ? options.now : () => Date.now();
    this.inflight = new Map();
  }

  getDiagnostics() {
    const state = this.getState();
    const credentialStatuses = {};
    const authorizations = {};
    const currentModels = {};
    for (const provider of state.providers || []) {
      if (provider.id !== "codex") {
        try {
          credentialStatuses[provider.id] = this.credentialStatus(provider.id)
            || { configured: false, source: null };
        } catch {
          credentialStatuses[provider.id] = { configured: false, source: null };
        }
        authorizations[provider.id] = this.hasAuthorization(provider.id) === true;
      }
      currentModels[provider.id] = selectedModelByProvider(state, provider.id);
    }
    return buildConnectionDiagnostics({
      providers: state.providers,
      providerConnections: state.runtime?.providerConnections,
      credentialStatuses,
      authorizations,
      currentModels,
      models: state.runtime?.models,
      events: state.operationEvents,
    });
  }

  async diagnose(providerId) {
    const existing = this.inflight.get(providerId);
    if (existing) return existing;
    const task = this._diagnose(providerId);
    this.inflight.set(providerId, task);
    try {
      return await task;
    } finally {
      if (this.inflight.get(providerId) === task) this.inflight.delete(providerId);
    }
  }

  async _diagnose(providerId) {
    const state = this.getState();
    if (!(state.providers || []).some((provider) => provider?.id === providerId)) {
      throw new Error("未知的模型提供商");
    }
    const startedAt = this.now();
    const phase = providerId === "codex" ? "app-server" : "model-discovery";
    state.operationEvents = appendOperationEvent(state.operationEvents, {
      providerId,
      model: selectedModelByProvider(state, providerId),
      phase,
      outcome: "started",
    });
    this.notify();
    try {
      await this.probeProvider(providerId);
      const configuredOnly = state.runtime?.providerConnections?.[providerId]?.status === "configured";
      state.operationEvents = appendOperationEvent(state.operationEvents, {
        providerId,
        model: selectedModelByProvider(state, providerId),
        phase,
        outcome: configuredOnly ? "unsupported" : "succeeded",
        latencyMs: this.now() - startedAt,
      });
      await this.save().catch(() => {});
      this.notify();
      return this.getDiagnostics().find((item) => item.providerId === providerId);
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error?.message) || "连接检测失败";
      if (state.runtime?.providerConnections) {
        state.runtime.providerConnections[providerId] = { status: "error", error: errorMessage };
      }
      state.operationEvents = appendOperationEvent(state.operationEvents, {
        providerId,
        model: selectedModelByProvider(state, providerId),
        phase,
        outcome: error?.code === "timeout" || /超时|timeout/iu.test(String(error?.message || ""))
          ? "timed-out"
          : "failed",
        latencyMs: this.now() - startedAt,
        errorCode: typeof error?.code === "string" ? error.code : null,
        errorMessage,
      });
      await this.save().catch(() => {});
      this.notify();
      throw error;
    }
  }
}

module.exports = { ConnectionDiagnosticsService, selectedModelByProvider };
