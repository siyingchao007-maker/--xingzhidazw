"use strict";

async function openVaultFile(workspace, file, options = {}) {
  if (!workspace || typeof workspace.getLeaf !== "function") throw new Error("缺少 Obsidian 工作区");
  if (!file || typeof file.path !== "string") throw new Error("缺少要打开的文件");
  const requestedMode = options.mode === "window" ? "window" : "tab";
  let leaf = null;
  let actualMode = requestedMode;
  if (requestedMode === "window" && typeof workspace.openPopoutLeaf === "function") {
    try {
      leaf = await workspace.openPopoutLeaf();
    } catch {
      leaf = null;
      actualMode = "tab";
    }
  }
  if (!leaf) {
    leaf = workspace.getLeaf("tab");
    actualMode = "tab";
  }
  if (!leaf || typeof leaf.openFile !== "function") throw new Error("无法创建独立文件页签");
  await leaf.openFile(file, { active: true });
  await workspace.revealLeaf?.(leaf);
  return { mode: actualMode, path: file.path };
}

module.exports = { openVaultFile };
