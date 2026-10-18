"use strict";

const crypto = require("node:crypto");
const { normalizeImageGenerationConfig } = require("./image-generation-client.cjs");
const { parseMessageDiagram, renderMessageDiagramSvg, extractMessageDiagramBlocks } = require("./message-diagram.cjs");

const IMAGE_ROOT = "12_资料库/生成资源/图片/";
const DIAGRAM_ROOT = "12_资料库/生成资源/图表/";

function writableMedia(runtime, conversation) {
  runtime.requireLicense();
  if (!conversation || conversation.deletedAt || conversation.archivedAt) throw new Error("当前没有可用对话");
  if (runtime.state.settings.permissionMode === "read-only" || conversation.permissionMode === "read-only") {
    throw new Error("当前为只读模式，不能保存生成资源；未发送生图请求");
  }
  if (typeof runtime.vault.createBinary !== "function") throw new Error("当前知识库不支持保存图片");
}

function createMediaRuntimeMethods() {
  return {
    getImageGenerationConfig() {
      return { ...normalizeImageGenerationConfig(this.state.settings.imageGeneration) };
    },

    async updateImageGenerationConfig() {
      throw new Error("行知图片生成功能已取消；没有修改配置或发送生图请求。");
    },

    async generateImage() {
      throw new Error("行知图片生成功能已取消；未发送生图请求。");
    },

    async saveMessageDiagram({ conversationId, messageId, diagram } = {}) {
      const conversation = this.state.conversations.find(item => item.id === conversationId);
      writableMedia(this, conversation);
      const message = conversation.messages.find(item => item.id === messageId && item.role === "assistant" && !item.contentDeletedAt);
      if (!message || message.status !== "completed") throw new Error("原消息已改变或未完成，不能保存此图");
      const checked = parseMessageDiagram(typeof diagram === "string" ? diagram : JSON.stringify(diagram));
      // Export only a diagram still present in the source message. User-provided
      // paths, arbitrary SVG, external links and invented graph data are rejected.
      const blocks = extractMessageDiagramBlocks(message.content);
      const list = Array.isArray(blocks) ? blocks : blocks.blocks || blocks.diagrams || [];
      const matches = list.some(block => {
        try { return JSON.stringify(parseMessageDiagram(typeof block === "string" ? block : block.source)) === JSON.stringify(checked); }
        catch { return false; }
      });
      if (!matches) throw new Error("结构图已与原文不同，请从当前消息重新打开");
      const svg = renderMessageDiagramSvg(checked);
      const file = `${DIAGRAM_ROOT}${crypto.randomUUID()}.svg`;
      await this.vault.createBinary(file, Buffer.from(svg, "utf8"));
      return { path: file, label: checked.title || "结构图", saved: true };
    },
  };
}

module.exports = { createMediaRuntimeMethods, IMAGE_ROOT, DIAGRAM_ROOT, writableMedia };
