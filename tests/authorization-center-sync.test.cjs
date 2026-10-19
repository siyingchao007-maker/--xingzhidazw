"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  checkAuthorizationCenter,
  syncAuthorizationCenter,
} = require("../src/authorization-center-sync.cjs");

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function createFixture({ installedVersion = "0.45.29", centerVersion = "0.42.1", packMismatch = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xz-auth-sync-"));
  const projectRoot = path.join(root, "project");
  const installedPluginRoot = path.join(root, "installed-plugin");
  const authorizationCenterRoot = path.join(root, "authorization-center");
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(installedPluginRoot, { recursive: true });
  fs.mkdirSync(path.join(authorizationCenterRoot, "tools"), { recursive: true });
  fs.mkdirSync(path.join(authorizationCenterRoot, "运行数据"), { recursive: true });
  fs.mkdirSync(path.join(authorizationCenterRoot, "签发记录"), { recursive: true });
  fs.mkdirSync(path.join(authorizationCenterRoot, "一次性初始化密钥_绝不交付客户"), { recursive: true });

  fs.writeFileSync(path.join(projectRoot, "manifest.json"), JSON.stringify({ version: "0.45.29" }));
  fs.writeFileSync(path.join(installedPluginRoot, "manifest.json"), JSON.stringify({ version: installedVersion }));
  const pluginPack = Buffer.from(JSON.stringify({
    format: "XZCAP1", version: 1, protocolId: "XZ-DUAL-AUTH-v3.0-2026-09-25",
    packId: "xzcap-test", entries: { a: {} }, protectedRoots: ["10_智能体与技能"],
  }));
  const centerPack = packMismatch ? Buffer.from(JSON.stringify({
    format: "XZCAP1", version: 1, protocolId: "XZ-DUAL-AUTH-v3.0-2026-09-25",
    packId: "xzcap-other", entries: {}, protectedRoots: [],
  })) : pluginPack;
  fs.writeFileSync(path.join(installedPluginRoot, "capabilities.xcap"), pluginPack);
  fs.writeFileSync(path.join(authorizationCenterRoot, "运行数据", "capabilities.xcap"), centerPack);
  fs.writeFileSync(path.join(authorizationCenterRoot, "tools", "issuer-core.mjs"), [
    'export const PROTOCOL_ID="XZ-DUAL-AUTH-v3.0-2026-09-25", LICENSE_PREFIX="XZ-LICENSE.v1.", DEVICE_PREFIX="XZ-DEVICE.v1.", CAP_PREFIX="XZ-CAPKEY.v1.";',
    'const EXPECTED_SIGNING_KEY_ID="xz-ed25519-773011c3371884dc";',
  ].join("\n"));
  fs.writeFileSync(path.join(authorizationCenterRoot, "协议同步清单.json"), JSON.stringify({
    protocolId: "XZ-DUAL-AUTH-v3.0-2026-09-25",
    devicePrefix: "XZ-DEVICE.v1.",
    licensePrefix: "XZ-LICENSE.v1.",
    licensePayloadVersion: 2,
    capabilityUnlockPrefix: "XZ-CAPKEY.v1.",
    capabilityEnvelopeVersion: 1,
    trustedSigningKeyId: "xz-ed25519-773011c3371884dc",
    capabilityPackFormat: "XZCAP1",
    capabilityPackVersion: 1,
    capabilityPackId: JSON.parse(centerPack).packId,
    capabilityPackSha256: sha256(centerPack),
    capabilityPackEntryCount: Object.keys(JSON.parse(centerPack).entries).length,
    capabilityPackProtectedRootCount: JSON.parse(centerPack).protectedRoots.length,
    protectedFileCount: Object.keys(JSON.parse(centerPack).entries).length,
    pluginVersion: centerVersion,
    runtimeLabel: `行知商业版 ${centerVersion} + DualAuth v3.0`,
    lastSynchronizedAt: "2026-10-01",
  }, null, 2));
  fs.writeFileSync(path.join(authorizationCenterRoot, "当前签发体系指纹.txt"), "old\n");
  fs.writeFileSync(path.join(authorizationCenterRoot, "签发记录", "must-stay.txt"), "record");
  fs.writeFileSync(path.join(authorizationCenterRoot, "一次性初始化密钥_绝不交付客户", "must-stay.key"), "secret");

  return { root, projectRoot, installedPluginRoot, authorizationCenterRoot };
}

test("check reports a stale desktop authorization center before synchronization", () => {
  const fixture = createFixture();
  const result = checkAuthorizationCenter(fixture);
  assert.equal(result.ok, false);
  assert.match(result.issues.join("\n"), /0\.42\.1.*0\.45\.29/u);
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("sync updates public release metadata while preserving authorization records and key material", () => {
  const fixture = createFixture();
  const recordPath = path.join(fixture.authorizationCenterRoot, "签发记录", "must-stay.txt");
  const keyPath = path.join(fixture.authorizationCenterRoot, "一次性初始化密钥_绝不交付客户", "must-stay.key");

  const result = syncAuthorizationCenter({ ...fixture, now: new Date("2026-10-19T12:00:00.000Z") });
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture.authorizationCenterRoot, "协议同步清单.json"), "utf8"));
  assert.equal(result.ok, true);
  assert.equal(manifest.pluginVersion, "0.45.29");
  assert.equal(manifest.runtimeLabel, "行知商业版 0.45.29 + DualAuth v3.0");
  assert.equal(manifest.lastSynchronizedAt, "2026-10-19");
  assert.equal(fs.readFileSync(recordPath, "utf8"), "record");
  assert.equal(fs.readFileSync(keyPath, "utf8"), "secret");
  assert.match(fs.readFileSync(path.join(fixture.authorizationCenterRoot, "当前签发体系指纹.txt"), "utf8"), /0\.45\.29/u);
  assert.equal(checkAuthorizationCenter(fixture).ok, true);
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("sync refuses to claim success when the installed plugin has another version", () => {
  const fixture = createFixture({ installedVersion: "0.45.28" });
  assert.throws(() => syncAuthorizationCenter(fixture), /正式插件版本.*0\.45\.28.*源码版本.*0\.45\.29/u);
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test("sync refuses to claim compatibility when capability packs differ", () => {
  const fixture = createFixture({ packMismatch: true });
  assert.throws(() => syncAuthorizationCenter(fixture), /能力包.*不一致/u);
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

