"use strict";

const { execFile } = require("node:child_process");
const { isIP } = require("node:net");
const path = require("node:path");

const INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const MAX_SETTINGS_BYTES = 32 * 1024;

function readWindowsProxySettings() {
  const registryProgram = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe");
  return new Promise((resolve, reject) => execFile(registryProgram, ["query", INTERNET_SETTINGS_KEY], {
    encoding: "utf8", windowsHide: true, timeout: 1_500, maxBuffer: MAX_SETTINGS_BYTES,
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}

function proxyUrl(value) {
  if (typeof value !== "string" || value.length > 2_000 || /[\s\0]/u.test(value)) return null;
  const candidate = value.includes("://") ? value : `http://${value}`;
  const portMatch = candidate.match(/:(\d+)$/u);
  if (!portMatch || Number(portMatch[1]) < 1 || Number(portMatch[1]) > 65535) return null;
  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    return url.origin;
  } catch { return null; }
}

function bypassRules(value) {
  const result = [];
  for (const token of value.split(";").map((item) => item.trim()).filter(Boolean)) {
    if (token === "*" || isIP(token)) {
      result.push(token);
    } else if (/^(?:\*\.)?[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/u.test(token)) {
      result.push(token.replace(/^\*/u, ""));
    } else if (/^(?:\d{1,3}\.){1,3}\d{0,3}\*$/u.test(token)) {
      // Windows accepts IPv4 prefix wildcards; NO_PROXY uses CIDR ranges.
      const parts = token.slice(0, -1).split(".");
      const partial = parts.pop();
      const fixed = parts.map(Number);
      if (fixed.some((part) => part > 255)) return null;
      const ranges = partial ? Array.from({ length: 256 }, (_, index) => index)
        .filter((index) => String(index).startsWith(partial)).map((index) => [...fixed, index]) : [fixed];
      if (!ranges.length) return null;
      for (const prefix of ranges) {
        result.push(`${[...prefix, ...Array(4 - prefix.length).fill(0)].join(".")}/${prefix.length * 8}`);
      }
    } else {
      // PAC and arbitrary globs cannot be faithfully represented as environment variables.
      return null;
    }
  }
  const normalized = [...new Set(result)].join(",");
  return normalized.length <= 16 * 1024 ? normalized : null;
}

function proxyEnvironmentFromRegistry(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_SETTINGS_BYTES) return null;
  if (/^\s*AutoConfigURL\s+REG_SZ\s+\S+/mu.test(text)) return null;
  const fields = Object.create(null);
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*(ProxyEnable|ProxyServer|ProxyOverride)\s+REG_(DWORD|SZ)\s+(.*?)\s*$/u);
    if (match) fields[match[1]] = match[3];
  }
  if (Number(fields.ProxyEnable) !== 1 || !fields.ProxyServer) return null;
  const bypass = bypassRules(fields.ProxyOverride || "");
  if (bypass === null) return null;
  const result = {};
  if (fields.ProxyServer.includes("=")) {
    for (const entry of fields.ProxyServer.split(";")) {
      const match = entry.trim().match(/^(https?)=(.+)$/iu);
      if (!match) continue;
      const value = proxyUrl(match[2]);
      if (!value) return null;
      result[`${match[1].toUpperCase()}_PROXY`] = value;
    }
  } else {
    const value = proxyUrl(fields.ProxyServer);
    if (!value) return null;
    result.HTTP_PROXY = value;
    result.HTTPS_PROXY = value;
  }
  if (!result.HTTP_PROXY && !result.HTTPS_PROXY) return null;
  result.NO_PROXY = bypass;
  return result;
}

async function resolveAppServerEnvironment(environment, {
  platform = process.platform,
  readSettings = readWindowsProxySettings,
} = {}) {
  // Explicit proxy variables, including an intentional empty value, always win.
  if (platform !== "win32" || ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]
    .some((key) => Object.hasOwn(environment, key))) return environment;
  try {
    const settings = proxyEnvironmentFromRegistry(await readSettings());
    return settings ? { ...settings, ...environment } : environment;
  } catch {
    // A disabled/unreadable system proxy must not prevent the plugin from loading.
    return environment;
  }
}

module.exports = { proxyEnvironmentFromRegistry, resolveAppServerEnvironment };
