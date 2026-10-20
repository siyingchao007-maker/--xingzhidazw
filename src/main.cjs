"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const nodePath = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const { ItemView, Modal, Notice, Plugin, TFile, loadPdfJs } = require("obsidian");
const { LicenseManager } = require("./commercial-licensing.cjs");
const { getCurrentDeviceIdentity } = require("./commercial-device-identity.cjs");
const { createCommercialVaultGate } = require("./commercial-vault-gate.cjs");
const TRUSTED_COMMERCIAL_KEYS = require("./commercial-public-key.cjs");
const COMMERCIAL_BUILD = typeof true !== "undefined" && true;
const {
  STANDARD_BRAND_CLASS,
  XINGZHI_BRAND_ASSET,
  XINGZHI_LOGO_ICON,
  isStandardBrandConfig,
} = require("./brand.cjs");
const { normalizeVaultPath } = require("./core.cjs");
const { openVaultFile } = require("./obsidian-file-opener.cjs");
const {
  WorkbenchRuntime,
  createObsidianVaultAdapter,
  createRuntimeState,
} = require("./workbench-runtime.cjs");
const { XingzhiWorkbenchView, VIEW_TYPE_XINGZHI } = require("./workbench-view.cjs");
const { CognitiveHomeView, VIEW_TYPE_COGNITIVE_HOME } = require("./view-cognitive-home.cjs");
const {
  VIEW_TYPE_XINGZHI_ARCHIVE_REVIEW,
  XingzhiArchiveReviewView,
} = require("./view-archive-review.cjs");
const {
  VIEW_TYPE_XINGZHI_ACTION_CENTER,
  XingzhiActionCenterView,
} = require("./view-action-center.cjs");
const {
  buildOnlineEvidenceCandidates,
  bridgeEnvironmentCandidates,
} = require("./evidence-environment-bridge.cjs");

const JOURNAL_KEY_BYTES = 32;
const ALLOWED_SECRET_REFS = new Set([
  "env:OPENAI_API_KEY",
  "env:DEEPSEEK_API_KEY",
  "env:MOONSHOT_API_KEY",
  "env:XINGZHI_CUSTOM_API_KEY",
]);
const PROVIDER_SECRET_CONFIG = Object.freeze({
  openai: Object.freeze({ ref: "env:OPENAI_API_KEY", storageId: "xingzhi-openai-api-key" }),
  deepseek: Object.freeze({ ref: "env:DEEPSEEK_API_KEY", storageId: "xingzhi-deepseek-api-key" }),
  kimi: Object.freeze({ ref: "env:MOONSHOT_API_KEY", storageId: "xingzhi-kimi-api-key" }),
  custom: Object.freeze({ ref: "env:XINGZHI_CUSTOM_API_KEY", storageId: "xingzhi-custom-api-key" }),
});
const SECRET_REF_CONFIG = new Map(Object.entries(PROVIDER_SECRET_CONFIG).map(([providerId, config]) => (
  [config.ref, { providerId, ...config }]
)));

// Extra user-added compatible endpoints ("custom-2", "custom-3", ...) get their own
// secret slot derived from the id so each gateway keeps a separate API key.
const CUSTOM_SECRET_ID_PATTERN = /^custom-([0-9]{1,3})$/u;

function providerSecretConfig(providerId) {
  const fixed = PROVIDER_SECRET_CONFIG[providerId];
  if (fixed) return fixed;
  const match = CUSTOM_SECRET_ID_PATTERN.exec(String(providerId || ""));
  if (!match) return null;
  return Object.freeze({
    ref: `env:XINGZHI_CUSTOM_API_KEY_${match[1]}`,
    storageId: `xingzhi-custom-${match[1]}-api-key`,
  });
}

function secretRefConfig(ref) {
  const fixed = SECRET_REF_CONFIG.get(ref);
  if (fixed) return fixed;
  const match = /^env:XINGZHI_CUSTOM_API_KEY_([0-9]{1,3})$/u.exec(String(ref || ""));
  if (!match) return null;
  const providerId = `custom-${match[1]}`;
  return { providerId, ...providerSecretConfig(providerId) };
}

async function extractPdfText(bytes) {
  if (typeof loadPdfJs !== "function") throw new Error("当前 Obsidian 版本不能读取 PDF 正文");
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const pdf = await task.promise;
  if (!pdf?.numPages || pdf.numPages > 500) throw new Error("PDF 页数超过 500 页安全上限");
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push((content.items || []).map((item) => String(item?.str || "")).join(" ").trim());
    }
  } finally {
    await pdf.destroy?.();
  }
  return pages.filter(Boolean).join("\n\n");
}

function validJournalKey(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) return false;
  try {
    return Buffer.from(value, "hex").length === JOURNAL_KEY_BYTES;
  } catch {
    return false;
  }
}

const CAPABILITY_PACK_FILE = "capabilities.xcap";
const CAPABILITY_UNLOCK_PREFIX = "XZ-CAPKEY.v1.";
const CAPABILITY_UNLOCK_SECRET_ID = "xingzhi-capability-unlock-v1";
const CAPABILITY_PACK_MAX_BYTES = 64 * 1024 * 1024;
const CAPABILITY_FILE_MAX_BYTES = 512 * 1024;

function capabilityNormalizePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
}

function capabilitySha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function capabilityEntryId(vaultPath) {
  return capabilitySha256Hex(Buffer.from(`XZPATH\0${capabilityNormalizePath(vaultPath)}`, "utf8"));
}

function capabilityBase64Url(value, label) {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) {
    throw new Error(`${label}格式无效`);
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    if (!bytes.length || bytes.toString("base64url") !== value) throw new Error(`${label}格式无效`);
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message === `${label}格式无效`) throw error;
    throw new Error(`${label}格式无效`);
  }
}

function capabilityPluginDirectory(plugin) {
  const pluginId = String(plugin?.manifest?.id || "xingzhi-workbench").trim() || "xingzhi-workbench";
  const fallback = `.obsidian/plugins/${pluginId}`;
  const configured = String(plugin?.manifest?.dir || "").trim().replaceAll("\\", "/");
  if (!configured) return fallback;
  const normalized = configured.replace(/^\/+|\/+$/gu, "");
  const marker = ".obsidian/plugins/";
  const markerIndex = normalized.toLowerCase().lastIndexOf(marker);
  if (markerIndex >= 0) return normalized.slice(markerIndex);
  if (normalized === pluginId || normalized === `plugins/${pluginId}`) return fallback;
  return normalized;
}

class LocalCapabilityPack {
  constructor({ present = false, pack = null, packHash = null, masterKey = null, error = null } = {}) {
    this.present = present;
    this.pack = pack;
    this.packHash = packHash;
    this.masterKey = masterKey;
    this.error = error;
    this.unlocked = Boolean(present && pack && masterKey && !error);
    Object.seal(this);
  }

  has(vaultPath) {
    if (!this.present || !this.pack?.entries) return false;
    return Object.hasOwn(this.pack.entries, capabilityEntryId(vaultPath));
  }

  readText(vaultPath) {
    const normalized = capabilityNormalizePath(vaultPath);
    const entry = this.pack?.entries?.[capabilityEntryId(normalized)];
    if (!entry) throw new Error(`受保护能力不存在：${normalized}`);
    if (!this.unlocked || !this.masterKey) {
      throw new Error(`本地能力包尚未解锁：${this.error || "请在“管理商业版授权”中输入能力解锁码"}`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > CAPABILITY_FILE_MAX_BYTES) {
      throw new Error(`受保护能力大小无效：${normalized}`);
    }
    const iv = capabilityBase64Url(entry.iv, "能力文件 IV");
    const tag = capabilityBase64Url(entry.tag, "能力文件认证标签");
    const ciphertext = capabilityBase64Url(entry.ciphertext, "能力文件密文");
    if (iv.length !== 12 || tag.length !== 16) throw new Error(`受保护能力加密参数无效：${normalized}`);
    const aad = Buffer.from(`XZCAP1\0${this.pack.packId}\0${normalized}\0${entry.sha256}`, "utf8");
    let compressed;
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.masterKey, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error(`受保护能力解密失败：${normalized}`);
    }
    let raw;
    try {
      raw = zlib.gunzipSync(compressed);
    } catch {
      throw new Error(`受保护能力解压失败：${normalized}`);
    }
    if (raw.length !== entry.size || raw.length > CAPABILITY_FILE_MAX_BYTES) {
      throw new Error(`受保护能力长度校验失败：${normalized}`);
    }
    if (capabilitySha256Hex(raw) !== entry.sha256) {
      throw new Error(`受保护能力完整性校验失败：${normalized}`);
    }
    return raw.toString("utf8");
  }

  snapshot() {
    return Object.freeze({
      present: this.present,
      unlocked: this.unlocked,
      packId: this.pack?.packId || null,
      entryCount: Number.isSafeInteger(this.pack?.entryCount) ? this.pack.entryCount : 0,
      packHash: this.packHash || null,
      error: this.error || null,
    });
  }
}

function loadLocalCapabilityPack({ vaultPath, pluginDirectory, licenseKey, deviceId, unlockCode } = {}) {
  const packPath = nodePath.join(String(vaultPath || ""), capabilityNormalizePath(pluginDirectory), CAPABILITY_PACK_FILE);
  if (!fs.existsSync(packPath)) return new LocalCapabilityPack();
  try {
    const stat = fs.statSync(packPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > CAPABILITY_PACK_MAX_BYTES) {
      return new LocalCapabilityPack({ present: true, error: "本地能力包文件大小无效" });
    }
    const packBytes = fs.readFileSync(packPath);
    const packHash = capabilitySha256Hex(packBytes);
    const pack = JSON.parse(packBytes.toString("utf8"));
    if (!pack || pack.format !== "XZCAP1" || pack.version !== 1
      || typeof pack.packId !== "string" || !/^xzcap-[a-f0-9]{24}$/u.test(pack.packId)
      || !pack.entries || typeof pack.entries !== "object" || Array.isArray(pack.entries)) {
      return new LocalCapabilityPack({ present: true, packHash, error: "本地能力包格式无效" });
    }
    const actualEntryCount = Object.keys(pack.entries).length;
    if (!Number.isSafeInteger(pack.entryCount) || pack.entryCount !== actualEntryCount || actualEntryCount > 5_000) {
      return new LocalCapabilityPack({ present: true, pack, packHash, error: "本地能力包目录无效" });
    }
    if (!unlockCode) {
      return new LocalCapabilityPack({ present: true, pack, packHash, error: "尚未输入能力解锁码" });
    }
    if (typeof licenseKey !== "string" || !licenseKey.trim() || typeof deviceId !== "string" || !deviceId.trim()) {
      return new LocalCapabilityPack({ present: true, pack, packHash, error: "请先完成本机商业授权" });
    }
    const code = String(unlockCode).trim();
    if (!code.startsWith(CAPABILITY_UNLOCK_PREFIX)) {
      return new LocalCapabilityPack({ present: true, pack, packHash, error: "能力解锁码格式无效" });
    }
    const encoded = code.slice(CAPABILITY_UNLOCK_PREFIX.length);
    const envelope = JSON.parse(capabilityBase64Url(encoded, "能力解锁码").toString("utf8"));
    if (!envelope || envelope.formatVersion !== 1 || envelope.packId !== pack.packId
      || envelope.packHash !== packHash || envelope.deviceId !== deviceId) {
      return new LocalCapabilityPack({ present: true, pack, packHash, error: "能力解锁码与当前能力包、授权或设备不匹配" });
    }
    const salt = capabilityBase64Url(envelope.salt, "能力解锁盐");
    const iv = capabilityBase64Url(envelope.iv, "能力解锁 IV");
    const tag = capabilityBase64Url(envelope.tag, "能力解锁认证标签");
    const wrappedKey = capabilityBase64Url(envelope.wrappedKey, "能力解锁密文");
    if (salt.length !== 32 || iv.length !== 12 || tag.length !== 16 || wrappedKey.length !== 32) {
      return new LocalCapabilityPack({ present: true, pack, packHash, error: "能力解锁码加密参数无效" });
    }
    const ikm = crypto.createHash("sha256").update(licenseKey.trim(), "utf8").digest();
    const info = Buffer.from(`xingzhi-capability-key-v1\0${deviceId}\0${pack.packId}\0${packHash}`, "utf8");
    const kek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, 32));
    const aad = Buffer.from(`XZ-CAPKEY.v1\0${pack.packId}\0${packHash}\0${deviceId}`, "utf8");
    let masterKey;
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", kek, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      masterKey = Buffer.concat([decipher.update(wrappedKey), decipher.final()]);
    } catch {
      return new LocalCapabilityPack({ present: true, pack, packHash, error: "能力解锁码认证失败" });
    } finally {
      kek.fill(0);
      ikm.fill(0);
    }
    if (masterKey.length !== 32) {
      masterKey.fill(0);
      return new LocalCapabilityPack({ present: true, pack, packHash, error: "能力主密钥长度无效" });
    }
    return new LocalCapabilityPack({ present: true, pack, packHash, masterKey });
  } catch (error) {
    return new LocalCapabilityPack({
      present: true,
      error: `本地能力包加载失败：${String(error?.message || error || "未知错误").slice(0, 240)}`,
    });
  }
}

function createProtectedCapabilityVaultAdapter(baseAdapter, getPack) {
  if (!baseAdapter || typeof baseAdapter.read !== "function" || typeof getPack !== "function") {
    throw new Error("本地能力包 Vault 适配器配置无效");
  }
  // 能力注册表只含 {id, configPath, skillPath}，没有任何 Prompt / 路由 / 编排正文，
  // 是运行时索引且必须可读可写：加载能力目录要读它，新增能力要往里合并条目。
  // 若让它走加密包，打包那一刻的旧注册表会永久盖住磁盘上的新版本，
  // 导致后来注册的 Skill 与透镜在运行时完全不存在（且不产生任何 issue）。
  // Skill 与透镜的正文仍然全部由能力包加密保护，此处不降低 IP 保护强度。
  const REGISTRY_PASSTHROUGH = new Set([
    "10_智能体与技能/注册表/技能注册表.yaml",
    "10_智能体与技能/注册表/智能体注册表.yaml",
  ]);
  const normalizedForPassthrough = (vaultPath) => String(vaultPath || "")
    .replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  const isRegistry = (vaultPath) => REGISTRY_PASSTHROUGH.has(normalizedForPassthrough(vaultPath));
  const pack = () => getPack?.() || null;
  const isProtected = (vaultPath) => Boolean(!isRegistry(vaultPath) && pack()?.present && pack()?.has(vaultPath));
  const assertWritable = (vaultPath) => {
    if (isProtected(vaultPath)) throw new Error(`受保护能力文件为只读：${capabilityNormalizePath(vaultPath)}`);
  };
  return Object.freeze({
    ...baseAdapter,
    async listMarkdown(...args) {
      const rows = await baseAdapter.listMarkdown(...args);
      const current = pack();
      if (!current?.present) return rows;
      const result = [];
      for (const row of rows) {
        if (isRegistry(row?.path) || !current.has(row?.path)) {
          result.push(row);
          continue;
        }
        if (!current.unlocked) continue;
        result.push({ ...row, content: current.readText(row.path) });
      }
      return result;
    },
    async read(vaultPath) {
      if (isRegistry(vaultPath)) return baseAdapter.read(vaultPath);
      const current = pack();
      if (current?.present && current.has(vaultPath)) return current.readText(vaultPath);
      return baseAdapter.read(vaultPath);
    },
    async create(vaultPath, content) {
      assertWritable(vaultPath);
      return baseAdapter.create(vaultPath, content);
    },
    async modify(vaultPath, content) {
      assertWritable(vaultPath);
      return baseAdapter.modify(vaultPath, content);
    },
    async process(vaultPath, processor) {
      assertWritable(vaultPath);
      return baseAdapter.process(vaultPath, processor);
    },
    async rename(from, to) {
      assertWritable(from);
      assertWritable(to);
      return baseAdapter.rename(from, to);
    },
    async trashMarkdown(vaultPath) {
      assertWritable(vaultPath);
      return baseAdapter.trashMarkdown(vaultPath);
    },
  });
}

class CommercialLicenseModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }

  onOpen() {
    const root = this.contentEl;
    root.empty();
    root.createEl("h2", { text: "行知商业版授权" });
    const status = this.plugin.getCommercialLicenseSnapshot();
    const labels = { ACTIVE: "已激活", EXPIRING: "即将到期", EXPIRED: "已到期", UNACTIVATED: "未激活", INVALID: "授权无效", NOT_STARTED: "尚未生效" };
    root.createEl("p", { text: `${labels[status.status] || status.status}${status.expiresAt ? ` · 到期 ${status.expiresAt.slice(0, 10)}` : ""}${status.error ? ` · ${status.error}` : ""}` });
    const capabilityStatus = this.plugin.getCapabilityProtectionSnapshot();
    if (capabilityStatus.present) {
      root.createEl("p", { text: `本地能力包：${capabilityStatus.unlocked ? "已解锁" : "未解锁"} · ${capabilityStatus.entryCount || 0} 个受保护文件${capabilityStatus.error && !capabilityStatus.unlocked ? ` · ${capabilityStatus.error}` : ""}` });
    }
    root.createEl("p", { text: "授权绑定一台设备。未激活或到期后，已有 Markdown 文件仍可用 Obsidian 查看和导出；行知 AI 与自动写入知识库暂停。" });
    if (this.plugin.deviceIdentity) {
      root.createEl("p", { text: `当前设备：${this.plugin.deviceIdentity.deviceLabel}` });
      root.createEl("p", { text: "把设备申请码发送给签发人员。申请码不包含原始系统机器标识。" });
      const request = root.createEl("textarea", { attr: { rows: "4", readonly: "readonly", "aria-label": "行知设备申请码" } });
      request.value = this.plugin.deviceIdentity.requestCode;
      request.style.width = "100%";
      root.createEl("button", { text: "复制设备申请码" }).addEventListener("click", async () => {
        try { await globalThis.navigator.clipboard.writeText(request.value); new Notice("设备申请码已复制"); }
        catch { new Notice("复制失败，请手动复制申请码"); }
      });
    } else {
      root.createEl("p", { text: `设备识别失败：${this.plugin.deviceIdentityError || "未知错误"}` });
    }
    root.createEl("h3", { text: "激活或续期" });
    const input = root.createEl("textarea", { attr: { rows: "5", placeholder: "粘贴行知商业版授权码", "aria-label": "行知商业版授权码" } });
    input.style.width = "100%";
    const button = root.createEl("button", { text: "验证并保存授权码" });
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const next = await this.plugin.activateCommercialLicense(input.value);
        const protection = this.plugin.getCapabilityProtectionSnapshot();
        if (protection.present && !protection.unlocked) {
          new Notice(`行知商业版授权已生效，到期 ${next.expiresAt.slice(0, 10)}；请继续输入能力解锁码。`);
          button.disabled = false;
        } else {
          new Notice(`行知商业版授权已生效，到期 ${next.expiresAt.slice(0, 10)}`);
          this.close();
        }
      } catch (error) {
        new Notice(error instanceof Error ? error.message : "授权码无效");
        button.disabled = false;
      }
    });
    if (capabilityStatus.present) {
      root.createEl("h3", { text: "本地能力包解锁" });
      root.createEl("p", { text: "能力解锁码与当前商业授权、设备和能力包版本绑定，并安全保存在 Obsidian SecretStorage。" });
      const unlockInput = root.createEl("textarea", { attr: { rows: "5", placeholder: "粘贴 XZ-CAPKEY.v1... 能力解锁码", "aria-label": "行知能力解锁码" } });
      unlockInput.style.width = "100%";
      const unlockButton = root.createEl("button", { text: capabilityStatus.unlocked ? "重新验证能力解锁码" : "验证并安全保存能力解锁码" });
      unlockButton.addEventListener("click", async () => {
        unlockButton.disabled = true;
        try {
          const next = await this.plugin.activateCapabilityUnlock(unlockInput.value);
          new Notice(`本地能力包已解锁：${next.entryCount} 个受保护文件。`);
          this.close();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "能力解锁码无效");
          unlockButton.disabled = false;
        }
      });
    }
  }
}

class StartupRecoveryView extends ItemView {
  constructor(leaf, plugin, viewType) { super(leaf); this.plugin = plugin; this.viewType = viewType; }
  getViewType() { return this.viewType; }
  getDisplayText() { return this.plugin.startupFailure ? "行知启动恢复" : "行知正在恢复"; }
  getIcon() { return this.plugin.startupFailure ? "alert-triangle" : "loader"; }
  getState() { return this.startupViewState || {}; }
  async setState(state) { this.startupViewState = state; }
  async onOpen() {
    this.startupViewClosed = false;
    this.renderStartup();
    if (this.plugin.startupViewErrors?.has(this.leaf)) return;
    void this.plugin.startupPromise?.then(async () => {
      if (this.startupViewClosed || this.plugin.startupCancelled || this.leaf.view !== this) return;
      if (!this.plugin.startupReady) { this.renderStartup(); return; }
      await this.restoreOriginalView();
    }).catch(() => { if (!this.plugin.startupCancelled) new Notice("行知页面恢复未完成，请从功能区重新打开。历史记录已保留。"); });
  }
  async restoreOriginalView() {
    const state = this.getState();
    try {
      await this.leaf.setViewState({ type: "empty" });
      if (!this.plugin.startupCancelled && this.leaf.view?.getViewType?.() === "empty") {
        await this.leaf.setViewState({ type: this.viewType, state });
      }
    } catch {
      if (this.plugin.startupCancelled) return;
      new Notice("行知页面恢复未完成，历史记录已保留。可以重试打开页面。");
      const type = this.leaf.view?.getViewType?.();
      if (type !== "empty" && type !== this.viewType) return;
      this.plugin.startupViewErrors.set(this.leaf, true);
      await this.leaf.setViewState({ type: "empty" });
      if (!this.plugin.startupCancelled && this.leaf.view?.getViewType?.() === "empty") {
        await this.leaf.setViewState({ type: this.viewType, state });
      }
    }
  }
  async onClose() { this.startupViewClosed = true; }
  renderStartup() {
    this.contentEl.empty();
    if (this.plugin.startupViewErrors?.has(this.leaf)) {
      this.contentEl.createEl("h2", { text: "行知页面恢复未完成" });
      this.contentEl.createEl("p", { text: "历史记录已恢复，原页面暂时未能打开。你可以重试打开页面。" });
      const retry = this.contentEl.createEl("button", { text: "重试打开页面" });
      retry.addEventListener("click", () => {
        this.plugin.startupViewErrors.delete(this.leaf);
        void this.restoreOriginalView().catch(() => new Notice("页面暂时无法打开，请从功能区重新打开行知。"));
      });
      return;
    }
    if (!this.plugin.startupFailure) {
      this.contentEl.createEl("h2", { text: "正在恢复行知" });
      this.contentEl.createEl("p", { text: "正在校验并恢复本地历史记录。完成后会自动打开原页面。" });
      this.contentEl.createEl("p", { text: "恢复期间暂停保存，你可以继续使用 Obsidian 的其他页面。" });
      return;
    }
    this.contentEl.createEl("h2", { text: "行知启动未完成" });
    this.contentEl.createEl("p", { text: "原始数据已保护，当前暂停保存。请运行升级包中的只读诊断，并保留升级前备份。" });
    this.contentEl.createEl("p", { text: `失败阶段：${this.plugin.startupFailure?.stage || "unknown"}` });
    const button = this.contentEl.createEl("button", { text: "查看启动诊断" });
    button.addEventListener("click", () => this.plugin.openStartupDiagnostics());
  }
}

const { createJournalStore } = require("./journal-storage.cjs");

class XingzhiWorkbenchPlugin extends Plugin {
  async onload() {
    this.startupFailure = null;
    this.startupReady = false;
    this.startupCancelled = false;
    this.startupViewErrors = new WeakMap();
    this.addCommand({ id: "open-startup-diagnostics", name: "查看启动诊断", callback: () => this.openStartupDiagnostics() });
    for (const [type, View] of [
      [VIEW_TYPE_XINGZHI, XingzhiWorkbenchView],
      [VIEW_TYPE_XINGZHI_ARCHIVE_REVIEW, XingzhiArchiveReviewView],
      [VIEW_TYPE_XINGZHI_ACTION_CENTER, XingzhiActionCenterView],
      [VIEW_TYPE_COGNITIVE_HOME, CognitiveHomeView],
    ]) {
      this.registerView(type, leaf => this.startupReady && !this.startupViewErrors.has(leaf)
        ? new View(leaf, this)
        : new StartupRecoveryView(leaf, this, type));
    }
    // Returning lets Obsidian finish its own load while journal recovery remains
    // a tracked task. Every write stays closed until the full initialization ends.
    this.startupPromise = Promise.resolve().then(() => {
      if (!this.startupCancelled) return this._initializeWorkbench();
    }).catch(error => {
      if (this.startupCancelled) return;
      this.startupReady = false;
      this.startupFailure = { stage: this.startupStage || "initialize", code: /^[A-Z_]+$/u.test(error?.code || "") ? error.code : "STARTUP_FAILED" };
      new Notice("行知恢复未完成，原始数据已保护。请打开“查看启动诊断”。", 10000);
    });
  }

  async _initializeWorkbench() {
    let baseVaultAdapter;
    try {
    this.startupStage = "read-data";
    let stored = await this.loadData();
    if (this.startupCancelled) return;
    // Obsidian may return null after a read/parse failure. Existing state must
    // never be treated as a new empty installation in that case.
    if (stored == null) {
      const dataPath = nodePath.join(this.getVaultPath(), this.manifest?.dir || ".obsidian/plugins/xingzhi-workbench", "data.json");
      stored = fs.existsSync(dataPath) ? JSON.parse(fs.readFileSync(dataPath, "utf8")) : {};
    }
    if (typeof stored !== "object" || Array.isArray(stored)) throw new Error("工作台状态必须是对象");
    this.journalStore = null;
    if (stored.journalStorage !== undefined) {
      this.startupStage = "read-cold-journal";
      const marker = stored.journalStorage;
      if (!marker || marker.schemaVersion !== 1 || marker.format !== "xingzhi-journal-store-v1"
        || !/^[a-f0-9]{32}$/u.test(marker.epoch || "")
        || Object.keys(marker).some(key => !["schemaVersion", "epoch", "format"].includes(key))
        || !validJournalKey(stored.localJournalKey)) {
        throw Object.assign(new Error("冷日志指针或配对密钥无效，已保留原始数据。"), { code: "INVALID_JOURNAL_STORAGE" });
      }
      if (stored.knowledgeTransactions !== undefined || stored.knowledgeIndexTransactions !== undefined) {
        throw Object.assign(new Error("新旧日志存储同时出现，需要核对迁移状态。"), { code: "AMBIGUOUS_JOURNAL_STORAGE" });
      }
      this.journalStore = createJournalStore({
        directory: nodePath.join(this.getVaultPath(), this.manifest?.dir || ".obsidian/plugins/xingzhi-workbench", "state-store", "journals-v1"),
        journalKey: stored.localJournalKey, epoch: marker.epoch,
      });
      stored = { ...stored, ...await this.journalStore.hydrate() };
      if (this.startupCancelled) return;
    }
    for (const key of ["knowledgeTransactions", "knowledgeIndexTransactions"]) {
      if (stored[key] !== undefined && !Array.isArray(stored[key])) throw new Error("事务日志必须是数组");
    }
    this.deviceIdentity = null;
    this.deviceIdentityError = null;
    this.licenseManager = null;
    this.capabilityPack = null;
    this.protectedSkillRuntimeDir = null;
    if (COMMERCIAL_BUILD) {
      try { this.deviceIdentity = getCurrentDeviceIdentity(); }
      catch (error) { this.deviceIdentityError = String(error?.message || "设备识别失败").slice(0, 200); }
      if (this.deviceIdentity) {
        this.licenseManager = new LicenseManager({
          load: async () => ({ licenseKey: stored.licenseKey }),
          save: async () => this.saveWorkbenchState(),
          deviceId: this.deviceIdentity.deviceId,
          trustedPublicKeys: TRUSTED_COMMERCIAL_KEYS,
        });
        await this.licenseManager.initialize();
        if (this.startupCancelled) return;
      }
      this.addCommand({ id: "manage-commercial-license", name: "管理商业版授权", callback: () => this.openCommercialLicenseModal() });
    }
    this.standardBrandEnabled = await this.detectStandardBrandVault();
    if (this.startupCancelled) return;
    this.brandIconName = XINGZHI_LOGO_ICON;
    this.brandMarkIconName = XINGZHI_LOGO_ICON;
    this.standardBrandRoot = this.app.workspace?.containerEl || null;
    if (this.standardBrandEnabled) this.standardBrandRoot?.addClass(STANDARD_BRAND_CLASS);
    this.localJournalKey = validJournalKey(stored.localJournalKey)
      ? stored.localJournalKey
      : crypto.randomBytes(JOURNAL_KEY_BYTES).toString("hex");
    this.originalLocalJournalKey = stored.localJournalKey;
    this.localJournalKeyStatus = stored.localJournalKey === undefined ? "missing" : validJournalKey(stored.localJournalKey) ? "valid" : "invalid";
    this.openOnStartup = stored.openOnStartup !== false;
    this.capabilityRefreshes = new Map();
    this.startupStage = "normalize-state";
    this.state = createRuntimeState(stored);
    const vaultPath = this.getVaultPath();
    this.vaultPath = vaultPath;
    this._reloadCapabilityPack();
    if (COMMERCIAL_BUILD && this.capabilityPack?.present && !this.capabilityPack.unlocked
      && typeof this.app?.secretStorage?.setSecret === "function") {
      const bootstrapUnlockPath = nodePath.join(
        vaultPath,
        "00_系统",
        "备份",
        "2026-09-24-IP保护升级-v1.0",
        "当前设备-能力解锁码.txt",
      );
      if (fs.existsSync(bootstrapUnlockPath)) {
        const bootstrapUnlockCode = fs.readFileSync(bootstrapUnlockPath, "utf8").trim();
        const candidate = loadLocalCapabilityPack({
          vaultPath,
          pluginDirectory: capabilityPluginDirectory(this),
          licenseKey: this.licenseManager?.licenseKey || null,
          deviceId: this.deviceIdentity?.deviceId || null,
          unlockCode: bootstrapUnlockCode,
        });
        if (candidate.unlocked) {
          this.app.secretStorage.setSecret(CAPABILITY_UNLOCK_SECRET_ID, bootstrapUnlockCode);
          this.capabilityPack = candidate;
        }
      }
    }
    baseVaultAdapter = createObsidianVaultAdapter(this.app.vault, {
      retrievalIndexDirectory: nodePath.join(vaultPath, this.manifest?.dir || ".obsidian/plugins/xingzhi-workbench", "state-store", "retrieval-v1"),
    });
    const protectedVaultAdapter = createProtectedCapabilityVaultAdapter(baseVaultAdapter, () => this.capabilityPack);
    this.startupStage = "create-runtime";
    this.workbenchRuntime = new WorkbenchRuntime({
      state: this.state,
      vaultPath,
      vault: COMMERCIAL_BUILD
        ? createCommercialVaultGate(protectedVaultAdapter, () => this.requireCommercialLicense())
        : protectedVaultAdapter,
      enableModelSemanticRouter: true,
      journalKey: this.localJournalKey,
      journalStore: this.journalStore,
      requireLicense: COMMERCIAL_BUILD ? () => this.requireCommercialLicense() : undefined,
      resolveSkillExtraRoots: () => this.prepareProtectedSkillExtraRoots(),
      cleanupSkillExtraRoots: () => this.cleanupProtectedSkillRuntime(),
      resolveSecret: (secretRef) => this.resolveSecret(secretRef),
      credentialStatus: (providerId) => this.getProviderCredentialStatus(providerId),
      saveState: (state) => this.saveWorkbenchState(state),
      extractPdf: (bytes) => extractPdfText(bytes),
    });
    if (this.journalStore && this.workbenchRuntime.journalImportBlocked) {
      this.startupStage = "validate-cold-journal";
      throw Object.assign(new Error("冷日志中的事务未通过原签名校验。"), { code: "JOURNAL_IMPORT_BLOCKED" });
    }
    } catch (error) {
      if (this.startupCancelled) return;
      this.startupFailure = { stage: this.startupStage, code: /^[A-Z_]+$/u.test(error?.code || "") ? error.code : "STARTUP_FAILED" };
      new Notice("行知启动未完成，已保护原始数据。请打开“查看启动诊断”或运行升级包中的只读诊断。", 10000);
      return;
    }
    if (this.workbenchRuntime.journalImportBlocked) {
      new Notice(this.state.runtime.journalImportWarning, 12000);
    }

    for (const event of ["create", "modify", "delete", "rename"]) {
      this.registerEvent(this.app.vault.on(event, (file, oldPath) => {
        baseVaultAdapter.invalidateRetrievalIndex?.(file?.path, oldPath);
        this.workbenchRuntime.invalidateDailyReview(file?.path, oldPath);
      }));
    }

    this.addRibbonIcon(XINGZHI_LOGO_ICON, "打开行知工作台", () => {
      void this.openCognitiveHome();
    });
    this.addCommand({ id: "open-cognitive-home", name: "打开行知主界面", callback: () => this.openCognitiveHome() });

    this.addCommand({
      id: "open-workbench",
      name: "打开工作台",
      callback: () => this.activateWorkbench(),
    });
    this.addCommand({
      id: "open-cognitive-dashboard",
      name: "打开知识库导航笔记",
      callback: async () => {
        const file = this.app.vault.getAbstractFileByPath("行知-首页.md");
        if (!file) { new Notice("知识库首页尚未建立，请先安装配套导航文件。"); return; }
        await openVaultFile(this.app.workspace, file);
      },
    });
    this.addCommand({
      id: "new-conversation",
      name: "新建行知对话",
      callback: async () => {
        await this.createConversation();
        await this.activateWorkbench();
      },
    });
    this.addCommand({
      id: "open-quick-capture",
      name: "打开快速收集（对话）",
      callback: () => this.activateWorkbench("capture"),
    });
    this.addCommand({
      id: "open-codex-workspace",
      name: "打开与行知 AI 工作",
      callback: () => this.activateWorkbench("ai"),
    });
    this.addCommand({
      id: "open-connection-settings",
      name: "打开模型连接设置",
      callback: () => this.activateWorkbench("settings"),
    });
    this.addCommand({
      id: "open-connection-diagnostics",
      name: "打开连接诊断",
      callback: () => this.openConnectionDiagnostics(),
    });
    this.addCommand({
      id: "run-first-principles-shadow-probe",
      name: "运行第一性重建影子连接测试",
      callback: async () => {
        new Notice("正在运行第一性重建影子连接测试；不会写入知识库或改变正式回答。");
        try {
          const result = await this.runFirstPrinciplesShadowProbe();
          new Notice(`影子连接测试通过：${result.findingCount} 项发现，${result.tokenUsage.totalTokens} Token，${result.latencyMs}ms。`);
        } catch (error) {
          const message = String(error?.message || error || "未知错误").replace(/[\r\n]+/gu, " ").slice(0, 300);
          new Notice(`影子连接测试失败：${message}`);
        }
      },
    });
    this.addCommand({
      id: "run-first-principles-pilot-case",
      name: "运行下一条第一性重建新旧配对评测",
      callback: async () => {
        new Notice("正在依次运行旧规则与新版 MD；只使用固定测试情景，不改变正式回答。");
        try {
          const result = await this.runFirstPrinciplesPilotCase();
          if (!result.comparison) {
            new Notice(`第一性重建配对评测已完成 ${result.completedCases}/8；迁移门槛${result.gate.passed ? "通过" : "未通过"}。`);
            return;
          }
          new Notice(`配对评测 ${result.caseId}：${result.status}，进度 ${result.completedCases}/8，剩余 ${result.remainingCases}。`);
        } catch (error) {
          const message = String(error?.message || error || "未知错误").replace(/[\r\n]+/gu, " ").slice(0, 300);
          new Notice(`第一性重建配对评测失败：${message}`);
        }
      },
    });
    this.addCommand({
      id: "activate-first-principles-migration",
      name: "激活已通过评测的第一性重建 Skill",
      callback: async () => {
        new Notice("正在核对八条迁移证据并切换到第一性重建活动 MD 快照。");
        try {
          const result = await this.activateFirstPrinciplesMigration();
          new Notice(`第一性重建已激活：${result.identity.skillVersion}，${result.gate.qualifyingCases}/8 条证据通过。`);
        } catch (error) {
          const message = String(error?.message || error || "未知错误").replace(/[\r\n]+/gu, " ").slice(0, 300);
          new Notice(`第一性重建未激活：${message}`);
        }
      },
    });
    this.addCommand({
      id: "run-system-feedback-pilot-case",
      name: "运行下一条系统与反馈分析新旧配对评测",
      callback: async () => {
        new Notice("正在依次运行旧系统规则与新版 MD；只使用固定合成情景，不改变正式回答。");
        try {
          const result = await this.runSystemFeedbackPilotCase();
          if (!result.comparison) {
            new Notice(`系统与反馈分析配对评测已完成 ${result.completedCases}/8；迁移门槛${result.gate.passed ? "通过" : "未通过"}。`);
            return;
          }
          new Notice(`系统配对评测 ${result.caseId}：${result.status}，进度 ${result.completedCases}/8，剩余 ${result.remainingCases}。`);
        } catch (error) {
          const message = String(error?.message || error || "未知错误").replace(/[\r\n]+/gu, " ").slice(0, 300);
          new Notice(`系统与反馈分析配对评测失败：${message}`);
        }
      },
    });
    this.addCommand({
      id: "activate-system-feedback-migration",
      name: "激活已通过评测的系统与反馈分析 Skill",
      callback: async () => {
        new Notice("正在核对八条系统迁移证据并切换到活动 MD 快照。");
        try {
          const result = await this.activateSystemFeedbackMigration();
          new Notice(`系统与反馈分析已激活：${result.identity.skillVersion}，${result.gate.qualifyingCases}/8 条证据通过。`);
        } catch (error) {
          const message = String(error?.message || error || "未知错误").replace(/[\r\n]+/gu, " ").slice(0, 300);
          new Notice(`系统与反馈分析未激活：${message}`);
        }
      },
    });
    this.addCommand({
      id: "run-causal-evidence-pilot-case",
      name: "运行下一条因果与证据检验新旧配对评测",
      callback: async () => {
        new Notice("正在运行固定因果、证据或联合情景的新旧配对；不会改变正式回答。");
        try {
          const result = await this.runCausalEvidencePilotCase();
          if (!result.comparison) {
            new Notice(`因果与证据检验配对评测已完成 ${result.completedCases}/8；迁移门槛${result.gate.passed ? "通过" : "未通过"}。`);
            return;
          }
          new Notice(`因果与证据配对评测 ${result.caseId}：${result.status}，进度 ${result.completedCases}/8，剩余 ${result.remainingCases}。`);
        } catch (error) {
          const message = String(error?.message || error || "未知错误").replace(/[\r\n]+/gu, " ").slice(0, 300);
          new Notice(`因果与证据检验配对评测失败：${message}`);
        }
      },
    });
    this.addCommand({
      id: "activate-causal-evidence-migration",
      name: "激活已通过评测的因果与证据检验 Skill",
      callback: async () => {
        new Notice("正在核对八条因果与证据迁移证据，并验证单模式和联合模式。");
        try {
          const result = await this.activateCausalEvidenceMigration();
          new Notice(`因果与证据检验已激活：${result.identity.skillVersion}，${result.gate.qualifyingCases}/8 条证据通过。`);
        } catch (error) {
          const message = String(error?.message || error || "未知错误").replace(/[\r\n]+/gu, " ").slice(0, 300);
          new Notice(`因果与证据检验未激活：${message}`);
        }
      },
    });
    this.addCommand({
      id: "run-reversal-failure-pilot-case",
      name: "运行下一条反演与失败条件新旧配对评测",
      callback: async () => {
        new Notice("正在运行固定失败预演、目标倒推或联合情景的新旧配对；不会改变正式回答。");
        try {
          const result = await this.runReversalFailurePilotCase();
          if (!result.comparison) {
            new Notice(`反演与失败条件配对评测已完成 ${result.completedCases}/8；迁移门槛${result.gate.passed ? "通过" : "未通过"}。`);
            return;
          }
          new Notice(`反演与失败条件配对评测 ${result.caseId}：${result.status}，进度 ${result.completedCases}/8，剩余 ${result.remainingCases}。`);
        } catch (error) {
          const message = String(error?.message || error || "未知错误").replace(/[\r\n]+/gu, " ").slice(0, 300);
          new Notice(`反演与失败条件配对评测失败：${message}`);
        }
      },
    });
    this.addCommand({
      id: "activate-reversal-failure-migration",
      name: "激活已通过评测的反演与失败条件 Skill",
      callback: async () => {
        new Notice("正在核对八条反演与失败条件迁移证据，并验证单模式和联合模式。");
        try {
          const result = await this.activateReversalFailureMigration();
          new Notice(`反演与失败条件已激活：${result.identity.skillVersion}，${result.gate.qualifyingCases}/8 条证据通过。`);
        } catch (error) {
          const message = String(error?.message || error || "未知错误").replace(/[\r\n]+/gu, " ").slice(0, 300);
          new Notice(`反演与失败条件未激活：${message}`);
        }
      },
    });
    this.addCommand({
      id: "run-contradiction-stage-pilot-case",
      name: "运行下一条矛盾与阶段分析新旧配对评测",
      callback: async () => {
        new Notice("正在运行固定产品、职业、关系或长期成长情景的新旧配对；不会改变正式回答。");
        try {
          const result = await this.runContradictionStagePilotCase();
          if (!result.comparison) {
            new Notice(`矛盾与阶段分析配对评测已完成 ${result.completedCases}/10；迁移门槛${result.gate.passed ? "通过" : "未通过"}。`);
            return;
          }
          new Notice(`矛盾与阶段配对评测 ${result.caseId}：${result.status}，进度 ${result.completedCases}/10，剩余 ${result.remainingCases}。`);
        } catch (error) {
          const message = String(error?.message || error || "未知错误").replace(/[\r\n]+/gu, " ").slice(0, 300);
          new Notice(`矛盾与阶段分析配对评测失败：${message}`);
        }
      },
    });
    this.addCommand({
      id: "activate-contradiction-stage-migration",
      name: "激活已通过评测的矛盾与阶段分析 Skill",
      callback: async () => {
        new Notice("正在核对十条矛盾与阶段迁移证据，并切换到活动 MD 快照。");
        try {
          const result = await this.activateContradictionStageMigration();
          new Notice(`矛盾与阶段分析已激活：${result.identity.skillVersion}，${result.gate.qualifyingCases}/10 条证据通过。`);
        } catch (error) {
          const message = String(error?.message || error || "未知错误").replace(/[\r\n]+/gu, " ").slice(0, 300);
          new Notice(`矛盾与阶段分析未激活：${message}`);
        }
      },
    });
    this.addCommand({
      id: "run-incentive-structure-pilot-case",
      name: "运行下一条利益与激励分析新旧配对评测",
      callback: async () => {
        new Notice("正在运行固定客户、合作、职场或平台规则情景的新旧配对；不会改变正式回答。");
        try {
          const result = await this.runIncentiveStructurePilotCase();
          if (!result.comparison) {
            new Notice(`利益与激励分析配对评测已完成 ${result.completedCases}/10；迁移门槛${result.gate.passed ? "通过" : "未通过"}。`);
            return;
          }
          new Notice(`利益与激励配对评测 ${result.caseId}：${result.status}，进度 ${result.completedCases}/10，剩余 ${result.remainingCases}。`);
        } catch (error) {
          const message = String(error?.message || error || "未知错误").replace(/[\r\n]+/gu, " ").slice(0, 300);
          new Notice(`利益与激励分析配对评测失败：${message}`);
        }
      },
    });
    this.addCommand({
      id: "activate-incentive-structure-migration",
      name: "激活已通过评测的利益与激励分析 Skill",
      callback: async () => {
        new Notice("正在核对十条利益与激励迁移证据，并切换到活动 MD 快照。");
        try {
          const result = await this.activateIncentiveStructureMigration();
          new Notice(`利益与激励分析已激活：${result.identity.skillVersion}，${result.gate.qualifyingCases}/10 条证据通过。`);
        } catch (error) {
          const message = String(error?.message || error || "未知错误").replace(/[\r\n]+/gu, " ").slice(0, 300);
          new Notice(`利益与激励分析未激活：${message}`);
        }
      },
    });
    this.addCommand({
      id: "open-conversation-recycle-bin",
      name: "打开删除对话回收站",
      callback: () => this.openRecycleBin(),
    });
    this.addCommand({
      id: "open-knowledge-health",
      name: "打开知识体检",
      callback: () => this.openKnowledgeHealth(),
    });
    this.addCommand({
      id: "open-knowledge-structure",
      name: "打开知识结构管理",
      callback: () => this.openKnowledgeStructure(),
    });
    this.addCommand({
      id: "open-user-growth",
      name: "打开我的成长",
      callback: () => this.openUserGrowth(),
    });
    this.addCommand({
      id: "open-action-center",
      name: "打开每日决策",
      callback: () => this.openActionCenter(),
    });
    this.addCommand({
      id: "preview-knowledge-indexes",
      name: "预览并更新知识索引",
      callback: () => this.activateWorkbench("knowledge-health"),
    });
    this.addCommand({
      id: "retry-current-archive",
      name: "重试当前对话归档",
      callback: async () => {
        const conversationId = this.state.activeConversationId;
        if (this.getArchiveRecoveryAction(conversationId).action !== "retry") {
          throw new Error("当前对话没有需要重试的归档任务");
        }
        await this.retryArchiveConversation(conversationId);
      },
    });

    this.startupReady = true;
    this.app.workspace.onLayoutReady(() => {
      if (this.startupCancelled) return;
      const protection = this.getCapabilityProtectionSnapshot();
      if (!protection.present || protection.unlocked) {
        // Skill 与认知透镜只依赖 vault 目录，与引擎无关：先无条件把能力目录读出来，
        // 否则默认 provider 不是 codex 时，冷启动后 capabilityCatalog 始终为空，
        // 透镜与 Skill 选择面板只会显示「尚未读取到可用透镜」。
        const startupProviderId = this.state.settings.providerId || "codex";
        void (async () => {
          try {
            await this.workbenchRuntime.refreshCapabilityCatalog();
          } catch (error) {
            this.state.runtime.connection.warnings.push(`能力目录加载失败：${String(error?.message || error).slice(0, 200)}`);
          }
          try {
            await this.refreshCapabilities(startupProviderId);
          } catch (_) {
            // 模型发现失败不影响已经加载好的 Skill 与透镜
          }
        })();
      }
      void (this.openOnStartup ? this.openCognitiveHome() : this.migrateLegacyWorkspaces())
        .catch(error => new Notice(`行知工作区恢复未完成：${error?.message || "未知错误"}。原资料未更改。`));
      if (COMMERCIAL_BUILD && !this.getCommercialLicenseSnapshot().allowAi) {
        new Notice("行知商业版尚未激活或授权已到期；请在命令面板打开“管理商业版授权”。");
      } else if (protection.present && !protection.unlocked) {
        new Notice("行知本地能力包尚未解锁；请在命令面板打开“管理商业版授权”输入能力解锁码。");
      }
    });
  }

  onunload() {
    this.startupCancelled = true;
    this.workbenchRuntime?.stop();
    this.cleanupProtectedSkillRuntime();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_COGNITIVE_HOME);
    if (this.standardBrandEnabled) this.standardBrandRoot?.removeClass(STANDARD_BRAND_CLASS);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_XINGZHI);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_XINGZHI_ARCHIVE_REVIEW);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_XINGZHI_ACTION_CENTER);
  }

  async detectStandardBrandVault() {
    const file = this.app.vault.getAbstractFileByPath?.("00_系统/标准库配置.json");
    if (!(file instanceof TFile)) return false;
    try {
      const config = JSON.parse(await this.app.vault.read(file));
      return isStandardBrandConfig(config);
    } catch (_) {
      return false;
    }
  }

  getBrandIconName() {
    return this.brandIconName || "brain-circuit";
  }

  getBrandMarkIconName() {
    return this.brandMarkIconName || this.getBrandIconName();
  }


  getBrandAssetUrl() {
    const pluginDirectory = String(
      this.manifest?.dir || `.obsidian/plugins/${this.manifest?.id || "xingzhi-workbench"}`,
    ).replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
    return this.app.vault.adapter.getResourcePath(
      `${pluginDirectory}/${XINGZHI_BRAND_ASSET}`,
    );
  }
  getVaultPath() {
    const basePath = this.app.vault.adapter.getBasePath?.();
    if (!basePath) throw new Error("行知工作台只支持可访问本地路径的 Obsidian 桌面库");
    return basePath;
  }

  resolveSecret(secretRef) {
    const reference = String(secretRef || "");
    if (!ALLOWED_SECRET_REFS.has(reference)) throw new Error("该密钥引用不在行知允许列表中");
    const stored = this._storedSecret(reference);
    if (stored) return stored;
    const name = reference.slice(4);
    const value = process.env[name];
    if (typeof value !== "string" || !value) {
      throw new Error(`尚未配置 ${name}；请在行知设置中安全保存 API Key`);
    }
    return value;
  }

  _storedSecret(secretRef) {
    const config = secretRefConfig(String(secretRef || ""));
    if (!config || typeof this.app?.secretStorage?.getSecret !== "function") return null;
    const value = this.app.secretStorage.getSecret(config.storageId);
    return typeof value === "string" && value ? value : null;
  }

  setProviderSecret(providerId, secret) {
    const config = providerSecretConfig(providerId);
    if (!config) throw new Error("不支持的模型提供商");
    if (typeof this.app?.secretStorage?.setSecret !== "function") {
      throw new Error("当前 Obsidian 安全密钥库不可用，请升级到 1.11.4 或更高版本");
    }
    const value = String(secret || "");
    if (!value) throw new Error("API Key 不能为空");
    if (value.length > 8_192) throw new Error("API Key 过长");
    if (/[\r\n]/u.test(value)) throw new Error("API Key 不能包含换行");
    this.app.secretStorage.setSecret(config.storageId, value);
    return this.getProviderCredentialStatus(providerId);
  }

  getProviderCredentialStatus(providerId) {
    const config = providerSecretConfig(providerId);
    if (!config) return { configured: false, source: null };
    if (this._storedSecret(config.ref)) {
      return { configured: true, source: "obsidian-secret-storage" };
    }
    const name = config.ref.slice(4);
    const environmentValue = process.env[name];
    return typeof environmentValue === "string" && environmentValue
      ? { configured: true, source: "environment" }
      : { configured: false, source: null };
  }

  cleanupProtectedSkillRuntime() {
    const runtimeDir = this.protectedSkillRuntimeDir;
    this.protectedSkillRuntimeDir = null;
    if (!runtimeDir) return;
    try {
      const resolved = nodePath.resolve(runtimeDir);
      const tempRoot = nodePath.resolve(os.tmpdir());
      if (resolved !== tempRoot && resolved.startsWith(`${tempRoot}${nodePath.sep}`)
        && nodePath.basename(resolved).startsWith("xingzhi-cap-")) {
        fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      }
    } catch (_) {}
  }

  _materializeProtectedSkillTree(sourceRoot, targetRoot) {
    const vaultRoot = nodePath.resolve(this.vaultPath || this.getVaultPath());
    const source = nodePath.resolve(sourceRoot);
    if (source !== vaultRoot && !source.startsWith(`${vaultRoot}${nodePath.sep}`)) {
      throw new Error("受保护 Skill 源目录越过 Vault 边界");
    }
    fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
    const walk = (fromDir, toDir) => {
      for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const from = nodePath.join(fromDir, entry.name);
        const to = nodePath.join(toDir, entry.name);
        if (entry.isDirectory()) {
          fs.mkdirSync(to, { recursive: true, mode: 0o700 });
          walk(from, to);
          continue;
        }
        if (!entry.isFile()) continue;
        const relative = capabilityNormalizePath(nodePath.relative(vaultRoot, from));
        let bytes;
        if (this.capabilityPack?.present && this.capabilityPack.has(relative)) {
          bytes = Buffer.from(this.capabilityPack.readText(relative), "utf8");
        } else {
          bytes = fs.readFileSync(from);
        }
        fs.writeFileSync(to, bytes, { mode: 0o600 });
      }
    };
    if (fs.existsSync(source)) walk(source, targetRoot);
    return targetRoot;
  }

  prepareProtectedSkillExtraRoots() {
    const protection = this.getCapabilityProtectionSnapshot();
    if (!protection.present) return null;
    if (!protection.unlocked) {
      throw new Error(`本地能力包尚未解锁：${protection.error || "请输入能力解锁码"}`);
    }
    this.cleanupProtectedSkillRuntime();
    const runtimeDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "xingzhi-cap-"));
    try { fs.chmodSync(runtimeDir, 0o700); } catch (_) {}
    this.protectedSkillRuntimeDir = runtimeDir;
    const skillRoot = nodePath.join(this.vaultPath, "10_智能体与技能", "技能");
    const releaseRoot = nodePath.join(this.vaultPath, "00_系统", "能力运行时", "skill-releases");
    const materializedSkillRoot = this._materializeProtectedSkillTree(
      skillRoot, nodePath.join(runtimeDir, "skills"),
    );
    const materializedReleaseRoot = this._materializeProtectedSkillTree(
      releaseRoot, nodePath.join(runtimeDir, "releases"),
    );
    return [materializedSkillRoot, materializedReleaseRoot];
  }

  _storedCapabilityUnlockCode() {
    if (typeof this.app?.secretStorage?.getSecret !== "function") return null;
    const value = this.app.secretStorage.getSecret(CAPABILITY_UNLOCK_SECRET_ID);
    return typeof value === "string" && value ? value : null;
  }

  _reloadCapabilityPack(unlockCode = this._storedCapabilityUnlockCode()) {
    const vaultPath = this.vaultPath || this.getVaultPath();
    this.capabilityPack = loadLocalCapabilityPack({
      vaultPath,
      pluginDirectory: capabilityPluginDirectory(this),
      licenseKey: this.licenseManager?.licenseKey || null,
      deviceId: this.deviceIdentity?.deviceId || null,
      unlockCode,
    });
    return this.capabilityPack.snapshot();
  }

  getCapabilityProtectionSnapshot() {
    return this.capabilityPack?.snapshot?.() || Object.freeze({
      present: false,
      unlocked: false,
      packId: null,
      entryCount: 0,
      packHash: null,
      error: null,
    });
  }

  async activateCapabilityUnlock(code) {
    if (!COMMERCIAL_BUILD || !this.licenseManager || !this.deviceIdentity) {
      throw new Error("请先完成本机商业授权");
    }
    this.licenseManager.require("core.workbench");
    if (typeof this.app?.secretStorage?.setSecret !== "function") {
      throw new Error("当前 Obsidian 安全密钥库不可用，请升级到 1.11.4 或更高版本");
    }
    const candidate = loadLocalCapabilityPack({
      vaultPath: this.vaultPath || this.getVaultPath(),
      pluginDirectory: capabilityPluginDirectory(this),
      licenseKey: this.licenseManager.licenseKey,
      deviceId: this.deviceIdentity.deviceId,
      unlockCode: String(code || "").trim(),
    });
    const snapshot = candidate.snapshot();
    if (!snapshot.present) throw new Error("当前安装中没有本地加密能力包");
    if (!snapshot.unlocked) throw new Error(snapshot.error || "能力解锁失败");
    this.app.secretStorage.setSecret(CAPABILITY_UNLOCK_SECRET_ID, String(code || "").trim());
    this.capabilityPack = candidate;
    try {
      if (this.workbenchRuntime?.started) this.workbenchRuntime.stop();
      await this.refreshCapabilities("codex");
    } catch (error) {
      new Notice(`能力包已解锁；运行时刷新失败，重启 Obsidian 后再试：${String(error?.message || error).slice(0, 200)}`);
    }
    return snapshot;
  }

  async saveWorkbenchState(state = this.state) {
    if (!this.startupReady || this.startupFailure) throw new Error("行知启动恢复未完成，已保护原始数据，暂停保存。");
    const persisted = {
      ...state,
      ...(this.workbenchRuntime?.journalImportBlocked ? this.workbenchRuntime.journalOriginals : {}),
      runtime: undefined,
      localJournalKey: this.workbenchRuntime?.journalImportBlocked ? this.originalLocalJournalKey : this.localJournalKey,
      openOnStartup: this.openOnStartup,
      ...(COMMERCIAL_BUILD ? { licenseKey: this.licenseManager?.licenseKey || null } : {}),
    };
    // Only the durable store may supply the cold journal marker. Ordinary state
    // saves never rewrite signed snapshots and never publish an unverified head.
    if (this.journalStore) await this.journalStore.assertHealthy({ allowActive: true });
    await this.saveData(this.journalStore ? this.journalStore.compactState(persisted) : persisted);
  }

  openStartupDiagnostics() {
    const modal = new Modal(this.app);
    modal.onOpen = () => {
      modal.contentEl.createEl("h2", { text: "行知启动诊断" });
      modal.contentEl.createEl("p", { text: this.startupFailure
        ? "启动未完成，原始数据暂停保存。运行升级包的只读诊断后检查配置和状态文件。"
        : !this.startupReady
          ? "正在校验并恢复本地历史记录。恢复期间暂停保存，完成后会自动打开原页面。"
        : this.workbenchRuntime?.journalImportBlocked
          ? this.state.runtime.journalImportWarning
          : "事务日志导入正常。若 Obsidian 仍白屏，请检查配置、其他插件及 Obsidian 运行环境。" });
      modal.contentEl.createEl("pre", { text: JSON.stringify({
        pluginVersion: this.manifest?.version || "0.45.3",
        startupFailure: this.startupFailure,
        localJournalKeyStatus: this.localJournalKeyStatus || "not-read",
        journals: this.state?.runtime?.journalImportReport || null,
      }, null, 2) });
      modal.contentEl.createEl("p", { text: "异常条目的 index 从 0 开始。诊断不包含正文或密钥。恢复时应配对使用同一份备份中的事务日志与本地密钥，不要手改签名。" });
    };
    modal.open();
  }

  getCommercialLicenseSnapshot() {
    return this.licenseManager?.snapshot() || {
      status: this.deviceIdentityError ? "INVALID" : "UNACTIVATED",
      error: this.deviceIdentityError,
      allowAi: false,
      expiresAt: null,
    };
  }

  requireCommercialLicense() {
    if (!COMMERCIAL_BUILD) return;
    if (!this.licenseManager) throw new Error(`行知商业版授权不可用：${this.deviceIdentityError || "请先获取设备申请码"}`);
    this.licenseManager.require("core.workbench");
    const protection = this.getCapabilityProtectionSnapshot();
    if (protection.present && !protection.unlocked) {
      throw new Error(`本地能力包尚未解锁：${protection.error || "请在“管理商业版授权”中输入能力解锁码"}`);
    }
  }

  openCommercialLicenseModal() { if (COMMERCIAL_BUILD) new CommercialLicenseModal(this.app, this).open(); }

  async activateCommercialLicense(code) {
    if (!COMMERCIAL_BUILD || !this.licenseManager) throw new Error("本机尚无法激活商业版授权");
    const snapshot = await this.licenseManager.activate(code);
    const protection = this._reloadCapabilityPack();
    if (!protection.present || protection.unlocked) {
      try { await this.workbenchRuntime?.refreshCapabilityCatalog(); }
      catch (error) { new Notice(`授权已保存；能力目录刷新失败，重启 Obsidian 后再试：${String(error?.message || error).slice(0, 200)}`); }
    }
    return snapshot;
  }

  subscribe(listener) {
    this.workbenchRuntime.on("stateChanged", listener);
    return () => this.workbenchRuntime.off("stateChanged", listener);
  }

  createConversation() {
    this.requireCommercialLicense();
    return this.workbenchRuntime.createConversation();
  }

  getDailyReviewState() {
    return this.workbenchRuntime.getDailyReviewState();
  }

  generateDailyReview() {
    this.requireCommercialLicense();
    return this.workbenchRuntime.generateDailyReview();
  }

  ensureDailyReview() { return this.workbenchRuntime.ensureDailyReview(); }

  saveDailyReviewSnapshot(reviewId) {
    return this.workbenchRuntime.saveDailyReviewSnapshot(reviewId);
  }

  getUserContinuitySnapshot(options) { return this.workbenchRuntime.getUserContinuitySnapshot(options); }
  getCognitiveSnapshot() { return this.workbenchRuntime.getCognitiveSnapshot(); }
  createCognitiveLoop(input) { this.requireCommercialLicense(); return this.workbenchRuntime.createCognitiveLoop(input); }
  recordCognitiveFeedback(path, input, expectedHash) { this.requireCommercialLicense(); return this.workbenchRuntime.recordCognitiveFeedback(path, input, expectedHash); }
  updateCognitiveHolds(action, payload, expectedHash) { this.requireCommercialLicense(); return this.workbenchRuntime.updateCognitiveHolds(action, payload, expectedHash); }
  undoCognitiveChange(id) { return this.workbenchRuntime.undoCognitiveChange(id); }
  getGrowthReplayPreview(options) { return this.workbenchRuntime.getGrowthReplayPreview(options); }
  replayGrowthRecords(selections) { return this.workbenchRuntime.replayGrowthRecords(selections); }
  cancelGrowthReplay() { return this.workbenchRuntime.cancelGrowthReplay(); }

  selectConversation(id) {
    return this.workbenchRuntime.selectConversation(id);
  }

  toggleConversationPin(id) {
    return this.workbenchRuntime.toggleConversationPin(id);
  }

  renameConversation(id, title) {
    return this.workbenchRuntime.renameConversation(id, title);
  }

  archiveConversation(id) {
    return this.workbenchRuntime.archiveConversation(id);
  }

  backgroundArchiveConversation(id) {
    return this.workbenchRuntime.backgroundArchiveConversation(id);
  }

  prepareArchiveReview(id, options) {
    return this.workbenchRuntime.prepareArchiveReview(id, options);
  }

  getMessageBlocks(conversationId, messageId) {
    return this.workbenchRuntime.getMessageBlocks(conversationId, messageId);
  }

  prepareMessageBlockArchive(conversationId, messageId, blockIds) {
    return this.workbenchRuntime.prepareMessageBlockArchive(conversationId, messageId, blockIds);
  }

  deleteMessageBlocks(conversationId, messageId, blockIds) {
    return this.workbenchRuntime.deleteMessageBlocks(conversationId, messageId, blockIds);
  }

  restoreMessageBlockDeletion(conversationId, messageId, trashId) {
    return this.workbenchRuntime.restoreMessageBlockDeletion(conversationId, messageId, trashId);
  }

  getArchiveReview(id) {
    return this.workbenchRuntime.getArchiveReview(id);
  }

  setArchiveSourceSelection(conversationId, draftId, messageId, selected) {
    return this.workbenchRuntime.setArchiveSourceSelection(conversationId, draftId, messageId, selected);
  }

  organizeArchiveReview(conversationId, draftId) {
    return this.workbenchRuntime.organizeArchiveReview(conversationId, draftId);
  }

  setArchiveCandidateSelection(conversationId, draftId, candidateId, selected) {
    return this.workbenchRuntime.setArchiveCandidateSelection(conversationId, draftId, candidateId, selected);
  }

  submitArchiveClarification(conversationId, draftId, candidateId, answer) {
    return this.workbenchRuntime.submitArchiveClarification(conversationId, draftId, candidateId, answer);
  }

  confirmArchiveContents(conversationId, draftId) {
    return this.workbenchRuntime.confirmArchiveContents(conversationId, draftId);
  }

  confirmArchiveCandidate(conversationId, draftId, candidateId) {
    return this.workbenchRuntime.confirmArchiveCandidate(conversationId, draftId, candidateId);
  }

  finalizeArchive(conversationId, draftId) {
    return this.workbenchRuntime.finalizeArchive(conversationId, draftId);
  }

  discardArchiveDraft(conversationId, draftId) {
    return this.workbenchRuntime.discardArchiveDraft(conversationId, draftId);
  }

  directArchiveConversation(id) {
    return this.workbenchRuntime.directArchiveConversation(id);
  }

  getArchiveRecoveryAction(id) {
    return this.workbenchRuntime.getArchiveRecoveryAction(id);
  }

  retryArchiveConversation(id) {
    return this.workbenchRuntime.retryArchiveConversation(id);
  }

  continueArchiveConversation(id) {
    return this.workbenchRuntime.continueArchiveConversation(id);
  }

  getKnowledgeHealthReport() {
    return this.workbenchRuntime.getKnowledgeHealthReport();
  }

  async setConversationReasoningProfile(conversationId, profile) {
    return this.workbenchRuntime.setConversationReasoningProfile(conversationId, profile);
  }

  recordQuestionCalibrationEvent(event) {
    return this.workbenchRuntime.recordQuestionCalibrationEvent(event);
  }

  clearQuestionCalibrationEvents() {
    return this.workbenchRuntime.clearQuestionCalibrationEvents();
  }

  getKnowledgeGovernanceState() {
    return this.workbenchRuntime.getKnowledgeGovernanceState();
  }

  setKnowledgeGovernanceItemStatus(itemId, status) {
    return this.workbenchRuntime.setKnowledgeGovernanceItemStatus(itemId, status);
  }

  analyzeKnowledgeGovernanceItem(itemId) {
    return this.workbenchRuntime.analyzeKnowledgeGovernanceItem(itemId);
  }

  getKnowledgeGovernanceAgentBatchState() {
    return this.workbenchRuntime.getKnowledgeGovernanceAgentBatchState();
  }

  previewKnowledgeGovernanceAgentBatch(options) {
    return this.workbenchRuntime.previewKnowledgeGovernanceAgentBatch(options);
  }

  applyKnowledgeGovernanceAgentBatch(previewId, selectedItemIds) {
    return this.workbenchRuntime.applyKnowledgeGovernanceAgentBatch(previewId, selectedItemIds);
  }

  refreshKnowledgeHealth() {
    return this.workbenchRuntime.refreshKnowledgeHealth({ persistGovernance: true });
  }

  previewKnowledgeHealthRepairs(issueIds) {
    return this.workbenchRuntime.previewKnowledgeHealthRepairs(issueIds);
  }

  applyKnowledgeHealthRepairs(previewId) {
    return this.workbenchRuntime.applyKnowledgeHealthRepairs(previewId);
  }

  previewKnowledgeLifecycleChanges(selections) {
    return this.workbenchRuntime.previewKnowledgeLifecycleChanges(selections);
  }

  previewIntelligentKnowledgeMerge(candidateId, reason) {
    return this.workbenchRuntime.previewIntelligentKnowledgeMerge(candidateId, reason);
  }

  applyKnowledgeLifecycleChanges(previewId) {
    return this.workbenchRuntime.applyKnowledgeLifecycleChanges(previewId);
  }

  undoKnowledgeLifecycleTransaction(transactionId) {
    return this.workbenchRuntime.undoKnowledgeLifecycleTransaction(transactionId);
  }

  previewKnowledgeRemoval(vaultPath) {
    return this.workbenchRuntime.previewKnowledgeRemoval(vaultPath);
  }

  applyKnowledgeRemoval(previewId) {
    return this.workbenchRuntime.applyKnowledgeRemoval(previewId);
  }

  undoKnowledgeRemovalTransaction(transactionId) {
    return this.workbenchRuntime.undoKnowledgeRemovalTransaction(transactionId);
  }

  previewKnowledgeIndexes() {
    return this.workbenchRuntime.previewKnowledgeIndexes();
  }

  applyKnowledgeIndexes(previewId) {
    return this.workbenchRuntime.applyKnowledgeIndexes(previewId);
  }

  undoKnowledgeIndexTransaction(transactionId) {
    return this.workbenchRuntime.undoKnowledgeIndexTransaction(transactionId);
  }

  getKnowledgeStructureCatalog() {
    return this.workbenchRuntime.getKnowledgeStructureCatalog();
  }

  refreshKnowledgeStructureCatalog() {
    return this.workbenchRuntime.refreshKnowledgeStructureCatalog();
  }

  readKnowledgeStructureFile(vaultPath) {
    return this.workbenchRuntime.readKnowledgeStructureFile(vaultPath);
  }

  previewKnowledgeStructureCreate(input) {
    return this.workbenchRuntime.previewKnowledgeStructureCreate(input);
  }

  applyKnowledgeStructureCreate(previewId) {
    return this.workbenchRuntime.applyKnowledgeStructureCreate(previewId);
  }

  previewKnowledgeStructureEnrichment() {
    return this.workbenchRuntime.previewKnowledgeStructureEnrichment();
  }

  applyKnowledgeStructureEnrichment(previewId, selectedSuggestionIds) {
    return this.workbenchRuntime.applyKnowledgeStructureEnrichment(previewId, selectedSuggestionIds);
  }

  ingestDocuments(documents, options) {
    return this.workbenchRuntime.ingestDocuments(documents, options);
  }

  retryDocumentKnowledgeProcessing(files, options) {
    return this.workbenchRuntime.retryDocumentKnowledgeProcessing(files, options);
  }

  storeReferenceDocuments(documents, options) {
    return this.workbenchRuntime.storeReferenceDocuments(documents, options);
  }

  sendMessageWithDocuments(text, documents, options) {
    return this.workbenchRuntime.sendMessageWithDocuments(text, documents, options);
  }

  unarchiveConversation(id) {
    return this.workbenchRuntime.unarchiveConversation(id);
  }

  deleteConversation(id) {
    return this.workbenchRuntime.deleteConversation(id);
  }

  listDeletedConversations() {
    return this.workbenchRuntime.listDeletedConversations();
  }

  restoreConversation(id) {
    return this.workbenchRuntime.restoreConversation(id);
  }

  permanentlyDeleteConversation(id) {
    return this.workbenchRuntime.permanentlyDeleteConversation(id);
  }

  sendMessage(text, options) {
    return this.workbenchRuntime.sendMessage(text, options);
  }

  getImageGenerationConfig() { return this.workbenchRuntime.getImageGenerationConfig(); }
  updateImageGenerationConfig(config) { return this.workbenchRuntime.updateImageGenerationConfig(config); }
  generateImage(prompt, options) { return this.workbenchRuntime.generateImage(prompt, options); }
  saveMessageDiagram(options) { return this.workbenchRuntime.saveMessageDiagram(options); }

  setTrainingResponseModeActive(conversationId, active) {
    return this.workbenchRuntime.setTrainingResponseModeActive(conversationId, active);
  }

  retryFailedResponse(conversationId, options) {
    return this.workbenchRuntime.retryFailedResponse(conversationId, options);
  }

  respondAgentRecommendation(id, decision) {
    return this.workbenchRuntime.respondAgentRecommendation(id, decision);
  }

  respondSkillRecommendation(id, decision, selectedSkills) {
    return this.workbenchRuntime.respondSkillRecommendation(id, decision, selectedSkills);
  }

  stopActiveTurn(conversationId) {
    return this.workbenchRuntime.stopActiveTurn(conversationId);
  }

  updateSettings(patch) {
    return this.workbenchRuntime.updateSettings(patch);
  }

  refreshCapabilityCatalog() {
    return this.workbenchRuntime.refreshCapabilityCatalog();
  }

  setCapabilityEnabled(kind, id, enabled) {
    return this.workbenchRuntime.setCapabilityEnabled(kind, id, enabled);
  }

  validateCapabilityRelease(id) {
    return this.workbenchRuntime.validateCapabilityRelease(id);
  }

  previewCapabilityReleaseAction(action, id) {
    return this.workbenchRuntime.previewCapabilityReleaseAction(action, id);
  }

  applyCapabilityReleaseAction(token) {
    return this.workbenchRuntime.applyCapabilityReleaseAction(token);
  }

  simulateCapabilityRoute(text) {
    return this.workbenchRuntime.simulateCapabilityRoute(text);
  }

  previewCapabilityRecovery(kind, id) {
    return this.workbenchRuntime.previewCapabilityRecovery(kind, id);
  }

  applyCapabilityRecovery(token) {
    return this.workbenchRuntime.applyCapabilityRecovery(token);
  }

  hasExternalTransferConsent(providerId, conversationId) {
    return this.workbenchRuntime.hasExternalTransferConsent(providerId, conversationId);
  }

  getConversationContextStatus(conversationId) {
    return this.workbenchRuntime.getConversationContextStatus(conversationId);
  }

  consumeContextReminder(conversationId) {
    return this.workbenchRuntime.consumeContextReminder(conversationId);
  }

  saveProviderSecret(providerId, secret) {
    return this.setProviderSecret(providerId, secret);
  }

  providerCredentialStatus(providerId) {
    return this.getProviderCredentialStatus(providerId);
  }

  getConnectionDiagnostics() {
    return this.workbenchRuntime.getConnectionDiagnostics();
  }

  diagnoseProvider(providerId) {
    return this.workbenchRuntime.diagnoseProvider(providerId);
  }

  runFirstPrinciplesShadowProbe(options) {
    return this.workbenchRuntime.runFirstPrinciplesShadowProbe(options);
  }

  runFirstPrinciplesPilotCase(options) {
    return this.workbenchRuntime.runFirstPrinciplesPilotCase(options);
  }

  runSystemFeedbackPilotCase(options) {
    return this.workbenchRuntime.runSystemFeedbackPilotCase(options);
  }

  runCausalEvidencePilotCase(options) {
    return this.workbenchRuntime.runCausalEvidencePilotCase(options);
  }

  runReversalFailurePilotCase(options) {
    return this.workbenchRuntime.runReversalFailurePilotCase(options);
  }

  runContradictionStagePilotCase(options) {
    return this.workbenchRuntime.runContradictionStagePilotCase(options);
  }

  runIncentiveStructurePilotCase(options) {
    return this.workbenchRuntime.runIncentiveStructurePilotCase(options);
  }

  activateCausalEvidenceMigration(options) {
    return this.workbenchRuntime.activateCausalEvidenceMigration(options);
  }

  activateReversalFailureMigration(options) {
    return this.workbenchRuntime.activateReversalFailureMigration(options);
  }

  activateContradictionStageMigration(options) {
    return this.workbenchRuntime.activateContradictionStageMigration(options);
  }

  activateIncentiveStructureMigration(options) {
    return this.workbenchRuntime.activateIncentiveStructureMigration(options);
  }

  activateSystemFeedbackMigration(options) {
    return this.workbenchRuntime.activateSystemFeedbackMigration(options);
  }

  activateFirstPrinciplesMigration(options) {
    return this.workbenchRuntime.activateFirstPrinciplesMigration(options);
  }

  respondApproval(id, decision) {
    return this.workbenchRuntime.respondApproval(id, decision);
  }

  respondKnowledgeConfirmation(id, decision) {
    return this.workbenchRuntime.respondKnowledgeConfirmation(id, decision);
  }

  undoTransaction(id) {
    return this.workbenchRuntime.undoTransaction(id);
  }

  async refreshCapabilities(providerId = this.state.settings.providerId || "codex") {
    if (COMMERCIAL_BUILD) this.requireCommercialLicense();
    if (!this.capabilityRefreshes) this.capabilityRefreshes = new Map();
    const existing = this.capabilityRefreshes.get(providerId);
    if (existing) return existing;
    const refresh = (async () => {
      if (providerId === "codex") {
        if (!this.workbenchRuntime.started) await this.workbenchRuntime.start();
        else await this.workbenchRuntime.discoverProviderModels("codex");
        return this.state.runtime.models;
      }
      if (!this.hasExternalTransferConsent(providerId)) {
        throw new Error("请先在设置中保存并锁定该外部提供商连接");
      }
      // Skill 与认知透镜只依赖 vault 目录，与引擎无关。
      // 不经过这一步，capabilityCatalog 会保持构造时的空数组，
      // 导致外部 API 路径下 _availableSkills 返回空、Skill 与透镜全部不可选。
      // 本类是委托层，作用域内没有 boundedPush / safeErrorMessage，
      // 因此失败时静默降级，不阻断模型发现。
      try {
        await this.workbenchRuntime.refreshCapabilityCatalog();
      } catch (error) {
        // 不阻断外部提供商连接，但必须留下线索：
        // 静默失败会让「透镜为空」完全无法定位。
        this.state.runtime.connection.warnings.push(`能力目录加载失败：${String(error?.message || error).slice(0, 200)}`);
      }
      return this.workbenchRuntime.discoverProviderModels(providerId);
    })();
    this.capabilityRefreshes.set(providerId, refresh);
    try {
      return await refresh;
    } finally {
      if (this.capabilityRefreshes.get(providerId) === refresh) {
        this.capabilityRefreshes.delete(providerId);
      }
    }
  }

  async openVaultPath(input, options = {}) {
    const vaultPath = normalizeVaultPath(input);
    const file = this.app.vault.getAbstractFileByPath(vaultPath);
    if (!(file instanceof TFile)) throw new Error("目标不是可打开的 Markdown 文件，或已经移动");
    if (options.blockId && /^[A-Za-z0-9._:-]+$/u.test(options.blockId) && typeof this.app.workspace.openLinkText === "function") {
      await this.app.workspace.openLinkText(`${vaultPath}#^${options.blockId}`, vaultPath, "tab");
      return { path: vaultPath, blockId: options.blockId };
    }
    return openVaultFile(this.app.workspace, file, options);
  }

  openConnectionDiagnostics() {
    return this.activateWorkbench("diagnostics");
  }

  openRecycleBin() {
    return this.activateWorkbench("recycle-bin");
  }

  openKnowledgeHealth() {
    return this.activateWorkbench("knowledge-health");
  }

  openKnowledgeStructure() {
    return this.activateWorkbench("knowledge-structure");
  }

  openUserGrowth() {
    return this.activateWorkbench("user-growth");
  }

  async openCognitiveHome() {
    return this.activateWorkbench("chat");
  }

  async migrateLegacyWorkspaces() {
    if (this.legacyWorkspaceMigration) return this.legacyWorkspaceMigration;
    const { workspace } = this.app;
    this.legacyWorkspaceMigration = (async () => {
      const homes = workspace.getLeavesOfType(VIEW_TYPE_COGNITIVE_HOME);
      const dailies = workspace.getLeavesOfType(VIEW_TYPE_XINGZHI_ACTION_CENTER);
      const old = [...homes, ...dailies];
      if (!old.length) return;
      const existing = workspace.getLeavesOfType(VIEW_TYPE_XINGZHI)[0];
      const target = existing || homes.find(leaf => leaf === workspace.activeLeaf) || old[0];
      const entries = homes.map((leaf, index) => {
        const view = leaf.view, drafts = {};
        for (const key of ["wbHoldDraft", "wbPerceiveDraft", "questionDraft"]) {
          const value = view[key];
          if (value && (typeof value === "string" ? value.trim() : Object.values(value).some(x => typeof x === "string" && x.trim()))) drafts[key] = structuredClone(value);
        }
        return { sourceLeafId: String(leaf.id || `legacy-home-${index + 1}`), label: `旧首页草稿 ${index + 1}`, preferences: { ...(view.getState?.() || {}) }, drafts, active: leaf === workspace.activeLeaf };
      });
      const selected = entries.find(entry => entry.active) || entries[0];
      const state = existing?.view?.getState?.() || {};
      const hasCurrentPreferences = state.cognitivePreferences && Object.keys(state.cognitivePreferences).length > 0;
      const snapshots = [...(state.legacyWorkspaceDrafts || [])];
      for (const entry of entries.filter(entry => Object.keys(entry.drafts).length)) {
        const index = snapshots.findIndex(saved => saved.sourceLeafId === entry.sourceLeafId);
        if (index >= 0) snapshots[index] = entry;
        else snapshots.push(entry);
      }
      const merged = { ...state,
        cognitivePreferences: selected?.active || !hasCurrentPreferences ? selected?.preferences || state.cognitivePreferences || {} : state.cognitivePreferences,
        legacyCognitiveDrafts: existing?.view?.unifiedWorkspace?.cognitive ? state.legacyCognitiveDrafts : selected?.drafts || state.legacyCognitiveDrafts,
        legacyWorkspaceDrafts: snapshots,
      };
      const activeLegacy = old.includes(workspace.activeLeaf), activeDaily = dailies.includes(workspace.activeLeaf);
      if (existing) await existing.view.setState(merged, {});
      else await target.setViewState({ type: VIEW_TYPE_XINGZHI, state: merged, active: activeLegacy });
      // All drafts are held in the target's serialized workspace state first.
      workspace.requestSaveLayout?.();
      for (const leaf of old) if (leaf !== target) leaf.detach();
      if (activeLegacy) await workspace.revealLeaf(target);
      if (activeDaily) await target.view.navigate("action-center");
    })().finally(() => { this.legacyWorkspaceMigration = null; });
    return this.legacyWorkspaceMigration;
  }

  async openActionCenter() {
    return this.activateWorkbench("action-center");
  }

  async openArchiveReview(conversationId) {
    const id = String(conversationId || "").trim();
    const conversation = this.state.conversations.find((item) => item?.id === id && !item?.deletedAt);
    if (!conversation?.archiveDraft) throw new Error("尚未生成归档预览");
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_XINGZHI_ARCHIVE_REVIEW)[0];
    if (!leaf) leaf = workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE_XINGZHI_ARCHIVE_REVIEW,
      active: true,
      state: { conversationId: id },
    });
    await workspace.revealLeaf(leaf);
  }

  async activateWorkbench(section = "chat") {
    const { workspace } = this.app;
    try { await this.migrateLegacyWorkspaces(); }
    catch (error) {
      if (!workspace.getLeavesOfType(VIEW_TYPE_XINGZHI).length) throw error;
      new Notice(`旧工作区尚未完成恢复：${error?.message || "未知错误"}。继续打开现有对话；旧页面和草稿未主动删除。`);
    }
    let leaf = this.workbenchLeafOpening ? await this.workbenchLeafOpening : workspace.getLeavesOfType(VIEW_TYPE_XINGZHI)[0];
    if (!leaf) {
      this.workbenchLeafOpening = (async () => {
        const created = workspace.getLeaf("tab");
        await created.setViewState({ type: VIEW_TYPE_XINGZHI, active: true });
        return created;
      })().finally(() => { this.workbenchLeafOpening = null; });
      leaf = await this.workbenchLeafOpening;
    }
    await workspace.revealLeaf(leaf);
    if (section && leaf.view instanceof XingzhiWorkbenchView) await leaf.view.navigate(section);
  }
}

module.exports = XingzhiWorkbenchPlugin;
