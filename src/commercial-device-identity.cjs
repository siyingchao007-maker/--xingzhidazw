"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const { createDeviceRequestCode, deriveDeviceId } = require("./commercial-licensing.cjs");

const WINDOWS_MACHINE_GUID_KEY = "HKLM\\SOFTWARE\\Microsoft\\Cryptography";
const MAX_MACHINE_ID_LENGTH = 1_024;

function fail(message) {
  throw new Error(message);
}

function normalizeMachineId(value) {
  if (typeof value !== "string") fail("无法读取本机设备标识");
  const normalized = value.trim();
  if (normalized.length < 2
    || normalized.length > MAX_MACHINE_ID_LENGTH
    || /[\u0000-\u001f\u007f\s]/u.test(normalized)) {
    fail("无法读取本机设备标识");
  }
  return normalized;
}

function readWindowsMachineId(execFileSync) {
  try {
    const output = execFileSync(
      "reg.exe",
      ["query", WINDOWS_MACHINE_GUID_KEY, "/v", "MachineGuid"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 64 * 1_024,
      },
    );
    const match = String(output || "").match(/(?:^|\r?\n)\s*MachineGuid\s+REG_SZ\s+([^\r\n\s]+)\s*(?:\r?\n|$)/iu)
      || String(output || "").match(/MachineGuid\s+REG_SZ\s+([^\r\n\s]+)/iu);
    return normalizeMachineId(match?.[1]);
  } catch (error) {
    if (error?.message === "无法读取本机设备标识") throw error;
    fail("无法读取本机设备标识");
  }
}

function readMacMachineId(execFileSync) {
  try {
    const output = execFileSync(
      "ioreg",
      ["-rd1", "-c", "IOPlatformExpertDevice"],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 128 * 1_024,
      },
    );
    const match = String(output || "").match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/u);
    return normalizeMachineId(match?.[1]);
  } catch (error) {
    if (error?.message === "无法读取本机设备标识") throw error;
    fail("无法读取本机设备标识");
  }
}

function readLinuxMachineId(readFileSync) {
  const paths = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
  for (const path of paths) {
    try {
      return normalizeMachineId(readFileSync(path, "utf8"));
    } catch {
      // 仅在标准路径不可读或内容无效时尝试兼容路径。
    }
  }
  fail("无法读取本机设备标识");
}

function readMachineId({
  platform = process.platform,
  execFileSync = childProcess.execFileSync,
  readFileSync = fs.readFileSync,
} = {}) {
  if (platform === "win32") return readWindowsMachineId(execFileSync);
  if (platform === "darwin") return readMacMachineId(execFileSync);
  if (platform === "linux") return readLinuxMachineId(readFileSync);
  fail("行知设备绑定暂不支持当前操作系统");
}

function sanitizeDeviceLabel(value) {
  const label = String(value || "")
    .replace(/[\u0000-\u001f\u007f\s]+/gu, " ")
    .trim()
    .slice(0, 100);
  return label || "未命名设备";
}

function getCurrentDeviceIdentity({
  platform = process.platform,
  arch = process.arch,
  hostname = os.hostname,
  now = () => new Date(),
  execFileSync = childProcess.execFileSync,
  readFileSync = fs.readFileSync,
} = {}) {
  const machineId = readMachineId({ platform, execFileSync, readFileSync });
  const generated = now();
  if (!(generated instanceof Date) || !Number.isFinite(generated.getTime())) fail("当前时间无效");
  const deviceLabel = sanitizeDeviceLabel(hostname());
  const deviceId = deriveDeviceId({ machineId, platform, arch });
  const requestCode = createDeviceRequestCode({
    machineId,
    platform,
    arch,
    generatedAt: generated.toISOString(),
    deviceLabel,
  });
  return Object.freeze({
    deviceId,
    requestCode,
    platform,
    arch,
    deviceLabel,
  });
}

module.exports = {
  getCurrentDeviceIdentity,
  readMachineId,
  sanitizeDeviceLabel,
};
