"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  checkAuthorizationCenter,
  syncAuthorizationCenter,
} = require("../src/authorization-center-sync.cjs");

const root = path.resolve(__dirname, "..");
const configPath = process.env.XINGZHI_RELEASE_CONFIG
  ? path.resolve(process.env.XINGZHI_RELEASE_CONFIG)
  : path.join(root, "release.local.json");
const mode = process.argv.includes("--sync") ? "sync" : "check";

if (!fs.existsSync(configPath)) {
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: "未配置本机正式插件和桌面授权中心路径",
    configPath,
  }));
  process.exit(0);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const options = {
  projectRoot: root,
  installedPluginRoot: path.resolve(config.installedPluginRoot || ""),
  authorizationCenterRoot: path.resolve(config.authorizationCenterRoot || ""),
};

const result = mode === "sync"
  ? syncAuthorizationCenter(options)
  : checkAuthorizationCenter(options);
console.log(JSON.stringify({
  ...result,
  mode,
  authorizationCenterRoot: options.authorizationCenterRoot,
}, null, 2));
if (!result.ok) process.exitCode = 1;
