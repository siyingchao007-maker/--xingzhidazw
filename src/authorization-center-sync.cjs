"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const AUTHORIZATION_PROTOCOL = Object.freeze({
  protocolId: "XZ-DUAL-AUTH-v3.0-2026-09-25",
  devicePrefix: "XZ-DEVICE.v1.",
  licensePrefix: "XZ-LICENSE.v1.",
  licensePayloadVersion: 2,
  capabilityUnlockPrefix: "XZ-CAPKEY.v1.",
  capabilityEnvelopeVersion: 1,
  capabilityPackFormat: "XZCAP1",
  capabilityPackVersion: 1,
});

const SYNC_MANIFEST_NAME = "协议同步清单.json";
const FINGERPRINT_NAME = "当前签发体系指纹.txt";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label}无法读取：${error?.message || error}`);
  }
}

function readPack(file, label) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    throw new Error(`${label}无法读取：${error?.message || error}`);
  }
  let pack;
  try {
    pack = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label}不是有效 JSON`);
  }
  const entries = pack?.entries && typeof pack.entries === "object" && !Array.isArray(pack.entries)
    ? Object.keys(pack.entries).length
    : 0;
  return {
    bytes,
    sha256: sha256(bytes),
    format: pack?.format,
    version: pack?.version,
    packId: pack?.packId,
    entryCount: Number.isInteger(pack?.entryCount) ? pack.entryCount : entries,
    protectedRootCount: Number.isInteger(pack?.protectedRootCount) ? pack.protectedRootCount : null,
  };
}

function extractStringConstant(source, name) {
  const match = String(source || "").match(new RegExp(`\\b${name}\\s*=\\s*(["'])((?:(?!\\1).)*)\\1`, "u"));
  return match?.[2] || null;
}

function getProjectKeyId(projectRoot, fallback) {
  const publicKeyFile = path.join(projectRoot, "src", "commercial-public-key.cjs");
  const licensingFile = path.join(projectRoot, "src", "commercial-licensing.cjs");
  if (!fs.existsSync(publicKeyFile) || !fs.existsSync(licensingFile)) return fallback;
  const publicKeys = require(publicKeyFile);
  const { getPublicKeyId } = require(licensingFile);
  const ids = Object.keys(publicKeys || {});
  if (ids.length !== 1) throw new Error("插件验签公钥必须且只能有一个当前 Key ID");
  const derived = getPublicKeyId(publicKeys[ids[0]]);
  if (derived !== ids[0]) throw new Error("插件验签公钥 Key ID 与公钥内容不一致");
  return derived;
}

function inspectAuthorizationCenter({ projectRoot, installedPluginRoot, authorizationCenterRoot }) {
  for (const [label, value] of Object.entries({ projectRoot, installedPluginRoot, authorizationCenterRoot })) {
    if (!value || !path.isAbsolute(value)) throw new Error(`${label} 必须是绝对路径`);
  }
  const sourceManifest = readJson(path.join(projectRoot, "manifest.json"), "源码 manifest.json");
  const installedManifest = readJson(path.join(installedPluginRoot, "manifest.json"), "正式插件 manifest.json");
  const syncManifestPath = path.join(authorizationCenterRoot, SYNC_MANIFEST_NAME);
  const syncManifest = readJson(syncManifestPath, "授权中心协议同步清单");
  const pluginPack = readPack(path.join(installedPluginRoot, "capabilities.xcap"), "正式插件能力包");
  const centerPack = readPack(path.join(authorizationCenterRoot, "运行数据", "capabilities.xcap"), "授权中心能力包");
  const issuerCorePath = path.join(authorizationCenterRoot, "tools", "issuer-core.mjs");
  let issuerSource;
  try {
    issuerSource = fs.readFileSync(issuerCorePath, "utf8");
  } catch (error) {
    throw new Error(`授权中心签发核心无法读取：${error?.message || error}`);
  }
  const trustedSigningKeyId = getProjectKeyId(projectRoot, syncManifest.trustedSigningKeyId);
  const issuerContract = {
    protocolId: extractStringConstant(issuerSource, "PROTOCOL_ID"),
    licensePrefix: extractStringConstant(issuerSource, "LICENSE_PREFIX"),
    devicePrefix: extractStringConstant(issuerSource, "DEVICE_PREFIX"),
    capabilityUnlockPrefix: extractStringConstant(issuerSource, "CAP_PREFIX"),
    trustedSigningKeyId: extractStringConstant(issuerSource, "EXPECTED_SIGNING_KEY_ID"),
  };
  return {
    sourceVersion: sourceManifest.version,
    installedVersion: installedManifest.version,
    syncManifest,
    syncManifestPath,
    fingerprintPath: path.join(authorizationCenterRoot, FINGERPRINT_NAME),
    pluginPack,
    centerPack,
    trustedSigningKeyId,
    issuerContract,
  };
}

function compatibilityIssues(state) {
  const issues = [];
  if (state.installedVersion !== state.sourceVersion) {
    issues.push(`正式插件版本 ${state.installedVersion} 与源码版本 ${state.sourceVersion} 不一致`);
  }
  if (state.pluginPack.sha256 !== state.centerPack.sha256) issues.push("正式插件与授权中心的能力包 SHA-256 不一致");
  if (state.pluginPack.packId !== state.centerPack.packId) issues.push("正式插件与授权中心的能力包 ID 不一致");
  if (state.pluginPack.format !== AUTHORIZATION_PROTOCOL.capabilityPackFormat
    || state.centerPack.format !== AUTHORIZATION_PROTOCOL.capabilityPackFormat) {
    issues.push("能力包格式与授权协议不一致");
  }
  if (state.pluginPack.version !== AUTHORIZATION_PROTOCOL.capabilityPackVersion
    || state.centerPack.version !== AUTHORIZATION_PROTOCOL.capabilityPackVersion) {
    issues.push("能力包版本与授权协议不一致");
  }
  for (const key of ["protocolId", "licensePrefix", "devicePrefix", "capabilityUnlockPrefix"]) {
    if (state.issuerContract[key] !== AUTHORIZATION_PROTOCOL[key]) {
      issues.push(`授权中心 ${key} 与插件授权协议不一致`);
    }
  }
  if (state.issuerContract.trustedSigningKeyId !== state.trustedSigningKeyId) {
    issues.push("授权中心签发 Key ID 与插件验签公钥不一致");
  }
  return issues;
}

function expectedManifest(state, now) {
  const day = now.toISOString().slice(0, 10);
  return {
    ...state.syncManifest,
    ...AUTHORIZATION_PROTOCOL,
    trustedSigningKeyId: state.trustedSigningKeyId,
    capabilityPackId: state.centerPack.packId,
    capabilityPackSha256: state.centerPack.sha256,
    capabilityPackEntryCount: state.centerPack.entryCount,
    capabilityPackProtectedRootCount: state.centerPack.protectedRootCount,
    protectedFileCount: state.syncManifest.protectedFileCount,
    pluginVersion: state.sourceVersion,
    runtimeLabel: `行知商业版 ${state.sourceVersion} + DualAuth v3.0`,
    lastSynchronizedAt: day,
  };
}

function statusIssues(state) {
  const issues = compatibilityIssues(state);
  if (state.syncManifest.pluginVersion !== state.sourceVersion) {
    issues.push(`授权中心记录版本 ${state.syncManifest.pluginVersion} 尚未同步到 ${state.sourceVersion}`);
  }
  if (state.syncManifest.capabilityPackSha256 !== state.centerPack.sha256) issues.push("授权中心清单中的能力包摘要已过期");
  if (state.syncManifest.trustedSigningKeyId !== state.trustedSigningKeyId) issues.push("授权中心清单中的签发 Key ID 已过期");
  for (const [key, value] of Object.entries(AUTHORIZATION_PROTOCOL)) {
    if (state.syncManifest[key] !== value) issues.push(`授权中心清单中的 ${key} 已过期`);
  }
  return [...new Set(issues)];
}

function checkAuthorizationCenter(options) {
  const state = inspectAuthorizationCenter(options);
  const issues = statusIssues(state);
  return Object.freeze({
    ok: issues.length === 0,
    sourceVersion: state.sourceVersion,
    installedVersion: state.installedVersion,
    centerVersion: state.syncManifest.pluginVersion,
    packId: state.centerPack.packId,
    packSha256: state.centerPack.sha256,
    issues: Object.freeze(issues),
  });
}

function fingerprintText(manifest) {
  return [
    `行知厂商双授权签发中心 v1.1（已同步至行知商业版 ${manifest.pluginVersion}）`,
    `商业签发 Key ID: ${manifest.trustedSigningKeyId}`,
    `能力包 ID: ${manifest.capabilityPackId}`,
    `能力包 SHA-256: ${manifest.capabilityPackSha256}`,
    `能力协议: ${manifest.capabilityUnlockPrefix} (envelope formatVersion ${manifest.capabilityEnvelopeVersion})`,
    `商业协议: ${manifest.licensePrefix} / payload formatVersion ${manifest.licensePayloadVersion}`,
    "",
    "务必注意：能力解锁码协议必须与客户端插件一致。",
    "同步脚本只更新公开兼容信息，不读取或改写私钥、厂商密码、既有授权码和签发记录。",
    "",
  ].join("\n");
}

function syncAuthorizationCenter(options) {
  const state = inspectAuthorizationCenter(options);
  const blockers = compatibilityIssues(state);
  if (blockers.length) throw new Error(blockers.join("；"));
  const now = options.now instanceof Date ? options.now : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("同步时间无效");
  const manifest = expectedManifest(state, now);
  fs.writeFileSync(state.syncManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.writeFileSync(state.fingerprintPath, fingerprintText(manifest), "utf8");
  return checkAuthorizationCenter(options);
}

module.exports = {
  AUTHORIZATION_PROTOCOL,
  checkAuthorizationCenter,
  inspectAuthorizationCenter,
  syncAuthorizationCenter,
};
