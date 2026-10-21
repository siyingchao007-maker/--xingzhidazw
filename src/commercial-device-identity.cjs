"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const { createDeviceRequestCode, deriveDeviceId } = require("./commercial-licensing.cjs");

const WINDOWS_MACHINE_GUID_KEY = "HKLM\\SOFTWARE\\Microsoft\\Cryptography";
const MAX_MACHINE_ID_LENGTH = 1_024;
const WINDOWS_MACHINE_ID_COMMAND = Object.freeze({
  file: "reg.exe",
  args: Object.freeze(["query", WINDOWS_MACHINE_GUID_KEY, "/v", "MachineGuid"]),
  options: Object.freeze({ encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1_024 }),
});
const MAC_MACHINE_ID_COMMAND = Object.freeze({
  file: "ioreg",
  args: Object.freeze(["-rd1", "-c", "IOPlatformExpertDevice"]),
  options: Object.freeze({ encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 128 * 1_024 }),
});
const LINUX_MACHINE_ID_PATHS = Object.freeze(["/etc/machine-id", "/var/lib/dbus/machine-id"]);

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

function parseWindowsMachineId(output) {
  const match = String(output || "").match(/(?:^|\r?\n)\s*MachineGuid\s+REG_SZ\s+([^\r\n\s]+)\s*(?:\r?\n|$)/iu)
    || String(output || "").match(/MachineGuid\s+REG_SZ\s+([^\r\n\s]+)/iu);
  return normalizeMachineId(match?.[1]);
}

function parseMacMachineId(output) {
  const match = String(output || "").match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/u);
  return normalizeMachineId(match?.[1]);
}

function readCommandMachineId(execFileSync, command, parse) {
  try {
    return parse(execFileSync(command.file, [...command.args], { ...command.options }));
  } catch {
    fail("无法读取本机设备标识");
  }
}

function readWindowsMachineId(execFileSync) {
  return readCommandMachineId(execFileSync, WINDOWS_MACHINE_ID_COMMAND, parseWindowsMachineId);
}

function readMacMachineId(execFileSync) {
  return readCommandMachineId(execFileSync, MAC_MACHINE_ID_COMMAND, parseMacMachineId);
}

function readLinuxMachineId(readFileSync) {
  for (const path of LINUX_MACHINE_ID_PATHS) {
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

// Asynchronous counterpart used during plugin startup so that the registry or
// ioreg subprocess (up to 5 s) never blocks Obsidian's renderer thread.
function execFileText(execFile, command) {
  return new Promise((resolve, reject) => {
    execFile(command.file, [...command.args], { ...command.options }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function readCommandMachineIdAsync(execFile, command, parse) {
  let output;
  try {
    output = await execFileText(execFile, command);
  } catch {
    fail("无法读取本机设备标识");
  }
  try {
    return parse(output);
  } catch {
    fail("无法读取本机设备标识");
  }
}

async function readLinuxMachineIdAsync(readFile) {
  for (const path of LINUX_MACHINE_ID_PATHS) {
    try {
      return normalizeMachineId(await readFile(path, "utf8"));
    } catch {
      // 仅在标准路径不可读或内容无效时尝试兼容路径。
    }
  }
  fail("无法读取本机设备标识");
}

async function readMachineIdAsync({
  platform = process.platform,
  execFile = childProcess.execFile,
  readFile = fs.promises.readFile,
} = {}) {
  if (platform === "win32") return readCommandMachineIdAsync(execFile, WINDOWS_MACHINE_ID_COMMAND, parseWindowsMachineId);
  if (platform === "darwin") return readCommandMachineIdAsync(execFile, MAC_MACHINE_ID_COMMAND, parseMacMachineId);
  if (platform === "linux") return readLinuxMachineIdAsync(readFile);
  fail("行知设备绑定暂不支持当前操作系统");
}

function sanitizeDeviceLabel(value) {
  const label = String(value || "")
    .replace(/[\u0000-\u001f\u007f\s]+/gu, " ")
    .trim()
    .slice(0, 100);
  return label || "未命名设备";
}

function buildDeviceIdentity({ machineId, platform, arch, hostname, now }) {
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

function getCurrentDeviceIdentity({
  platform = process.platform,
  arch = process.arch,
  hostname = os.hostname,
  now = () => new Date(),
  execFileSync = childProcess.execFileSync,
  readFileSync = fs.readFileSync,
} = {}) {
  const machineId = readMachineId({ platform, execFileSync, readFileSync });
  return buildDeviceIdentity({ machineId, platform, arch, hostname, now });
}

async function getCurrentDeviceIdentityAsync({
  platform = process.platform,
  arch = process.arch,
  hostname = os.hostname,
  now = () => new Date(),
  execFile = childProcess.execFile,
  readFile = fs.promises.readFile,
} = {}) {
  const machineId = await readMachineIdAsync({ platform, execFile, readFile });
  return buildDeviceIdentity({ machineId, platform, arch, hostname, now });
}

module.exports = {
  getCurrentDeviceIdentity,
  getCurrentDeviceIdentityAsync,
  readMachineId,
  readMachineIdAsync,
  sanitizeDeviceLabel,
};
