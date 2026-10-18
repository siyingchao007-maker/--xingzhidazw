"use strict";
// [本地增强] 对话沉淀改名后仍能被找到。
// 注意：data.json 里存的是「已签名的知识事务日志」，手改 draftPath 会让签名失效，
// 插件会以「知识事务日志已被篡改」拒绝加载。因此这里改为「读取时回退查找」。
function resolveOrganizationPath (draftPath, record) {
  const fallback = typeof draftPath === "string" ? draftPath : "";
  try {
    const app = globalThis.app;
    if (!fallback || !app || !app.vault) return fallback;
    try { if (app.vault.getAbstractFileByPath(fallback)) return fallback; } catch (error) {}
    const keys = new Set();
    for (const value of [record && record.userMessageId, record && record.sourceHash, record && record.assistantMessageId]) {
      if (typeof value === "string" && value) keys.add(value);
    }
    if (!keys.size || typeof app.vault.getMarkdownFiles !== "function") return fallback;
    const cache = app.metadataCache;
    for (const file of app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith("09_认知资产/对话沉淀/")) continue;
      let frontmatter = null;
      try { frontmatter = (cache && cache.getFileCache && cache.getFileCache(file) || {}).frontmatter || null; } catch (error) {}
      if (!frontmatter) continue;
      if (keys.has(frontmatter.user_message_id) || keys.has(frontmatter.source_hash) || keys.has(frontmatter.assistant_message_id)) {
        return file.path;
      }
    }
  } catch (error) {}
  return fallback;
}

module.exports = { resolveOrganizationPath };
