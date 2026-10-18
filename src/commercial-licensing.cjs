"use strict";

const crypto = require("node:crypto");

// 行知商业版授权码由离线私钥签发，插件只内置公钥并在本机验签。
// 设备申请码仅包含不可逆派生后的设备编号，不包含原始系统机器标识。
const LICENSE_PREFIX = "XZ-LICENSE.v1.";
const LEGACY_LICENSE_PREFIX = "XZ-LICENSE.v0.";
const DEVICE_REQUEST_PREFIX = "XZ-DEVICE.v1.";
const DEVICE_ID_PREFIX = "XZDEV1_";
const MAX_LICENSE_KEY_LENGTH = 20_000;
const MAX_DEVICE_REQUEST_LENGTH = 8_000;
const EXPIRING_THRESHOLD_DAYS = 14;
const PLAN_NAMES = Object.freeze(["STANDARD"]);

const CORE_FEATURES = Object.freeze([
  "core.workbench",
  "core.ai_chat",
  "core.document_ingest",
  "core.knowledge_search",
  "core.decision_loop",
  "core.archive",
]);

const PLAN_FEATURES = Object.freeze({
  STANDARD: CORE_FEATURES,
});

// 这是合同/签发口径，不是单机插件能独立统计的联网激活次数。
const PLAN_LIMITS = Object.freeze({
  STANDARD: Object.freeze({ licensedDevices: 1 }),
});

function fail(message) {
  throw new Error(message);
}

function assertPlainObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(message);
}

function assertDateString(value, fieldName) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    fail(`${fieldName} 必须是 UTC ISO 时间`);
  }
  if (!Number.isFinite(Date.parse(value))) fail(`${fieldName} 不是有效时间`);
}

function assertDeviceId(value) {
  if (typeof value !== "string" || !/^XZDEV1_[A-Za-z0-9_-]{43}$/u.test(value)) {
    fail("deviceId 无效");
  }
  return value;
}

function assertLicensePayload(payload) {
  assertPlainObject(payload, "授权载荷无效");
  if (payload.formatVersion !== 2) fail("不支持的授权载荷版本");
  if (typeof payload.licenseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$/u.test(payload.licenseId)) {
    fail("licenseId 无效");
  }
  if (!PLAN_NAMES.includes(payload.plan)) fail("不支持的版本");
  assertDateString(payload.issuedAt, "issuedAt");
  assertDateString(payload.startsAt, "startsAt");
  assertDateString(payload.expiresAt, "expiresAt");
  if (Date.parse(payload.expiresAt) <= Date.parse(payload.startsAt)) fail("expiresAt 必须晚于 startsAt");
  if (payload.customerLabel !== undefined
    && (typeof payload.customerLabel !== "string" || payload.customerLabel.length > 200)) {
    fail("customerLabel 无效");
  }
  assertDeviceId(payload.deviceId);
  if (typeof payload.keyId !== "string" || !/^xz-ed25519-[a-f0-9]{16}$/u.test(payload.keyId)) {
    fail("keyId 无效");
  }
  return payload;
}

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeBase64Url(encoded, errorMessage) {
  if (typeof encoded !== "string"
    || !encoded
    || !/^[A-Za-z0-9_-]+$/u.test(encoded)
    || encoded.length % 4 === 1) {
    fail(errorMessage);
  }
  try {
    const value = Buffer.from(encoded, "base64url");
    if (!value.length || value.toString("base64url") !== encoded) fail(errorMessage);
    return value;
  } catch (error) {
    if (error?.message === errorMessage) throw error;
    fail(errorMessage);
  }
}

function decodePayload(encoded, errorMessage = "授权码格式无效") {
  try {
    const json = decodeBase64Url(encoded, errorMessage).toString("utf8");
    if (!json || !/^\{[\s\S]*\}$/u.test(json)) fail(errorMessage);
    return JSON.parse(json);
  } catch (error) {
    if (error?.message === errorMessage) throw error;
    fail(errorMessage);
  }
}

function asPublicKey(key) {
  try {
    if (key?.type === "public") return key;
    return crypto.createPublicKey(key);
  } catch {
    fail("授权信任配置无效");
  }
}

function getPublicKeyId(publicKey) {
  const key = asPublicKey(publicKey);
  let der;
  try {
    der = key.export({ type: "spki", format: "der" });
  } catch {
    fail("授权信任配置无效");
  }
  return `xz-ed25519-${crypto.createHash("sha256").update(der).digest("hex").slice(0, 16)}`;
}

function normalizeIdentityPart(value, fieldName, maxLength = 512) {
  if (typeof value !== "string") fail(`${fieldName} 无效`);
  const normalized = value.trim().toLowerCase();
  if (normalized.length < 2 || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail(`${fieldName} 无效`);
  }
  return normalized;
}

function deriveDeviceId({ machineId, platform, arch } = {}) {
  const normalizedMachineId = normalizeIdentityPart(machineId, "machineId");
  const normalizedPlatform = normalizeIdentityPart(platform, "platform", 32);
  const normalizedArch = normalizeIdentityPart(arch, "arch", 32);
  const material = ["xingzhi-device-v1", normalizedPlatform, normalizedArch, normalizedMachineId].join("\0");
  return `${DEVICE_ID_PREFIX}${crypto.createHash("sha256").update(material, "utf8").digest("base64url")}`;
}

function createDeviceRequestCode({ machineId, platform, arch, generatedAt, deviceLabel } = {}) {
  const normalizedPlatform = normalizeIdentityPart(platform, "platform", 32);
  const normalizedArch = normalizeIdentityPart(arch, "arch", 32);
  assertDateString(generatedAt, "generatedAt");
  if (deviceLabel !== undefined
    && (typeof deviceLabel !== "string" || !deviceLabel.trim() || deviceLabel.length > 100)) {
    fail("deviceLabel 无效");
  }
  const payload = {
    formatVersion: 1,
    deviceId: deriveDeviceId({ machineId, platform: normalizedPlatform, arch: normalizedArch }),
    platform: normalizedPlatform,
    arch: normalizedArch,
    generatedAt,
    ...(deviceLabel === undefined ? {} : { deviceLabel: deviceLabel.trim() }),
  };
  const request = `${DEVICE_REQUEST_PREFIX}${encodePayload(payload)}`;
  if (request.length > MAX_DEVICE_REQUEST_LENGTH) fail("设备申请码过长");
  return request;
}

function parseDeviceRequestCode(input) {
  if (typeof input !== "string" || !input.trim()) fail("设备申请码不能为空");
  const request = input.trim();
  if (request.length > MAX_DEVICE_REQUEST_LENGTH) fail("设备申请码过长");
  if (!request.startsWith(DEVICE_REQUEST_PREFIX)) fail("设备申请码格式无效");
  const payload = decodePayload(request.slice(DEVICE_REQUEST_PREFIX.length), "设备申请码格式无效");
  assertPlainObject(payload, "设备申请码格式无效");
  if (payload.formatVersion !== 1) fail("不支持的设备申请码版本");
  assertDeviceId(payload.deviceId);
  normalizeIdentityPart(payload.platform, "platform", 32);
  normalizeIdentityPart(payload.arch, "arch", 32);
  assertDateString(payload.generatedAt, "generatedAt");
  if (payload.deviceLabel !== undefined
    && (typeof payload.deviceLabel !== "string" || !payload.deviceLabel.trim() || payload.deviceLabel.length > 100)) {
    fail("deviceLabel 无效");
  }
  if (Object.hasOwn(payload, "machineId")) fail("设备申请码包含禁止字段");
  return payload;
}

function createLicenseKey(input, { privateKey } = {}) {
  assertPlainObject(input, "授权载荷无效");
  if (!privateKey) fail("缺少授权签名私钥");
  let publicKey;
  try {
    publicKey = crypto.createPublicKey(privateKey);
  } catch {
    fail("授权签名私钥无效");
  }
  const payload = assertLicensePayload({
    formatVersion: 2,
    licenseId: input.licenseId,
    plan: input.plan,
    issuedAt: input.issuedAt,
    startsAt: input.startsAt,
    expiresAt: input.expiresAt,
    ...(input.customerLabel === undefined ? {} : { customerLabel: input.customerLabel }),
    deviceId: input.deviceId,
    keyId: getPublicKeyId(publicKey),
  });
  const encoded = encodePayload(payload);
  const signedMessage = Buffer.from(`${LICENSE_PREFIX}${encoded}`, "utf8");
  let signature;
  try {
    signature = crypto.sign(null, signedMessage, privateKey).toString("base64url");
  } catch {
    fail("授权签名失败");
  }
  const key = `${LICENSE_PREFIX}${encoded}.${signature}`;
  if (key.length > MAX_LICENSE_KEY_LENGTH) fail("授权码过长");
  return key;
}

function findTrustedPublicKey(trustedPublicKeys, keyId) {
  if (!trustedPublicKeys || typeof trustedPublicKeys !== "object") fail("缺少授权信任配置");
  const key = trustedPublicKeys instanceof Map
    ? trustedPublicKeys.get(keyId)
    : Object.prototype.hasOwnProperty.call(trustedPublicKeys, keyId) ? trustedPublicKeys[keyId] : undefined;
  if (!key) fail("未知的授权签名密钥");
  return asPublicKey(key);
}

function parseLicenseKey(input, { trustedPublicKeys, expectedDeviceId } = {}) {
  if (typeof input !== "string" || !input.trim()) fail("授权码不能为空");
  const key = input.trim();
  if (key.length > MAX_LICENSE_KEY_LENGTH) fail("授权码过长");
  if (key.startsWith(LEGACY_LICENSE_PREFIX)) fail("旧版授权码已停用，请换取本机签名授权码");
  if (!key.startsWith(LICENSE_PREFIX)) fail("授权码格式无效");

  const pieces = key.slice(LICENSE_PREFIX.length).split(".");
  if (pieces.length !== 2) fail("授权码格式无效");
  const [encoded, encodedSignature] = pieces;
  const payload = decodePayload(encoded);
  assertPlainObject(payload, "授权载荷无效");
  if (typeof payload.keyId !== "string" || !/^xz-ed25519-[a-f0-9]{16}$/u.test(payload.keyId)) {
    fail("keyId 无效");
  }

  const publicKey = findTrustedPublicKey(trustedPublicKeys, payload.keyId);
  const signature = decodeBase64Url(encodedSignature, "授权码格式无效");
  const signedMessage = Buffer.from(`${LICENSE_PREFIX}${encoded}`, "utf8");
  let verified = false;
  try {
    verified = crypto.verify(null, signedMessage, publicKey, signature);
  } catch {
    verified = false;
  }
  if (!verified) fail("授权签名无效");

  assertLicensePayload(payload);
  assertDeviceId(expectedDeviceId);
  if (payload.deviceId !== expectedDeviceId) fail("授权码不属于本机");
  return payload;
}

function hasFeature(plan, feature) {
  return PLAN_FEATURES[plan]?.includes(String(feature || "")) === true;
}

function getLicenseSnapshot(payload, now = new Date()) {
  const currentTime = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(currentTime)) fail("当前时间无效");
  if (!payload) return createSnapshot({ status: "UNACTIVATED", payload: null, nowMs: currentTime });
  assertLicensePayload(payload);
  const startsAtMs = Date.parse(payload.startsAt);
  const expiresAtMs = Date.parse(payload.expiresAt);
  if (currentTime < startsAtMs) return createSnapshot({ status: "NOT_STARTED", payload, nowMs: currentTime });
  if (currentTime >= expiresAtMs) return createSnapshot({ status: "EXPIRED", payload, nowMs: currentTime });
  const daysRemaining = Math.floor((expiresAtMs - currentTime) / 86_400_000);
  return createSnapshot({
    status: daysRemaining <= EXPIRING_THRESHOLD_DAYS ? "EXPIRING" : "ACTIVE",
    payload,
    nowMs: currentTime,
  });
}

function createSnapshot({ status, payload, nowMs }) {
  const expiresAtMs = payload ? Date.parse(payload.expiresAt) : null;
  const daysRemaining = expiresAtMs === null
    ? null
    : Math.max(0, Math.floor((expiresAtMs - nowMs) / 86_400_000));
  const plan = payload?.plan || null;
  const allowAi = status === "ACTIVE" || status === "EXPIRING";
  return Object.freeze({
    status,
    plan,
    licenseId: payload?.licenseId || null,
    issuedAt: payload?.issuedAt || null,
    startsAt: payload?.startsAt || null,
    expiresAt: payload?.expiresAt || null,
    customerLabel: payload?.customerLabel || null,
    deviceId: payload?.deviceId || null,
    keyId: payload?.keyId || null,
    daysRemaining,
    allowReadOnly: true,
    allowAi,
    features: Object.freeze(plan ? [...PLAN_FEATURES[plan]] : []),
    limits: Object.freeze(plan ? { ...PLAN_LIMITS[plan] } : {}),
    allowFeature(feature) {
      return allowAi && hasFeature(plan, feature);
    },
  });
}

class LicenseManager {
  constructor({ load, save, now = () => new Date(), deviceId, trustedPublicKeys } = {}) {
    if (typeof load !== "function" || typeof save !== "function") fail("LicenseManager 需要 load 和 save 函数");
    assertDeviceId(deviceId);
    if (!trustedPublicKeys || typeof trustedPublicKeys !== "object") fail("缺少授权信任配置");
    this.load = load;
    this.save = save;
    this.now = now;
    this.deviceId = deviceId;
    this.trustedPublicKeys = trustedPublicKeys;
    this.licenseKey = null;
    this.payload = null;
    this.error = null;
  }

  parse(key) {
    return parseLicenseKey(key, {
      trustedPublicKeys: this.trustedPublicKeys,
      expectedDeviceId: this.deviceId,
    });
  }

  async initialize() {
    const stored = (await this.load()) || {};
    const key = typeof stored.licenseKey === "string" ? stored.licenseKey : "";
    this.licenseKey = key || null;
    this.error = null;
    if (key) {
      try {
        this.payload = this.parse(key);
      } catch (error) {
        this.payload = null;
        this.error = error instanceof Error ? error.message : "授权码无效";
      }
    } else {
      this.payload = null;
    }
    return this.snapshot();
  }

  snapshot() {
    if (this.error) {
      return Object.freeze({
        ...createSnapshot({ status: "INVALID", payload: null, nowMs: this.now().getTime() }),
        error: this.error,
      });
    }
    return getLicenseSnapshot(this.payload, this.now());
  }

  async activate(input) {
    const key = typeof input === "string" ? input.trim() : "";
    const payload = this.parse(key);
    const candidate = getLicenseSnapshot(payload, this.now());
    if (!candidate.allowAi) fail(candidate.status === "EXPIRED" ? "授权码已到期" : "授权码尚未生效");
    const previous = {
      licenseKey: this.licenseKey,
      payload: this.payload,
      error: this.error,
    };
    this.licenseKey = key;
    this.payload = payload;
    this.error = null;
    try {
      await this.save({ licenseKey: key });
    } catch (error) {
      this.licenseKey = previous.licenseKey;
      this.payload = previous.payload;
      this.error = previous.error;
      throw error;
    }
    return this.snapshot();
  }

  async clear() {
    const previous = {
      licenseKey: this.licenseKey,
      payload: this.payload,
      error: this.error,
    };
    this.licenseKey = null;
    this.payload = null;
    this.error = null;
    try {
      await this.save({ licenseKey: null });
    } catch (error) {
      this.licenseKey = previous.licenseKey;
      this.payload = previous.payload;
      this.error = previous.error;
      throw error;
    }
    return this.snapshot();
  }

  can(feature) {
    return this.snapshot().allowFeature(feature);
  }

  // 到期后保留只读数据，但关闭 AI/执行入口。
  catalogCan(feature) {
    return hasFeature(this.snapshot().plan || "STANDARD", feature);
  }

  require(feature) {
    if (!this.can(feature)) {
      const snapshot = this.snapshot();
      const suffix = snapshot.status === "EXPIRED" ? "（授权已到期，请续期）" : "（请激活授权）";
      fail(`当前授权不能使用 ${feature}${suffix}`);
    }
  }
}

module.exports = {
  DEVICE_REQUEST_PREFIX,
  LEGACY_LICENSE_PREFIX,
  LICENSE_PREFIX,
  PLAN_FEATURES,
  PLAN_LIMITS,
  PLAN_NAMES,
  LicenseManager,
  createDeviceRequestCode,
  createLicenseKey,
  deriveDeviceId,
  getLicenseSnapshot,
  getPublicKeyId,
  hasFeature,
  parseDeviceRequestCode,
  parseLicenseKey,
};
