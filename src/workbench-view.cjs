const { skillCallLabel, skillCallDescription } = require("./skill-call-state.cjs");
const {
  PROFILE_OPTIONS,
  normalizeReasoningExecution,
  normalizeReasoningProfile,
  profileLabel,
  reasoningExecutionLabel,
  resolveReasoningExecution,
} = require("./reasoning-profile.cjs");
const crypto = require("node:crypto");
const { Component, ItemView, MarkdownRenderer, Modal, Notice, Setting, loadMermaid, setIcon } = require("obsidian");
const { conversationTranscriptPath } = require("./conversation-store.cjs");
const { prepareMessageMarkdown } = require("./message-markdown.cjs");
const {
  extractMessageDiagramBlocks,
  MESSAGE_DIAGRAM_PLACEHOLDER_LANGUAGE,
  parseMessageDiagram,
  renderMessageDiagramSvg,
} = require("./message-diagram.cjs");
const {
  isInternalTurn,
  reconcileOptimisticUserMessage,
  visibleConversationMessages,
  visibleStreamingMessage,
} = require("./message-visibility.cjs");
const { ConnectionDiagnosticsPanel } = require("./view-connections.cjs");
const { RecycleBinPanel } = require("./view-recycle-bin.cjs");
const { KnowledgeHealthPanel } = require("./view-knowledge-health.cjs");
const { KnowledgeStructurePanel } = require("./view-knowledge-structure.cjs");
const { UserGrowthPanel } = require("./view-user-growth.cjs");
const {
  TechnicalDetailsDisclosureController,
  WorkPanelLifecycleController,
  knowledgeSearchStatusText,
} = require("./work-panel-lifecycle.cjs");
const { capabilityControlsLocked, sendControlState, turnIsActive } = require("./ui-control-state.cjs");
const { buildResponseMetricsSummary, formatLiveDuration } = require("./response-metrics.cjs");
const { renderArchiveStatus } = require("./view-archive-status.cjs");
const { buildChatNavigation, applyChatArt, observeChatWidth } = require("./reference-ui.cjs");
const { UnifiedWorkspace } = require("./unified-workspace.cjs");
const { renderTurnAnalysisPathCard } = require("./view-turn-analysis-path.cjs");
const {
  XingzhiClarificationModal,
  XingzhiKnowledgeDetailModal,
} = require("./view-knowledge-review.cjs");
const { SKILL_MODE_OPTIONS, XingzhiSkillPickerModal } = require("./view-skill-picker.cjs");
const { normalizedSkillType } = require("./capability-surface.cjs");
const { categorySelection, mergeCategorySelection } = require("./capability-selection.cjs");
const { XingzhiCapabilityManagerModal } = require("./view-capability-manager.cjs");
const { XingzhiMessageBlocksModal } = require("./view-message-blocks.cjs");
const {
  buildAttachmentReceiptPresentation,
  buildComposerPresentation,
  buildFailureRecoveryPresentation,
  buildTaskHeaderPresentation,
  buildWorkbenchRunSummary,
  conversationOrganizationInlineMode,
  inferWorkbenchTaskKind,
} = require("./workbench-interface-model.cjs");
const { trainingResponseModeAction } = require("./capability-orchestrator.cjs");
const {
  appendAttachments,
  attachmentQueueIsBusy,
  attachmentQueueSummary,
  groupAttachmentBatches,
  normalizeAttachmentPurpose,
  updateAttachmentStatus,
} = require("./attachment-queue.cjs");
const { filesFromClipboardData } = require("./clipboard-attachments.cjs");
const {
  closeConversationMenusOutside,
  closeConversationMenuOnEscape,
  syncConversationMenuToggle,
} = require("./conversation-menu.cjs");

const VIEW_TYPE_XINGZHI = "xingzhi-workbench-view";
const MAX_ATTACHMENT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_BATCH_BYTES = 20 * 1024 * 1024;
let attachmentReadChain = Promise.resolve();

function withAttachmentReadSlot(read) {
  const task = attachmentReadChain.catch(() => {}).then(read);
  attachmentReadChain = task.then(() => undefined, () => undefined);
  return task;
}

const PROVIDER_FALLBACKS = [
  { id: "codex", label: "Codex", capabilities: ["本地执行", "工具调用", "持续对话"] },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", secretRef: "env:OPENAI_API_KEY", capabilities: ["对话", "结构化输出"] },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com", secretRef: "env:DEEPSEEK_API_KEY", capabilities: ["对话", "推理"] },
  { id: "kimi", label: "Kimi", baseUrl: "https://api.moonshot.cn/v1", secretRef: "env:MOONSHOT_API_KEY", capabilities: ["对话", "长上下文"] },
  { id: "custom", label: "自定义", baseUrl: "", secretRef: "env:XINGZHI_CUSTOM_API_KEY", capabilities: ["兼容 API"] },
];

// Additional user-added compatible endpoints reuse the "custom" contract but carry
// their own id suffix so several third-party gateways can stay configured at once.
const CUSTOM_PROVIDER_ID_PATTERN = /^custom(?:-[0-9]{1,3})?$/u;

function isCustomProviderId(value) {
  return typeof value === "string" && CUSTOM_PROVIDER_ID_PATTERN.test(value);
}

function customProviderSecretRef(providerId) {
  if (providerId === "custom") return "env:XINGZHI_CUSTOM_API_KEY";
  const suffix = String(providerId).slice("custom-".length);
  return `env:XINGZHI_CUSTOM_API_KEY_${suffix}`;
}

function customProviderLabel(providerId) {
  return providerId === "custom" ? "自定义" : `自定义 ${String(providerId).slice("custom-".length)}`;
}

function customProviderFallback(providerId) {
  return {
    id: providerId,
    label: customProviderLabel(providerId),
    baseUrl: "",
    secretRef: customProviderSecretRef(providerId),
    capabilities: ["兼容 API"],
  };
}

function nextCustomProviderId(existingIds) {
  const used = new Set(asArray(existingIds).filter((id) => isCustomProviderId(id)));
  if (!used.has("custom")) return "custom";
  for (let index = 2; index <= 999; index += 1) {
    const candidate = `custom-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("自定义 API 数量已达上限");
}

const PERMISSION_OPTIONS = [
  { id: "auto-write", label: "自动整理（可选）", hint: "启用后，低风险知识会自动归类、打标签并写入；所有变化保留记录并可撤销" },
  { id: "confirm-write", label: "整理前确认", hint: "生成归类和标签预览，每次正式写入前都需要你确认" },
  { id: "read-only", label: "关闭自动整理（只读）", hint: "只读取和分析，不改动知识库" },
];

const CONVERSATION_PROCESSING_OPTIONS = [
  { id: "automatic", label: "自动整理", hint: "保存本轮原文，并在回答后自动分类、打标签、比较新旧知识；只有重大信息需要人工审核" },
  { id: "record-only", label: "仅记录", hint: "保存完整输入输出和交互事件，但不运行本轮语义整理" },
];

const AGENT_MODE_OPTIONS = [
  { id: "orchestrator", label: "自动调度", hint: "先识别本轮任务，再自动切换专业 Agent、加载对应 Skill 并选择推理方法" },
  { id: "smart-route", label: "智能推荐", hint: "识别到专业问题时先推荐 Agent，不会静默切换" },
  { id: "locked", label: "手动锁定专业 Agent", hint: "把当前专业 Agent 固定到本对话" },
];

const MESSAGE_MERMAID_LANGUAGE = "xingzhi-mermaid-placeholder";
const MESSAGE_DIAGRAM_LANGUAGE = MESSAGE_DIAGRAM_PLACEHOLDER_LANGUAGE;
const MESSAGE_MERMAID_MAX_DIAGRAMS = 8;
const MESSAGE_MERMAID_MAX_SOURCE_BYTES = 8 * 1024;
const MESSAGE_MERMAID_MAX_SOURCE_LINES = 160;
const MESSAGE_DIAGRAM_MAX_DIAGRAMS = 8;
const MESSAGE_WINDOW_PAGE_SIZE = 40;
const MESSAGE_WINDOW_MAX_NODES = 80;
const MESSAGE_FAILURE_SUMMARY_MAX_BYTES = 1024;
let messageMermaidSequence = 0;
let messageMermaidApiPromise = null;

function utf8CodePointBytes(codePoint) {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function utf8SliceWithinBudget(value, start = 0, maxBytes) {
  const source = String(value || "");
  const begin = Math.max(0, Math.min(source.length, Number(start) || 0));
  const budget = Math.max(0, Number(maxBytes) || 0);
  let cursor = begin;
  let bytes = 0;
  while (cursor < source.length) {
    const codePoint = source.codePointAt(cursor);
    const codeUnits = codePoint > 0xffff ? 2 : 1;
    const codePointBytes = utf8CodePointBytes(codePoint);
    if (bytes + codePointBytes > budget) break;
    bytes += codePointBytes;
    cursor += codeUnits;
  }
  return { text: source.slice(begin, cursor), start: begin, end: cursor, bytes };
}

function boundedMessageErrorSummary(value) {
  const source = String(value || "");
  const slice = utf8SliceWithinBudget(source, 0, MESSAGE_FAILURE_SUMMARY_MAX_BYTES);
  return slice.end < source.length
    ? `${slice.text}…（错误信息过长，仅显示摘要）`
    : slice.text;
}

function hasIncompleteProviderCompletion(message) {
  const completion = message?.providerCompletion;
  if (!completion || typeof completion !== "object" || Array.isArray(completion)) return false;
  return Boolean(completion.incompleteReason)
    || (typeof completion.finishReason === "string"
      && !new Set(["stop", "tool_calls", "function_call"]).has(completion.finishReason))
    || (typeof completion.responseStatus === "string" && completion.responseStatus !== "completed");
}

function extractMessageMermaidBlocks(markdown) {
  const blocks = [];
  const source = String(markdown || "");
  const lines = source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu) || [source];
  const output = [];
  const lineText = (segment) => segment.replace(/(?:\r\n|\n|\r)$/u, "");
  const lineEnding = (segment) => segment.slice(lineText(segment).length);

  for (let cursor = 0; cursor < lines.length;) {
    const openingLine = lineText(lines[cursor]);
    const opening = openingLine.match(/^( {0,3})(`{3,}|~{3,})[ \t]*([^\r\n]*)$/u);
    if (!opening) {
      output.push(lines[cursor]);
      cursor += 1;
      continue;
    }

    const [, indent, marker, rawInfo] = opening;
    const closingPattern = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`, "u");
    let closingIndex = cursor + 1;
    while (closingIndex < lines.length && !closingPattern.test(lineText(lines[closingIndex]))) {
      closingIndex += 1;
    }
    if (closingIndex >= lines.length) {
      output.push(...lines.slice(cursor));
      break;
    }

    if (!/^mermaid(?:[ \t]+.*)?$/iu.test(rawInfo.trim())) {
      output.push(...lines.slice(cursor, closingIndex + 1));
      cursor = closingIndex + 1;
      continue;
    }

    const diagram = lines.slice(cursor + 1, closingIndex).join("").trim();
    const index = blocks.push(diagram) - 1;
    const newline = lineEnding(lines[cursor]) || "\n";
    const closingNewline = lineEnding(lines[closingIndex]);
    output.push(`${indent}\`\`\`${MESSAGE_MERMAID_LANGUAGE}${newline}${index}${newline}${indent}\`\`\`${closingNewline}`);
    cursor = closingIndex + 1;
  }

  return { markdown: output.join(""), blocks };
}

async function messageMermaidApi(ownerDocument) {
  if (!messageMermaidApiPromise) {
    messageMermaidApiPromise = (async () => {
      const view = ownerDocument?.defaultView;
      const loaded = typeof loadMermaid === "function" ? await loadMermaid() : null;
      const candidates = [
        loaded?.default,
        loaded,
        view?.mermaid,
        view?.__esbuild_esm_mermaid_nm?.mermaid?.default,
        view?.__esbuild_esm_mermaid_nm?.mermaid,
      ];
      const api = candidates.find((candidate) => typeof candidate?.render === "function");
      if (!api) throw new Error("当前 Obsidian 没有提供 Mermaid 渲染器");
      const config = typeof api.mermaidAPI?.getConfig === "function"
        ? api.mermaidAPI.getConfig() : null;
      if (String(config?.securityLevel) !== "strict") {
        throw new Error("Mermaid 安全级别不是 strict，已拒绝直接渲染");
      }
      return api;
    })();
  }
  try {
    return await messageMermaidApiPromise;
  } catch (error) {
    messageMermaidApiPromise = null;
    throw error;
  }
}

function sanitizeMessageMermaidSvg(container) {
  container.querySelectorAll("script, iframe, object, embed").forEach((node) => node.remove());
  const nodes = [container, ...container.querySelectorAll("*")];
  nodes.forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      if (/^on/iu.test(attribute.name)) {
        node.removeAttribute(attribute.name);
        return;
      }
      if (!/^(?:href|xlink:href)$/iu.test(attribute.name)) return;
      const value = attribute.value.trim();
      if (!value.startsWith("#")) node.removeAttribute(attribute.name);
    });
  });
}

function normalizeMessageMermaidSvgBreaks(svg) {
  let output = "";
  let cursor = 0;
  let changed = false;

  while (cursor < svg.length) {
    if (svg.startsWith("<!--", cursor)) {
      const end = svg.indexOf("-->", cursor + 4);
      if (end < 0) break;
      const after = end + 3;
      output += svg.slice(cursor, after);
      cursor = after;
      continue;
    }
    if (svg.startsWith("<![CDATA[", cursor)) {
      const end = svg.indexOf("]]>", cursor + 9);
      if (end < 0) break;
      const after = end + 3;
      output += svg.slice(cursor, after);
      cursor = after;
      continue;
    }
    if (svg[cursor] !== "<") {
      output += svg[cursor];
      cursor += 1;
      continue;
    }

    let quote = "";
    let end = cursor + 1;
    for (; end < svg.length; end += 1) {
      const character = svg[end];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === "\"" || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (end >= svg.length) break;

    const token = svg.slice(cursor, end + 1);
    if (/^<br\s*>$/u.test(token)) {
      output += "<br/>";
      changed = true;
    } else {
      output += token;
    }
    cursor = end + 1;
  }

  output += svg.slice(cursor);
  return changed ? output : svg;
}

function appendSanitizedMessageMermaidSvg(canvas, svg) {
  const view = canvas.ownerDocument?.defaultView;
  const Parser = view?.DOMParser || globalThis.DOMParser;
  if (typeof Parser !== "function") throw new Error("当前环境不能安全解析 Mermaid SVG");
  let parsed = new Parser().parseFromString(svg, "image/svg+xml");
  if (parsed.querySelector("parsererror")) {
    const normalized = normalizeMessageMermaidSvgBreaks(svg);
    if (normalized === svg) throw new Error("Mermaid SVG 解析失败");
    parsed = new Parser().parseFromString(normalized, "image/svg+xml");
    if (parsed.querySelector("parsererror")) throw new Error("Mermaid SVG 解析失败");
  }
  const parsedSvg = parsed.documentElement;
  if (String(parsedSvg?.localName || parsedSvg?.nodeName || "").toLowerCase() !== "svg"
    || parsedSvg.namespaceURI !== "http://www.w3.org/2000/svg") {
    throw new Error("Mermaid SVG 无效");
  }
  sanitizeMessageMermaidSvg(parsedSvg);
  const safeSvg = canvas.ownerDocument.importNode(parsedSvg, true);
  canvas.replaceChildren(safeSvg);
  return safeSvg;
}

function isMessageMermaidSyntaxError(error) {
  const message = String(error?.message || "").trimStart();
  return error?.name === "ParseError"
    || message.startsWith("Parse error")
    || message.startsWith("Lexical error on line");
}

function messageMermaidStageFailureReason(stage, error) {
  if (stage === "drawing" && isMessageMermaidSyntaxError(error)) {
    return "图表语法无法解析，请检查 Mermaid 源码。原始源码仍然保留。";
  }
  if (stage === "loading") return "Mermaid 渲染器加载失败；原始源码仍然保留。";
  if (stage === "drawing") return "图表绘制失败；原始源码仍然保留。";
  if (stage === "svg-processing") return "图表 SVG 处理失败；原始源码仍然保留。";
  return "图表交互绑定失败；原始源码仍然保留。";
}

function showMessageMermaidFailure(figure, canvas, source, reason) {
  canvas.remove();
  const document = figure.ownerDocument;
  const message = document.createElement("p");
  message.className = "xz-mermaid-error";
  message.setAttribute("role", "status");
  message.textContent = reason;
  figure.appendChild(message);
  const details = document.createElement("details");
  details.className = "xz-mermaid-fallback";
  const summary = document.createElement("summary");
  summary.textContent = "图表生成失败，查看 Mermaid 源码";
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = source;
  pre.appendChild(code);
  details.append(summary, pre);
  figure.appendChild(details);
}

function showMessageDiagramFailure(figure, canvas, source, reason) {
  canvas.remove();
  const document = figure.ownerDocument;
  const message = document.createElement("p");
  message.className = "xz-message-diagram-error";
  message.setAttribute("role", "status");
  message.textContent = reason;
  figure.appendChild(message);
  const details = document.createElement("details");
  details.className = "xz-message-diagram-source";
  const summary = document.createElement("summary");
  summary.textContent = "图表无效，保留原始 JSON";
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = source;
  pre.appendChild(code);
  details.append(summary, pre);
  figure.appendChild(details);
}

function appendSafeMessageDiagramSvg(canvas, svg) {
  const view = canvas.ownerDocument?.defaultView;
  const Parser = view?.DOMParser || globalThis.DOMParser;
  if (typeof Parser !== "function") throw new Error("当前环境不能安全解析本地结构图 SVG");
  const parsed = new Parser().parseFromString(svg, "image/svg+xml");
  if (parsed.querySelector("parsererror")) throw new Error("本地结构图 SVG 无效");
  const root = parsed.documentElement;
  if (String(root?.nodeName || "").toLowerCase() !== "svg") throw new Error("本地结构图 SVG 根元素无效");
  const allowedElements = new Set(["svg", "title", "rect", "text", "tspan", "line", "polygon"]);
  const allowedAttributes = new Set([
    "xmlns", "width", "height", "viewBox", "role", "aria-label",
    "x", "y", "x1", "y1", "x2", "y2", "rx", "fill", "stroke", "stroke-width",
    "font-family", "font-size", "font-weight", "text-anchor", "dy", "points",
  ]);
  for (const node of [root, ...root.querySelectorAll("*")]) {
    if (!allowedElements.has(String(node.localName || "").toLowerCase())) {
      throw new Error("本地结构图包含未允许的 SVG 元素");
    }
    for (const attribute of [...node.attributes]) {
      if (!allowedAttributes.has(attribute.name)) throw new Error("本地结构图包含未允许的 SVG 属性");
    }
  }
  const safeSvg = canvas.ownerDocument.importNode(root, true);
  canvas.replaceChildren(safeSvg);
  return safeSvg;
}

function renderMessageDiagramBlocks(container, blocks, {
  isCurrent = () => true,
  conversationId = "",
  messageId = "",
  messageStatus = "",
  plugin = null,
  openVaultPath = () => {},
  savedDiagrams = null,
} = {}) {
  const placeholders = [...container.querySelectorAll(`code.language-${MESSAGE_DIAGRAM_LANGUAGE}`)];
  placeholders.forEach((placeholder, position) => {
    if (!isCurrent()) return;
    const sourceIndex = Number.parseInt(String(placeholder.textContent || "").trim(), 10);
    const block = Number.isInteger(sourceIndex) ? blocks[sourceIndex] : null;
    const source = typeof block?.source === "string" ? block.source : "";
    const original = placeholder.closest("pre") || placeholder;
    const document = container.ownerDocument;
    const figure = document.createElement("figure");
    figure.className = "xz-message-diagram";
    figure.setAttribute("aria-label", "行知结构图");
    const caption = document.createElement("figcaption");
    caption.textContent = "结构图 · 未知信息保留为未知";
    const canvas = document.createElement("div");
    canvas.className = "xz-message-diagram-canvas is-loading";
    canvas.setAttribute("aria-busy", "true");
    canvas.textContent = "正在绘制结构图…";
    figure.append(caption, canvas);
    original.replaceWith(figure);

    if (!source) {
      showMessageDiagramFailure(figure, canvas, "", "没有读取到结构图 JSON。");
      return;
    }
    if (position >= MESSAGE_DIAGRAM_MAX_DIAGRAMS) {
      showMessageDiagramFailure(figure, canvas, source, `单条回复最多直接显示 ${MESSAGE_DIAGRAM_MAX_DIAGRAMS} 张结构图。`);
      return;
    }

    let diagram;
    try {
      diagram = parseMessageDiagram(source);
      const safeSvg = appendSafeMessageDiagramSvg(canvas, renderMessageDiagramSvg(diagram));
      safeSvg.setAttribute("role", "img");
      // Obsidian treats aria-label as a tooltip and assumes HTMLElement.isShown.
      // Keep SVG's accessible name in <title>; put tooltip labels on HTML only.
      figure.setAttribute("aria-label", diagram.title ? `结构图：${diagram.title}` : "行知结构图");
      canvas.classList.remove("is-loading");
      canvas.setAttribute("aria-busy", "false");
    } catch (_error) {
      showMessageDiagramFailure(figure, canvas, source, "结构图未绘制；请修正 JSON 或协议字段。原文仍然保留。");
      return;
    }

    const exportKey = `${conversationId}\u241f${messageId}\u241f${position}`;
    const saved = savedDiagrams?.get(exportKey);
    const save = document.createElement("button");
    save.className = "xz-diagram-save";
    save.type = "button";
    save.setAttribute("aria-label", "将此结构图保存为本地 SVG");
    save.textContent = saved?.saved ? "已保存" : "保存 SVG 到资料库";
    const state = document.createElement("span");
    state.className = "xz-diagram-save-state";
    state.setAttribute("role", "status");
    state.setAttribute("aria-live", "polite");
    caption.append(save, state);
    if (saved?.saved) {
      save.disabled = true;
      state.textContent = saved.label ? `已保存：${saved.label}` : "已保存到资料库";
      const open = document.createElement("button");
      open.className = "xz-diagram-save-open";
      open.type = "button";
      open.textContent = "打开文件";
      caption.appendChild(open);
      open.addEventListener("click", () => { if (saved.path) openVaultPath(saved.path); });
    } else if (messageStatus !== "completed") {
      save.disabled = true;
      save.setAttr("title", "回复完成后可保存");
      state.setText("回复完成后可保存");
    } else if (typeof plugin?.saveMessageDiagram !== "function") {
      save.disabled = true;
      state.setText("当前版本不支持保存结构图");
    } else {
      save.addEventListener("click", async () => {
        save.disabled = true;
        save.textContent = "正在保存…";
        state.textContent = "";
        try {
          const result = await plugin.saveMessageDiagram({ conversationId, messageId, diagram });
          const savedResult = {
            saved: result?.saved === true,
            path: firstText(result?.path),
            label: firstText(result?.label, diagram.title, "结构图"),
          };
          if (!savedResult.saved || !savedResult.path) throw new Error("保存结果未确认");
          savedDiagrams?.set(exportKey, savedResult);
          save.textContent = "已保存";
          state.textContent = `已保存：${savedResult.label}`;
          const open = document.createElement("button");
          open.className = "xz-diagram-save-open";
          open.type = "button";
          open.textContent = "打开文件";
          caption.appendChild(open);
          open.addEventListener("click", () => openVaultPath(savedResult.path));
        } catch (error) {
          save.disabled = false;
          save.textContent = "保存 SVG 到资料库";
          state.textContent = `保存失败：${boundedMessageErrorSummary(firstText(error?.message, error, "未知错误"))}`;
        }
      });
    }
  });
  return isCurrent();
}

async function renderMessageMermaidBlocks(container, blocks, isCurrent = () => true) {
  const selector = `code.language-${MESSAGE_MERMAID_LANGUAGE}`;
  const placeholders = [...container.querySelectorAll(selector)];
  for (let position = 0; position < placeholders.length; position += 1) {
    const placeholder = placeholders[position];
    const sourceIndex = Number.parseInt(String(placeholder.textContent || "").trim(), 10);
    const source = Number.isInteger(sourceIndex) ? blocks[sourceIndex] : "";
    const original = placeholder.closest("pre") || placeholder;
    const document = container.ownerDocument;
    const figure = document.createElement("figure");
    figure.className = "xz-mermaid-diagram";
    figure.setAttribute("aria-label", "Mermaid 图表");
    const caption = document.createElement("figcaption");
    caption.textContent = "图表 · 已适配对话框宽度";
    const canvas = document.createElement("div");
    canvas.className = "xz-mermaid-canvas is-loading";
    canvas.setAttribute("aria-busy", "true");
    canvas.textContent = "正在生成图表…";
    figure.append(caption, canvas);
    original.replaceWith(figure);

    if (!source) {
      showMessageMermaidFailure(figure, canvas, "", "没有读取到 Mermaid 源码。");
      continue;
    }
    if (position >= MESSAGE_MERMAID_MAX_DIAGRAMS) {
      showMessageMermaidFailure(figure, canvas, source, `单条回复最多直接显示 ${MESSAGE_MERMAID_MAX_DIAGRAMS} 张图。`);
      continue;
    }
    const sourceBytes = Buffer.byteLength(source, "utf8");
    const sourceLines = source.split(/\r\n|\n|\r/u).length;
    if (sourceBytes > MESSAGE_MERMAID_MAX_SOURCE_BYTES || sourceLines > MESSAGE_MERMAID_MAX_SOURCE_LINES) {
      showMessageMermaidFailure(figure, canvas, source, "图表源码较复杂，已保留源码并停止自动绘制。");
      continue;
    }

    let stage = "loading";
    try {
      const api = await messageMermaidApi(container.ownerDocument);
      messageMermaidSequence += 1;
      stage = "drawing";
      const result = await api.render(`xz-mermaid-${Date.now()}-${messageMermaidSequence}`, source);
      if (!isCurrent()) return;
      stage = "svg-processing";
      const svg = String(result?.svg || "").trim();
      if (!svg.startsWith("<svg")) throw new Error("Mermaid 没有返回 SVG");
      const svgNode = appendSanitizedMessageMermaidSvg(canvas, svg);
      svgNode.setAttribute("role", "img");
      svgNode.removeAttribute("aria-label");
      svgNode.removeAttribute("height");
      stage = "binding";
      if (typeof result?.bindFunctions === "function") result.bindFunctions(canvas);
      canvas.classList.remove("is-loading");
      canvas.setAttribute("aria-busy", "false");
    } catch (error) {
      if (!isCurrent()) return;
      figure.setAttribute("data-mermaid-error-stage", stage);
      showMessageMermaidFailure(figure, canvas, source, messageMermaidStageFailureReason(stage, error));
      console.warn("行知 Mermaid 图表渲染失败", { stage, error });
    }
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function attachmentDataByteLength(value) {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return null;
}

function declaredAttachmentByteLength(item) {
  const file = item?.file;
  const byteLength = attachmentDataByteLength(file?.bytes);
  const fileSize = Number(file?.size);
  const itemSize = Number(item?.size);
  const declared = Number.isFinite(fileSize) && fileSize >= 0 ? fileSize
    : Number.isFinite(itemSize) && itemSize >= 0 ? itemSize : null;
  return byteLength === null ? declared : Math.max(byteLength, declared || 0);
}

function assertAttachmentBatchWithinLimits(items) {
  let total = 0;
  for (const item of items) {
    const size = declaredAttachmentByteLength(item);
    if (size === null) throw new Error(`无法预先确认「${item?.name || "未命名文件"}」的文件大小；请重新选择文件。`);
    if (size > MAX_ATTACHMENT_FILE_BYTES) throw new Error(`「${item?.name || "未命名文件"}」超过单个文件 10MiB 上限。`);
    total += size;
    if (total > MAX_ATTACHMENT_BATCH_BYTES) throw new Error("当前附件批次总量超过 20MiB，请减少本批文件后重试。");
  }
}

async function readBoundedAttachment(item, maximumBytes = MAX_ATTACHMENT_FILE_BYTES) {
  const boundedMaximum = Math.min(MAX_ATTACHMENT_FILE_BYTES, Math.max(0, Number(maximumBytes) || 0));
  const declared = declaredAttachmentByteLength(item);
  if (declared === null) throw new Error(`无法确认「${item?.name || "未命名文件"}」的文件大小。`);
  if (declared > MAX_ATTACHMENT_FILE_BYTES) throw new Error(`「${item?.name || "未命名文件"}」超过单个文件 10MiB 上限。`);
  if (declared > boundedMaximum) throw new Error("当前附件批次总量超过 20MiB，请减少本批文件后重试。");
  const file = item?.file;
  let bytes;
  if (typeof file?.arrayBuffer === "function") {
    if (typeof file.slice !== "function") throw new Error(`无法安全限幅读取「${item?.name || "未命名文件"}」；请重新选择文件。`);
    const source = file.slice(0, boundedMaximum + 1);
    if (typeof source?.arrayBuffer !== "function") throw new Error(`无法读取「${item?.name || "未命名文件"}」的文件内容。`);
    bytes = await withAttachmentReadSlot(() => source.arrayBuffer());
  } else {
    bytes = file?.bytes;
  }
  const actual = attachmentDataByteLength(bytes);
  if (actual === null) throw new Error(`无法确认「${item?.name || "未命名文件"}」的实际内容大小。`);
  if (actual > MAX_ATTACHMENT_FILE_BYTES) throw new Error(`「${item?.name || "未命名文件"}」的实际内容超过单个文件 10MiB 上限。`);
  if (actual > boundedMaximum) throw new Error("当前附件批次实际读取量超过 20MiB，请减少本批文件后重试。");
  return { bytes, byteLength: actual };
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
}

function firstRawText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

function messageText(message) {
  if (message?.contentDeletedAt) {
    return "本条消息内容已删除，可打开“段落管理”恢复。";
  }
  const content = message?.displayContent ?? message?.content ?? message?.text ?? message?.message ?? "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return firstText(part?.text, part?.content, part?.value);
    })
    .filter(Boolean)
    .join("\n");
}

function formatTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat("zh-CN", sameDay
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(date);
}

function normalizeId(item, fallback = "") {
  if (typeof item === "string") return item;
  return firstText(item?.id, item?.slug, item?.name, item?.model, fallback);
}

function normalizeLabel(item, fallback = "") {
  if (typeof item === "string") return item;
  return firstText(item?.displayName, item?.label, item?.title, item?.name, item?.id, fallback);
}

function visibleAgentProfiles(value) {
  return asArray(value).filter((agent) => (
    agent && agent.id !== "xingzhi-orchestrator" && agent.internal !== true
  ));
}

function brandIcon(plugin) {
  return plugin?.getBrandIconName?.() || "brain-circuit";
}

function renderBrandAvatar(avatar, plugin) {
  avatar.empty();
  let brandAssetUrl = "";
  try {
    brandAssetUrl = plugin?.getBrandAssetUrl?.() || "";
  } catch (_error) {
    brandAssetUrl = "";
  }
  if (!brandAssetUrl) {
    setIcon(avatar, brandIcon(plugin));
    return null;
  }
  const image = avatar.createEl("img", {
    cls: "xz-message-brand-image",
    attr: { src: brandAssetUrl, alt: "", draggable: "false" },
  });
  image.addEventListener("error", () => {
    if (!image.isConnected) return;
    image.remove();
    setIcon(avatar, brandIcon(plugin));
  }, { once: true });
  return image;
}

function brandMarkIcon(plugin) {
  return plugin?.getBrandMarkIconName?.() || brandIcon(plugin);
}

function setButtonIcon(button, icon, label) {
  button.empty();
  const iconEl = button.createSpan({ cls: "xz-button-icon", attr: { "aria-hidden": "true" } });
  setIcon(iconEl, icon);
  if (label) button.createSpan({ text: label });
}

function createIconButton(parent, icon, label, handler, className = "xz-icon-button") {
  const button = parent.createEl("button", {
    cls: className,
    attr: { type: "button", "aria-label": label, title: label },
  });
  setButtonIcon(button, icon);
  button.addEventListener("click", handler);
  return button;
}

function stateSettings(plugin) {
  return plugin?.state?.settings || {};
}

class XingzhiTextPromptModal extends Modal {
  constructor(app, options = {}) {
    super(app);
    this.title = options.title || "请输入内容";
    this.initialValue = options.initialValue || "";
    this.submitLabel = options.submitLabel || "确定";
    this.resolveValue = null;
    this.promise = new Promise((resolve) => { this.resolveValue = resolve; });
  }

  onOpen() {
    this.titleEl.setText(this.title);
    let input;
    new Setting(this.contentEl)
      .setName("名称")
      .addText((text) => {
        input = text.inputEl;
        text.setValue(this.initialValue);
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" || event.isComposing) return;
          event.preventDefault();
          this.resolveValue?.(text.getValue());
          this.resolveValue = null;
          this.close();
        });
      });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const submit = actions.createEl("button", {
      cls: "mod-cta",
      text: this.submitLabel,
      attr: { type: "button" },
    });
    submit.addEventListener("click", () => {
      this.resolveValue?.(input?.value || "");
      this.resolveValue = null;
      this.close();
    });
    setTimeout(() => {
      input?.focus();
      input?.select();
    }, 0);
  }

  onClose() {
    this.resolveValue?.(null);
    this.resolveValue = null;
    this.contentEl.empty();
  }

  waitForValue() {
    this.open();
    return this.promise;
  }
}

class XingzhiConfirmationModal extends Modal {
  constructor(app, options = {}) {
    super(app);
    this.title = options.title || "请确认";
    this.message = options.message || "";
    this.confirmLabel = options.confirmLabel || "确定";
    this.resolveValue = null;
    this.promise = new Promise((resolve) => { this.resolveValue = resolve; });
  }

  onOpen() {
    this.titleEl.setText(this.title);
    this.contentEl.createEl("p", { text: this.message });
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    const confirm = actions.createEl("button", {
      cls: "mod-warning",
      text: this.confirmLabel,
      attr: { type: "button" },
    });
    confirm.addEventListener("click", () => {
      this.resolveValue?.(true);
      this.resolveValue = null;
      this.close();
    });
    setTimeout(() => cancel.focus(), 0);
  }

  onClose() {
    this.resolveValue?.(false);
    this.resolveValue = null;
    this.contentEl.empty();
  }

  waitForConfirmation() {
    this.open();
    return this.promise;
  }
}

const {
  TASK_TYPES,
  assessQuestion,
  buildSuggestedQuestion,
  buildQuestionHabitHints,
  shouldShowQuestionCalibration,
  createQuestionCalibrationEvent,
} = require("./question-calibration.cjs");
const { buildDynamicThinkingRequest } = require("./dynamic-thinking-policy.cjs");

class QuestionCalibrationModal extends Modal {
  constructor(app, { assessment, original, mode = "send", habitHints = [] } = {}) {
    super(app);
    this.assessment = assessment;
    this.original = original || assessment?.original || "";
    this.mode = mode;
    this.habitHints = habitHints;
    this.selectedPerspectiveCodes = new Set();
    this.suggested = this.original;
    this.resolveValue = null;
    this.promise = new Promise((resolve) => { this.resolveValue = resolve; });
  }

  onOpen() {
    this.modalEl.addClass("xz-question-calibration-modal");
    this.titleEl.setText("补充思考，让问题更清楚");
    this.contentEl.empty();
    const type = this.assessment?.taskType || TASK_TYPES.analysis;
    this.contentEl.createSpan({ cls: "xz-question-calibration-kicker", text: `可选视角 · ${type.label} · 本地规则建议` });
    this.contentEl.createEl("p", {
      cls: "xz-question-calibration-intro",
      text: "保留你的原话，看看有没有值得继续想的角度。选择后会把对应问题接在原话后面；你仍可编辑或直接使用原话。",
    });
    const reason = this.contentEl.createDiv({ cls: "xz-question-calibration-reason", attr: { role: "note" } });
    reason.createEl("strong", { text: "可能值得考虑的角度" });
    reason.createEl("p", { text: this.assessment?.reason || "补充少量关键上下文可能让回答更贴合你的处境。" });
    for (const item of this.assessment?.perspectives || []) {
      const row = reason.createEl("label", { cls: "xz-question-calibration-perspective" });
      const check = row.createEl("input", { attr: { type: "checkbox", "aria-label": `加入：${item.label}` } });
      const copy = row.createDiv();
      copy.createEl("strong", { text: item.label });
      copy.createEl("p", { text: item.question });
      copy.createSpan({ text: `为什么值得想：${item.reason}` });
      copy.createSpan({ text: `关联：${item.source}「${item.anchor}」` });
      check.addEventListener("change", () => {
        if (this.editor.value !== this.suggested) {
          check.checked = this.selectedPerspectiveCodes.has(item.id);
          new Notice("你已编辑预览。请先保留手动修改，再调整角度；不会覆盖你的文字。");
          return;
        }
        if (check.checked) this.selectedPerspectiveCodes.add(item.id);
        else this.selectedPerspectiveCodes.delete(item.id);
        this.suggested = buildSuggestedQuestion(this.assessment, { selectedPerspectiveCodes: [...this.selectedPerspectiveCodes] });
        this.editor.value = this.suggested;
      });
    }
    if (!this.assessment?.perspectives?.length) reason.createEl("p", { text: "当前没有明确匹配的补充角度。可以在下面自行整理表达，也可以保持原话。" });
    const learning = this.contentEl.createDiv({ cls: "xz-question-calibration-learning", attr: { role: "note" } });
    learning.createEl("strong", { text: "下次可以自己这样问" });
    learning.createEl("p", { text: this.assessment?.learningHint || "先说清当前处境和这一轮希望得到什么。" });
    learning.createSpan({ text: "只是一种可选表达方法，不要求你按固定模板说话。" });
    for (const item of this.habitHints.slice(0, 1)) {
      const hint = this.contentEl.createDiv({ cls: "xz-question-calibration-learning" });
      hint.createEl("strong", { text: "近期表达回顾" });
      hint.createEl("p", { text: item.text });
      hint.createEl("p", { text: item.nextTime });
      hint.createSpan({ text: item.boundary });
    }
    const originalDetails = this.contentEl.createEl("details", { cls: "xz-question-calibration-original" });
    originalDetails.createEl("summary", { text: "查看本次保留的原问题" });
    originalDetails.createEl("blockquote", { text: this.original });
    const editorLabel = this.contentEl.createEl("label", { cls: "xz-question-calibration-editor-label" });
    editorLabel.createSpan({ text: "原话与所选补充（可编辑）" });
    this.editor = editorLabel.createEl("textarea", {
      attr: { rows: "11", "aria-label": "可编辑的提问建议版本" },
    });
    this.editor.value = this.suggested;
    this.contentEl.createEl("p", {
      cls: "xz-question-calibration-privacy",
      text: "提示由本地规则生成，不额外调用模型。正式回答仍由你已配置的模型处理。校准记录只保留角度编号和选择；表达回顾可在设置中开启、关闭或清空记录。",
    });
    const actions = this.contentEl.createDiv({ cls: "xz-question-calibration-actions" });
    const originalButton = actions.createEl("button", {
      cls: "xz-secondary-button",
      text: this.mode === "send" ? "按原话发送" : "保留原话",
      attr: { type: "button" },
    });
    originalButton.addEventListener("click", () => this.resolve({ decision: "sent-original", text: this.original, selectedPerspectiveCodes: [] }));
    const suggestedButton = actions.createEl("button", {
      cls: "mod-cta",
      text: this.mode === "send" ? "采用当前版本发送" : "放回输入框",
      attr: { type: "button" },
    });
    suggestedButton.addEventListener("click", () => {
      const value = this.editor.value.trim();
      if (!value) {
        new Notice("建议版本不能为空；也可以按原问题发送");
        this.editor.focus();
        return;
      }
      this.resolve({
        decision: value === this.original.trim() ? "sent-original" : value === this.suggested.trim() ? "accepted-suggestion" : "edited-suggestion",
        text: value,
        selectedPerspectiveCodes: value === this.original.trim() ? [] : [...this.selectedPerspectiveCodes]
          .filter((id) => value.includes(this.assessment.perspectives.find((item) => item.id === id)?.question || "\u0000")),
      });
    });
    const cancel = actions.createEl("button", {
      cls: "xz-question-calibration-cancel",
      text: "返回输入框",
      attr: { type: "button" },
    });
    cancel.addEventListener("click", () => this.close());
    setTimeout(() => this.editor?.focus(), 0);
  }

  resolve(value) {
    if (!this.resolveValue) return;
    const resolve = this.resolveValue;
    this.resolveValue = null;
    resolve(value);
    this.close();
  }

  onClose() {
    this.resolveValue?.(null);
    this.resolveValue = null;
    this.contentEl.empty();
  }

  waitForChoice() {
    this.open();
    return this.promise;
  }
}

// Attachment previews use existing evidence links; image bytes stay in the Vault.
function uploadedImagePath(value) {
  const path = String(value || "").replace(/\\/gu, "/");
  if (!path.startsWith("12_资料库/导入资料/原文件/")
    || path.split("/").some((part) => !part || part === "." || part === "..")
    || !/\.(?:png|jpe?g|webp|gif)$/iu.test(path)) return "";
  return path;
}

function generatedImagePath(value) {
  const path = String(value || "").replace(/\\/gu, "/");
  if (!path.startsWith("12_资料库/生成资源/图片/")
    || path.split("/").some((part) => !part || part === "." || part === "..")
    || !/\.(?:png|jpe?g|webp)$/iu.test(path)) return "";
  return path;
}

class AttachmentImagePreviewModal extends Modal {
  constructor(app, { url, name, path = "", onOpenPath = null }) {
    super(app);
    this.image = { url, name, path, onOpenPath };
  }

  onOpen() {
    this.modalEl.addClass("xz-image-preview-modal");
    this.titleEl.setText(this.image.name || "图片预览");
    this.contentEl.createEl("img", {
      cls: "xz-image-preview-full",
      attr: { src: this.image.url, alt: this.image.name || "上传的图片", decoding: "async" },
    });
    if (this.image.path && this.image.onOpenPath) {
      const open = this.contentEl.createEl("button", {
        cls: "xz-secondary-button", text: "打开本地原图", attr: { type: "button" },
      });
      open.addEventListener("click", () => { this.image.onOpenPath(this.image.path); this.close(); });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

let messageDiagramPreviewSequence = 0;

function cloneMessageDiagramSvg(svg) {
  const clone = svg.cloneNode(true);
  sanitizeMessageMermaidSvg(clone);
  // The preview lives beside the original: isolate IDs, markers and scoped CSS.
  const prefix = `xz-diagram-preview-${++messageDiagramPreviewSequence}-`;
  const nodes = [clone, ...clone.querySelectorAll("*")];
  const ids = new Map();
  for (const node of nodes) {
    if (node.id) { ids.set(node.id, `${prefix}${ids.size}`); node.id = ids.get(node.id); }
  }
  const selectorIds = [...ids.keys()].map((id) => id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const idPattern = selectorIds.length ? new RegExp(`#(${selectorIds.join("|")})(?![\\w-])`, "gu") : null;
  const replaceIds = (value) => idPattern
    ? value.replace(idPattern, (_match, id) => `#${ids.get(id)}`) : value;
  for (const node of nodes) {
    for (const attr of [...node.attributes]) {
      if (attr.name === "id") continue;
      const value = /^(?:aria-labelledby|aria-describedby)$/u.test(attr.name)
        ? attr.value.split(/\s+/u).map((id) => ids.get(id) || id).join(" ")
        : replaceIds(attr.value);
      if (value !== attr.value) node.setAttribute(attr.name, value);
    }
    if (node.localName === "style") node.textContent = replaceIds(node.textContent || "");
  }
  return clone;
}

class MessageDiagramPreviewModal extends Modal {
  constructor(app, svg, trigger = null) {
    super(app);
    this.sourceSvg = svg;
    this.trigger = trigger;
    this.listeners = [];
    this.scale = 1;
    this.fitted = true;
  }

  listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this.listeners.push(() => target.removeEventListener(type, handler, options));
  }

  onOpen() {
    this.modalEl.addClass("xz-diagram-preview-modal");
    this.titleEl.setText("图表 · 放大查看");
    const toolbar = this.contentEl.createDiv({ cls: "xz-diagram-preview-toolbar", attr: { role: "group", "aria-label": "图表缩放控制" } });
    const control = (text, label, action) => {
      const button = toolbar.createEl("button", { text, attr: { type: "button", "aria-label": label, title: label } });
      this.listen(button, "click", action);
      return button;
    };
    this.zoomOut = control("−", "缩小图表", () => this.setScale(this.scale / 1.25));
    this.zoomLabel = toolbar.createSpan({ attr: { role: "status", "aria-live": "polite", "aria-label": "当前缩放比例" } });
    this.zoomIn = control("＋", "放大图表", () => this.setScale(this.scale * 1.25));
    control("100%", "按原始大小查看图表", () => this.setScale(1));
    control("适应窗口", "显示完整图表", () => this.fitDiagram());
    control("关闭", "关闭图表预览", () => this.close());
    this.contentEl.createEl("p", { cls: "xz-diagram-preview-hint", text: "拖动或滚动查看 · Ctrl/⌘ + 滚轮缩放 · + / − 缩放 · 0 原始大小 · F 全图 · Esc 关闭" });
    this.viewport = this.contentEl.createDiv({
      cls: "xz-diagram-preview-viewport",
      attr: { tabindex: "0", role: "region", "aria-label": "图表查看区域，可缩放、拖动和滚动" },
    });
    const stage = this.viewport.createDiv({ cls: "xz-diagram-preview-stage" });
    this.svg = cloneMessageDiagramSvg(this.sourceSvg);
    this.svg.classList.add("xz-diagram-preview-svg");
    stage.appendChild(this.svg);
    const box = this.svg.viewBox?.baseVal;
    this.size = {
      width: box?.width > 0 ? box.width : this.sourceSvg.getBoundingClientRect().width || 800,
      height: box?.height > 0 ? box.height : this.sourceSvg.getBoundingClientRect().height || 600,
    };
    this.listen(this.viewport, "wheel", (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = this.viewport.getBoundingClientRect();
      this.setScale(this.scale * Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.004), {
        x: event.clientX - rect.left, y: event.clientY - rect.top,
      });
    }, { passive: false });
    this.listen(this.viewport, "keydown", (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "+" || event.key === "=") this.setScale(this.scale * 1.25);
      else if (event.key === "-") this.setScale(this.scale / 1.25);
      else if (event.key === "0") this.setScale(1);
      else if (event.key.toLowerCase() === "f") this.fitDiagram();
      else return;
      event.preventDefault();
    });
    this.listen(this.viewport, "pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest?.("a, button")) return;
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: this.viewport.scrollLeft, top: this.viewport.scrollTop };
      this.viewport.setPointerCapture?.(event.pointerId);
      this.viewport.addClass("is-dragging");
      event.preventDefault();
    });
    this.listen(this.viewport, "pointermove", (event) => {
      if (this.drag?.id !== event.pointerId) return;
      this.viewport.scrollLeft = this.drag.left + this.drag.x - event.clientX;
      this.viewport.scrollTop = this.drag.top + this.drag.y - event.clientY;
    });
    const endDrag = () => { this.drag = null; this.viewport.removeClass("is-dragging"); };
    this.listen(this.viewport, "pointerup", endDrag);
    this.listen(this.viewport, "pointercancel", endDrag);
    this.listen(this.viewport, "lostpointercapture", endDrag);
    const view = this.viewport.ownerDocument.defaultView;
    if (typeof view?.ResizeObserver === "function") {
      this.resizeObserver = new view.ResizeObserver(() => { if (this.fitted) this.fitDiagram(); });
      this.resizeObserver.observe(this.viewport);
    }
    this.fitDiagram();
    this.viewport.focus();
  }

  setScale(value, anchor = null) {
    const viewport = this.viewport;
    const next = Math.max(0.02, Math.min(8, Number(value) || 1));
    const ratio = next / this.scale;
    const x = anchor?.x ?? viewport.clientWidth / 2;
    const y = anchor?.y ?? viewport.clientHeight / 2;
    const left = (viewport.scrollLeft + x - 24) * ratio + 24 - x;
    const top = (viewport.scrollTop + y - 24) * ratio + 24 - y;
    this.scale = next;
    this.fitted = false;
    this.svg.style.setProperty("width", `${this.size.width * next}px`, "important");
    this.svg.style.setProperty("height", `${this.size.height * next}px`, "important");
    this.svg.style.setProperty("max-width", "none", "important");
    viewport.scrollLeft = Math.max(0, left);
    viewport.scrollTop = Math.max(0, top);
    this.zoomLabel.setText(`${Math.round(next * 100)}%`);
    this.zoomIn.disabled = next >= 8;
    this.zoomOut.disabled = next <= 0.02;
  }

  fitDiagram() {
    this.setScale(Math.min(1,
      Math.max(1, this.viewport.clientWidth - 48) / this.size.width,
      Math.max(1, this.viewport.clientHeight - 48) / this.size.height));
    this.fitted = true;
    this.viewport.scrollLeft = 0;
    this.viewport.scrollTop = 0;
  }

  onClose() {
    this.fitted = false;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const dispose of this.listeners.splice(0)) dispose();
    this.drag = null;
    this.contentEl.empty();
    if (this.trigger?.isConnected) this.trigger.focus();
    this.sourceSvg = null;
    this.svg = null;
    this.viewport = null;
    this.trigger = null;
  }
}

class XingzhiWorkbenchView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.section = "chat";
    this.draft = "";
    this.unsubscribe = null;
    this.updateFrame = null;
    this.messageNodes = new Map();
    this.messageWindowStarts = new Map();
    this.messageWindowScrollPositions = new Map();
    this.messageRenderedCounts = new Map();
    this.messageRenderGeneration = 0;
    this.messageScrollRevision = 0;
    this.messageScrollRestoreToken = null;
    this.messageScrollFollowLatest = true;
    this.pendingMessageWindowScroll = null;
    this.conversationNodes = new Map();
    this.renderedConversationId = "";
    this.lastConversationSignature = "";
    this.lastControlSignature = "";
    this.lastSkillSignature = "";
    this.lastInteractiveSignature = "";
    this.lastWorkSignature = "";
    this.lastMessageLocatorSignature = "";
    this.pendingSkillSelection = new Set();
    this.nextTurnSkillSelections = new Map();
    this.sendingConversationIds = new Set();
    this.pendingQuestionCalibrationConversations = new Set();
    this.preparedQuestionCalibrations = new Map();
    this.pendingOutgoingMessages = new Map();
    this.pendingThinkingTurns = new Map();
    this.conversationDrafts = new Map();
    this.attachmentQueues = new Map();
    this.attachmentSends = new Map();
    this.attachmentPreviewUrls = new Map();
    this.uploadedImageSources = new Map();
    this.imagePreviewModal = null;
    this.diagramPreviewModal = null;
    this.savedMessageDiagrams = new Map();
    this.attachmentPurposes = new Map();
    this.attachmentReceipts = new Map();
    this.attachmentKnowledgeRetries = new Set();
    this.historyOpen = false;
    this.sidebarCollapsed = false;
    this.historyQuery = "";
    this.showArchived = false;
    this.workPanelOpen = false;
    this.workPanelLifecycle = new WorkPanelLifecycleController({
      onChange: () => this.scheduleStateRender(),
    });
    this.technicalDetailsDisclosure = new TechnicalDetailsDisclosureController();
    this.settingsOpen = false;
    this.connectionDiagnosticsPanel = null;
    this.recycleBinPanel = null;
    this.knowledgeHealthPanel = null;
    this.knowledgeStructurePanel = null;
    this.refs = {};
    this.responseClock = null;
    this.messageNavigationObserver = null;
    this.boundKeydown = (event) => this.handleGlobalKeydown(event);
  }

  getViewType() {
    return VIEW_TYPE_XINGZHI;
  }

  getDisplayText() {
    return "行知";
  }

  getIcon() {
    return brandIcon(this.plugin);
  }

  getState() {
    return { cognitivePreferences: { ...(this.unifiedWorkspace?.cognitive?.preferences || this.cognitivePreferences || {}) },
      ...(this.legacyCognitiveDrafts ? { legacyCognitiveDrafts: this.legacyCognitiveDrafts } : {}),
      ...(this.legacyWorkspaceDrafts?.length ? { legacyWorkspaceDrafts: this.legacyWorkspaceDrafts } : {}) };
  }

  async setState(state, result) {
    this.cognitivePreferences = { ...(state?.cognitivePreferences || {}) };
    this.legacyCognitiveDrafts = state?.legacyCognitiveDrafts;
    this.legacyWorkspaceDrafts = state?.legacyWorkspaceDrafts;
    await super.setState(state, result);
    if (this.unifiedWorkspace?.cognitive) await this.unifiedWorkspace.cognitive.setState(this.cognitivePreferences);
    applyChatArt(this);
  }

  async onOpen() {
    this.containerEl.addClass("xz-view-host");
    this.buildShell();
    this.renderState({ force: true });
    this.viewDocument = this.containerEl.ownerDocument || document;
    this.viewDocument.addEventListener("keydown", this.boundKeydown);
    this.responseClock = globalThis.setInterval(() => this.refreshStreamingClock(), 500);
    this.responseClock.unref?.();

    if (typeof this.plugin?.subscribe === "function") {
      const maybeUnsubscribe = this.plugin.subscribe(() => this.scheduleStateRender());
      if (typeof maybeUnsubscribe === "function") this.unsubscribe = maybeUnsubscribe;
    } else {
      const runtime = this.plugin?.workbenchRuntime || this.plugin?.runtime;
      if (typeof runtime?.on === "function") {
        const listener = () => this.scheduleStateRender();
        runtime.on("stateChanged", listener);
        this.unsubscribe = () => {
          if (typeof runtime.off === "function") runtime.off("stateChanged", listener);
          else runtime.removeListener?.("stateChanged", listener);
        };
      }
    }

    const models = asArray(this.plugin?.state?.runtime?.models);
    const startupProviderId = firstText(stateSettings(this.plugin).providerId, "codex");
    const mayRefreshAtStartup = startupProviderId === "codex"
      || this.hasExternalTransferConsent(startupProviderId);
    if (!models.length && mayRefreshAtStartup && typeof this.plugin?.refreshCapabilities === "function") {
      Promise.resolve().then(() => this.plugin.refreshCapabilities(startupProviderId)).catch((error) => {
        console.warn("行知能力读取失败", error);
      });
    }
  }

  async onClose() {
    await this.unifiedWorkspace?.dispose();
    this.chatWidthObserver?.disconnect();
    this.chatWidthObserver = null;
    if (this.responseClock !== null) {
      globalThis.clearInterval(this.responseClock);
      this.responseClock = null;
    }
    if (this.updateFrame !== null) {
      const cancel = globalThis.cancelAnimationFrame || clearTimeout;
      cancel(this.updateFrame);
      this.updateFrame = null;
    }
    this.invalidateMessageScrollRestore();
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    this.messageNavigationObserver?.disconnect?.();
    this.messageNavigationObserver = null;
    this.workPanelLifecycle.dispose();
    this.messageRenderGeneration += 1;
    for (const entry of this.messageNodes.values()) this.disposeMessageEntry(entry);
    this.messageNodes.clear();
    this.messageWindowStarts.clear();
    this.messageWindowScrollPositions.clear();
    this.messageRenderedCounts.clear();
    this.pendingMessageWindowScroll = null;
    this.pendingOutgoingMessages.clear();
    this.pendingThinkingTurns.clear();
    this.imagePreviewModal?.close();
    this.imagePreviewModal = null;
    this.diagramPreviewModal?.close();
    this.diagramPreviewModal = null;
    this.attachmentQueues.clear();
    this.attachmentSends.clear();
    this.releaseUnusedAttachmentPreviews();
    this.uploadedImageSources.clear();
    for (const entry of this.conversationNodes.values()) {
      entry.menuDocument?.removeEventListener("pointerdown", entry.outsidePointerdown, true);
    }
    this.destroyKnowledgeOverlays();
    this.viewDocument?.removeEventListener("keydown", this.boundKeydown);
    this.viewDocument = null;
    this.containerEl.removeClass("xz-view-host");
  }

  navigate(section) {
    if (["home", "perceive", "anchor", "test", "hone", "archive", "tune", "action-center"].includes(section)) {
      this.closeSettings(); this.closeMaintenancePanels();
      return this.unifiedWorkspace.open(section);
    }
    if (section === "settings") this.openSettings();
    else if (section === "diagnostics") this.openConnectionDiagnostics();
    else if (section === "recycle-bin") this.openRecycleBin();
    else if (section === "knowledge-health") this.openKnowledgeHealth();
    else if (section === "knowledge-structure") this.openKnowledgeStructure();
    else if (section === "user-growth") this.openUserGrowth();
    else {
      this.section = "chat";
      this.closeSettings();
      this.closeMaintenancePanels();
      this.unifiedWorkspace?.showChat();
    }
    if (this.section === "chat") this.refs.composerInput?.focus();
  }

  async render() {
    if (!this.refs.root?.isConnected) this.buildShell();
    this.renderState({ force: true });
  }

  scheduleStateRender() {
    if (this.updateFrame !== null) return;
    const schedule = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 16));
    this.updateFrame = schedule(() => {
      this.updateFrame = null;
      this.renderState();
    });
  }

  buildShell() {
    if (this.unifiedWorkspace) { void this.unifiedWorkspace.dispose(); this.unifiedWorkspace = null; }
    this.messageNavigationObserver?.disconnect?.();
    this.messageNavigationObserver = null;
    this.destroyKnowledgeOverlays();
    this.contentEl.empty();
    this.contentEl.addClass("xz-workbench", "xz-reference-ui");
    applyChatArt(this);

    const root = this.contentEl.createDiv({ cls: "xz-chat-shell" });
    this.refs.root = root;
    this.buildConversationSidebar(root);
    this.buildConversationWorkspace(root);
    const businessHost = this.refs.workspace.createEl("section", { cls: "xz-unified-page", attr: { hidden: "", "aria-label": "行知工作区" } });
    this.unifiedWorkspace = new UnifiedWorkspace(this, businessHost);
    this.buildWorkPanel(root);
    this.buildSettingsDrawer(root);
    this.buildMaintenancePanels(root);
    observeChatWidth(this);
  }

  destroyKnowledgeOverlays() {
    this.knowledgeHealthPanel?.destroy?.();
    this.knowledgeStructurePanel?.destroy?.();
    this.userGrowthPanel?.destroy?.();
    this.knowledgeHealthPanel = null;
    this.knowledgeStructurePanel = null;
    this.userGrowthPanel = null;
  }

  buildConversationSidebar(root) {
    const sidebar = root.createEl("aside", {
      cls: "xz-conversation-sidebar",
      attr: { "aria-label": "对话历史与功能入口" },
    });
    this.refs.sidebar = sidebar;

    this.refs.historyClose = createIconButton(sidebar, "x", "关闭对话历史", () => {
      this.historyOpen = false;
      this.syncResponsiveState();
      this.refs.historyToggle?.focus();
    }, "xz-icon-button xz-history-close");

    const brand = sidebar.createDiv({ cls: "xz-brand" });
    const mark = brand.createDiv({ cls: "xz-brand-mark", attr: { "aria-hidden": "true" } });
    let brandAssetUrl = "";
    try {
      brandAssetUrl = this.plugin?.getBrandAssetUrl?.() || "";
    } catch (_error) {
      brandAssetUrl = "";
    }
    if (brandAssetUrl) {
      const brandImage = mark.createEl("img", {
        cls: "xz-brand-image",
        attr: { src: brandAssetUrl, alt: "", draggable: "false" },
      });
      brandImage.addEventListener("error", () => {
        if (!brandImage.isConnected) return;
        brandImage.remove();
        setIcon(mark, brandMarkIcon(this.plugin));
      }, { once: true });
    } else {
      setIcon(mark, brandMarkIcon(this.plugin));
    }

    const copy = brand.createDiv({ cls: "xz-brand-copy" });
    const brandTitle = copy.createDiv({ cls: "xz-brand-title" });
    brandTitle.createEl("strong", { text: "行知" });
    brandTitle.createSpan({ text: "XINGZHI" });
    copy.createDiv({
      cls: "xz-brand-line xz-brand-line-primary",
      text: "行而知真，以真破妄。",
    });
    copy.createDiv({
      cls: "xz-brand-line",
      text: "知世而不随世，知己而不困己。",
    });
    copy.createDiv({
      cls: "xz-brand-line",
      text: "世界可以给你答案，人生由你决定。",
    });

    buildChatNavigation(sidebar, this);
    const newButton = sidebar.createEl("button", {
      cls: "xz-new-conversation",
      attr: { type: "button" },
    });
    this.refs.newConversation = newButton;
    setButtonIcon(newButton, "square-pen", "新对话");
    newButton.disabled = typeof this.plugin?.createConversation !== "function";
    newButton.addEventListener("click", () => this.createConversation());

    this.refs.historySearch = sidebar.createEl("input", {
      cls: "xz-history-search",
      attr: { type: "search", placeholder: "搜索对话、附件或来源", "aria-label": "搜索对话、附件或来源" },
    });
    this.refs.historySearch.addEventListener("input", () => {
      this.historyQuery = this.refs.historySearch.value.trim();
      this.lastConversationSignature = "";
      this.renderConversationHistory({ force: true });
    });

    const heading = sidebar.createDiv({ cls: "xz-sidebar-heading" });
    heading.createEl("span", { text: "对话历史" });
    const archiveToggle = heading.createEl("button", {
      cls: "xz-sidebar-archive-toggle",
      text: "归档",
      attr: { type: "button", "aria-pressed": "false", title: "显示归档对话" },
    });
    this.refs.archiveToggle = archiveToggle;
    archiveToggle.addEventListener("click", () => {
      this.showArchived = !this.showArchived;
      archiveToggle.setAttr("aria-pressed", this.showArchived ? "true" : "false");
      archiveToggle.setText(this.showArchived ? "返回" : "归档");
      this.lastConversationSignature = "";
      this.renderConversationHistory({ force: true });
    });

    this.refs.conversationList = sidebar.createDiv({
      cls: "xz-conversation-list",
      attr: { role: "list", "aria-label": "历史对话" },
    });

    const maintenance = sidebar.createEl("details", {
      cls: "xz-sidebar-maintenance",
      attr: { "aria-labelledby": "xz-system-tools-title" },
    });
    this.refs.systemTools = maintenance;
    const maintenanceHead = maintenance.createEl("summary", {
      cls: "xz-sidebar-maintenance-head",
      attr: {
        "aria-label": "展开系统工具，3 个工具入口",
        "aria-expanded": "false",
        title: "展开系统工具",
      },
    });
    const maintenanceCopy = maintenanceHead.createSpan({ cls: "xz-sidebar-maintenance-copy" });
    maintenanceCopy.createSpan({
      cls: "xz-sidebar-maintenance-title",
      text: "系统工具",
      attr: { id: "xz-system-tools-title" },
    });
    maintenanceCopy.createSpan({ cls: "xz-sidebar-maintenance-count", text: "3 个入口" });
    const maintenanceMeta = maintenanceHead.createSpan({ cls: "xz-sidebar-maintenance-meta" });
    maintenanceMeta.createSpan({
      cls: "xz-sidebar-version",
      text: `v${this.plugin?.manifest?.version || "开发版"}`,
      attr: { title: "当前实际加载的插件版本" },
    });
    const maintenanceChevron = maintenanceMeta.createSpan({
      cls: "xz-sidebar-maintenance-chevron",
      attr: { "aria-hidden": "true" },
    });
    setIcon(maintenanceChevron, "chevron-right");
    maintenance.addEventListener("toggle", () => {
      const expanded = maintenance.open === true;
      maintenanceHead.setAttr("aria-expanded", expanded ? "true" : "false");
      maintenanceHead.setAttr("aria-label", `${expanded ? "收起" : "展开"}系统工具，3 个工具入口`);
      maintenanceHead.setAttr("title", `${expanded ? "收起" : "展开"}系统工具`);
    });
    const maintenanceTools = maintenance.createDiv({ cls: "xz-sidebar-maintenance-tools" });

    const createToolButton = ({ icon, title, description, buttonTitle, parent = maintenanceTools }) => {
      const button = parent.createEl("button", {
        cls: "xz-sidebar-tool",
        attr: { type: "button", title: buttonTitle, "aria-label": `${title}：${description}` },
      });
      const iconEl = button.createSpan({ cls: "xz-sidebar-tool-icon", attr: { "aria-hidden": "true" } });
      setIcon(iconEl, icon);
      const toolCopy = button.createSpan({ cls: "xz-sidebar-tool-copy" });
      toolCopy.createSpan({ cls: "xz-sidebar-tool-title", text: title });
      toolCopy.createSpan({ cls: "xz-sidebar-tool-description", text: description });
      const meta = button.createSpan({ cls: "xz-sidebar-tool-meta", attr: { "aria-hidden": "true" } });
      setIcon(meta, "chevron-right");
      return { button, meta };
    };

    this.refs.sidebarSettingsButton = createToolButton({
      icon: "settings-2",
      title: "设置",
      description: "调整连接、资料范围与工作方式",
      buttonTitle: "打开工作台设置",
    }).button;
    this.refs.sidebarSettingsButton.addEventListener("click", () => this.openSettings());
    this.refs.diagnosticsButton = createToolButton({
      icon: "activity",
      title: "连接诊断",
      description: "检查 Codex 与 API 连接",
      buttonTitle: "打开连接诊断",
    }).button;
    this.refs.diagnosticsButton.addEventListener("click", () => this.openConnectionDiagnostics());
    const recycleTool = createToolButton({
      icon: "archive-restore",
      title: "回收站",
      description: "恢复或永久删除对话",
      buttonTitle: "打开删除对话回收站",
    });
    this.refs.recycleButton = recycleTool.button;
    recycleTool.meta.empty();
    this.refs.recycleCount = recycleTool.meta.createSpan({ cls: "xz-sidebar-count", text: "0" });
    const recycleChevron = recycleTool.meta.createSpan({ cls: "xz-sidebar-tool-chevron", attr: { "aria-hidden": "true" } });
    setIcon(recycleChevron, "chevron-right");
    this.refs.recycleButton.addEventListener("click", () => this.openRecycleBin());

    const foot = sidebar.createDiv({ cls: "xz-sidebar-foot" });
    const local = foot.createDiv({ cls: "xz-local-badge" });
    const dot = local.createSpan({ cls: "xz-local-dot", attr: { "aria-hidden": "true" } });
    dot.setText(" ");
    const localCopy = local.createDiv();
    localCopy.createEl("strong", { text: "本地知识库" });
    localCopy.createEl("span", { text: "写入有来源，可撤销" });
  }

  buildConversationWorkspace(root) {
    const workspace = root.createEl("section", { cls: "xz-conversation-workspace" });
    this.refs.workspace = workspace;

    const header = workspace.createEl("header", { cls: "xz-conversation-header" });
    this.refs.historyToggle = createIconButton(
      header,
      "panel-left",
      "打开对话历史",
      () => this.toggleHistoryPanel(),
      "xz-icon-button xz-history-toggle",
    );

    const topic = header.createDiv({ cls: "xz-topic" });
    const topicTitleRow = topic.createDiv({ cls: "xz-topic-title-row" });
    this.refs.topicTitle = topicTitleRow.createEl("h1", { text: "新对话" });
    const contextDetails = header.createEl("details", { cls: "xz-conversation-context" });
    this.refs.contextDetails = contextDetails;
    const contextSummary = contextDetails.createEl("summary", {
      attr: { "aria-label": "对话信息", title: "任务说明与上下文信息" },
    });
    setIcon(contextSummary, "info");
    const contextPopover = contextDetails.createDiv({ cls: "xz-conversation-context-popover" });
    this.refs.topicBadges = contextPopover.createDiv({ cls: "xz-topic-badges", attr: { "aria-label": "任务类型与资料范围" } });
    this.refs.topicMeta = contextPopover.createEl("p", { text: "回复只回答当前请求；知识沉淀与整理按你的开关在后台执行" });
    this.refs.contextStatus = contextPopover.createEl("p", {
      cls: "xz-context-status",
      text: "上下文容量：正在计算",
    });
    contextDetails.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      contextDetails.removeAttribute("open");
      contextSummary.focus({ preventScroll: true });
      event.preventDefault();
      event.stopPropagation();
    });
    contextDetails.addEventListener("focusout", (event) => {
      if (event.relatedTarget && !contextDetails.contains(event.relatedTarget)) contextDetails.removeAttribute("open");
    });

    const headerActions = header.createDiv({ cls: "xz-header-actions" });
    this.refs.connectionButton = headerActions.createEl("button", {
      cls: "xz-connection-pill is-checking",
      attr: { type: "button", title: "查看连接诊断" },
    });
    this.refs.connectionDot = this.refs.connectionButton.createSpan({ cls: "xz-connection-dot", attr: { "aria-hidden": "true" } });
    this.refs.connectionText = this.refs.connectionButton.createSpan({ text: "正在连接" });
    this.refs.connectionButton.addEventListener("click", () => this.openConnectionDiagnostics());
    this.refs.connectionButton.disabled = typeof this.plugin?.getConnectionDiagnostics !== "function";

    this.refs.workToggle = createIconButton(
      header,
      "panel-right",
      "打开本轮工作",
      () => this.toggleWorkPanel(),
      "xz-icon-button xz-work-toggle",
    );
    this.refs.workResultCount = this.refs.workToggle.createSpan({
      cls: "xz-work-result-count",
      text: "0",
      attr: { "aria-hidden": "true", hidden: "" },
    });
    this.refs.settingsButton = createIconButton(
      header,
      "settings-2",
      "打开连接设置",
      () => this.openSettings(),
    );

    const messageStage = workspace.createDiv({ cls: "xz-message-stage" });
    this.refs.messageStage = messageStage;
    const scroll = messageStage.createDiv({
      cls: "xz-message-scroll",
      attr: { role: "log", tabindex: "0", "aria-label": "行知对话", "aria-live": "off" },
    });
    this.refs.messageScroll = scroll;
    const messageWindowNav = scroll.createDiv({
      cls: "xz-message-window-nav",
      attr: { hidden: "", role: "group", "aria-label": "浏览历史消息" },
    });
    this.refs.messageWindowNav = messageWindowNav;
    this.refs.messageWindowOlder = messageWindowNav.createEl("button", {
      cls: "xz-message-window-button xz-message-window-older",
      text: "较早",
      attr: { type: "button", "aria-label": "加载较早消息" },
    });
    this.refs.messageWindowOlder.addEventListener("click", () => this.navigateMessageWindow("older"));
    this.refs.messageWindowSummary = messageWindowNav.createSpan({
      cls: "xz-message-window-summary",
      attr: { "aria-live": "polite" },
    });
    this.refs.messageWindowNewer = messageWindowNav.createEl("button", {
      cls: "xz-message-window-button xz-message-window-newer",
      text: "较新",
      attr: { type: "button", "aria-label": "加载较新消息" },
    });
    this.refs.messageWindowNewer.addEventListener("click", () => this.navigateMessageWindow("newer"));
    this.refs.messageWindowLatest = messageWindowNav.createEl("button", {
      cls: "xz-message-window-button xz-message-window-latest",
      text: "回到最新",
      attr: { type: "button", "aria-label": "回到最新消息" },
    });
    this.refs.messageWindowLatest.addEventListener("click", () => this.scrollConversationToBottom());
    this.refs.welcome = this.createWelcome(scroll);
    this.refs.messageList = scroll.createDiv({ cls: "xz-message-list" });
    this.refs.interactiveCards = scroll.createDiv({ cls: "xz-interactive-cards" });
    this.refs.streaming = this.createStreamingNode(scroll);

    this.refs.messageLocator = messageStage.createEl("nav", {
      cls: "xz-message-locator",
      attr: { "aria-label": "对话内容定位", hidden: "" },
    });
    this.refs.scrollToBottom = createIconButton(
      messageStage,
      "arrow-down",
      "跳到最新内容",
      () => this.scrollConversationToBottom(),
      "xz-scroll-to-bottom",
    );
    this.refs.scrollToBottom.setAttr("hidden", "");
    scroll.addEventListener("scroll", () => {
      this.rememberMessagePageScroll();
      this.updateMessageScrollFollowState();
      this.updateConversationNavigation();
    }, { passive: true });
    const markMessageScrollIntent = () => this.markMessageScrollIntent();
    scroll.addEventListener("wheel", markMessageScrollIntent, { passive: true });
    scroll.addEventListener("touchmove", markMessageScrollIntent, { passive: true });
    scroll.addEventListener("keydown", (event) => {
      if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
      if (!scroll.contains?.(event.target) || event.isComposing || event.defaultPrevented) return;
      if (event.target?.closest?.("button, a, input, textarea, select, [contenteditable='true']")) return;
      markMessageScrollIntent();
    });
    scroll.addEventListener("pointerdown", (event) => {
      if (event.target !== scroll) return;
      const bounds = scroll.getBoundingClientRect?.();
      if (!bounds) return;
      const gutter = Math.max(12, Number(scroll.offsetWidth || 0) - Number(scroll.clientWidth || 0));
      if (event.clientX >= bounds.right - gutter) markMessageScrollIntent();
    }, { passive: true });
    if (typeof globalThis.ResizeObserver === "function") {
      this.messageNavigationObserver = new globalThis.ResizeObserver(() => {
        this.updateConversationNavigation({ updateLayout: true });
      });
      this.messageNavigationObserver.observe(scroll);
      this.messageNavigationObserver.observe(this.refs.messageList);
    }

    this.buildComposer(workspace);
  }

  createWelcome(parent) {
    const welcome = parent.createEl("section", { cls: "xz-welcome", attr: { "aria-labelledby": "xz-welcome-title" } });
    const glyph = welcome.createDiv({ cls: "xz-welcome-glyph", attr: { "aria-hidden": "true" } });
    setIcon(glyph, "sparkles");
    welcome.createEl("h2", { text: "从一次真实对话开始", attr: { id: "xz-welcome-title" } });
    welcome.createEl("p", {
      text: "你只需要讲清楚正在发生什么。行知会读取相关资料、追问缺口，并把可确认的信息整理到知识库。",
    });
    const examples = welcome.createDiv({ cls: "xz-prompt-examples" });
    [
      ["观境", "基于当前资料，帮我分析眼前这个问题"],
      ["观境", "这个决定里，我忽略了哪些关键事实？"],
      ["知变", "把今天的行动和结果整理进知识库"],
    ].forEach(([tag, text]) => {
      const button = examples.createEl("button", { attr: { type: "button" } });
      button.createEl("em", { cls: "xz-prompt-tag", text: tag });
      button.createSpan({ cls: "xz-prompt-text", text });
      button.addEventListener("click", () => {
        this.setComposerDraft(text, { focus: true });
      });
    });
    return welcome;
  }

  createStreamingNode(parent) {
    const article = parent.createEl("article", {
      cls: "xz-message xz-message-assistant xz-streaming-message",
      attr: { hidden: "", "aria-live": "polite", "aria-label": "行知正在回复" },
    });
    const avatar = article.createDiv({ cls: "xz-message-avatar", attr: { "aria-hidden": "true" } });
    renderBrandAvatar(avatar, this.plugin);
    const body = article.createDiv({ cls: "xz-message-body" });
    const meta = body.createDiv({ cls: "xz-message-meta" });
    meta.createEl("strong", { text: "行知" });
    const live = meta.createSpan({ cls: "xz-live-label" });
    live.createSpan({ cls: "xz-live-dot", attr: { "aria-hidden": "true" } });
    this.refs.streamingStatus = live.createSpan({ text: "正在思考" });
    this.refs.streamingTiming = body.createDiv({
      cls: "xz-live-stage-timing",
      attr: { "aria-live": "off" },
    });
    this.refs.streamingText = body.createDiv({ cls: "xz-message-text" });
    const chatImage = body.createDiv({
      cls: "xz-chat-image",
      attr: { hidden: "", role: "group", "aria-label": "本条回复中的图片生成状态" },
    });
    this.refs.streamingChatImageEntry = {
      chatImage,
      chatImageSignature: "",
    };
    return article;
  }

  buildComposer(workspace) {
    const composer = workspace.createEl("footer", { cls: "xz-composer-area" });
    this.refs.composer = composer;

    const contextBar = composer.createDiv({
      cls: "xz-composer-context-bar",
      attr: { "aria-label": "本轮已启用状态", hidden: "" },
    });
    this.refs.composerContextBar = contextBar;
    this.refs.composerModeChips = contextBar.createDiv({ cls: "xz-composer-mode-chips" });
    this.refs.composerContextEmpty = contextBar.createSpan({
      cls: "xz-composer-context-empty",
      text: "默认模式 · 自动选择所需能力",
    });

    // 模型与能力默认收起；同一个开关放入输入区操作行，避免额外占用阅读高度。
    const ctxLine = composer.createDiv({ cls: "xz-composer-ctxline" });
    const ctxDefault = ctxLine.createSpan({ cls: "xz-ctxline-default" });
    ctxDefault.createSpan({ cls: "xz-ctxline-mode", text: "默认模式" });
    ctxDefault.createSpan({ cls: "xz-ctxline-note", text: "自动选择所需能力" });
    const runtimeToggle = ctxLine.createEl("button", {
      cls: "xz-runtime-toggle",
      attr: { type: "button", "aria-expanded": "false", title: "展开大模型与能力选择" },
    });
    runtimeToggle.createSpan({ text: "大模型与能力" });
    const runtimeToggleIcon = runtimeToggle.createSpan({ cls: "xz-runtime-toggle-icon", attr: { "aria-hidden": "true" } });
    setIcon(runtimeToggleIcon, "chevron-down");
    this.refs.runtimeToggle = runtimeToggle;
    const applyRuntimeOpen = (open) => {
      composer.toggleClass("is-runtime-open", open);
      runtimeToggle.setAttribute("aria-expanded", open ? "true" : "false");
      runtimeToggle.setAttribute("title", open ? "收起大模型与能力选择" : "展开大模型与能力选择");
    };
    applyRuntimeOpen(Boolean(this.runtimeRowOpen));
    runtimeToggle.addEventListener("click", () => {
      this.runtimeRowOpen = !this.runtimeRowOpen;
      applyRuntimeOpen(this.runtimeRowOpen);
    });

    const runtimeRow = composer.createDiv({
      cls: "xz-composer-runtime-row",
      attr: { "aria-label": "模型与能力配置" },
    });
    this.refs.composerRuntimeRow = runtimeRow;

    const controls = runtimeRow.createDiv({
      cls: "xz-runtime-controls xz-technical-runtime-controls",
      attr: { "aria-label": "能力配置" },
    });
    this.refs.runtimeControls = controls;
    controls.createSpan({ cls: "xz-runtime-group-label", text: "能力配置" });
    const routingPanel = controls.createDiv({
      cls: "xz-routing-controls-panel",
      attr: { "aria-label": "Agent、Skill 与透镜配置" },
    });
    this.refs.agentModeSelect = this.createCompactSelect(routingPanel, "Agent 模式", "route");
    this.refs.agentSelect = this.createCompactSelect(routingPanel, "智能体", "bot");
    this.refs.skillPicker = this.createCapabilityPicker(routingPanel, "skill");
    this.refs.lensPicker = this.createCapabilityPicker(routingPanel, "lens");
    this.refs.capabilityManagerButton = createIconButton(
      routingPanel,
      "blocks",
      "打开 Agent、Skill、透镜与受控工具管理",
      () => this.openCapabilityManager(),
    );
    this.refs.capabilityManagerButton.addClass("xz-capability-manager-trigger");

    this.refs.agentModeSelect.addEventListener("change", () => {
      const agentMode = this.refs.agentModeSelect.value;
      const patch = { agentMode };
      if (agentMode === "locked" && this.refs.agentSelect.value) patch.agentId = this.refs.agentSelect.value;
      void this.updateSettings(patch).catch(() => {});
    });
    this.refs.agentSelect.addEventListener("change", () => {
      const agentId = this.refs.agentSelect.value;
      void this.updateSettings({ agentId, agentMode: "locked" }).catch(() => {});
    });

    const tray = composer.createEl("section", {
      cls: "xz-attachment-tray",
      attr: { hidden: "", "aria-label": "附件待处理区", "aria-live": "polite" },
    });
    this.refs.attachmentTray = tray;
    const trayHeader = tray.createDiv({ cls: "xz-attachment-tray-header" });
    const trayCopy = trayHeader.createDiv({ cls: "xz-attachment-tray-copy" });
    trayCopy.createEl("strong", { text: "附件待处理区" });
    this.refs.attachmentSummary = trayCopy.createEl("span", { text: "尚未添加附件" });
    const purposeWrap = trayHeader.createEl("label", { cls: "xz-attachment-purpose" });
    this.refs.attachmentPurposeWrap = purposeWrap;
    purposeWrap.createSpan({ text: "处理方式" });
    this.refs.attachmentPurpose = purposeWrap.createEl("select", { attr: { "aria-label": "附件处理方式" } });
    [
      ["conversation", "用于本轮对话"],
      ["reference", "仅存入资料库"],
      ["knowledge", "整理入知识库"],
      ["compare", "对比这些文件"],
    ].forEach(([value, label]) => this.refs.attachmentPurpose.createEl("option", { value, text: label }));
    this.refs.attachmentPurpose.addEventListener("change", () => {
      const conversationId = normalizeId(this.getActiveConversation());
      if (conversationId) {
        this.attachmentPurposes.set(
          conversationId,
          normalizeAttachmentPurpose(this.refs.attachmentPurpose.value),
        );
      }
      this.syncSendControls();
    });
    this.refs.clearAttachments = createIconButton(
      trayHeader,
      "trash-2",
      "移除全部待处理附件",
      () => this.clearAttachments(),
      "xz-attachment-clear",
    );
    this.refs.attachmentList = tray.createDiv({ cls: "xz-attachment-list", attr: { role: "list" } });

    const modelControls = runtimeRow.createDiv({
      cls: "xz-composer-model-controls",
      attr: { role: "group", "aria-label": "大模型" },
    });
    this.refs.modelControls = modelControls;
    modelControls.createSpan({ cls: "xz-runtime-group-label", text: "大模型" });
    this.refs.providerSelect = this.createCompactSelect(modelControls, "提供商", "cloud", "is-provider");
    this.refs.modelSelect = this.createCompactSelect(modelControls, "模型", "cpu");
    this.refs.reasoningProfileSelect = this.createCompactSelect(modelControls, "思考档位", "brain", "is-reasoning-profile");
    this.refs.reasoningProfileSelect.addEventListener("change", () => {
      const conversation = this.getActiveConversation();
      const conversationId = normalizeId(conversation);
      const profile = normalizeReasoningProfile(this.refs.reasoningProfileSelect.value);
      const description = PROFILE_OPTIONS.find((item) => item.id === profile)?.description || "";
      this.refs.reasoningProfileSelect.title = `思考档位：${profileLabel(profile)}。${description}；仅控制推理投入，不控制回答长度。`;
      if (typeof this.plugin?.setConversationReasoningProfile !== "function") {
        new Notice("当前插件版本不支持保存思考档位");
        return;
      }
      void this.plugin.setConversationReasoningProfile(conversationId, profile)
        .then(() => new Notice(`本对话思考档位已设为：${profileLabel(profile)}`))
        .catch((error) => {
          new Notice(`思考档位未保存：${firstText(error?.message, error)}`);
          this.renderRuntimeControls({ force: true });
        });
    });
    this.refs.providerSelect.addEventListener("change", async () => {
      const providerId = this.refs.providerSelect.value;
      try {
        await this.updateSettings({ providerId, model: null });
        await this.refreshCapabilities(null, providerId);
      } catch (_) {
        // updateSettings and refreshCapabilities already surface bounded Notices.
      }
    });
    this.refs.modelSelect.addEventListener("change", () => {
      void this.updateSettings({ model: this.refs.modelSelect.value }).catch(() => {});
    });
    // Keep model and capability controls together immediately above the input.
    runtimeRow.prepend(modelControls);

    const box = composer.createDiv({ cls: "xz-composer-box" });
    this.refs.composerInput = box.createEl("textarea", {
      attr: {
        rows: "1",
        placeholder: "告诉行知正在发生什么，或直接交代一个任务…",
        "aria-label": "发送给行知的消息",
      },
    });
    this.refs.composerInput.addEventListener("input", () => {
      this.draft = this.refs.composerInput.value;
      this.resizeComposer();
      this.renderComposerPresentation();
      this.syncSendControls();
    });
    this.refs.composerInput.addEventListener("paste", (event) => this.stagePastedDocuments(event));
    this.refs.composerInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      void this.sendCurrentDraft();
    });

    const composerActions = box.createDiv({ cls: "xz-composer-actions" });
    this.refs.fileInput = composerActions.createEl("input", {
      cls: "xz-file-input",
      attr: {
        type: "file",
        multiple: "",
        accept: ".txt,.md,.csv,.tsv,.json,.yaml,.yml,.html,.htm,.pdf,.docx,.docm,.dotx,.dotm,.xlsx,.xlsm,.xltx,.xltm,.png,.jpg,.jpeg,.webp,.gif",
        "aria-label": "选择要上传并整理的文件或图片",
      },
    });
    this.refs.fileInput.addEventListener("change", () => this.stageSelectedDocuments());
    this.refs.uploadButton = composerActions.createEl("button", {
      cls: "xz-upload-button",
      attr: {
        type: "button",
        "aria-label": "选择要添加的文件或图片，也可以在输入框直接粘贴",
        title: "添加文件；也可在输入框直接粘贴图片或文档",
      },
    });
    setButtonIcon(this.refs.uploadButton, "paperclip", "添加文件");
    this.refs.uploadButton.addEventListener("click", () => this.refs.fileInput.click());
    this.refs.questionThinkingButton = composerActions.createEl("button", {
      cls: "xz-upload-button xz-question-thinking-button",
      attr: { type: "button", "aria-label": "请求动态展开思考", title: "先理解已有思考，再展开尚未想到的视角与可能性" },
    });
    setButtonIcon(this.refs.questionThinkingButton, "lightbulb", "补充思考");
    this.refs.questionThinkingButton.addEventListener("click", () => {
      void this.prepareQuestionThinking().catch((error) => new Notice(`补充思考未完成：${firstText(error?.message, error)}`));
    });
    this.refs.sourceScopeSelect = composerActions.createEl("select", {
      cls: "xz-source-scope-select",
      attr: { "aria-label": "本轮资料范围", title: "本轮资料范围" },
    });
    this.refs.sourceScopeSelect.createEl("option", { value: "local-web", text: "范围：本地 + 全网" });
    this.refs.sourceScopeSelect.createEl("option", { value: "local", text: "范围：仅本地" });
    this.refs.sourceScopeSelect.addEventListener("change", () => {
      void this.updateSettings({ networkAccess: this.refs.sourceScopeSelect.value === "local-web" }).catch(() => {});
    });
    composerActions.appendChild(runtimeToggle);
    const helper = composerActions.createSpan({ text: "Enter 发送 · Shift+Enter 换行" });
    helper.addClass("xz-composer-helper");
    this.refs.composerHelper = helper;
    this.refs.stopButton = composerActions.createEl("button", {
      cls: "xz-stop-button",
      attr: { type: "button", hidden: "", "aria-label": "停止当前回复" },
    });
    setButtonIcon(this.refs.stopButton, "square", "停止");
    this.refs.stopButton.addEventListener("click", () => this.stopTurn());
    this.refs.sendButton = composerActions.createEl("button", {
      cls: "xz-send-button",
      attr: { type: "button", "aria-label": "发送消息" },
    });
    setButtonIcon(this.refs.sendButton, "arrow-up", "发送");
    this.refs.sendButton.addEventListener("click", () => this.sendCurrentDraft());
  }

  createCompactSelect(parent, label, icon, extraClass = "") {
    const wrap = parent.createDiv({
      cls: extraClass ? `xz-compact-select ${extraClass}` : "xz-compact-select",
    });
    const glyph = wrap.createSpan({ cls: "xz-control-icon", attr: { "aria-hidden": "true" } });
    setIcon(glyph, icon);
    const select = wrap.createEl("select", { attr: { "aria-label": label, title: label } });
    return select;
  }

  createCapabilityPicker(parent, category) {
    const lens = category === "lens";
    const label = lens ? "透镜" : "Skill";
    const button = parent.createEl("button", {
      cls: `xz-skill-picker-trigger${lens ? " xz-lens-picker-trigger" : ""}`,
      attr: {
        type: "button",
        "aria-label": `选择${label}`,
        title: `选择${label}`,
      },
    });
    this.refs[lens ? "lensPickerSummary" : "skillPickerSummary"] = button;
    const glyph = button.createSpan({ cls: "xz-control-icon", attr: { "aria-hidden": "true" } });
    setIcon(glyph, lens ? "eye" : "wand-sparkles");
    this.refs[lens ? "lensSummaryText" : "skillSummaryText"] = button.createSpan({
      cls: "xz-skill-summary", text: `${label}：自动选择`,
    });
    button.addEventListener("click", () => this.openSkillPicker(category));
    return button;
  }

  buildWorkPanel(root) {
    const panel = root.createEl("aside", {
      cls: "xz-work-panel",
      attr: { "aria-label": "本轮工作" },
    });
    this.refs.workPanel = panel;
    const header = panel.createDiv({ cls: "xz-work-panel-header" });
    const copy = header.createDiv();
    copy.createEl("span", { cls: "xz-eyebrow", text: "执行过程" });
    copy.createEl("h2", { text: "本轮工作" });
    createIconButton(header, "x", "收起本轮工作", () => this.toggleWorkPanel());
    this.refs.workPanelBody = panel.createDiv({ cls: "xz-work-panel-body" });
  }

  buildSettingsDrawer(root) {
    const scrim = root.createDiv({ cls: "xz-settings-scrim", attr: { hidden: "" } });
    scrim.addEventListener("click", () => this.closeSettings());
    this.refs.settingsScrim = scrim;

    const drawer = root.createEl("aside", {
      cls: "xz-settings-drawer",
      attr: {
        hidden: "",
        role: "dialog",
        "aria-modal": "false",
        "aria-labelledby": "xz-settings-title",
      },
    });
    this.refs.settingsDrawer = drawer;
    const header = drawer.createDiv({ cls: "xz-settings-header" });
    const copy = header.createDiv();
    copy.createEl("span", { cls: "xz-eyebrow", text: "执行与连接" });
    copy.createEl("h2", { text: "设置", attr: { id: "xz-settings-title" } });
    this.refs.settingsClose = createIconButton(header, "x", "关闭设置", () => this.closeSettings());
    this.refs.settingsBody = drawer.createDiv({ cls: "xz-settings-body" });
  }

  buildMaintenancePanels(root) {
    this.connectionDiagnosticsPanel = new ConnectionDiagnosticsPanel({
      root,
      plugin: this.plugin,
      onClose: () => this.refs.diagnosticsButton?.focus(),
    });
    this.recycleBinPanel = new RecycleBinPanel({
      root,
      plugin: this.plugin,
      onClose: () => this.refs.recycleButton?.focus(),
      onRestored: () => {
        this.recycleBinPanel.close();
        this.lastConversationSignature = "";
        this.renderState({ force: true });
      },
      onPermanentlyDeleted: () => this.renderState({ force: true }),
      confirm: (options) => new XingzhiConfirmationModal(this.app, options).waitForConfirmation(),
    });
    this.knowledgeHealthPanel = new KnowledgeHealthPanel({
      root,
      plugin: this.plugin,
      onClose: () => this.refs.healthButton?.focus(),
      confirm: (options) => new XingzhiConfirmationModal(this.app, options).waitForConfirmation(),
    });
    this.knowledgeStructurePanel = new KnowledgeStructurePanel({
      root,
      plugin: this.plugin,
      onClose: () => this.refs.structureButton?.focus(),
      confirm: (options) => new XingzhiConfirmationModal(this.app, options).waitForConfirmation(),
    });
    this.userGrowthPanel = new UserGrowthPanel({
      root,
      plugin: this.plugin,
      onClose: () => this.refs.growthButton?.focus(),
    });
  }

  renderState({ force = false } = {}) {
    if (!this.refs.root) return;
    this.renderPrimaryNavigation();
    this.renderConversationHistory({ force });
    if (!this.unifiedWorkspace || this.unifiedWorkspace.page === "chat") {
      this.renderConversationHeader();
      this.renderMessages({ force });
      this.renderInteractiveCards({ force });
      this.renderStreamingTurn();
    }
    this.renderRuntimeControls({ force });
    this.renderComposerPresentation();
    this.renderAttachmentQueue();
    this.renderWorkPanel({ force });
    this.syncSendControls();
    this.syncWorkPanelLifecycle();
    this.syncResponsiveState();
    if (this.settingsOpen && force) this.renderSettings();
    this.connectionDiagnosticsPanel?.render();
    this.recycleBinPanel?.render();
    this.knowledgeHealthPanel?.render();
    this.knowledgeStructurePanel?.render();
    this.userGrowthPanel?.render();
    const deletedCount = typeof this.plugin?.listDeletedConversations === "function"
      ? this.plugin.listDeletedConversations().length
      : 0;
    this.refs.recycleCount?.setText(String(deletedCount));
    this.refs.recycleButton?.setAttr("aria-label", `打开删除对话回收站，${deletedCount} 个对话`);
  }

  renderPrimaryNavigation() {
    // 旧版左栏没有常驻一级导航；保留空钩子以兼容现有面板切换流程。
  }

  getConversations() {
    const query = String(this.historyQuery || "").trim().toLocaleLowerCase("zh-CN");
    return asArray(this.plugin?.state?.conversations)
      .filter((item) => item && !item.deletedAt && (
        this.showArchived ? Boolean(item.archivedAt) : !item.archivedAt
      ))
      .filter((item) => {
        if (!query) return true;
        const searchable = [
          normalizeLabel(item, "新对话"),
          firstText(item.summary),
          ...visibleConversationMessages(asArray(item.messages)).flatMap((message) => [
            messageText(message),
            ...asArray(message.references).flatMap((reference) => [reference?.label, reference?.path]),
          ]),
        ].filter(Boolean).join("\n").toLocaleLowerCase("zh-CN");
        return searchable.includes(query);
      })
      .sort((a, b) => {
        const pinned = Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt));
        if (pinned) return pinned;
        return Date.parse(b.updatedAt || b.mtime || b.createdAt || 0)
          - Date.parse(a.updatedAt || a.mtime || a.createdAt || 0);
      });
  }

  getActiveConversation() {
    const conversations = this.getConversations();
    const activeId = firstText(this.plugin?.state?.activeConversationId);
    return conversations.find((item) => normalizeId(item) === activeId)
      || asArray(this.plugin?.state?.conversations).find((item) => normalizeId(item) === activeId && !item.deletedAt)
      || conversations[0] || null;
  }

  turnForConversation(conversationId = normalizeId(this.getActiveConversation())) {
    const runtime = this.plugin?.state?.runtime || {};
    return runtime.activeTurns?.[conversationId]
      || (runtime.activeTurn?.conversationId === conversationId ? runtime.activeTurn : null);
  }

  workPanelForConversation(conversationId = normalizeId(this.getActiveConversation())) {
    const runtime = this.plugin?.state?.runtime || {};
    return runtime.workPanels?.[conversationId]
      || (runtime.workPanel?.conversationId === conversationId ? runtime.workPanel : {});
  }

  backgroundWorkPanelForConversation(conversationId = normalizeId(this.getActiveConversation())) {
    const runtime = this.plugin?.state?.runtime || {};
    return runtime.backgroundWorkPanels?.[conversationId]
      || (runtime.backgroundWorkPanel?.conversationId === conversationId
        ? runtime.backgroundWorkPanel : {});
  }

  pendingAgentForConversation(conversationId = normalizeId(this.getActiveConversation())) {
    const runtime = this.plugin?.state?.runtime || {};
    return runtime.pendingAgentRecommendations?.[conversationId]
      || (runtime.pendingAgentRecommendation?.conversationId === conversationId
        ? runtime.pendingAgentRecommendation : null);
  }

  pendingSkillForConversation(conversationId = normalizeId(this.getActiveConversation())) {
    const runtime = this.plugin?.state?.runtime || {};
    return runtime.pendingSkillRecommendations?.[conversationId]
      || (runtime.pendingSkillRecommendation?.conversationId === conversationId
        ? runtime.pendingSkillRecommendation : null);
  }

  renderConversationHistory({ force = false } = {}) {
    const conversations = this.getConversations();
    const activeId = normalizeId(this.getActiveConversation());
    const conversationsById = new Map(conversations.map((conversation) => [normalizeId(conversation), conversation]));
    const turnIsVisiblyRunning = (turn) => {
      if (!["running", "in_progress", "streaming", "starting", "waiting", "waiting_approval"]
        .includes(firstText(turn?.status).toLowerCase())) return false;
      const conversation = conversationsById.get(firstText(turn?.conversationId));
      if (!conversation) return false;
      return !isInternalTurn(asArray(conversation?.messages), turn?.assistantMessageId);
    };
    const runningConversationIds = new Set(Object.values(this.plugin?.state?.runtime?.activeTurns || {})
      .filter(turnIsVisiblyRunning)
      .map((turn) => firstText(turn?.conversationId))
      .filter(Boolean));
    const projectedTurn = this.plugin?.state?.runtime?.activeTurn;
    if (turnIsVisiblyRunning(projectedTurn) && projectedTurn?.conversationId) {
      runningConversationIds.add(String(projectedTurn.conversationId));
    }
    const signature = conversations
      .map((item) => [normalizeId(item), normalizeLabel(item, "新对话"), item.updatedAt || item.mtime || "", visibleConversationMessages(asArray(item.messages)).length, item.pinnedAt || "", item.archivedAt || "", item.archiveStatus || "", item.archiveError || "", runningConversationIds.has(normalizeId(item)) ? "running" : ""].join(":"))
      .join("|");
    if (!force && signature === this.lastConversationSignature) {
      this.conversationNodes.forEach((entry, id) => {
        entry.button.toggleClass("is-active", id === activeId);
        entry.button.setAttr("aria-current", id === activeId ? "page" : "false");
      });
      return;
    }
    this.lastConversationSignature = signature;
    const wanted = new Set();

    conversations.forEach((conversation) => {
      const id = normalizeId(conversation, `conversation-${wanted.size}`);
      wanted.add(id);
      let entry = this.conversationNodes.get(id);
      if (!entry) {
        const row = this.refs.conversationList.createDiv({
          cls: "xz-conversation-row",
          attr: { role: "listitem" },
        });
        const button = row.createEl("button", {
          cls: "xz-conversation-item",
          attr: { type: "button" },
        });
        const text = button.createDiv({ cls: "xz-conversation-copy" });
        const title = text.createEl("strong");
        const preview = text.createEl("span");
        const time = button.createEl("time", { cls: "xz-conversation-time" });
        button.addEventListener("click", () => this.selectConversation(id));
        const menu = row.createEl("details", { cls: "xz-conversation-menu" });
        const menuSummary = menu.createEl("summary", {
          attr: { "aria-label": "更多操作", "aria-expanded": "false", title: "更多操作" },
        });
        const menuGlyph = menuSummary.createSpan({ attr: { "aria-hidden": "true" } });
        setIcon(menuGlyph, "ellipsis");
        const actions = menu.createDiv({ cls: "xz-conversation-actions" });
        actions.setAttr("aria-label", "对话操作");
        const menuDocument = menu.ownerDocument || this.viewDocument || document;
        const outsidePointerdown = event => closeConversationMenusOutside(
          this.conversationNodes,
          event.composedPath?.() || [event.target],
        );
        const rename = createIconButton(actions, "pencil", "重命名对话", (event) => {
          event.stopPropagation();
          menu.open = false;
          void this.renameConversation(id);
        }, "xz-conversation-action");
        rename.createSpan({ cls: "xz-conversation-action-label", text: "重命名" });
        const pin = createIconButton(actions, "pin", "置顶对话", (event) => {
          event.stopPropagation();
          menu.open = false;
          void this.toggleConversationPin(id);
        }, "xz-conversation-action");
        pin.createSpan({ cls: "xz-conversation-action-label", text: "置顶" });
        const archive = createIconButton(actions, "archive", "预览并归档", (event) => {
          event.stopPropagation();
          menu.open = false;
          void this.archiveConversation(id);
        }, "xz-conversation-action");
        const archiveLabel = archive.createSpan({ cls: "xz-conversation-action-label", text: "预览并归档" });
        const remove = createIconButton(actions, "trash-2", "删除对话", (event) => {
          event.stopPropagation();
          menu.open = false;
          void this.deleteConversation(id);
        }, "xz-conversation-action is-danger");
        remove.createSpan({ cls: "xz-conversation-action-label", text: "删除" });
        const archiveStatus = row.createDiv({ cls: "xz-conversation-archive-status" });
        entry = {
          row,
          button,
          title,
          preview,
          archiveStatus,
          time,
          menu,
          menuSummary,
          menuDocument,
          outsidePointerdown,
          rename,
          pin,
          archive,
          archiveLabel,
          remove,
        };
        this.conversationNodes.set(id, entry);
        menu.addEventListener("toggle", () => {
          syncConversationMenuToggle(this.conversationNodes, entry);
          menuDocument.removeEventListener("pointerdown", outsidePointerdown, true);
          if (menu.open) menuDocument.addEventListener("pointerdown", outsidePointerdown, true);
        });
      }
      const messages = visibleConversationMessages(asArray(conversation.messages));
      const latest = messages[messages.length - 1];
      entry.title.setText(normalizeLabel(conversation, "新对话"));
      const latestPreview = utf8SliceWithinBudget(messageText(latest), 0, 512).text;
      entry.preview.setText(runningConversationIds.has(id)
        ? "正在回复，可切换查看"
        : firstText(conversation.summary, latestPreview, "等待开始…").slice(0, 52));
      entry.archiveStatus.empty();
      let archiveRecovery = null;
      try {
        archiveRecovery = typeof this.plugin?.getArchiveRecoveryAction === "function"
          ? this.plugin.getArchiveRecoveryAction(id) : null;
      } catch (_) {
        archiveRecovery = null;
      }
      renderArchiveStatus(entry.archiveStatus, archiveRecovery, {
        retry: () => this.retryArchiveConversation(id),
        review: () => this.openArchiveReview(id),
        discard: () => this.discardArchiveDraft(id, archiveRecovery?.draftId),
      });
      entry.time.setText(formatTimestamp(conversation.updatedAt || conversation.mtime || conversation.createdAt));
      entry.button.toggleClass("is-active", id === activeId);
      entry.row.toggleClass("is-running", runningConversationIds.has(id));
      entry.button.setAttr("aria-current", id === activeId ? "page" : "false");
      entry.pin.toggleClass("is-active", Boolean(conversation.pinnedAt));
      entry.pin.setAttr("aria-label", conversation.pinnedAt ? "取消置顶" : "置顶对话");
      entry.pin.toggleAttribute("hidden", this.showArchived);
      entry.archive.toggleAttribute("hidden", false);
      const hasArchiveDraft = Boolean(conversation.archiveDraft);
      entry.archive.setAttr("aria-label", this.showArchived
        ? "恢复归档对话"
        : (hasArchiveDraft ? "查看归档内容" : "预览并归档"));
      entry.archiveLabel.setText(this.showArchived
        ? "恢复到对话列表"
        : (hasArchiveDraft ? "查看归档内容" : "预览并归档"));
      entry.remove.toggleAttribute("hidden", false);
      this.refs.conversationList.appendChild(entry.row);
    });

    for (const [id, entry] of this.conversationNodes) {
      if (wanted.has(id)) continue;
      entry.menuDocument?.removeEventListener("pointerdown", entry.outsidePointerdown, true);
      entry.row.remove();
      this.conversationNodes.delete(id);
    }

    this.refs.conversationList.toggleClass("is-empty", conversations.length === 0);
    const emptyText = this.historyQuery
      ? "没有找到匹配的对话、附件或来源。"
      : (this.showArchived ? "还没有已归档对话。" : "还没有历史对话。");
    if (!conversations.length && !this.refs.conversationEmpty) {
      this.refs.conversationEmpty = this.refs.conversationList.createEl("p", {
        cls: "xz-conversation-empty",
        text: emptyText,
      });
    }
    if (!conversations.length) this.refs.conversationEmpty?.setText(emptyText);
    if (conversations.length && this.refs.conversationEmpty) {
      this.refs.conversationEmpty.remove();
      this.refs.conversationEmpty = null;
    }
  }

  renderConversationHeader() {
    const conversation = this.getActiveConversation();
    const conversationId = normalizeId(conversation);
    if (this.headerContextConversationId !== conversationId) this.refs.contextDetails?.removeAttribute("open");
    this.headerContextConversationId = conversationId;
    const settings = stateSettings(this.plugin);
    const conversationTitle = normalizeLabel(conversation, "新对话");
    const taskSummary = firstText(
      conversation?.taskSummary,
      conversation?.summary,
      "告诉行知想完成什么；回复优先交付结果，整理在后台继续。",
    );
    const headerPresentation = buildTaskHeaderPresentation({
      conversationTitle,
      taskTitle: firstText(conversation?.taskTitle),
      taskSummary,
      taskKind: firstText(conversation?.taskKind) || inferWorkbenchTaskKind(`${conversationTitle} ${taskSummary}`),
      sourceScope: settings.networkAccess === true ? "local-web" : "local",
    });
    this.refs.topicTitle.setText(headerPresentation.title);
    this.refs.topicTitle.setAttr("title", conversationTitle);
    this.refs.topicMeta.setText(headerPresentation.summary);
    this.refs.topicBadges.empty();
    for (const badge of headerPresentation.badges) {
      this.refs.topicBadges.createSpan({
        cls: `xz-topic-badge is-${badge.tone}`,
        text: badge.label,
      });
    }
    let context = null;
    try {
      context = typeof this.plugin?.getConversationContextStatus === "function" && conversation
        ? this.plugin.getConversationContextStatus(normalizeId(conversation))
        : null;
    } catch (_) {
      context = null;
    }
    if (context) {
      const archived = Number(context.archivedMessageCount || 0);
      this.refs.contextStatus.setText(archived > 0
        ? `上下文 ${context.percent}% · 已自动整理 ${archived} 条旧消息`
        : `上下文 ${context.percent}% · 达到上限后自动整理旧消息`);
      this.refs.contextStatus.setAttr(
        "title",
        `当前约 ${Math.ceil(Number(context.currentBytes || 0) / 1024)} KB / ${Math.ceil(Number(context.limitBytes || 0) / 1024)} KB；旧消息原文始终保留在本地对话记录。`,
      );
      this.refs.contextStatus.toggleClass("is-warning", Number(context.percent || 0) >= 80);
    } else {
      this.refs.contextStatus.setText("上下文达到上限后自动整理，原文保留在本地");
      this.refs.contextStatus.removeClass("is-warning");
    }

    // 对话长度软提醒：只消费"刚刚自动整理过一轮"留下的那次待提示。
    // 不在渲染里比较 segmentCount，所以切换到分过段的旧对话不会补弹；
    // 待提示也不持久化——重启后没看到就自然消失，符合"防打扰"。
    if (conversation) {
      const conversationKey = normalizeId(conversation);
      const pending = this.plugin?.state?.runtime?.pendingContextReminder;
      if (pending && pending.conversationId === conversationKey) {
        if (typeof this.plugin?.consumeContextReminder === "function") {
          this.plugin.consumeContextReminder(conversationKey);
        }
        new Notice(
          `这段对话已经很长，较早内容已自动整理成摘要（第 ${Number(pending.segmentCount || 0)} 段），原文仍保留在本地对话记录。可以继续，也可以在首页新建一条对话。`,
          10000,
        );
      }
    }

    const runtime = this.plugin?.state?.runtime || {};
    const providerId = firstText(settings.providerId, conversation?.providerId, "codex");
    const connection = runtime.providerConnections?.[providerId]
      || (providerId === "codex" ? runtime.connection : null) || {};
    const status = firstText(connection.status, "checking").toLowerCase();
    const connected = ["connected", "ready", "online"].includes(status);
    const failed = ["error", "failed", "offline", "disconnected"].includes(status);
    const label = firstText(
      connection.label,
      connection.message,
      connection.error,
      connected ? "已连接" : failed ? "连接异常"
        : status === "configured" ? "已配置，待验证" : status === "idle" ? "待检测" : "正在连接",
    );
    this.refs.connectionText.setText(label);
    this.refs.connectionButton.removeClass("is-ready", "is-error", "is-checking");
    this.refs.connectionButton.addClass(connected ? "is-ready" : failed ? "is-error" : "is-checking");
    this.refs.connectionButton.setAttr("aria-label", `${label}，点击查看连接诊断`);
  }

  rememberMessagePageScroll() {
    const conversationId = this.renderedConversationId;
    const start = this.messageWindowStarts.get(conversationId);
    const scroll = this.refs.messageScroll;
    if (!conversationId || !Number.isInteger(start) || !scroll) return;
    let positions = this.messageWindowScrollPositions.get(conversationId);
    if (!positions) {
      positions = new Map();
      this.messageWindowScrollPositions.set(conversationId, positions);
    }
    positions.set(start, Number(scroll.scrollTop) || 0);
    while (positions.size > 20) positions.delete(positions.keys().next().value);
    while (this.messageWindowScrollPositions.size > 24) {
      const oldestConversationId = this.messageWindowScrollPositions.keys().next().value;
      if (oldestConversationId === conversationId && this.messageWindowScrollPositions.size > 1) {
        const entries = [...this.messageWindowScrollPositions.entries()];
        this.messageWindowScrollPositions.clear();
        entries.slice(1).forEach(([id, value]) => this.messageWindowScrollPositions.set(id, value));
        continue;
      }
      this.messageWindowScrollPositions.delete(oldestConversationId);
    }
  }

  markMessageScrollIntent() {
    this.messageScrollRevision += 1;
    this.messageScrollFollowLatest = false;
    this.messageScrollRestoreToken = null;
    this.messageRenderGeneration += 1;
  }

  invalidateMessageScrollRestore() {
    this.messageScrollRevision += 1;
    this.messageScrollRestoreToken = null;
    this.messageRenderGeneration += 1;
  }

  messageDistanceFromBottom(scroll = this.refs.messageScroll) {
    if (!scroll) return 0;
    return Math.max(0, Number(scroll.scrollHeight || 0)
      - Number(scroll.scrollTop || 0)
      - Number(scroll.clientHeight || 0));
  }

  messageScrollIsAtBottom(scroll = this.refs.messageScroll) {
    return this.messageDistanceFromBottom(scroll) <= 6;
  }

  updateMessageScrollFollowState() {
    if (this.messageScrollIsAtBottom()) this.messageScrollFollowLatest = true;
  }

  messageAnchorTarget(messageId, kind = "message") {
    if (!messageId) return null;
    if (kind === "stream") {
      const streamId = this.visibleStreamingMessageId();
      if (streamId === messageId) return { element: this.refs.streaming, kind: "stream" };
    }
    const entry = this.messageNodes.get(messageId);
    if (entry?.article) return { element: entry.article, kind: "message" };
    const streamId = this.visibleStreamingMessageId();
    if (streamId === messageId) return { element: this.refs.streaming, kind: "stream" };
    return null;
  }

  visibleStreamingMessageId() {
    const stream = this.refs.streaming;
    if (!stream || stream.hasAttribute?.("hidden")) return "";
    const renderedId = firstText(stream.getAttribute?.("data-message-id"));
    if (renderedId) return renderedId;
    const conversationId = normalizeId(this.getActiveConversation());
    const turn = this.turnForConversation(conversationId);
    return firstText(turn?.assistantMessageId);
  }

  messageElementContentTop(element, kind = "message") {
    const scroll = this.refs.messageScroll;
    const list = this.refs.messageList;
    if (!element || !scroll) return 0;
    const elementRect = element.getBoundingClientRect?.();
    const scrollRect = scroll.getBoundingClientRect?.();
    if (elementRect && scrollRect && Number.isFinite(Number(elementRect.top))
      && Number.isFinite(Number(scrollRect.top))) {
      return (Number(scroll.scrollTop) || 0) + Number(elementRect.top) - Number(scrollRect.top);
    }
    return (Number(element.offsetTop) || 0)
      + (kind === "message" ? (Number(list?.offsetTop) || 0) : 0);
  }

  trimMessageWindowState(conversationId) {
    for (const map of [this.messageWindowStarts, this.messageRenderedCounts]) {
      if (map.has(conversationId)) {
        const value = map.get(conversationId);
        map.delete(conversationId);
        map.set(conversationId, value);
      }
      while (map.size > 24) {
        const oldestConversationId = map.keys().next().value;
        if (oldestConversationId === conversationId) break;
        map.delete(oldestConversationId);
      }
    }
  }

  captureMessageScrollAnchor() {
    const scroll = this.refs.messageScroll;
    const list = this.refs.messageList;
    if (!scroll || !list) return null;
    const scrollTop = Number(scroll.scrollTop) || 0;
    const scrollRectTop = Number(scroll.getBoundingClientRect?.().top);
    const hasScrollRectTop = Number.isFinite(scrollRectTop);
    const viewportAnchor = scrollTop + Math.min((Number(scroll.clientHeight) || 0) * 0.32, 180);
    const contentTop = (element, kind, rect) => {
      if (hasScrollRectTop && rect && Number.isFinite(Number(rect.top))) {
        return scrollTop + Number(rect.top) - scrollRectTop;
      }
      return (Number(element.offsetTop) || 0)
        + (kind === "message" ? (Number(list.offsetTop) || 0) : 0);
    };
    const candidates = [...list.querySelectorAll(".xz-message")].map((article) => {
      const rect = article.getBoundingClientRect?.();
      const top = contentTop(article, "message", rect);
      return {
        article,
        messageId: article.getAttribute("data-message-id") || "",
        kind: "message",
        top,
        bottom: hasScrollRectTop && rect && Number.isFinite(Number(rect.bottom))
          ? scrollTop + Number(rect.bottom) - scrollRectTop
          : top + Math.max(48, Number(rect?.height) || 0),
      };
    });
    const streamingId = this.visibleStreamingMessageId();
    if (streamingId && this.refs.streaming) {
      const rect = this.refs.streaming.getBoundingClientRect?.();
      const top = contentTop(this.refs.streaming, "stream", rect);
      candidates.push({
        article: this.refs.streaming,
        messageId: streamingId,
        kind: "stream",
        top,
        bottom: hasScrollRectTop && rect && Number.isFinite(Number(rect.bottom))
          ? scrollTop + Number(rect.bottom) - scrollRectTop
          : top + Math.max(48, Number(rect?.height) || 0),
      });
    }
    candidates.sort((left, right) => left.top - right.top);
    const anchor = candidates.find((candidate) => candidate.top <= viewportAnchor && candidate.bottom > viewportAnchor)
      || candidates.find((candidate) => candidate.top > viewportAnchor)
      || candidates[candidates.length - 1];
    if (!anchor) return { scrollTop, messageId: "", offset: 0, kind: "" };
    return {
      scrollTop,
      messageId: anchor.messageId,
      kind: anchor.kind,
      offset: anchor.top - scrollTop,
    };
  }

  renderMessageWindowControls(total, start, count) {
    this.ensureMessageWindowNavigation();
    const nav = this.refs.messageWindowNav;
    if (!nav) return;
    const hasHistory = total > MESSAGE_WINDOW_PAGE_SIZE;
    nav.toggleAttribute("hidden", !hasHistory);
    this.refs.messageWindowOlder.disabled = start <= 0;
    this.refs.messageWindowNewer.disabled = start + count >= total;
    this.refs.messageWindowLatest.disabled = start + count >= total;
    const first = total ? start + 1 : 0;
    const last = Math.min(total, start + count);
    this.refs.messageWindowSummary.setText(`显示第 ${first}–${last} 条，共 ${total} 条`);
  }

  ensureMessageWindowNavigation() {
    if (this.refs.messageWindowNav || !this.refs.messageScroll?.createDiv) return;
    const nav = this.refs.messageScroll.createDiv({
      cls: "xz-message-window-nav",
      attr: { hidden: "", role: "group", "aria-label": "浏览历史消息" },
    });
    this.refs.messageWindowNav = nav;
    this.refs.messageWindowOlder = nav.createEl("button", {
      cls: "xz-message-window-button xz-message-window-older",
      text: "较早",
      attr: { type: "button", "aria-label": "加载较早消息" },
    });
    this.refs.messageWindowOlder.addEventListener("click", () => this.navigateMessageWindow("older"));
    this.refs.messageWindowSummary = nav.createSpan({ cls: "xz-message-window-summary", attr: { "aria-live": "polite" } });
    this.refs.messageWindowNewer = nav.createEl("button", {
      cls: "xz-message-window-button xz-message-window-newer",
      text: "较新",
      attr: { type: "button", "aria-label": "加载较新消息" },
    });
    this.refs.messageWindowNewer.addEventListener("click", () => this.navigateMessageWindow("newer"));
    this.refs.messageWindowLatest = nav.createEl("button", {
      cls: "xz-message-window-button xz-message-window-latest",
      text: "回到最新",
      attr: { type: "button", "aria-label": "回到最新消息" },
    });
    this.refs.messageWindowLatest.addEventListener("click", () => this.scrollConversationToBottom());
  }

  navigateMessageWindow(direction) {
    const conversation = this.getActiveConversation();
    const conversationId = normalizeId(conversation);
    const reconciliation = reconcileOptimisticUserMessage(
      asArray(conversation?.messages),
      this.pendingOutgoingMessages.get(conversationId) || null,
    );
    const messages = reconciliation.messages
      .filter((message) => !(message?.role === "assistant" && message?.status === "streaming"));
    const start = this.messageWindowStarts.get(conversationId);
    if (!conversationId || !Number.isInteger(start)) return;
    const maxStart = Math.max(0, messages.length - MESSAGE_WINDOW_PAGE_SIZE);
    const nextStart = direction === "older"
      ? Math.max(0, start - MESSAGE_WINDOW_PAGE_SIZE)
      : Math.min(maxStart, start + MESSAGE_WINDOW_PAGE_SIZE);
    if (nextStart === start) return;
    this.markMessageScrollIntent();
    this.rememberMessagePageScroll();
    this.messageWindowStarts.set(conversationId, nextStart);
    this.pendingMessageWindowScroll = { conversationId, kind: direction };
    this.renderMessages();
  }

  renderMessages({ force = false } = {}) {
    const conversation = this.getActiveConversation();
    const conversationId = normalizeId(conversation);
    const optimisticMessage = this.pendingOutgoingMessages.get(conversationId) || null;
    const reconciliation = reconcileOptimisticUserMessage(
      asArray(conversation?.messages),
      optimisticMessage,
    );
    if (optimisticMessage && !reconciliation.pending) {
      this.pendingOutgoingMessages.delete(conversationId);
    }
    const visibleMessages = reconciliation.messages;
    // The active assistant placeholder is rendered by the dedicated live node.
    // Excluding it here avoids showing the same streaming answer twice.
    const messages = visibleMessages.filter((message) => !(message?.role === "assistant" && message?.status === "streaming"));
    const currentWork = this.workPanelForConversation(conversationId);
    const scroll = this.refs.messageScroll;
    const changedConversation = conversationId !== this.renderedConversationId;
    if (changedConversation) this.rememberMessagePageScroll();

    const previousCount = this.messageRenderedCounts.get(conversationId);
    let start = this.messageWindowStarts.get(conversationId);
    if (!Number.isInteger(start)) start = Math.max(0, messages.length - MESSAGE_WINDOW_PAGE_SIZE);
    if (!changedConversation && Number.isInteger(previousCount) && messages.length > previousCount) {
      const wasAtLatestPage = start + Math.min(MESSAGE_WINDOW_PAGE_SIZE, Math.max(0, previousCount - start)) >= previousCount;
      if (wasAtLatestPage) start = Math.max(0, messages.length - MESSAGE_WINDOW_PAGE_SIZE);
    }
    start = Math.max(0, Math.min(start, Math.max(0, messages.length - MESSAGE_WINDOW_PAGE_SIZE)));
    this.messageWindowStarts.set(conversationId, start);
    const windowMessages = messages.slice(start, start + Math.min(MESSAGE_WINDOW_PAGE_SIZE, MESSAGE_WINDOW_MAX_NODES));
    const pendingWindowScroll = this.pendingMessageWindowScroll?.conversationId === conversationId
      ? this.pendingMessageWindowScroll
      : null;
    this.pendingMessageWindowScroll = null;

    if (changedConversation) {
      for (const entry of this.messageNodes.values()) this.disposeMessageEntry(entry);
      this.refs.messageList.empty();
      this.messageNodes.clear();
      this.renderedConversationId = conversationId;
      this.lastMessageLocatorSignature = "";
    }

    const descriptors = windowMessages.map((message, index) => {
      const absoluteIndex = start + index;
      const id = firstText(message?.id, message?.messageId, `${conversationId || "new"}-${absoluteIndex}`);
      const role = firstText(message?.role, message?.author, "assistant").toLowerCase();
      const content = messageText(message);
      const failureSummary = ["failed", "error", "interrupted", "cancelled"].includes(message?.status)
        ? boundedMessageErrorSummary(firstRawText(message?.error, content, "本轮执行失败。"))
        : "";
      const signature = [
        role,
        message?.status || "",
        message?.contentDeletedAt || "",
        message?.updatedAt || "",
        JSON.stringify(message?.responseMetrics || null),
        JSON.stringify(message?.artifacts || message?.deliverables || message?.results || null),
        JSON.stringify(message?.references || message?.sources || null),
        message?.mediaKind || "",
        JSON.stringify(message?.chatImage || null),
        JSON.stringify(this.attachmentSends.get(conversationId)?.messageId === id
          ? this.attachmentSends.get(conversationId)?.presentation : null),
        JSON.stringify(currentWork?.recovery || null),
      ].join("\u241f");
      const entry = this.messageNodes.get(id) || null;
      return {
        id,
        message,
        role,
        content,
        failureSummary,
        signature,
        entry,
        shouldUpdate: !entry || force || entry.signature !== signature || entry.content !== content
          || entry.failureSummary !== failureSummary,
      };
    });
    const wanted = new Set(descriptors.map((descriptor) => descriptor.id));
    const existingChildren = [...this.refs.messageList.children];
    const hasStaleEntries = [...this.messageNodes.keys()].some((id) => !wanted.has(id));
    const hasMissingEntries = descriptors.some((descriptor) => !descriptor.entry);
    const hasOrderChanges = !hasMissingEntries && (existingChildren.length !== descriptors.length
      || descriptors.some((descriptor, index) => existingChildren[index] !== descriptor.entry.article));
    const hasMessageChanges = changedConversation || hasStaleEntries || hasMissingEntries || hasOrderChanges
      || descriptors.some((descriptor) => descriptor.shouldUpdate) || Boolean(pendingWindowScroll);
    const scrollAnchor = !changedConversation && hasMessageChanges ? this.captureMessageScrollAnchor() : null;
    const scrollIntentRevision = this.messageScrollRevision;
    const shouldFollowLatest = this.messageScrollFollowLatest && this.messageScrollIsAtBottom(scroll);
    let messageDomChanged = changedConversation;

    descriptors.forEach((descriptor) => {
      const { id, message, role, content, failureSummary, signature } = descriptor;
      let { entry } = descriptor;
      if (!entry) {
        entry = this.createMessageNode(id);
        this.messageNodes.set(id, entry);
        descriptor.entry = entry;
        messageDomChanged = true;
      }
      if (descriptor.shouldUpdate) {
        this.updateMessageNode(entry, message, role, content, failureSummary);
        entry.signature = signature;
        messageDomChanged = true;
      }
    });

    for (const [id, entry] of this.messageNodes) {
      if (wanted.has(id)) continue;
      this.disposeMessageEntry(entry);
      entry.article.remove();
      this.messageNodes.delete(id);
      messageDomChanged = true;
    }

    descriptors.forEach((descriptor, index) => {
      const article = descriptor.entry.article;
      const current = this.refs.messageList.children[index] || null;
      if (current === article) return;
      if (typeof this.refs.messageList.insertBefore === "function") {
        this.refs.messageList.insertBefore(article, current);
      } else {
        this.refs.messageList.appendChild(article);
      }
      messageDomChanged = true;
    });

    this.refs.welcome.toggleAttribute("hidden", visibleMessages.length > 0);
    this.refs.messageList.toggleAttribute("hidden", windowMessages.length === 0);
    this.renderMessageWindowControls(messages.length, start, windowMessages.length);
    this.renderMessageLocator(windowMessages, conversationId, start);
    this.messageRenderedCounts.set(conversationId, messages.length);
    this.trimMessageWindowState(conversationId);

    if (!messageDomChanged && !pendingWindowScroll && !changedConversation) return;

    const scrollTopQueued = Number(scroll?.scrollTop) || 0;
    const generation = ++this.messageRenderGeneration;
    const restoreToken = {
      generation,
      conversationId,
      revision: scrollIntentRevision,
      scrollTop: scrollTopQueued,
    };
    this.messageScrollRestoreToken = restoreToken;
    const schedule = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
    schedule(() => {
      if (generation !== this.messageRenderGeneration
        || this.messageScrollRestoreToken !== restoreToken
        || restoreToken.revision !== this.messageScrollRevision
        || normalizeId(this.getActiveConversation()) !== conversationId
        || Number(scroll.scrollTop) !== restoreToken.scrollTop) return;
      this.messageScrollRestoreToken = null;
      if (pendingWindowScroll?.kind === "target") {
        this.scrollRenderedMessageToTarget(pendingWindowScroll.messageId);
      } else if (pendingWindowScroll?.kind === "older") {
        scroll.scrollTop = scroll.scrollHeight;
        this.messageScrollFollowLatest = false;
      } else if (pendingWindowScroll?.kind === "newer") {
        const saved = this.messageWindowScrollPositions.get(conversationId)?.get(start);
        scroll.scrollTop = Number.isFinite(saved) ? saved : 0;
        this.messageScrollFollowLatest = this.messageScrollIsAtBottom(scroll);
      } else if (pendingWindowScroll?.kind === "latest" || (!changedConversation && shouldFollowLatest)) {
        scroll.scrollTop = scroll.scrollHeight;
        this.messageScrollFollowLatest = true;
      } else if (changedConversation) {
        const saved = this.messageWindowScrollPositions.get(conversationId)?.get(start);
        scroll.scrollTop = Number.isFinite(saved) ? saved : scroll.scrollHeight;
        this.messageScrollFollowLatest = this.messageScrollIsAtBottom(scroll);
      } else if (scrollAnchor?.messageId) {
        const target = this.messageAnchorTarget(scrollAnchor.messageId, scrollAnchor.kind);
        if (target?.element) {
          const targetTop = this.messageElementContentTop(target.element, target.kind);
          scroll.scrollTop = Math.max(0, targetTop - scrollAnchor.offset);
        } else {
          scroll.scrollTop = scrollAnchor.scrollTop;
        }
      } else if (scrollAnchor) {
        scroll.scrollTop = scrollAnchor.scrollTop;
      }
      this.updateConversationNavigation({ updateLayout: true });
      this.rememberMessagePageScroll();
    });
  }

  renderMessageLocator(messages, conversationId, indexOffset = 0) {
    const locator = this.refs.messageLocator;
    if (!locator) return;
    const entries = messages.map((message, index) => {
      const absoluteIndex = indexOffset + index;
      const id = firstText(message?.id, message?.messageId, `${conversationId || "new"}-${absoluteIndex}`);
      const role = firstText(message?.role, message?.author, "assistant").toLowerCase();
      const raw = utf8SliceWithinBudget(messageText(message), 0, 512).text.replace(/\s+/gu, " ").trim();
      const preview = raw || "（无内容）";
      return {
        id,
        role,
        index: absoluteIndex + 1,
        preview: preview.length > 116 ? `${preview.slice(0, 116)}…` : preview,
        time: formatTimestamp(message?.createdAt || message?.timestamp || message?.updatedAt),
      };
    });
    const signature = JSON.stringify(entries);
    const structureChanged = signature !== this.lastMessageLocatorSignature;
    if (structureChanged) {
      locator.empty();
      entries.forEach((item, index) => {
        const roleLabel = item.role === "user" ? "你的消息" : "行知回答";
        const marker = locator.createEl("button", {
          cls: `xz-message-locator-marker is-${item.role === "user" ? "user" : "assistant"}`,
          attr: {
            type: "button",
            "data-message-id": item.id,
            "aria-label": `跳到第 ${item.index} 条，${roleLabel}：${item.preview}`,
          },
        });
        marker.createSpan({ cls: "xz-message-locator-tick", attr: { "aria-hidden": "true" } });
        const preview = marker.createDiv({ cls: "xz-message-locator-preview", attr: { role: "tooltip" } });
        const heading = preview.createDiv({ cls: "xz-message-locator-preview-head" });
        heading.createEl("strong", { text: `${item.index}. ${roleLabel}` });
        if (item.time) heading.createEl("time", { text: item.time });
        preview.createEl("p", { text: item.preview });
        marker.addEventListener("click", () => this.scrollToMessage(item.id));
      });
      this.lastMessageLocatorSignature = signature;
    }
    locator.toggleAttribute("hidden", entries.length === 0);
    if (!structureChanged) return;
    const schedule = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
    schedule(() => this.updateConversationNavigation({ updateLayout: true }));
  }

  scrollConversationToBottom() {
    const scroll = this.refs.messageScroll;
    const conversation = this.getActiveConversation();
    const conversationId = normalizeId(conversation);
    const reconciliation = reconcileOptimisticUserMessage(
      asArray(conversation?.messages),
      this.pendingOutgoingMessages.get(conversationId) || null,
    );
    const messages = reconciliation.messages
      .filter((message) => !(message?.role === "assistant" && message?.status === "streaming"));
    if (!scroll || !conversationId) return;
    this.invalidateMessageScrollRestore();
    this.messageScrollFollowLatest = true;
    const start = Math.max(0, messages.length - MESSAGE_WINDOW_PAGE_SIZE);
    this.messageWindowStarts.set(conversationId, start);
    this.pendingMessageWindowScroll = { conversationId, kind: "latest" };
    this.renderMessages();
  }

  scrollToMessage(messageId) {
    const conversation = this.getActiveConversation();
    const conversationId = normalizeId(conversation);
    if (!conversationId || !messageId) return;
    const optimisticMessage = this.pendingOutgoingMessages.get(conversationId) || null;
    const reconciliation = reconcileOptimisticUserMessage(asArray(conversation?.messages), optimisticMessage);
    const messages = reconciliation.messages.filter((message) => !(message?.role === "assistant" && message?.status === "streaming"));
    const index = messages.findIndex((message, position) => (
      firstText(message?.id, message?.messageId, `${conversationId}-${position}`) === messageId
    ));
    if (index < 0) return;
    this.markMessageScrollIntent();
    const currentStart = this.messageWindowStarts.get(conversationId);
    const currentEnd = Number.isInteger(currentStart)
      ? currentStart + Math.min(MESSAGE_WINDOW_PAGE_SIZE, messages.length - currentStart)
      : -1;
    if (index < currentStart || index >= currentEnd) {
      const maxStart = Math.max(0, messages.length - MESSAGE_WINDOW_PAGE_SIZE);
      const start = Math.max(0, Math.min(index - Math.floor(MESSAGE_WINDOW_PAGE_SIZE / 2), maxStart));
      this.messageWindowStarts.set(conversationId, start);
      this.pendingMessageWindowScroll = { conversationId, kind: "target", messageId };
      this.renderMessages();
      return;
    }
    this.scrollRenderedMessageToTarget(messageId);
  }

  scrollRenderedMessageToTarget(messageId) {
    const scroll = this.refs.messageScroll;
    const article = this.messageNodes.get(messageId)?.article;
    if (!scroll || !article) return;
    this.markMessageScrollIntent();
    const target = Math.max(0, this.messageElementContentTop(article, "message") - 16);
    if (typeof scroll.scrollTo === "function") scroll.scrollTo({ top: target, behavior: "smooth" });
    else scroll.scrollTop = target;
    article.addClass("is-locator-target");
    globalThis.setTimeout(() => {
      if (article.isConnected) article.removeClass("is-locator-target");
    }, 900);
    this.updateConversationNavigation();
  }

  updateConversationNavigation({ updateLayout = false } = {}) {
    const scroll = this.refs.messageScroll;
    const locator = this.refs.messageLocator;
    if (!scroll || !locator) return;
    const maxScroll = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    const distanceFromBottom = Math.max(0, maxScroll - scroll.scrollTop);
    const canScroll = maxScroll > 16;
    this.refs.scrollToBottom?.toggleAttribute("hidden", !canScroll || distanceFromBottom < 96);

    const markers = Array.from(locator.querySelectorAll(".xz-message-locator-marker"));
    if (!markers.length) return;
    const anchor = scroll.scrollTop + Math.min(scroll.clientHeight * 0.32, 180);
    let activeId = markers[0]?.getAttribute("data-message-id") || "";
    markers.forEach((marker, index) => {
      const messageId = marker.getAttribute("data-message-id") || "";
      if (updateLayout) {
        const article = this.messageNodes.get(messageId)?.article;
        if (!article) return;
        const articleTop = this.messageElementContentTop(article, "message");
        const targetScroll = Math.min(Math.max(0, articleTop - 16), maxScroll);
        const fallback = markers.length === 1 ? 50 : (index / (markers.length - 1)) * 100;
        const position = maxScroll > 0 ? (targetScroll / maxScroll) * 100 : fallback;
        marker.xzTargetScroll = targetScroll;
        marker.style.setProperty("--xz-locator-position", `${Math.min(100, Math.max(0, position))}%`);
      }
      const fallback = markers.length === 1 ? 50 : (index / (markers.length - 1)) * 100;
      const targetScroll = Number.isFinite(Number(marker.xzTargetScroll))
        ? Number(marker.xzTargetScroll)
        : (fallback / 100) * maxScroll;
      if (targetScroll <= anchor) activeId = messageId;
    });
    markers.forEach((marker) => {
      const active = marker.getAttribute("data-message-id") === activeId;
      marker.toggleClass("is-active", active);
      if (active) marker.setAttr("aria-current", "location");
      else marker.removeAttribute("aria-current");
    });
  }

  createMessageNode(id) {
    const article = this.refs.messageList.createEl("article", {
      cls: "xz-message",
      attr: { "data-message-id": id },
    });
    const avatar = article.createDiv({ cls: "xz-message-avatar", attr: { "aria-hidden": "true" } });
    const body = article.createDiv({ cls: "xz-message-body" });
    const meta = body.createDiv({ cls: "xz-message-meta" });
    const author = meta.createEl("strong");
    const mediaBadge = meta.createSpan({ cls: "xz-message-media-kind", attr: { hidden: "" } });
    const time = meta.createEl("time");
    const text = body.createDiv({ cls: "xz-message-text" });
    const chatImage = body.createDiv({
      cls: "xz-chat-image",
      attr: { hidden: "", role: "group", "aria-label": "本条回复中的图片生成状态" },
    });
    const images = body.createDiv({ cls: "xz-message-images", attr: { hidden: "", "aria-label": "上传的图片" } });
    const generatedImages = body.createDiv({
      cls: "xz-message-generated-images",
      attr: { hidden: "", "aria-label": "AI 生成图片" },
    });
    const attachmentStatus = body.createDiv({
      cls: "xz-message-attachment-status",
      attr: { hidden: "", role: "status", "aria-live": "polite", "aria-atomic": "true" },
    });
    const results = body.createDiv({ cls: "xz-message-results", attr: { hidden: "" } });
    const failureRecovery = body.createDiv({ cls: "xz-failure-recovery", attr: { hidden: "" } });
    const references = body.createDiv({ cls: "xz-message-references" });
    const actions = body.createDiv({ cls: "xz-message-actions" });
    const copy = createIconButton(actions, "copy", "复制本条内容", () => {
      void this.copyMessageContent(entry?.content || "");
    }, "xz-message-action");
    const manageBlocks = createIconButton(actions, "layout-list", "段落管理", () => {
      this.openMessageBlocks(entry?.conversationId, entry?.messageId);
    }, "xz-message-action xz-message-block-action");
    const metrics = body.createEl("footer", {
      cls: "xz-response-metrics",
      attr: { hidden: "", "aria-label": "本轮耗时与 Token 用量" },
    });
    const entry = {
      article,
      avatar,
      body,
      author,
      mediaBadge,
      time,
      actions,
      copy,
      manageBlocks,
      metrics,
      text,
      chatImage,
      chatImageSignature: "",
      failureSummary: "",
      images,
      generatedImages,
      attachmentStatus,
      imageSignature: "",
      generatedImageSignature: "",
      imageRenderVersion: 0,
      generatedImageRenderVersion: 0,
      results,
      failureRecovery,
      references,
      signature: "",
      content: "",
      conversationId: "",
      messageId: id,
      renderKey: "",
      renderContent: null,
      renderMarkdown: null,
      renderVersion: 0,
      markdownComponent: null,
      pendingMarkdownComponent: null,
    };
    return entry;
  }

  removeMessageRenderComponent(component) {
    if (!component) return;
    try {
      this.removeChild(component);
    } catch (_error) {
      component.unload?.();
    }
  }

  disposeMessageEntry(entry) {
    if (!entry) return;
    entry.renderVersion = Number(entry.renderVersion || 0) + 1;
    entry.imageRenderVersion = Number(entry.imageRenderVersion || 0) + 1;
    entry.generatedImageRenderVersion = Number(entry.generatedImageRenderVersion || 0) + 1;
    this.removeMessageRenderComponent(entry.pendingMarkdownComponent);
    if (entry.markdownComponent !== entry.pendingMarkdownComponent) {
      this.removeMessageRenderComponent(entry.markdownComponent);
    }
    entry.pendingMarkdownComponent = null;
    entry.markdownComponent = null;
    entry.renderKey = "";
    entry.renderContent = null;
    entry.content = "";
    entry.failureSummary = "";
  }

  messageMarkdownSourcePath(conversationId) {
    try {
      return conversationTranscriptPath(conversationId);
    } catch (_error) {
      return "";
    }
  }

  enhanceRenderedMessage(container) {
    container.querySelectorAll(".copy-code-button").forEach((button) => {
      if (!button.getAttribute("aria-label")) button.setAttribute("aria-label", "复制代码");
    });
    container.querySelectorAll(".xz-mermaid-diagram, .xz-message-diagram").forEach((figure) => {
      const canvas = figure.querySelector(".xz-mermaid-canvas, .xz-message-diagram-canvas");
      const svg = canvas?.querySelector("svg");
      const caption = figure.querySelector("figcaption");
      if (!svg || !caption || caption.querySelector(".xz-diagram-open")) return;
      const open = caption.createEl("button", {
        cls: "xz-diagram-open", text: "放大查看",
        attr: { type: "button", "aria-label": "单独打开并放大查看图表" },
      });
      const show = () => this.openDiagramPreview(svg, open);
      open.addEventListener("click", show);
      canvas.setAttribute("role", "button");
      canvas.setAttribute("tabindex", "0");
      canvas.setAttribute("aria-label", "点击放大查看图表");
      canvas.setAttribute("title", "点击放大查看图表");
      canvas.classList.add("is-expandable");
      canvas.addEventListener("click", (event) => {
        if (!event.defaultPrevented && !event.target.closest?.("a, button")) show();
      });
      canvas.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        show();
      });
    });
    container.querySelectorAll("table").forEach((table) => {
      if (table.parentElement?.classList.contains("xz-markdown-table-scroll")) return;
      const wrapper = table.ownerDocument.createElement("div");
      wrapper.className = "xz-markdown-table-scroll";
      wrapper.setAttribute("role", "region");
      wrapper.setAttribute("aria-label", "表格，可横向滚动查看全部内容");
      wrapper.setAttribute("tabindex", "0");
      table.replaceWith(wrapper);
      wrapper.appendChild(table);
    });

    container.querySelectorAll("img").forEach((image) => {
      image.setAttribute("loading", "lazy");
      image.setAttribute("decoding", "async");
      if (!image.getAttribute("alt")) image.setAttribute("alt", "知识库图片");
    });

    container.querySelectorAll("a[href]").forEach((link) => {
      if (/^https?:/iu.test(link.getAttribute("href") || "")) {
        link.setAttribute("rel", "noopener noreferrer");
      }
    });
  }

  renderMessageContent(entry, content, {
    markdown = false,
    conversationId = "",
    messageId = "",
    messageStatus = "",
  } = {}) {
    const value = String(content || "");
    if (entry.renderMarkdown === markdown && entry.renderContent === value) return;
    entry.renderKey = markdown ? "markdown" : "plain";
    entry.renderContent = value;
    entry.renderMarkdown = markdown;
    entry.renderVersion = Number(entry.renderVersion || 0) + 1;
    const renderVersion = entry.renderVersion;

    this.removeMessageRenderComponent(entry.pendingMarkdownComponent);
    if (entry.markdownComponent !== entry.pendingMarkdownComponent) {
      this.removeMessageRenderComponent(entry.markdownComponent);
    }
    entry.pendingMarkdownComponent = null;
    entry.markdownComponent = null;

    if (!markdown || !value) {
      entry.text.removeClass("is-markdown-rendered");
      entry.text.setAttr("aria-busy", null);
      if (String(entry.text.textContent || "") !== value) entry.text.setText(value);
      return;
    }

    const prepared = prepareMessageMarkdown(value);
    const mermaidPrepared = extractMessageMermaidBlocks(prepared);
    const diagramPrepared = extractMessageDiagramBlocks(mermaidPrepared.markdown);
    const staging = entry.text.ownerDocument.createElement("div");
    const component = new Component();
    this.addChild(component);
    entry.pendingMarkdownComponent = component;
    entry.text.setAttr("aria-busy", "true");
    entry.text.removeClass("is-markdown-rendered");
    if (String(entry.text.textContent || "") !== value) entry.text.setText(value);

    MarkdownRenderer.render(
      this.app,
      diagramPrepared.markdown,
      staging,
      this.messageMarkdownSourcePath(conversationId),
      component,
    ).then(async () => {
      if (entry.renderVersion !== renderVersion) {
        this.removeMessageRenderComponent(component);
        return;
      }
      await renderMessageMermaidBlocks(
        staging,
        mermaidPrepared.blocks,
        () => entry.renderVersion === renderVersion,
      );
      if (entry.renderVersion !== renderVersion) {
        this.removeMessageRenderComponent(component);
        return;
      }
      renderMessageDiagramBlocks(staging, diagramPrepared.blocks, {
        isCurrent: () => entry.renderVersion === renderVersion,
        conversationId,
        messageId,
        messageStatus,
        plugin: this.plugin,
        openVaultPath: (path) => this.openVaultPath(path),
        savedDiagrams: this.savedMessageDiagrams,
      });
      if (entry.renderVersion !== renderVersion) {
        this.removeMessageRenderComponent(component);
        return;
      }
      const activeConversationId = normalizeId(this.getActiveConversation());
      const scrollAnchor = activeConversationId === conversationId && entry.article?.isConnected
        ? this.captureMessageScrollAnchor() : null;
      const followLatest = activeConversationId === conversationId
        && this.messageScrollFollowLatest
        && this.messageScrollIsAtBottom(this.refs.messageScroll);
      this.enhanceRenderedMessage(staging);
      entry.text.empty();
      while (staging.firstChild) entry.text.appendChild(staging.firstChild);
      entry.text.addClass("is-markdown-rendered");
      entry.text.setAttr("aria-busy", null);
      entry.pendingMarkdownComponent = null;
      entry.markdownComponent = component;
      if (scrollAnchor) {
        this.invalidateMessageScrollRestore();
        this.applyMessageScrollAnchor(scrollAnchor, { followLatest });
        this.updateConversationNavigation({ updateLayout: true });
      }
    }).catch((error) => {
      this.removeMessageRenderComponent(component);
      if (entry.renderVersion !== renderVersion) return;
      entry.pendingMarkdownComponent = null;
      entry.renderKey = "";
      entry.renderContent = null;
      entry.renderMarkdown = null;
      entry.text.removeClass("is-markdown-rendered");
      entry.text.setAttr("aria-busy", null);
      if (String(entry.text.textContent || "") !== value) entry.text.setText(value);
      console.warn("行知回答排版失败，已回退为纯文字", error);
    });
  }

  renderMessageResults(entry, message, content) {
    entry.results.empty();
    const artifacts = asArray(message?.artifacts || message?.deliverables || message?.results)
      .filter((artifact) => artifact !== null && artifact !== undefined)
      .slice(0, 4);
    for (const artifact of artifacts) {
      const title = firstText(
        artifact?.title,
        artifact?.name,
        artifact?.label,
        typeof artifact === "string" ? artifact : "",
        "本轮结果",
      );
      const path = firstText(artifact?.path, artifact?.file, artifact?.vaultPath);
      const card = entry.results.createEl("section", { cls: "xz-result-card" });
      const icon = card.createSpan({ cls: "xz-result-card-icon", attr: { "aria-hidden": "true" } });
      setIcon(icon, "file-check-2");
      const copy = card.createDiv({ cls: "xz-result-card-copy" });
      copy.createEl("strong", { text: `结果：${title}` });
      const description = firstText(artifact?.summary, artifact?.description, artifact?.statusLabel);
      if (description) copy.createEl("span", { text: description });
      const meta = [
        Number(artifact?.pages) > 0 ? `${Number(artifact.pages)} 页` : "",
        Number(artifact?.words) > 0 ? `${Number(artifact.words).toLocaleString("zh-CN")} 字` : "",
      ].filter(Boolean).join(" · ");
      if (meta) copy.createEl("small", { text: meta });
      const actions = card.createDiv({ cls: "xz-result-card-actions" });
      if (path) {
        const open = actions.createEl("button", { text: "打开结果", attr: { type: "button" } });
        open.disabled = typeof this.plugin?.openVaultPath !== "function";
        open.addEventListener("click", () => this.openVaultPath(path));
      }
      if (content) {
        const copyButton = actions.createEl("button", { text: "复制结果", attr: { type: "button" } });
        copyButton.addEventListener("click", () => { void this.copyMessageContent(content); });
      }
      if (asArray(message?.references || message?.sources).length) {
        const sources = actions.createEl("button", { text: "查看来源", attr: { type: "button" } });
        sources.addEventListener("click", () => {
          entry.references.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
          entry.references.querySelector("button")?.focus();
        });
      }
    }
    entry.results.toggleAttribute("hidden", artifacts.length === 0);
  }

  renderFailureRecovery(entry, message, work) {
    entry.failureRecovery.empty();
    const boundedError = entry.failureSummary || boundedMessageErrorSummary(
      firstRawText(message?.error, messageText(message), "本轮执行失败。"),
    );
    const presentation = buildFailureRecoveryPresentation({
      status: message?.status,
      error: boundedError,
      authenticationRequired: message?.status === "failed"
        && firstText(message?.providerId, this.getActiveConversation()?.providerId, stateSettings(this.plugin).providerId) === "codex"
        && this.plugin?.state?.runtime?.providerConnections?.codex?.authenticationRequired === true,
      recovery: work?.recovery,
      mandatoryOnline: work?.mandatoryOnline === true,
    });
    entry.failureRecovery.toggleAttribute("hidden", !presentation);
    const preserveIncompleteProviderBody = message?.status === "failed"
      && Boolean(message?.content)
      && hasIncompleteProviderCompletion(message);
    entry.text.toggleAttribute("hidden", Boolean(presentation) && !preserveIncompleteProviderBody);
    if (!presentation) return;
    const icon = entry.failureRecovery.createSpan({ cls: "xz-failure-recovery-icon", attr: { "aria-hidden": "true" } });
    setIcon(icon, presentation.title === "本轮已停止" ? "circle-stop" : "circle-alert");
    const copy = entry.failureRecovery.createDiv({ cls: "xz-failure-recovery-copy" });
    copy.createEl("strong", { text: presentation.title });
    copy.createEl("p", { text: presentation.detail });
    const actions = copy.createDiv({ cls: "xz-failure-recovery-actions" });
    if (presentation.canRetryAfterAuthentication && typeof this.plugin?.retryFailedResponse === "function") {
      const retry = actions.createEl("button", {
        cls: "xz-secondary-button", text: "重新登录后重试", attr: { type: "button" },
      });
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        try {
          const confirmed = await new XingzhiConfirmationModal(this.app, {
            title: "确认已更新本机认证",
            message: "请先在本机重新登录对应的 Codex 账号，或更新 API 连接凭据，再确认。行知不会替你操作账号；此确认不代表认证已通过，下一次请求仍可能失败，并会重新提交本轮问题。",
            confirmLabel: "我已更新认证，重试本轮",
          }).waitForConfirmation();
          if (confirmed) await this.plugin.retryFailedResponse(entry.conversationId, { authenticationRechecked: true });
        } catch (_error) {
          new Notice("重试未完成，请查看连接诊断；已有对话记录保留。");
        } finally {
          retry.disabled = false;
        }
      });
    }
    if (presentation.canRetry && typeof this.plugin?.retryFailedResponse === "function") {
      const retry = actions.createEl("button", {
        cls: "xz-primary-button",
        text: "从安全点重试",
        attr: { type: "button" },
      });
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        try {
          await this.plugin.retryFailedResponse(entry.conversationId);
          new Notice("已从安全检查点重新执行；不会重复已经确认的外部操作");
        } catch (error) {
          retry.disabled = false;
          new Notice(`无法安全重试：${firstText(error?.message, error, "未知错误")}`);
        }
      });
    }
    const diagnostics = actions.createEl("button", {
      cls: "xz-secondary-button",
      text: "查看连接诊断",
      attr: { type: "button" },
    });
    diagnostics.addEventListener("click", () => this.openConnectionDiagnostics());
  }

  updateMessageNode(entry, message, role, content, failureSummary = "") {
    const isUser = ["user", "human", "me"].includes(role);
    const isAssistant = ["assistant", "agent", "ai"].includes(role);
    const isFailed = ["failed", "error"].includes(message?.status);
    const isStopped = ["interrupted", "cancelled"].includes(message?.status);
    entry.article.className = `xz-message ${isUser ? "xz-message-user" : isAssistant ? "xz-message-assistant" : "xz-message-system"}`;
    entry.article.toggleClass("is-content-deleted", Boolean(message?.contentDeletedAt));
    entry.avatar.empty();
    if (isAssistant) renderBrandAvatar(entry.avatar, this.plugin);
    else setIcon(entry.avatar, isUser ? "user-round" : "info");
    entry.author.setText(isUser ? "你" : isAssistant ? "行知" : "系统");
    const isGeneratedImage = message?.mediaKind === "generated-image" && !message?.chatImage;
    entry.mediaBadge.toggleAttribute("hidden", !isGeneratedImage);
    if (isGeneratedImage) {
      const hasImage = asArray(message?.references).some((reference) => generatedImagePath(reference?.path || reference));
      entry.mediaBadge.setText(isUser
        ? "图片生成请求"
        : message?.status === "streaming" ? "正在生成图片"
          : isFailed ? "生成图片失败"
            : hasImage ? "AI 生成图片 · 已保存" : "AI 生成图片");
    } else {
      entry.mediaBadge.setText("");
    }
    entry.time.setText(formatTimestamp(message?.createdAt || message?.timestamp || message?.updatedAt));
    const preserveIncompleteProviderBody = isFailed
      && Boolean(message?.content)
      && hasIncompleteProviderCompletion(message);
    const boundPlainBody = (isFailed && !preserveIncompleteProviderBody) || (isStopped && !content);
    let displayText = boundPlainBody ? failureSummary : content;
    if (isUser && asArray(message?.references).length) {
      displayText = displayText.replace(/\[\[(12_资料库\/导入资料\/资料记录\/[^\]|\r\n]+)\|([^\]\r\n]+)\]\]/gu, "$2");
    }
    const renderMarkdown = isAssistant
      && message?.status !== "streaming"
      && (!isFailed || preserveIncompleteProviderBody)
      && (!isStopped || Boolean(content));
    const conversationId = normalizeId(this.getActiveConversation());
    const currentMessageId = firstText(message?.id, message?.messageId, entry.messageId);
    this.renderMessageContent(entry, displayText, {
      markdown: renderMarkdown,
      conversationId,
      messageId: currentMessageId,
      messageStatus: firstText(message?.status),
    });
    this.renderMessageImages(entry, isUser ? message : null);
    this.renderChatImage(entry, isAssistant ? message?.chatImage : null, message);
    this.renderGeneratedMessageImages(entry, isAssistant ? message : null);
    this.renderMessageAttachmentStatus(entry, isUser ? message : null);
    entry.content = content;
    entry.failureSummary = failureSummary;
    entry.conversationId = conversationId;
    entry.messageId = firstText(message?.id, message?.messageId, entry.messageId);
    const work = this.workPanelForConversation(conversationId);
    this.renderMessageResults(entry, message, content);
    this.renderFailureRecovery(entry, message, work);
    const canCopy = Boolean(content) && !message?.contentDeletedAt && message?.status !== "streaming";
    const canManageBlocks = (Boolean(content) || Boolean(message?.contentDeletedAt))
      && message?.status === "completed"
      && (isUser || isAssistant);
    const canAct = canCopy || canManageBlocks;
    entry.actions.toggleAttribute("hidden", !canAct);
    entry.copy.disabled = !canCopy;
    entry.manageBlocks.disabled = !canManageBlocks;
    entry.manageBlocks.toggleAttribute("hidden", !canManageBlocks);
    entry.article.toggleClass("is-error", message?.status === "failed" || message?.status === "error");

    entry.metrics.empty();
    const metricsSummary = isAssistant ? buildResponseMetricsSummary(message?.responseMetrics) : null;
    const reasoningLabel = isAssistant ? reasoningExecutionLabel(message?.reasoningExecution) : "";
    const metricLabels = [];
    if (reasoningLabel) {
      const execution = normalizeReasoningExecution(message?.reasoningExecution);
      const detail = execution?.degradationReason
        || "表示行知随本轮请求发送的档位参数；提供商未返回可验证的内部推理投入回执。";
      entry.metrics.createSpan({
        cls: `xz-reasoning-profile-result is-${execution?.status || "model-default"}`,
        text: reasoningLabel,
        attr: { title: detail },
      });
      metricLabels.push(reasoningLabel);
    }
    if (metricsSummary) {
      entry.metrics.createSpan({ cls: "xz-response-metric is-total", text: metricsSummary.total });
      metricLabels.push(metricsSummary.total);
      metricsSummary.stages.forEach((stage) => {
        entry.metrics.createSpan({ cls: "xz-response-metric", text: stage });
        metricLabels.push(stage);
      });
      const tokenText = metricsSummary.token || "Token 未返回";
      entry.metrics.createSpan({
        cls: `xz-response-metric is-token${metricsSummary.tokenAvailable ? "" : " is-unavailable"}`,
        text: tokenText,
      });
      metricLabels.push(tokenText);
    }
    if (metricLabels.length) entry.metrics.setAttr("aria-label", metricLabels.join("；"));
    entry.metrics.toggleAttribute("hidden", metricLabels.length === 0);

    entry.references.empty();
    const references = asArray(message?.references || message?.sources);
    references.slice(0, 8).forEach((reference) => {
      const path = firstText(reference?.path, reference?.file, typeof reference === "string" ? reference : "");
      if (!path) return;
      const button = entry.references.createEl("button", { attr: { type: "button" } });
      const glyph = button.createSpan({ attr: { "aria-hidden": "true" } });
      setIcon(glyph, "file-text");
      button.createSpan({ text: firstText(reference?.label, reference?.title, path) });
      button.addEventListener("click", () => this.openVaultPath(path));
    });
    entry.references.toggleAttribute("hidden", references.length === 0);
  }

  openImagePreview(image) {
    this.imagePreviewModal?.close();
    this.imagePreviewModal = new AttachmentImagePreviewModal(this.app, {
      ...image, onOpenPath: (path) => { void this.openVaultPath(path); },
    });
    this.imagePreviewModal.open();
  }

  openDiagramPreview(svg, trigger = null) {
    this.diagramPreviewModal?.close();
    this.diagramPreviewModal = new MessageDiagramPreviewModal(this.app, svg, trigger);
    this.diagramPreviewModal.open();
  }

  createImageThumbnail(parent, image, cls) {
    const button = parent.createEl("button", {
      cls, attr: { type: "button", title: "点击放大图片", "aria-label": `放大图片：${image.name}` },
    });
    const showUnavailable = () => {
      button.empty();
      button.createSpan({ cls: "xz-image-unavailable", text: "原图不可用" });
      button.disabled = true;
      button.setAttr("title", "原图可能已移动或删除");
    };
    if (!image.url) { showUnavailable(); return button; }
    const img = button.createEl("img", {
      attr: { src: image.url, alt: image.name, loading: "lazy", decoding: "async" },
    });
    img.addEventListener("error", showUnavailable, { once: true });
    button.addEventListener("click", () => this.openImagePreview(image));
    return button;
  }

  async uploadedImageSource(reference) {
    const sourcePath = firstText(reference?.path, typeof reference === "string" ? reference : "");
    const directPath = uploadedImagePath(sourcePath);
    if (!directPath && (!sourcePath.startsWith("12_资料库/导入资料/资料记录/")
      || sourcePath.split("/").some((part) => !part || part === "." || part === "..")
      || !sourcePath.endsWith(".md"))) return null;
    const vault = this.app?.vault;
    if (!vault || typeof vault.getAbstractFileByPath !== "function") return null;
    let pending = this.uploadedImageSources.get(sourcePath);
    if (!pending) {
      pending = (async () => {
        let imagePath = directPath;
        let hash = "";
        if (!imagePath) {
          const evidenceFile = vault.getAbstractFileByPath(sourcePath);
          if (!evidenceFile || evidenceFile.extension !== "md") return null;
          const record = await vault.cachedRead(evidenceFile);
          if (!/^source_kind:\s*["']?uploaded-document["']?\s*$/mu.test(record)) return null;
          const original = record.match(/^- 原文件[：:]\s*\[\[([^\]|\r\n]+)(?:\|[^\]\r\n]*)?\]\]/mu);
          imagePath = uploadedImagePath(original?.[1]);
          if (!imagePath) return null;
          hash = record.match(/^sha256:\s*["']?([a-f0-9]{64})/mu)?.[1] || "";
        }
        const file = vault.getAbstractFileByPath(imagePath);
        return {
          path: imagePath, hash,
          url: file && typeof vault.getResourcePath === "function" ? vault.getResourcePath(file) : "",
        };
      })().catch(() => null);
      this.uploadedImageSources.set(sourcePath, pending);
    }
    const source = await pending;
    if (!source) { this.uploadedImageSources.delete(sourcePath); return null; }
    return { ...source, name: firstText(reference?.label, source.path.split("/").pop(), "上传的图片") };
  }

  renderGeneratedMessageImages(entry, message) {
    if (!entry.generatedImages) return;
    const references = message?.mediaKind === "generated-image" && !message.chatImage && !message.contentDeletedAt
      ? asArray(message.references).slice(0, 12) : [];
    const signature = JSON.stringify(references.map((reference) => [reference?.path || reference, reference?.label]));
    if (entry.generatedImageSignature === signature) return;
    entry.generatedImageSignature = signature;
    const version = entry.generatedImageRenderVersion = Number(entry.generatedImageRenderVersion || 0) + 1;
    entry.generatedImages.empty();
    entry.generatedImages.toggleAttribute("hidden", true);
    if (!references.length) return;

    const vault = this.app?.vault;
    const seen = new Set();
    for (const reference of references) {
      const path = generatedImagePath(reference?.path || reference);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      const file = vault?.getAbstractFileByPath?.(path) || null;
      const url = file && typeof vault?.getResourcePath === "function" ? vault.getResourcePath(file) : "";
      this.createImageThumbnail(entry.generatedImages, {
        path,
        url,
        name: firstText(reference?.label, path.split("/").pop(), "AI 生成图片"),
      }, "xz-generated-image");
    }
    if (entry.generatedImageRenderVersion === version) {
      entry.generatedImages.toggleAttribute("hidden", seen.size === 0);
    }
  }

  renderChatImage(entry, task, message = null) {
    const container = entry.chatImage;
    if (!container) return;
    if (message?.contentDeletedAt) task = null;
    if (!task || typeof task !== "object") {
      entry.chatImageSignature = "";
      container.empty();
      container.toggleAttribute("hidden", true);
      return;
    }

    const signature = JSON.stringify([
      task,
      message?.references || null,
      message?.contentDeletedAt || "",
    ]);
    if (entry.chatImageSignature === signature) return;
    entry.chatImageSignature = signature;
    container.empty();
    container.toggleAttribute("hidden", false);

    const state = firstText(task.status);
    const stateLine = container.createEl("p", {
      cls: "xz-chat-image-status",
      attr: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
    });
    if (["awaiting-confirmation", "generating", "saving"].includes(state)) {
      stateLine.setText("图片生成功能已取消，本次不会继续或发送新的请求");
      return;
    }

    const stateLabels = {
      completed: "图片生成完成。",
      failed: "本次图片生成失败；没有自动重试收费请求。",
      declined: "你选择了不生成图片，行知会继续处理文字。",
      cancelled: "本次图片生成已取消。",
    };
    stateLine.setText(stateLabels[state] || "图片生成状态暂不可用。");
    if (state === "completed") {
      container.createEl("p", {
        cls: "xz-chat-image-disclosure",
        text: "这是 AI 生成内容，不是现实证据。",
      });
    }
    if (task.error) {
      container.createEl("p", {
        cls: state === "failed" || state === "cancelled" ? "xz-chat-image-error" : "xz-chat-image-note",
        attr: state === "failed" || state === "cancelled" ? { role: "alert" } : {},
        text: firstText(task.error),
      });
    }

    const taskPath = state === "completed" || state === "cancelled" ? generatedImagePath(task.path) : "";
    const hasExactMessageReference = Boolean(taskPath) && asArray(message?.references).some((reference) => {
      const referencePath = generatedImagePath(firstText(reference?.path, typeof reference === "string" ? reference : ""));
      return referencePath === taskPath;
    });
    const path = hasExactMessageReference ? taskPath : "";
    if (path) {
      const vault = this.app?.vault;
      const file = vault?.getAbstractFileByPath?.(path) || null;
      const filePath = firstText(file?.path).replace(/\\/gu, "/");
      const extension = firstText(file?.extension).toLowerCase();
      const isExactImageFile = filePath === path && ["png", "jpg", "jpeg", "webp"].includes(extension);
      if (isExactImageFile && typeof vault?.getResourcePath === "function") {
        const url = vault.getResourcePath(file);
        container.createEl("p", {
          cls: "xz-chat-image-local-state",
          text: "图片已保存在本地 Vault。",
        });
        this.createImageThumbnail(container, {
          path,
          url,
          name: "AI 生成图片",
        }, "xz-chat-generated-image");
        if (state === "cancelled") {
          container.createEl("p", {
            cls: "xz-chat-image-disclosure",
            text: "该本地图片来自停止前已开始的生成，不代表现实证据。",
          });
        }
      } else {
        container.createEl("p", {
          cls: "xz-chat-image-error",
          attr: { role: "alert" },
          text: "生成记录中的本地图片文件当前不存在或无法读取；没有自动重试。",
        });
      }
    } else if (state === "completed") {
      container.createEl("p", {
        cls: "xz-chat-image-error",
        attr: { role: "alert" },
        text: "生成记录没有同时匹配本条消息引用的可验证本地图片；没有自动重试。",
      });
    }
  }

  renderMessageImages(entry, message) {
    if (!entry.images) return;
    const references = message && !message.contentDeletedAt ? asArray(message.references).slice(0, 20) : [];
    const send = this.attachmentSends?.get(normalizeId(this.getActiveConversation?.()));
    const pendingImages = message && !message.contentDeletedAt && send && send.messageId === message.id
      ? asArray(send.items).filter((item) => item.kind === "image") : [];
    const signature = JSON.stringify([references, pendingImages.map((item) => item.id)]);
    if (entry.imageSignature === signature) return;
    entry.imageSignature = signature;
    const version = entry.imageRenderVersion = Number(entry.imageRenderVersion || 0) + 1;
    entry.images.empty();
    entry.images.toggleAttribute("hidden", true);
    if (pendingImages.length) {
      for (const item of pendingImages) this.renderQueuedImage(entry.images, item, "xz-message-image");
      entry.images.toggleAttribute("hidden", false);
      return;
    }
    if (!references.length) return;
    void Promise.all(references.map((reference) => this.uploadedImageSource(reference))).then((sources) => {
      if (entry.imageRenderVersion !== version) return;
      const seen = new Set();
      for (const source of sources) {
        if (!source || seen.has(source.hash || source.path)) continue;
        seen.add(source.hash || source.path);
        this.createImageThumbnail(entry.images, source, "xz-message-image");
      }
      entry.images.toggleAttribute("hidden", seen.size === 0);
    });
  }

  renderMessageAttachmentStatus(entry, message) {
    if (!entry.attachmentStatus) return;
    const conversationId = normalizeId(this.getActiveConversation());
    const send = this.attachmentSends.get(conversationId);
    const visible = Boolean(message && !message.contentDeletedAt && send && send.messageId === message.id);
    entry.attachmentStatus.empty();
    entry.attachmentStatus.toggleAttribute("hidden", !visible);
    if (!visible) return;
    const failed = send.presentation.status === "error";
    entry.attachmentStatus.toggleClass("is-error", failed);
    const read = asArray(message.references).length > 0;
    const label = failed ? send.presentation.detail : read
      ? (send.purpose === "knowledge" ? "已读取，正在整理…" : send.purpose === "reference" ? "正在保存本地资料…" : "已读取，正在处理…")
      : send.presentation.detail;
    entry.attachmentStatus.createSpan({ text: label });
    const documents = asArray(send.items).filter((item) => item.kind !== "image");
    if (documents.length) entry.attachmentStatus.createSpan({
      cls: "xz-message-attachment-names", text: documents.map((item) => item.name).join("、"),
    });
  }

  releaseUnusedAttachmentPreviews() {
    const activeIds = new Set([
      ...[...this.attachmentQueues.values()].flatMap((items) => items.map((item) => item.id)),
      ...[...(this.attachmentSends?.values() || [])].flatMap((send) => asArray(send.items).map((item) => item.id)),
    ]);
    for (const [id, preview] of this.attachmentPreviewUrls) {
      if (activeIds.has(id)) continue;
      if (preview.url) {
        if (this.imagePreviewModal?.image?.url === preview.url) this.imagePreviewModal.close();
        preview.urlApi.revokeObjectURL(preview.url);
      }
      this.attachmentPreviewUrls.delete(id);
    }
  }

  renderQueuedImage(parent, item, imageClass = "xz-queued-image") {
    const slot = parent.createDiv({ cls: imageClass === "xz-message-image" ? "xz-message-image-slot" : "xz-queued-image-slot" });
    slot.createSpan({ cls: "xz-image-unavailable", text: "加载预览…" });
    let preview = this.attachmentPreviewUrls.get(item.id);
    if (!preview) {
      preview = { url: "", urlApi: this.viewDocument?.defaultView?.URL || globalThis.URL, promise: null };
      this.attachmentPreviewUrls.set(item.id, preview);
      preview.promise = (async () => {
        const { bytes } = await readBoundedAttachment(item);
        if (!bytes || this.attachmentPreviewUrls.get(item.id) !== preview) return "";
        const BlobClass = this.viewDocument?.defaultView?.Blob || globalThis.Blob;
        preview.url = preview.urlApi.createObjectURL(new BlobClass([bytes], { type: item.mimeType }));
        return preview.url;
      })().catch(() => "");
    }
    void preview.promise.then((url) => {
      if (!slot.isConnected || this.attachmentPreviewUrls.get(item.id) !== preview) return;
      slot.empty();
      if (url) this.createImageThumbnail(slot, { url, name: item.name }, imageClass);
      else slot.createSpan({ cls: "xz-image-unavailable", text: "无法预览" });
    });
  }

  streamingTurnState(conversationId) {
    const runtimeTurn = this.turnForConversation(conversationId);
    const runtimeStatus = firstText(runtimeTurn?.status).toLowerCase();
    const runtimeActive = Boolean(runtimeTurn)
      && ["running", "in_progress", "streaming", "starting", "waiting_approval", "waiting"].includes(runtimeStatus);
    if (runtimeActive) {
      this.pendingThinkingTurns.delete(conversationId);
      return { turn: runtimeTurn, status: runtimeStatus, active: true, preflight: false };
    }
    const pendingTurn = this.pendingThinkingTurns.get(conversationId) || null;
    return pendingTurn
      ? { turn: pendingTurn, status: "starting", active: true, preflight: true }
      : { turn: null, status: "", active: false, preflight: false };
  }

  renderStreamingTurn() {
    const activeConversationId = normalizeId(this.getActiveConversation());
    const state = this.streamingTurnState(activeConversationId);
    const { turn, status, active, preflight } = state;
    if (!active) {
      this.hideStreamingTurn();
      return;
    }
    const conversation = this.getActiveConversation();
    const conversationMessages = asArray(conversation?.messages);
    if (isInternalTurn(conversationMessages, turn?.assistantMessageId)) {
      this.hideStreamingTurn();
      return;
    }
    const scroll = this.refs.messageScroll;
    const shouldFollowLatest = this.messageScrollFollowLatest && this.messageScrollIsAtBottom(scroll);
    this.refs.streaming.toggleAttribute("hidden", false);
    this.refs.streaming.setAttr?.(
      "aria-label",
      preflight ? "行知正在思考，正在解析问题语义" : "行知正在回复",
    );
    const streamingMessage = visibleStreamingMessage(conversationMessages, turn?.assistantMessageId);
    const streamingMessageId = firstText(turn?.assistantMessageId, streamingMessage?.id, streamingMessage?.messageId);
    this.refs.streaming.setAttr?.("data-message-id", streamingMessageId || null);
    const previousImageSignature = this.refs.streamingChatImageEntry?.chatImageSignature || "";
    this.renderChatImage(
      this.refs.streamingChatImageEntry,
      streamingMessage?.chatImage,
      streamingMessage,
    );
    const text = preflight
      ? "正在解析你的问题语义…"
      : firstRawText(turn.outputText, turn.text, turn.content, turn.delta, messageText(streamingMessage));
    const streamingText = text || "正在理解你的问题并读取相关资料…";
    const previousText = String(this.refs.streamingText.textContent || "");
    const textChanged = previousText !== streamingText;
    if (textChanged) {
      const textNode = this.refs.streamingText.firstChild;
      if (textNode?.nodeType === 3 && typeof textNode.appendData === "function"
        && streamingText.startsWith(previousText)) {
        textNode.appendData(streamingText.slice(previousText.length));
      } else {
        this.refs.streamingText.setText(streamingText);
      }
    }
    this.renderStreamingTiming(
      turn,
      status,
      streamingText,
      formatLiveDuration(turn?.phaseStartedAt || turn?.startedAt),
      formatLiveDuration(turn?.startedAt),
    );
    if (textChanged && shouldFollowLatest) {
      scroll.scrollTop = scroll.scrollHeight;
      this.messageScrollFollowLatest = true;
    }
    if (textChanged || previousImageSignature !== (this.refs.streamingChatImageEntry?.chatImageSignature || "")) {
      this.updateConversationNavigation({ updateLayout: true });
    }
  }

  hideStreamingTurn() {
    const stream = this.refs.streaming;
    if (!stream) return;
    const wasVisible = !stream.hasAttribute?.("hidden");
    const scrollAnchor = wasVisible ? this.captureMessageScrollAnchor() : null;
    const shouldFollowLatest = wasVisible
      && this.messageScrollFollowLatest
      && this.messageScrollIsAtBottom(this.refs.messageScroll);
    stream.toggleAttribute("hidden", true);
    stream.setAttr?.("data-message-id", null);
    if (this.refs.streamingText?.textContent) this.refs.streamingText.setText("");
    if (this.refs.streamingTiming?.textContent) this.refs.streamingTiming.setText("");
    this.refs.streamingChatImageEntry?.chatImage?.toggleAttribute("hidden", true);
    if (!wasVisible) return;
    this.invalidateMessageScrollRestore();
    this.applyMessageScrollAnchor(scrollAnchor, { followLatest: shouldFollowLatest });
    this.updateConversationNavigation({ updateLayout: true });
  }

  applyMessageScrollAnchor(anchor, { followLatest = false } = {}) {
    const scroll = this.refs.messageScroll;
    if (!scroll) return;
    if (followLatest) {
      scroll.scrollTop = scroll.scrollHeight;
      this.messageScrollFollowLatest = true;
    } else if (anchor?.messageId) {
      const target = this.messageAnchorTarget(anchor.messageId, anchor.kind);
      if (target?.element) {
        const targetTop = this.messageElementContentTop(target.element, target.kind);
        scroll.scrollTop = Math.max(0, targetTop - anchor.offset);
      } else {
        scroll.scrollTop = Number(anchor.scrollTop) || 0;
      }
      this.messageScrollFollowLatest = false;
    } else if (anchor) {
      scroll.scrollTop = Number(anchor.scrollTop) || 0;
      this.messageScrollFollowLatest = false;
    }
    this.rememberMessagePageScroll();
  }

  renderStreamingTiming(turn, status, text, stageDuration, totalDuration) {
    const phase = firstText(turn?.phase).toLowerCase();
    const statusLabel = status.includes("approval") || status === "waiting"
      ? "等待你的确认"
      : phase === "semantic-routing"
        ? "正在思考"
        : phase === "retrieving"
          ? "正在检索知识"
          : phase === "responding" || text
            ? "正在回复"
            : "正在思考";
    this.refs.streamingStatus.setText(`${statusLabel} · ${stageDuration}`);
    this.refs.streamingTiming.setText(`本轮已用 ${totalDuration}`);
  }

  refreshStreamingClock() {
    if (!this.refs.root?.isConnected || this.refs.streaming?.hasAttribute("hidden")) return;
    const activeConversationId = normalizeId(this.getActiveConversation());
    const { turn, status, active, preflight } = this.streamingTurnState(activeConversationId);
    if (!active) return;
    const streamingMessage = visibleStreamingMessage(
      asArray(this.getActiveConversation()?.messages),
      turn?.assistantMessageId,
    );
    const text = preflight ? "" : firstRawText(
      turn.outputText,
      turn.text,
      turn.content,
      turn.delta,
      messageText(streamingMessage),
    );
    this.renderStreamingTiming(
      turn,
      status,
      text,
      formatLiveDuration(turn?.phaseStartedAt || turn?.startedAt),
      formatLiveDuration(turn?.startedAt),
    );
  }

  getClarifications() {
    const conversation = this.getActiveConversation();
    const runtime = this.plugin?.state?.runtime || {};
    const activeConversationId = normalizeId(conversation);
    const panel = this.workPanelForConversation(activeConversationId);
    const activeTurn = this.turnForConversation(activeConversationId);
    return [
      ...asArray(conversation?.clarifications),
      ...asArray(runtime.clarifications),
      ...asArray(activeTurn?.clarifications),
      ...asArray(panel.clarifications),
    ].filter((item) => !item?.conversationId || item.conversationId === activeConversationId);
  }

  getKnowledgeConfirmations() {
    const activeConversationId = normalizeId(this.getActiveConversation());
    const work = this.workPanelForConversation(activeConversationId);
    const background = this.backgroundWorkPanelForConversation(activeConversationId);
    const seen = new Set();
    return [...asArray(work.confirmations), ...asArray(background.confirmations)].filter((item) => {
      if (!item?.id || seen.has(item.id)
        || (item.conversationId && item.conversationId !== activeConversationId)) return false;
      seen.add(item.id);
      return true;
    });
  }

  renderKnowledgeManifest(parent, confirmation, options = {}) {
    const category = confirmation?.category || {};
    const file = confirmation?.file || {};
    const retrieval = confirmation?.retrieval || {};
    const source = confirmation?.source || {};
    const tags = asArray(confirmation?.tags);
    const aliases = asArray(confirmation?.aliases);
    const relations = asArray(confirmation?.relatedKnowledge);
    const path = firstText(file.path, confirmation?.path);
    const manifest = parent.createEl("section", { cls: `xz-knowledge-manifest${options.compact ? " is-compact" : ""}` });
    const compact = options.compact === true;

    const content = manifest.createDiv({ cls: "xz-knowledge-content" });
    content.createEl("span", { cls: "xz-manifest-label", text: "准备写入的内容" });
    content.createEl("p", { text: firstText(confirmation?.content, "没有可显示的知识正文，当前项目不可确认写入。") });

    const facts = manifest.createEl("dl", { cls: "xz-knowledge-facts" });
    const addFact = (label, value, className = "") => {
      facts.createEl("dt", { text: label });
      facts.createEl("dd", { cls: className, text: value || "未提供" });
    };
    addFact("知识分类", firstText(category.label, category.knowledgeType));
    addFact("写入目录", firstText(category.directory, path ? path.split("/").slice(0, -1).join("/") : ""), "xz-path-value");
    addFact("文件名", firstText(file.name, path ? path.split("/").at(-1) : ""), "xz-path-value");
    addFact("完整路径", path, "xz-path-value");

    if (compact) {
      const chips = manifest.createDiv({ cls: "xz-manifest-chips" });
      tags.forEach((tag) => chips.createSpan({ text: `#${firstText(tag)}` }));
      const hint = manifest.createEl("details", { cls: "xz-compact-manifest-details" });
      hint.createEl("summary", { text: "查看关联、来源与调用方式" });
      const relatedText = relations.length
        ? relations.map((item) => `${firstText(item?.relationLabel, "相关")}：${firstText(item?.label, item?.path)}`).join("；")
        : "暂无明确关联知识";
      hint.createEl("p", { text: `关联知识：${relatedText}` });
      hint.createEl("p", { text: `来源依据：对话 ${firstText(source.conversationId, "未知")} · 消息 ${firstText(source.messageId, "未知")}` });
      hint.createEl("p", { text: `下次调用：${asArray(retrieval.terms).map(firstText).filter(Boolean).join("、") || "标题与正文关键词"}` });
      return manifest;
    }

    const taxonomy = manifest.createDiv({ cls: "xz-manifest-section" });
    taxonomy.createEl("span", { cls: "xz-manifest-label", text: "标签" });
    const tagList = taxonomy.createDiv({ cls: "xz-manifest-chips" });
    if (tags.length) tags.forEach((tag) => tagList.createSpan({ text: `#${firstText(tag)}` }));
    else tagList.createSpan({ cls: "is-empty", text: "暂无标签" });
    taxonomy.createEl("span", { cls: "xz-manifest-label", text: "别名" });
    const aliasList = taxonomy.createDiv({ cls: "xz-manifest-chips" });
    if (aliases.length) aliases.forEach((alias) => aliasList.createSpan({ text: firstText(alias) }));
    else aliasList.createSpan({ cls: "is-empty", text: "暂无别名" });

    const relationSection = manifest.createDiv({ cls: "xz-manifest-section" });
    relationSection.createEl("span", { cls: "xz-manifest-label", text: "关联知识" });
    const relationList = relationSection.createDiv({ cls: "xz-manifest-relations" });
    if (!relations.length) relationList.createEl("p", { text: "暂未识别出明确关联；写入后仍可通过来源、标签和正文检索。" });
    relations.forEach((relation) => {
      const row = relationList.createDiv({ cls: "xz-manifest-relation" });
      row.createSpan({ text: `${firstText(relation?.relationLabel, "相关")}：` });
      const relationPath = firstText(relation?.path);
      if (relationPath && typeof this.plugin?.openVaultPath === "function") {
        const button = row.createEl("button", { cls: "xz-inline-link", text: firstText(relation?.label, relationPath), attr: { type: "button" } });
        button.addEventListener("click", () => this.openVaultPath(relationPath));
      } else {
        row.createEl("strong", { text: firstText(relation?.label, "未命名知识") });
        if (!relation?.resolved) row.createSpan({ cls: "xz-unresolved-label", text: "尚未解析为文件" });
      }
    });

    const provenance = manifest.createDiv({ cls: "xz-manifest-section" });
    provenance.createEl("span", { cls: "xz-manifest-label", text: "来源依据" });
    provenance.createEl("p", {
      text: `对话 ${firstText(source.conversationId, "未知")} · 消息 ${firstText(source.messageId, "未知")}`,
    });
    if (source.quotedText) provenance.createEl("blockquote", { text: source.quotedText });
    if (source.conversationPath && typeof this.plugin?.openVaultPath === "function") {
      const sourceButton = provenance.createEl("button", { cls: "xz-inline-link", text: "打开来源对话", attr: { type: "button" } });
      sourceButton.addEventListener("click", () => this.openVaultPath(source.conversationPath));
    }
    if (asArray(source.documents).length) {
      provenance.createEl("p", { text: `文档证据：${asArray(source.documents).map(firstText).join("、")}` });
    }

    const retrievalSection = manifest.createDiv({ cls: "xz-manifest-section" });
    retrievalSection.createEl("span", { cls: "xz-manifest-label", text: "下次如何调用" });
    const modes = asArray(retrieval.modes);
    const modeList = retrievalSection.createEl("ul", { cls: "xz-retrieval-modes" });
    modes.forEach((mode) => modeList.createEl("li", {
      text: `${firstText(mode?.label, mode?.id)}：${firstText(mode?.detail, "可用于重新定位这条知识。")}`,
    }));
    if (!modes.length) modeList.createEl("li", { text: "通过标题、标签、正文关键词和来源反向链接重新检索。" });
    retrievalSection.createEl("p", {
      text: `检索词：${asArray(retrieval.terms).map(firstText).filter(Boolean).join("、") || "使用标题与正文关键词"}`,
    });
    retrievalSection.createEl("p", { text: `冲突校验键：${firstText(retrieval.conflictKey, "未设置")}` });

    const rawMarkdown = firstText(confirmation?.pendingWrite?.content);
    if (rawMarkdown && !options.compact) {
      const details = manifest.createEl("details", { cls: "xz-markdown-preview" });
      details.createEl("summary", { text: "查看将写入的完整 Markdown" });
      details.createEl("pre", { text: rawMarkdown });
    }
    return manifest;
  }

  renderInteractiveCards({ force = false } = {}) {
    const clarifications = this.getClarifications();
    const activeConversation = this.getActiveConversation();
    const activeConversationId = normalizeId(activeConversation);
    const approvals = asArray(this.plugin?.state?.runtime?.approvals)
      .filter((item) => !item?.conversationId || item.conversationId === activeConversationId);
    const confirmations = this.getKnowledgeConfirmations();
    const organization = this.plugin?.state?.runtime?.conversationOrganization?.conversationId === activeConversationId
      ? this.plugin.state.runtime.conversationOrganization : null;
    const organizationInlineMode = conversationOrganizationInlineMode(organization || {});
    const pendingAgentRecommendation = this.pendingAgentForConversation(activeConversationId);
    const pendingSkillRecommendation = this.pendingSkillForConversation(activeConversationId);
    const agentRecommendation = !pendingAgentRecommendation?.conversationId
      || pendingAgentRecommendation.conversationId === activeConversationId ? pendingAgentRecommendation : null;
    const skillRecommendation = !pendingSkillRecommendation?.conversationId
      || pendingSkillRecommendation.conversationId === activeConversationId ? pendingSkillRecommendation : null;
    const signature = [
      ...clarifications.map((item, index) => [normalizeId(item, index), item?.status, firstText(item?.question, item?.title), asArray(item?.options).join(",")].join(":")),
      ...approvals.map((item, index) => [normalizeId(item, index), item?.status, firstText(item?.title, item?.kind), item?.path].join(":")),
      ...confirmations.map((item, index) => [normalizeId(item, index), item?.status, item?.candidateId, item?.reason].join(":")),
      organization ? [
        organization.userMessageId,
        organization.assistantMessageId,
        organization.status,
        organization.pending,
        organization.written,
        organization.error,
      ].join(":") : "",
      agentRecommendation ? [agentRecommendation.id, agentRecommendation.agentId, agentRecommendation.reason].join(":") : "",
      skillRecommendation ? [skillRecommendation.id, ...asArray(skillRecommendation.skills).map(normalizeId)].join(":") : "",
      [activeConversation?.archiveStatus, activeConversation?.archiveError, activeConversation?.archivedAt].join(":"),
    ].join("|");
    if (!force && signature === this.lastInteractiveSignature) return;
    this.lastInteractiveSignature = signature;
    const host = this.refs.interactiveCards;
    host.empty();

    if (organization && organizationInlineMode !== "hidden") {
      const captureCard = host.createEl("section", {
        cls: "xz-inline-card xz-knowledge-capture-card",
      });
      const captureIcon = captureCard.createDiv({
        cls: "xz-inline-card-icon",
        attr: { "aria-hidden": "true" },
      });
      setIcon(captureIcon, "database-zap");
      const captureBody = captureCard.createDiv({ cls: "xz-inline-card-body" });
      captureBody.createEl("span", { cls: "xz-card-kicker", text: "知识沉淀检查" });
      const pendingCount = Math.max(0, Number(organization.pending) || 0);
      if (organizationInlineMode === "progress") {
        captureBody.createEl("h3", { text: "正在为本轮生成可检索标题、标签和知识线索" });
        captureBody.createEl("p", {
          text: "基础对话条目会先自动保存；低风险正式知识是否自动写入，取决于当前权限和本地风险策略。",
        });
      } else {
        captureBody.createEl("h3", {
          text: `发现 ${pendingCount || "若干"} 条仍需审核的正式知识线索`,
        });
        captureBody.createEl("p", {
          text: "对话条目已经可检索；下面这些敏感、冲突、替换或推断项仍需逐条查看后才能进入正式知识。",
        });
      }
    }

    if (agentRecommendation) {
      const card = host.createEl("section", { cls: "xz-inline-card xz-capability-card xz-agent-recommendation" });
      const icon = card.createDiv({ cls: "xz-inline-card-icon", attr: { "aria-hidden": "true" } });
      setIcon(icon, "bot");
      const body = card.createDiv({ cls: "xz-inline-card-body" });
      body.createEl("span", { cls: "xz-card-kicker", text: "Agent 智能推荐" });
      body.createEl("h3", { text: `建议本轮调用：${firstText(agentRecommendation.label, agentRecommendation.agentId)}` });
      body.createEl("p", { text: firstText(agentRecommendation.reason, "本轮任务与该专业智能体更匹配。") });
      const actions = body.createDiv({ cls: "xz-card-actions" });
      const canRespond = typeof this.plugin?.respondAgentRecommendation === "function";
      [
        ["本轮调用", "once", "xz-primary-button"],
        ["切换本对话 Agent", "lock", "xz-secondary-button"],
        ["忽略", "ignore", "xz-text-button"],
      ].forEach(([label, decision, cls]) => {
        const button = actions.createEl("button", { cls, text: label, attr: { type: "button" } });
        button.disabled = !canRespond;
        button.addEventListener("click", () => this.respondAgentRecommendation(agentRecommendation.id, decision, actions));
      });
    }

    if (skillRecommendation) {
      const card = host.createEl("section", { cls: "xz-inline-card xz-capability-card xz-skill-recommendation" });
      const icon = card.createDiv({ cls: "xz-inline-card-icon", attr: { "aria-hidden": "true" } });
      setIcon(icon, "wand-sparkles");
      const body = card.createDiv({ cls: "xz-inline-card-body" });
      body.createEl("span", { cls: "xz-card-kicker", text: "Skill 推荐" });
      body.createEl("h3", { text: "建议使用以下能力" });
      const choices = body.createDiv({ cls: "xz-skill-choice-list" });
      this.pendingSkillSelection = new Set(asArray(skillRecommendation.skills).map(normalizeId));
      asArray(skillRecommendation.skills).forEach((skill) => {
        const id = normalizeId(skill);
        const row = choices.createEl("label", { cls: "xz-skill-choice-row" });
        const input = row.createEl("input", { attr: { type: "checkbox", value: id } });
        input.checked = true;
        const copy = row.createDiv();
        copy.createEl("strong", { text: normalizeLabel(skill, id) });
        copy.createEl("span", { text: firstText(skill?.reason, "与本轮任务相符") });
        input.addEventListener("change", () => {
          if (input.checked) this.pendingSkillSelection.add(id);
          else this.pendingSkillSelection.delete(id);
        });
      });
      const actions = body.createDiv({ cls: "xz-card-actions" });
      const canRespond = typeof this.plugin?.respondSkillRecommendation === "function";
      const all = actions.createEl("button", { cls: "xz-primary-button", text: "全部使用", attr: { type: "button" } });
      all.disabled = !canRespond;
      all.addEventListener("click", () => this.respondSkillRecommendation(skillRecommendation.id, "all", [], actions));
      const selected = actions.createEl("button", { cls: "xz-secondary-button", text: "选择使用", attr: { type: "button" } });
      selected.disabled = !canRespond;
      selected.addEventListener("click", () => this.respondSkillRecommendation(
        skillRecommendation.id,
        "selected",
        [...this.pendingSkillSelection],
        actions,
      ));
      const none = actions.createEl("button", { cls: "xz-text-button", text: "不使用", attr: { type: "button" } });
      none.disabled = !canRespond;
      none.addEventListener("click", () => this.respondSkillRecommendation(skillRecommendation.id, "none", [], actions));
    }

    clarifications.filter((item) => !["answered", "resolved", "dismissed"].includes(item?.status)).forEach((item, index) => {
      const card = host.createEl("section", { cls: "xz-inline-card xz-clarification-card" });
      const icon = card.createDiv({ cls: "xz-inline-card-icon", attr: { "aria-hidden": "true" } });
      setIcon(icon, "circle-help");
      const body = card.createDiv({ cls: "xz-inline-card-body" });
      body.createEl("span", { cls: "xz-card-kicker", text: "需要澄清" });
      body.createEl("h3", { text: firstText(item?.question, item?.title, "请补充一项信息") });
      const detail = firstText(item?.description, item?.reason, item?.context);
      if (detail) body.createEl("p", { text: detail });
      const actions = body.createDiv({ cls: "xz-card-actions" });
      asArray(item?.options).forEach((option) => {
        const optionText = typeof option === "string" ? option : firstText(option?.label, option?.text, option?.value);
        if (!optionText) return;
        const button = actions.createEl("button", { cls: "xz-secondary-button", text: optionText, attr: { type: "button" } });
        button.addEventListener("click", () => this.replyWith(optionText));
      });
      const reply = actions.createEl("button", { cls: "xz-text-button", text: "自己补充", attr: { type: "button" } });
      reply.addEventListener("click", () => { void this.openClarificationDialog(item, index); });
    });

    confirmations.filter((item) => !["accepted", "declined", "resolved"].includes(item?.status)).forEach((confirmation, index) => {
      const id = confirmation?.id ?? confirmation?.candidateId ?? `knowledge-confirmation-${index}`;
      const card = host.createEl("section", { cls: "xz-inline-card xz-approval-card" });
      const icon = card.createDiv({ cls: "xz-inline-card-icon", attr: { "aria-hidden": "true" } });
      setIcon(icon, "file-question");
      const body = card.createDiv({ cls: "xz-inline-card-body" });
      body.createEl("span", {
        cls: "xz-card-kicker",
        text: confirmation?.reviewKind === "major" ? "重大信息审核" : "知识写入确认",
      });
      body.createEl("h3", { text: firstText(confirmation?.title, "有一项知识候选需要确认") });
      body.createEl("p", { text: firstText(confirmation?.reason, "确认后才会写入正式知识库。") });
      body.createEl("p", { text: "可稍后处理，不影响继续对话；确认前不会写入正式知识库。" });
      this.renderKnowledgeManifest(body, confirmation);
      const actions = body.createDiv({ cls: "xz-card-actions" });
      const canRespond = typeof this.plugin?.respondKnowledgeConfirmation === "function";
      const accept = actions.createEl("button", { cls: "xz-primary-button", text: "确认写入", attr: { type: "button" } });
      accept.disabled = !canRespond;
      accept.addEventListener("click", () => this.respondKnowledgeConfirmation(id, "accept", actions));
      const decline = actions.createEl("button", { cls: "xz-text-button is-danger", text: "不写入", attr: { type: "button" } });
      decline.disabled = !canRespond;
      decline.addEventListener("click", () => this.respondKnowledgeConfirmation(id, "decline", actions));
      if (!canRespond) body.createEl("p", { text: "当前运行层尚未提供知识确认接口，此项不会自动写入。" });
    });

    approvals.filter((item) => !["accepted", "declined", "cancelled", "resolved"].includes(item?.status)).forEach((approval, index) => {
      const id = approval?.id ?? `approval-${index}`;
      const card = host.createEl("section", { cls: "xz-inline-card xz-approval-card" });
      const icon = card.createDiv({ cls: "xz-inline-card-icon", attr: { "aria-hidden": "true" } });
      setIcon(icon, approval?.kind === "write" || approval?.type === "write" ? "file-pen-line" : "shield-alert");
      const body = card.createDiv({ cls: "xz-inline-card-body" });
      body.createEl("span", { cls: "xz-card-kicker", text: approval?.kind === "write" ? "写入确认" : "权限确认" });
      body.createEl("h3", { text: firstText(approval?.title, approval?.summary, "Codex 请求执行一项操作") });
      const detail = firstText(
        approval?.description,
        approval?.reason,
        approval?.command,
        approval?.path,
        approval?.params?.reason,
        approval?.params?.command,
        approval?.params?.path,
      );
      if (detail) body.createEl("p", { cls: "xz-approval-detail", text: detail });
      const actions = body.createDiv({ cls: "xz-card-actions" });
      const canApprove = typeof this.plugin?.respondApproval === "function";
      const accept = actions.createEl("button", { cls: "xz-primary-button", text: "本次允许", attr: { type: "button" } });
      accept.disabled = !canApprove;
      accept.addEventListener("click", () => this.respondApproval(id, "accept", actions));
      const session = actions.createEl("button", { cls: "xz-secondary-button", text: "本轮允许", attr: { type: "button" } });
      session.disabled = !canApprove;
      session.addEventListener("click", () => this.respondApproval(id, "acceptForSession", actions));
      const decline = actions.createEl("button", { cls: "xz-text-button is-danger", text: "拒绝", attr: { type: "button" } });
      decline.disabled = !canApprove;
      decline.addEventListener("click", () => this.respondApproval(id, "decline", actions));
    });

    host.toggleAttribute("hidden", host.childElementCount === 0);
  }

  getProviders() {
    const runtimeProviders = [
      ...asArray(this.plugin?.state?.providers),
      ...asArray(this.plugin?.state?.runtime?.providers),
    ];
    const merged = new Map(PROVIDER_FALLBACKS.map((item) => [item.id, item]));
    runtimeProviders.forEach((item) => {
      const id = normalizeId(item);
      if (id) merged.set(id, { ...merged.get(id), ...item, id });
    });
    return [...merged.values()];
  }

  providerLabel(id) {
    return normalizeLabel(this.getProviders().find((item) => normalizeId(item) === id), id || "Codex");
  }

  renderComposerPresentation() {
    if (!this.refs.composerModeChips || !this.refs.composerContextBar) return;
    const settings = stateSettings(this.plugin);
    const conversation = this.getActiveConversation();
    const draftTrainingAction = trainingResponseModeAction(this.refs.composerInput?.value || "");
    const presentation = buildComposerPresentation({
      sourceScope: settings.networkAccess === true ? "local-web" : "local",
      trainingModeActive: conversation?.trainingResponseModeActive === true,
      trainingSuppressedForTurn: draftTrainingAction === "skip" || draftTrainingAction === "exit",
    });
    this.refs.sourceScopeSelect.value = presentation.sourceScope;
    this.refs.composerModeChips.empty();
    for (const chip of presentation.modeChips) {
      if (chip.removable) {
        const button = this.refs.composerModeChips.createEl("button", {
          cls: `xz-mode-chip is-${chip.tone}`,
          attr: { type: "button", "aria-label": `退出${chip.label}`, title: `退出${chip.label}` },
        });
        button.createSpan({ text: chip.label });
        const close = button.createSpan({ cls: "xz-mode-chip-close", attr: { "aria-hidden": "true" } });
        setIcon(close, "x");
        button.addEventListener("click", () => this.exitTrainingModeFromChip());
      } else {
        this.refs.composerModeChips.createSpan({
          cls: `xz-mode-chip is-${chip.tone}`,
          text: chip.label,
        });
      }
    }
    this.refs.composerContextBar.toggleAttribute("hidden", presentation.modeChips.length === 0);
  }

  async exitTrainingModeFromChip() {
    const conversationId = normalizeId(this.getActiveConversation());
    if (!conversationId) return;
    if (typeof this.plugin?.setTrainingResponseModeActive === "function") {
      try {
        await this.plugin.setTrainingResponseModeActive(conversationId, false);
        this.renderComposerPresentation();
        this.refs.composerInput?.focus();
        return;
      } catch (error) {
        new Notice(`退出训练模式失败：${firstText(error?.message, error, "未知错误")}`);
        return;
      }
    }
    this.setComposerDraft("退出训练模式", { focus: false });
    await this.sendCurrentDraft();
  }

  renderRuntimeControls({ force = false } = {}) {
    const settings = stateSettings(this.plugin);
    const runtime = this.plugin?.state?.runtime || {};
    const providerId = firstText(settings.providerId, settings.provider, "codex");
    const modelId = firstText(settings.model);
    const conversation = this.getActiveConversation();
    const reasoningProfile = normalizeReasoningProfile(
      conversation?.reasoningProfile || settings.defaultReasoningProfile,
    );
    const agentMode = firstText(settings.agentMode, "orchestrator");
    const agentId = firstText(settings.agentId, settings.agent, "xingzhi-orchestrator");
    const providers = this.getProviders();
    const selectedProvider = providers.find((item) => normalizeId(item) === providerId);
    const allModels = asArray(runtime.models);
    const models = allModels.filter((item) => {
      const modelProvider = firstText(item?.providerId, item?.provider);
      return !modelProvider || modelProvider === providerId;
    });
    const selectedModelMetadata = models.find((item) => normalizeId(item) === modelId);
    const protocol = firstText(selectedProvider?.protocol, providerId === "codex"
      ? "codex-app-server" : providerId === "openai" ? "openai-responses" : "openai-chat-completions");
    const reasoningPreview = resolveReasoningExecution({
      requestedProfile: reasoningProfile,
      automaticEffort: "high",
      providerId,
      protocol,
      modelId,
      supportedEfforts: selectedModelMetadata?.supportedReasoningEfforts,
    });
    const reasoningUnsupported = reasoningPreview.status === "model-default";
    const agents = visibleAgentProfiles(runtime.agents);
    const turnStatus = firstText(this.turnForConversation()?.status).toLowerCase();
    const turnActive = ["running", "in_progress", "streaming", "starting", "waiting", "waiting_approval"].includes(turnStatus);
    const signature = [
      providerId,
      modelId,
      reasoningProfile,
      reasoningUnsupported ? "reasoning-unsupported" : "reasoning-supported",
      agentMode,
      agentId,
      providers.map((item) => `${normalizeId(item)}:${normalizeLabel(item)}`).join(","),
      models.map((item) => `${normalizeId(item)}:${normalizeLabel(item)}`).join(","),
      agents.map((item) => `${normalizeId(item)}:${normalizeLabel(item)}`).join(","),
      turnActive ? "running" : "idle",
    ].join("|");
    if (force || signature !== this.lastControlSignature) {
      this.lastControlSignature = signature;
      this.fillSelect(this.refs.providerSelect, providers, providerId);
      this.fillSelect(this.refs.modelSelect, models, modelId, providerId === "codex" ? "正在读取可用模型…" : "尚未发现模型，请在设置中填写");
      this.fillSelect(this.refs.reasoningProfileSelect, PROFILE_OPTIONS, reasoningProfile);
      const reasoningOption = PROFILE_OPTIONS.find((item) => item.id === reasoningProfile);
      this.refs.reasoningProfileSelect.title = reasoningUnsupported
        ? "当前提供商或模型未配置手动推理档位；本轮将使用模型默认设置。已保存的选择会保留，切换到支持的模型后生效。"
        : `思考档位：${reasoningOption?.label || "自动"}。${reasoningOption?.description || ""}；仅控制推理投入，不控制回答长度。`;
      this.fillSelect(this.refs.agentModeSelect, AGENT_MODE_OPTIONS, agentMode);
      const selectedAgentId = agents.some((agent) => normalizeId(agent) === agentId)
        ? agentId : normalizeId(agents[0]);
      this.fillSelect(this.refs.agentSelect, agents, selectedAgentId, "尚未发现专业 Agent");
      const settingsLocked = turnActive || typeof this.plugin?.updateSettings !== "function";
      this.refs.providerSelect.disabled = settingsLocked;
      this.refs.modelSelect.disabled = settingsLocked || models.length === 0;
      this.refs.reasoningProfileSelect.disabled = settingsLocked || reasoningUnsupported
        || typeof this.plugin?.setConversationReasoningProfile !== "function";
      this.refs.agentModeSelect.disabled = settingsLocked;
      this.refs.agentSelect.disabled = settingsLocked || agents.length === 0;
      this.refs.agentSelect.closest(".xz-compact-select")?.toggleAttribute("hidden", agentMode !== "locked");
      if (this.refs.capabilityManagerButton) this.refs.capabilityManagerButton.disabled = turnActive;
      this.refs.skillPicker.toggleAttribute("hidden", false);
      this.refs.lensPicker.toggleAttribute("hidden", false);
    }
    this.renderSkillPicker({ force });
  }

  fillSelect(select, items, selectedId, emptyLabel = "暂无可用选项") {
    const active = document.activeElement === select;
    select.empty();
    if (!items.length) {
      const option = select.createEl("option", { text: emptyLabel, attr: { value: "", disabled: "" } });
      option.selected = true;
      select.disabled = true;
      return;
    }
    select.disabled = false;
    items.forEach((item) => {
      const id = normalizeId(item);
      const option = select.createEl("option", { text: normalizeLabel(item, id), attr: { value: id } });
      if (id === selectedId) option.selected = true;
    });
    if (selectedId && !items.some((item) => normalizeId(item) === selectedId)) {
      const option = select.createEl("option", { text: selectedId, attr: { value: selectedId } });
      option.selected = true;
    }
    if (active) select.focus();
  }

  renderSkillPicker({ force = false } = {}) {
    const settings = stateSettings(this.plugin);
    const mode = firstText(settings.skillMode, "auto");
    const schema2 = settings.skillPreferenceSchemaVersion === 2;
    const candidates = new Set(asArray(settings.fixedCandidateIds).map((item) => normalizeId(item)).filter(Boolean));
    const invocations = new Set(asArray(settings.fixedInvocationIds).map((item) => normalizeId(item)).filter(Boolean));
    const selected = new Set((schema2 ? [...candidates, ...invocations] : asArray(settings.selectedSkills || settings.skills))
      .map((item) => normalizeId(item)).filter(Boolean));
    const disabled = new Set(asArray(settings.disabledSkills).map((item) => normalizeId(item)).filter(Boolean));
    const skills = asArray(this.plugin?.state?.runtime?.skills);
    const lensIds = new Set(skills.filter((item) => normalizedSkillType(item) === "cognitive-lens").map(normalizeId));
    const activeConversationId = normalizeId(this.getActiveConversation());
    const nextTurn = this.nextTurnSkillSelections.get(activeConversationId) || new Set();
    const activeTurn = this.turnForConversation(activeConversationId);
    const settingsLocked = capabilityControlsLocked({
      turn: activeTurn,
      canUpdate: typeof this.plugin?.updateSettings === "function",
    });
    const fixedSignature = schema2 ? `2:${[...candidates].sort().join(",")}:${[...invocations].sort().join(",")}:${settings.controlledSkillLoading === true}` : "legacy";
    const signature = `${activeConversationId}|${mode}|${fixedSignature}|${settingsLocked}|${[...selected].sort().join(",")}|${[...disabled].sort().join(",")}|${[...nextTurn].sort().join(",")}|${skills.map((item) => `${normalizeId(item)}:${normalizeLabel(item)}:${normalizedSkillType(item)}:${item?.applicationMode || "legacy"}:${item?.instructionLoaded === false ? "unloaded" : "loaded"}`).join("|")}`;
    if (!force && signature === this.lastSkillSignature) return;
    this.lastSkillSignature = signature;
    const modeLabel = SKILL_MODE_OPTIONS.find((item) => item.id === mode)?.label || "被动建议";
    const taskNextTurn = [...nextTurn].filter((id) => !lensIds.has(id)).length;
    const lensNextTurn = [...nextTurn].filter((id) => lensIds.has(id)).length;
    const taskSelected = [...selected].filter((id) => !lensIds.has(id)).length;
    const lensSelected = [...selected].filter((id) => lensIds.has(id)).length;
    const oneTurnLabel = taskNextTurn ? ` · 下一轮调用 ${taskNextTurn}` : "";
    const taskSelectedLabel = mode === "auto" ? "固定候选" : "固定调用";
    const fixedSummary = (lens) => [["固定候选", candidates], ["固定调用", invocations]]
      .map(([label, ids]) => [label, [...ids].filter((id) => lensIds.has(id) === lens).length])
      .filter(([, count]) => count).map(([label, count]) => `${label} ${count}`).join(" · ");
    const taskFixedSummary = schema2 ? fixedSummary(false) : taskSelected ? `${taskSelectedLabel} ${taskSelected}` : "";
    this.refs.skillSummaryText.setText(`Skill：${modeLabel}${taskFixedSummary ? ` · ${taskFixedSummary}` : ""}${oneTurnLabel}`);
    const lensSelectedLabel = mode === "auto" ? "固定候选" : "固定调用";
    const lensFixedSummary = schema2 ? fixedSummary(true) : lensSelected ? `${lensSelectedLabel} ${lensSelected}` : "";
    this.refs.lensSummaryText.setText(`透镜：${modeLabel}${lensFixedSummary ? ` · ${lensFixedSummary}` : ""}${lensNextTurn ? ` · 下一轮调用 ${lensNextTurn}` : ""}`);
    const summaryLabel = settingsLocked
      ? `查看 Skill（当前：${modeLabel}；本对话回复结束后可修改）`
      : `选择 Skill（当前：${modeLabel}${taskNextTurn ? `；下一轮完整调用 ${taskNextTurn} 项` : ""}）`;
    this.refs.skillPickerSummary?.setAttr("aria-label", summaryLabel);
    this.refs.skillPickerSummary?.setAttr("title", summaryLabel);
    const lensLabel = settingsLocked
      ? `查看透镜（当前：${modeLabel}；本对话回复结束后可修改）`
      : `选择透镜（当前：${modeLabel}${lensFixedSummary ? `；${lensFixedSummary}` : ""}${lensNextTurn ? `；下一轮完整调用 ${lensNextTurn} 项` : ""}）`;
    this.refs.lensPickerSummary?.setAttr("aria-label", lensLabel);
    this.refs.lensPickerSummary?.setAttr("title", lensLabel);
    this.refs.skillPicker.toggleClass("has-fixed-skills", taskSelected > 0);
    this.refs.skillPicker.toggleClass("has-next-turn-skills", taskNextTurn > 0);
    this.refs.skillPicker.toggleClass("is-settings-locked", settingsLocked);
    this.refs.lensPicker.toggleClass("has-fixed-skills", lensSelected > 0);
    this.refs.lensPicker.toggleClass("has-next-turn-skills", lensNextTurn > 0);
    this.refs.lensPicker.toggleClass("is-settings-locked", settingsLocked);
  }

  // 把挑选器里被明确选中的能力补写进 capabilityStates。
  // 返回启用失败的条目（依赖缺失、尚未被 Codex 发现等），由调用方剔除并告知用户。
  async ensureCapabilitiesEnabled(ids) {
    const refused = [];
    if (typeof this.plugin?.setCapabilityEnabled !== "function") return refused;
    const wanted = [...new Set(asArray(ids).map((id) => String(id || "").trim()).filter(Boolean))];
    if (!wanted.length) return refused;
    for (const id of wanted) {
      const skill = asArray(this.plugin?.state?.runtime?.skills).find((item) => item?.name === id);
      if (!skill || skill.enabled !== false) continue;
      const label = String(skill.displayName || skill.label || id);
      if (skill.unavailableReason && skill.unavailableReason !== "扩展能力尚未启用") {
        refused.push({ id, label, reason: String(skill.unavailableReason) });
        continue;
      }
      try {
        await this.plugin.setCapabilityEnabled("skills", id, true);
      } catch (error) {
        refused.push({ id, label, reason: String(error?.message || error || "启用失败") });
      }
    }
    return refused;
  }

  openSkillPicker(category = "skill") {
    const activeConversationId = normalizeId(this.getActiveConversation());
    if (!activeConversationId) {
      new Notice(`当前没有可设置${category === "lens" ? "透镜" : " Skill"}的对话`);
      return;
    }
    const settings = stateSettings(this.plugin);
    const activeTurn = this.turnForConversation(activeConversationId);
    const locked = capabilityControlsLocked({
      turn: activeTurn,
      canUpdate: typeof this.plugin?.updateSettings === "function",
    });
    const catalog = asArray(this.plugin?.state?.runtime?.skills);
    const onlyCategory = (values) => categorySelection(values, catalog, category);
    const mergeCategory = (values, updates) => mergeCategorySelection(values, updates, catalog, category);
    const modal = new XingzhiSkillPickerModal(this.app, {
      category,
      skillMode: firstText(settings.skillMode, "auto"),
      skills: asArray(this.plugin?.state?.runtime?.skills),
      selectedSkills: onlyCategory(settings.selectedSkills || settings.skills),
      ...(settings.skillPreferenceSchemaVersion === 2 ? {
        skillPreferenceSchemaVersion: 2,
        fixedCandidateIds: onlyCategory(settings.fixedCandidateIds),
        fixedInvocationIds: onlyCategory(settings.fixedInvocationIds),
        controlledSkillLoading: settings.controlledSkillLoading === true,
      } : {}),
      disabledSkills: onlyCategory(settings.disabledSkills),
      nextTurnSkills: onlyCategory([...(this.nextTurnSkillSelections.get(activeConversationId) || [])]),
      locked,
      onSave: async (result) => {
        if (normalizeId(this.getActiveConversation()) !== activeConversationId) {
          throw new Error(`当前对话已经切换，请重新打开${category === "lens" ? "透镜" : " Skill"}设置`);
        }
        // 选中即启用：被设为「固定/下一轮」的扩展能力如果还没启用，这里替用户打开，
        // 否则路由会把 enabled === false 的 Skill 整条滤掉，用户的选择静默失效。
        const disabledSelection = new Set(asArray(result.disabledSkills));
        const refused = await this.ensureCapabilitiesEnabled([
          ...(result.skillPreferenceSchemaVersion === 2
            ? [...asArray(result.fixedCandidateIds), ...asArray(result.fixedInvocationIds)] : asArray(result.selectedSkills)),
          ...asArray(result.nextTurnSkills),
        ].filter((id) => !disabledSelection.has(id)));
        if (normalizeId(this.getActiveConversation()) !== activeConversationId) {
          throw new Error(`当前对话已经切换，请重新打开${category === "lens" ? "透镜" : " Skill"}设置`);
        }
        if (refused.length) {
          const blocked = new Set(refused.map((item) => item.id));
          result = {
            ...result,
            selectedSkills: asArray(result.selectedSkills).filter((id) => !blocked.has(id)),
            ...(result.skillPreferenceSchemaVersion === 2 ? {
              fixedCandidateIds: asArray(result.fixedCandidateIds).filter((id) => !blocked.has(id)),
              fixedInvocationIds: asArray(result.fixedInvocationIds).filter((id) => !blocked.has(id)),
            } : {}),
            nextTurnSkills: asArray(result.nextTurnSkills).filter((id) => !blocked.has(id)),
          };
          new Notice(`以下能力无法启用，已跳过：${refused.map((item) => `${item.label}（${item.reason}）`).join("；")}`);
        }
        const latest = stateSettings(this.plugin);
        const fixedFields = result.skillPreferenceSchemaVersion === 2 ? {
          skillPreferenceSchemaVersion: 2,
          fixedCandidateIds: mergeCategory(latest.fixedCandidateIds, result.fixedCandidateIds),
          fixedInvocationIds: mergeCategory(latest.fixedInvocationIds, result.fixedInvocationIds),
        } : null;
        await this.updateSettings({
          ...(category === "skill" ? { skillMode: result.skillMode } : {}),
          ...(fixedFields || {}),
          ...(fixedFields && category === "skill" ? { controlledSkillLoading: result.controlledSkillLoading === true } : {}),
          selectedSkills: fixedFields
            ? [...new Set([...fixedFields.fixedCandidateIds, ...fixedFields.fixedInvocationIds])]
            : mergeCategory(latest.selectedSkills || latest.skills, result.selectedSkills),
          disabledSkills: mergeCategory(latest.disabledSkills, result.disabledSkills),
        });
        const nextTurn = new Set(mergeCategory(
          [...(this.nextTurnSkillSelections.get(activeConversationId) || [])], result.nextTurnSkills,
        ));
        if (nextTurn.size) this.nextTurnSkillSelections.set(activeConversationId, nextTurn);
        else this.nextTurnSkillSelections.delete(activeConversationId);
        this.renderSkillPicker({ force: true });
      },
    });
    modal.open();
  }

  openCapabilityManager() {
    const modal = new XingzhiCapabilityManagerModal(this.app, this.plugin);
    modal.open();
  }

  renderWorkbenchRunSummary(parent, summary) {
    const host = parent.createEl("section", {
      cls: "xz-work-summary",
      attr: { "aria-label": "本轮工作摘要" },
    });
    const now = host.createEl("section", {
      cls: `xz-work-summary-card is-now is-${summary.now.tone}`,
    });
    const nowHead = now.createDiv({ cls: "xz-work-summary-card-head" });
    const nowTitle = nowHead.createDiv({ cls: "xz-work-summary-card-title" });
    nowTitle.createSpan({ cls: "xz-work-summary-dot", attr: { "aria-hidden": "true" } });
    nowTitle.createEl("h3", { text: "现在" });
    nowHead.createSpan({ cls: "xz-work-summary-percent", text: `${summary.now.progress}%` });
    now.createEl("strong", { cls: "xz-work-summary-value", text: summary.now.label });
    now.createEl("p", { text: summary.now.detail });
    const progress = now.createDiv({ cls: "xz-work-summary-progress", attr: { "aria-hidden": "true" } });
    const progressValue = progress.createDiv({ cls: "xz-work-summary-progress-value" });
    progressValue.style.width = `${summary.now.progress}%`;
    const phaseOrder = [
      ["understanding", "理解"],
      ["finding", "查找"],
      ["executing", "执行"],
      ["organizing", "整理"],
    ];
    const currentIndex = phaseOrder.findIndex(([id]) => id === summary.now.id);
    const phaseList = now.createDiv({ cls: "xz-work-summary-phases", attr: { "aria-label": "本轮工作阶段" } });
    phaseOrder.forEach(([id, label], index) => {
      const completed = summary.now.id === "completed" || currentIndex > index;
      const active = currentIndex === index;
      phaseList.createSpan({
        cls: `xz-work-summary-phase${completed ? " is-completed" : ""}${active ? " is-active" : ""}`,
        text: label,
      });
    });

    const cards = host.createDiv({ cls: "xz-work-summary-grid" });
    const cardModels = [
      { id: "sources", icon: "folder-search-2", title: "资料", ...summary.sources, value: summary.sources.label },
      { id: "capability", icon: "sparkles", title: "能力", ...summary.capability, value: summary.capability.label },
      { id: "changes", icon: "file-check-2", title: "变化", ...summary.changes, value: summary.changes.label },
    ];
    for (const cardModel of cardModels) {
      const card = cards.createEl("section", { cls: `xz-work-summary-card is-${cardModel.id}` });
      const head = card.createDiv({ cls: "xz-work-summary-card-head" });
      const title = head.createDiv({ cls: "xz-work-summary-card-title" });
      const icon = title.createSpan({ attr: { "aria-hidden": "true" } });
      setIcon(icon, cardModel.icon);
      title.createEl("h3", { text: cardModel.title });
      card.createEl("strong", { cls: "xz-work-summary-value", text: cardModel.value });
      const detail = cardModel.id === "sources"
        ? "只统计本轮已经识别到的来源"
        : cardModel.detail;
      card.createEl("p", { text: detail });
    }
    return host;
  }

  renderWorkPanel({ force = false } = {}) {
    const runtime = this.plugin?.state?.runtime || {};
    const activeConversation = this.getActiveConversation();
    const activeConversationId = normalizeId(activeConversation);
    const rawWork = this.workPanelForConversation(activeConversationId);
    const work = rawWork.conversationId && rawWork.conversationId !== activeConversationId
      ? { conversationId: activeConversationId }
      : rawWork;
    const rawBackgroundWork = this.backgroundWorkPanelForConversation(activeConversationId);
    const backgroundWork = rawBackgroundWork.conversationId
      && rawBackgroundWork.conversationId !== activeConversationId
      ? { conversationId: activeConversationId }
      : rawBackgroundWork;
    const settings = stateSettings(this.plugin);
    const sources = asArray(work.sources || work.readSources || work.references);
    const candidates = asArray(work.candidates || work.knowledgeCandidates);
    const writes = asArray(work.writes || work.transactions || work.changes);
    const skills = asArray(work.skills || work.usedSkills);
    const lensIds = new Set(asArray(runtime.skills)
      .filter((item) => normalizedSkillType(item) === "cognitive-lens").map(normalizeId));
    const isLens = (item) => normalizedSkillType(item) === "cognitive-lens" || lensIds.has(normalizeId(item));
    const taskSkills = skills.filter((item) => !isLens(item));
    const lensSkills = skills.filter(isLens);
    const executionPipeline = asArray(work.executionPipeline);
    const actualReadRoots = asArray(work.actualReadRoots);
    const matchedReadRoots = asArray(work.matchedReadRoots || work.readScopes);
    const plannedPrefetchRoots = asArray(work.plannedPrefetchRoots || work.plannedReadScopes);
    const readScopes = actualReadRoots;
    const plannedReadScopes = plannedPrefetchRoots;
    const reasoningPlan = work.reasoningPlan && typeof work.reasoningPlan === "object"
      ? work.reasoningPlan : {};
    const reasoningOperators = asArray(reasoningPlan.operators);
    const mandatoryGates = asArray(reasoningPlan.mandatoryGates);
    const coreVersion = firstText(reasoningPlan.coreVersion);
    const knowledgeSearch = work.knowledgeSearch || { status: "not-run", attempts: 0, hits: 0 };
    const evidenceRetrieval = work.evidenceRetrieval || {};
    const evidenceBridge = work.evidenceBridge || {};
    const environmentImpactReviews = asArray(work.environmentImpactReviews);
    const qualityEvaluation = work.qualityEvaluation || {};
    const diagnostics = asArray(this.plugin?.state?.turnDiagnostics)
      .filter(row => row.conversationId === activeConversationId && row.lane === "dialogue").slice(-10).reverse();
    const recovery = work.recovery || {};
    const capabilities = asArray(work.capabilities);
    const knowledgeSummary = work.knowledgeSummary || {};
    const organization = runtime.conversationOrganization?.conversationId === activeConversationId
      ? runtime.conversationOrganization : null;
    const turn = this.turnForConversation(activeConversationId);
    const decisions = asArray(work.decisions);
    const traceStatus = firstText(work.traceStatus, "empty");
    const decisionByCandidate = new Map(decisions.map((item) => [firstText(item?.candidateId), item]));
    const signature = [
      firstText(work.agent, work.agentId, settings.agentId),
      traceStatus,
      work.routingSource,
      work.routingConfidence,
      work.routingRiskLevel,
      work.routingReason,
      work.routingError,
      work.sourceMode,
      work.sourceReason,
      work.semanticUnderstanding?.context,
      work.webSearch?.contextClarification,
      work.webSearch?.answerRetrieval,
      work.webSearch?.actualCalls,
      work.agentStatus,
      work.agentReason,
      skills.map((item) => `${normalizeId(item)}:${normalizeLabel(item)}:${skillCallLabel(item)}:${JSON.stringify(item?.callState || null)}`).join(","),
      [...lensIds].sort().join(","),
      executionPipeline.map((stage) => `${normalizeId(stage)}:${stage?.status}:${asArray(stage?.selections).join(",")}`).join("|"),
      reasoningOperators.map((item) => `${normalizeId(item)}:${item?.phase || ""}`).join(","),
      mandatoryGates.join(","),
      coreVersion,
      readScopes.join(","),
      plannedReadScopes.join(","),
      knowledgeSearch.status,
      knowledgeSearch.attempts,
      knowledgeSearch.hits,
      JSON.stringify(evidenceRetrieval),
      JSON.stringify(evidenceBridge),
      JSON.stringify(environmentImpactReviews),
      JSON.stringify(qualityEvaluation),
      JSON.stringify(work.analysisPath),
      diagnostics.map(row => row.turnId).join(","),
      JSON.stringify(recovery),
      JSON.stringify(knowledgeSummary),
      JSON.stringify(organization),
      activeConversation?.archiveStatus,
      activeConversation?.archiveError,
      activeConversation?.archivedAt,
      sources.map((item) => firstText(
        item?.path,
        item?.file,
        item?.url,
        item?.title,
        item?.label,
        typeof item === "string" ? item : "",
      )).join(","),
      candidates.map((item) => {
        const decision = decisionByCandidate.get(firstText(item?.candidateId, item?.id));
        return [normalizeId(item), item?.status, item?.decision, decision?.decision, item?.title].join(":" );
      }).join(","),
      writes.map((item) => [normalizeId(item), item?.status, item?.path, item?.transactionId].join(":" )).join(","),
      backgroundWork.traceStatus,
      backgroundWork.recordedAt,
      backgroundWork.agentLabel,
      backgroundWork.structuredRetry?.attempt,
      backgroundWork.structuredRetry?.status,
      backgroundWork.structuredRetry?.lastError,
      asArray(backgroundWork.errors).join(","),
      turn?.status,
      turn?.error,
    ].join("|");
    if (!force && signature === this.lastWorkSignature) return;
    this.lastWorkSignature = signature;

    const panelBody = this.refs.workPanelBody;
    panelBody.empty();
    const workSummary = buildWorkbenchRunSummary({
      turn,
      work,
      backgroundWork,
      organization,
      skillCatalog: runtime.skills,
    });
    this.renderWorkbenchRunSummary(panelBody, workSummary);
    renderTurnAnalysisPathCard(panelBody, work.analysisPath);
    const technicalDetails = panelBody.createEl("details", { cls: "xz-work-technical-details" });
    technicalDetails.open = this.technicalDetailsDisclosure.isOpen(activeConversationId);
    const technicalSummary = technicalDetails.createEl("summary", { cls: "xz-work-technical-summary" });
    const technicalSummaryIcon = technicalSummary.createSpan({ attr: { "aria-hidden": "true" } });
    setIcon(technicalSummaryIcon, "chevron-right");
    const technicalSummaryLabel = technicalSummary.createSpan();
    const syncTechnicalDetailsState = () => {
      const expanded = technicalDetails.open === true;
      this.technicalDetailsDisclosure.setOpen(activeConversationId, expanded);
      technicalSummary.setAttr("aria-expanded", expanded ? "true" : "false");
      technicalSummary.setAttr("aria-label", expanded ? "收起技术详情" : "展开技术详情");
      technicalSummaryLabel.setText(expanded ? "收起技术详情" : "展开技术详情");
    };
    syncTechnicalDetailsState();
    technicalDetails.addEventListener("toggle", syncTechnicalDetailsState);
    const technicalBody = technicalDetails.createDiv({ cls: "xz-work-technical-body" });
    const mainTrace = technicalBody.createEl("section", { cls: "xz-trace-group is-main" });
    mainTrace.createEl("h3", { cls: "xz-trace-title", text: "主回答轨迹" });
    const body = mainTrace.createDiv({ cls: "xz-trace-content" });
    const backgroundTrace = technicalBody.createEl("section", { cls: "xz-trace-group is-background" });
    backgroundTrace.createEl("h3", { cls: "xz-trace-title", text: "后台整理轨迹" });
    const backgroundContent = backgroundTrace.createDiv({ cls: "xz-trace-content" });
    const backgroundStatus = firstText(backgroundWork.traceStatus, "empty");
    if (backgroundStatus === "empty" || !backgroundWork.conversationId) {
      backgroundContent.createEl("p", {
        cls: "xz-permission-note",
        text: "主回答完成后，这里单独显示成长与知识整理，不覆盖主回答轨迹。",
      });
    } else {
      const backgroundRow = backgroundContent.createDiv({ cls: "xz-work-key-value" });
      backgroundRow.createSpan({ text: "整理状态" });
      backgroundRow.createEl("strong", {
        text: backgroundStatus === "active"
          ? "整理中" : (backgroundStatus === "failed" ? "整理失败" : "整理完成"),
      });
      const retryRow = backgroundContent.createDiv({ cls: "xz-work-key-value is-top" });
      retryRow.createSpan({ text: "结构化重试" });
      const retryValue = retryRow.createDiv({ cls: "xz-work-value-stack" });
      const retry = backgroundWork.structuredRetry || {};
      const retryLabel = retry.status === "retrying"
        ? "首次结构校验失败 · 正在进行唯一一次重试"
        : retry.status === "succeeded"
          ? "第二次结构校验通过"
          : retry.status === "exhausted"
            ? "唯一一次重试后仍未通过"
            : "首次结构校验通过，无需重试";
      retryValue.createEl("strong", { text: retryLabel });
      if (retry.lastError) retryValue.createSpan({ text: `首次错误：${retry.lastError}` });
      const backgroundErrors = asArray(backgroundWork.errors);
      if (backgroundErrors.length) {
        const errorRow = backgroundContent.createDiv({ cls: "xz-work-key-value is-top" });
        errorRow.createSpan({ text: "后台错误" });
        errorRow.createEl("strong", { cls: "xz-danger-text", text: firstText(backgroundErrors.at(-1)) });
      }
    }
    if (traceStatus === "empty" || !work.conversationId) {
      const empty = body.createEl("section", { cls: "xz-work-section xz-work-overview is-empty" });
      empty.createEl("h3", { text: "尚无本轮调用记录" });
      empty.createEl("p", {
        cls: "xz-permission-note",
        text: "发送消息后，这里会依次显示联网方式、证据检索、Agent、Skill、计划、执行、质量验收和回答提交的真实状态。",
      });
      return;
    }
    const agentId = firstText(work.agentId, settings.agentId);
    const visibleAgent = agentId !== "xingzhi-orchestrator"
      ? firstText(work.agentLabel, work.agent, agentId) : "";
    const overview = body.createEl("section", { cls: "xz-work-section xz-work-overview" });
    overview.createEl("h3", { text: traceStatus === "restored" ? "上轮调用记录" : "能力配置" });
    if (traceStatus === "restored") {
      overview.createEl("p", {
        cls: "xz-permission-note",
        text: "这是当前对话上一次已保存的真实调用轨迹；发送新消息后会被本轮记录替换。",
      });
    }
    if (visibleAgent) {
      const agentRow = overview.createDiv({ cls: "xz-work-key-value" });
      agentRow.createSpan({ text: "本轮 Agent" });
      const agentValue = agentRow.createDiv({ cls: "xz-work-value-stack" });
      agentValue.createEl("strong", { text: visibleAgent });
      const agentStatusLabel = {
        locked: "已锁定到本对话",
        "recommended-once": "仅本轮调用",
        "recommendation-ignored": "已忽略专业推荐",
        automatic: "已按本轮自动切换",
      }[work.agentStatus] || "按本轮路由";
      agentValue.createSpan({ text: agentStatusLabel });
      if (work.agentReason) agentValue.createSpan({ text: work.agentReason });
    }
    const routingRow = overview.createDiv({ cls: "xz-work-key-value is-top" });
    routingRow.createSpan({ text: "路由依据" });
    const routingValue = routingRow.createDiv({ cls: "xz-work-value-stack" });
    const routingLabel = work.routingSource === "semantic-model"
      ? "历史模型路由"
      : work.routingSource === "local-intent"
        ? "自动能力选配"
      : work.routingSource === "deterministic-fallback"
        ? "基础能力选配"
        : "未执行";
    const confidence = typeof work.routingConfidence === "number"
      && Number.isFinite(work.routingConfidence)
      ? work.routingConfidence
      : null;
    routingValue.createEl("strong", {
      text: Number.isFinite(confidence)
        ? `${routingLabel} · ${work.routingSource === "semantic-model" ? "模型自报强度" : "规则匹配强度"} ${Math.round(confidence * 100)}%（非准确率）`
        : routingLabel,
    });
    if (work.routingReason) routingValue.createSpan({ text: work.routingReason });
    if (work.routingError) routingValue.createSpan({ cls: "xz-danger-text", text: `路由异常：${work.routingError}` });
    const sourceModeLabels = {
      "model-only": "本地检查完成 · 当前语境与模型知识足够",
      personalized: "本地证据参与 · 未启用公开资料检索",
      "web-context-then-decide": "本地语境不足 · 联网澄清缺口",
      web: "当前模型直接联网回答",
      hybrid: "当前模型联网回答 + 本地证据补充",
      "local-only": "专用命令锁定仅本地",
    };
    const sourceModeRow = overview.createDiv({ cls: "xz-work-key-value" });
    sourceModeRow.createSpan({ text: "回答资料来源" });
    sourceModeRow.createEl("strong", { text: sourceModeLabels[work.sourceMode] || "尚未判断" });
    if (work.sourceReason) sourceModeRow.createSpan({ text: work.sourceReason });
    const sufficiencyRow = overview.createDiv({ cls: "xz-work-key-value is-top" });
    sufficiencyRow.createSpan({ text: "本地证据评估" });
    const sufficiencyValue = sufficiencyRow.createDiv({ cls: "xz-work-value-stack" });
    const sufficiency = evidenceRetrieval.sufficiency;
    const sufficiencyLabels = {
      sufficient: work.mandatoryOnline === true
        ? "本地充分，但不能取消强制联网"
        : "充分且时效满足",
      partial: "部分覆盖，需要联网补缺",
      missing: "缺失，需要联网补缺",
      "insufficient-local-only": "不足，但已锁定仅本地",
      "not-required": "本轮不需要额外证据",
    };
    sufficiencyValue.createEl("strong", {
      text: sufficiencyLabels[sufficiency]
        || (evidenceRetrieval.status === "running" ? "正在检查" : "尚未评估"),
    });
    const coveredCount = asArray(evidenceRetrieval.coveredNeedIds).length;
    const missingCount = asArray(evidenceRetrieval.missingNeedIds).length;
    const staleCount = asArray(evidenceRetrieval.staleNeedIds).length;
    if (coveredCount || missingCount || staleCount) {
      sufficiencyValue.createSpan({
        text: `已覆盖 ${coveredCount} 项 · 缺失 ${missingCount} 项 · 其中过期 ${staleCount} 项`,
      });
    }
    const bridgeRow = overview.createDiv({ cls: "xz-work-key-value is-top" });
    bridgeRow.createSpan({ text: "环境证据桥接" });
    const bridgeValue = bridgeRow.createDiv({ cls: "xz-work-value-stack" });
    const bridgeStatusLabels = {
      linked: "联网证据已进入受控候选链",
      "needs-review": "存在环境候选缺少可信证据链接",
      "not-used": "本轮未使用联网证据桥接",
    };
    bridgeValue.createEl("strong", {
      text: bridgeStatusLabels[evidenceBridge.status] || "等待后台整理",
    });
    const bridgeEvidenceCount = Math.max(0, Number(evidenceBridge.evidenceCandidateCount) || 0);
    const bridgeEnvironmentCount = Math.max(0, Number(evidenceBridge.environmentCandidateCount) || 0);
    const bridgeLinkedCount = Math.max(0, Number(evidenceBridge.linkedEnvironmentCandidateCount) || 0);
    const bridgeMissingCount = Math.max(0, Number(evidenceBridge.missingEvidenceLinkCount) || 0);
    if (bridgeEvidenceCount || bridgeEnvironmentCount || bridgeMissingCount) {
      bridgeValue.createSpan({
        text: `证据候选 ${bridgeEvidenceCount} · 环境候选 ${bridgeEnvironmentCount} · 已绑定 ${bridgeLinkedCount} · 待核验 ${bridgeMissingCount}`,
      });
    }
    const contextSearchRow = overview.createDiv({ cls: "xz-work-key-value" });
    contextSearchRow.createSpan({ text: "联网方式" });
    const contextSearchLabels = {
      planned: "判定需要 · 等待调用",
      "waiting-local-assessment": "等待本地证据评估",
      searching: "正在预取外部 API 所需的联网资料",
      completed: `外部 API 已取得联网资料${Number(work.webSearch?.probeCalls || 0) ? ` · ${Number(work.webSearch.probeCalls)} 次网页搜索` : ""}`,
      "delegated-to-main": "不做发送前预检 · 当前 Codex 模型直接联网回答",
      "failed-main-web": "主回答联网失败 · 本轮已停止",
      "failed-degraded": "联网失败 · 未退回本地回答",
      "not-used": "判定需要但本轮未实际调用",
      "not-required": "不需要",
    };
    contextSearchRow.createEl("strong", {
      text: contextSearchLabels[work.webSearch?.contextClarification] || "不需要",
    });
    const answerSearchRow = overview.createDiv({ cls: "xz-work-key-value" });
    answerSearchRow.createSpan({ text: "回答资料检索" });
    const answerSearchLabels = {
      planned: "强制联网 · 当前模型继续回答",
      searching: "正在检索回答资料",
      completed: `已实际联网检索${Number(work.webSearch?.actualCalls || 0) ? ` · ${Number(work.webSearch.actualCalls)} 次调用` : ""}`,
      "decide-after-context": "语境澄清后再判断",
      "waiting-local-assessment": "等待本地证据评估",
      "planned-gap-only": "只检索本地未覆盖的公开缺口",
      "local-degraded": "联网未完成 · 使用现有上下文继续",
      "not-required": "不需要联网检索",
    };
    answerSearchRow.createEl("strong", {
      text: work.webSearch?.answerRetrieval === "not-used"
        ? (work.sourceMode === "web-context-then-decide"
            ? "语境澄清后决定不再检索"
            : "判定需要但本轮未实际调用")
        : (answerSearchLabels[work.webSearch?.answerRetrieval] || "不需要联网检索"),
    });
    const modeRow = overview.createDiv({ cls: "xz-work-key-value" });
    modeRow.createSpan({ text: "功能选择" });
    modeRow.createEl("strong", {
      text: CONVERSATION_PROCESSING_OPTIONS.find(
        (item) => item.id === settings.conversationProcessingMode,
      )?.label || "自动整理",
    });
    const organizationRow = overview.createDiv({ cls: "xz-work-key-value is-top" });
    organizationRow.createSpan({ text: "对话整理" });
    const organizationValue = organizationRow.createDiv({ cls: "xz-work-value-stack" });
    let organizationLabel = "原文已保存 · 等待回答完成";
    if (settings.conversationProcessingMode === "record-only") {
      organizationLabel = "原文已保存 · 仅记录";
    } else if (new Set(["queued", "running"]).has(organization?.status)) {
      organizationLabel = "原文已保存 · 后台整理中，不影响继续对话";
    } else if (organization?.status === "pending-review") {
      organizationLabel = `后台整理完成 · 已确认写入 ${Number(organization.written || 0)} 条 · 重点待审核 ${Number(organization.majorPending ?? organization.pending ?? 0)} 条`;
    } else if (organization?.status === "pending-confirmation") {
      organizationLabel = `后台整理完成 · 已确认写入 ${Number(organization.written || 0)} 条 · 普通待确认 ${Number(organization.routinePending ?? organization.pending ?? 0)} 条`;
    } else if (organization?.status === "completed") {
      organizationLabel = `后台整理完成 · 已确认写入 ${Number(organization.written || 0)} 条`;
    } else if (organization?.status === "failed") {
      organizationLabel = "原文已保存 · 整理失败，可安全重试";
    }
    organizationValue.createEl("strong", { text: organizationLabel });
    if (organization?.draftPath) {
      const report = organizationValue.createEl("button", {
        cls: "xz-work-link",
        text: "查看后台处理记录（可选）",
        attr: { type: "button" },
      });
      report.disabled = typeof this.plugin?.openVaultPath !== "function";
      report.addEventListener("click", () => this.openVaultPath(globalThis.__xzResolveOrganizationPath(organization.draftPath, organization)));
    }
    const pipelineRow = overview.createDiv({ cls: "xz-work-key-value is-top" });
    pipelineRow.createSpan({ text: "调用链路" });
    const pipelineTags = pipelineRow.createDiv({ cls: "xz-tag-list" });
    const fallbackPipeline = [
      { id: "evidence-retrieval", label: "证据检索", status: "not-run" },
      { id: "agent-routing", label: "Agent 路由", status: "not-run" },
      { id: "skill-routing", label: "Skill 组合", status: "not-run" },
      { id: "planning", label: "计划与执行准备", status: "not-run" },
      { id: "execution", label: "Agent 执行", status: "not-run" },
      { id: "quality-evaluation", label: "主回答质量验收", status: "not-run" },
      { id: "response-commit", label: "回答提交", status: "not-run" },
    ];
    (executionPipeline.length ? executionPipeline : fallbackPipeline)
      .filter((stage) => stage?.id !== "semantic-understanding")
      .forEach((stage, index) => {
      const selections = asArray(stage?.selections).filter(Boolean);
      const statusLabel = stage?.status === "selected"
        ? (selections.join("、") || "已完成")
        : stage?.status === "completed"
          ? "已完成"
          : stage?.status === "failed"
            ? "执行失败"
            : stage?.status === "blocked"
              ? "等待人工确认"
              : stage?.status === "skipped"
                ? "已按契约跳过"
            : stage?.status === "running"
              ? "执行中"
        : stage?.status === "ready"
          ? "已就绪"
          : stage?.status === "not-required"
            ? "本轮无需"
            : "等待本轮任务";
      const tag = pipelineTags.createSpan({
        cls: `xz-tag is-soft${new Set(["ready", "running", "completed"]).has(stage?.status) ? " is-ready" : ""}`,
        text: `${index + 1}. ${firstText(stage?.label, normalizeId(stage))}`,
      });
      tag.setAttr("title", statusLabel);
    });
    const evidenceRow = overview.createDiv({ cls: "xz-work-key-value is-top" });
    evidenceRow.createSpan({ text: "证据探测" });
    const evidenceValue = evidenceRow.createDiv({ cls: "xz-work-value-stack" });
    const evidenceStatusLabel = evidenceRetrieval.status === "running"
      ? "正在检索"
      : evidenceRetrieval.status === "completed"
        ? "已完成"
        : evidenceRetrieval.status === "degraded"
          ? "检索降级，未冒充查无资料"
          : "等待执行";
    evidenceValue.createEl("strong", {
      text: `${evidenceStatusLabel} · ${firstText(evidenceRetrieval.strategy, "context-probe")}`,
    });
    if (Number(evidenceRetrieval.resultCount || 0) > 0
      || Number(evidenceRetrieval.fusedCandidateCount || 0) > 0) {
      evidenceValue.createSpan({
        text: `词法候选 ${Number(evidenceRetrieval.lexicalCandidateCount || 0)} · 近似候选 ${Number(evidenceRetrieval.fuzzyCandidateCount || 0)} · 融合候选 ${Number(evidenceRetrieval.fusedCandidateCount || 0)} · 返回 ${Number(evidenceRetrieval.resultCount || 0)} 条`,
      });
    } else if (work.sourceMode === "model-only") {
      evidenceValue.createSpan({
        text: work.mandatoryOnline === true
          ? "本轮保持联网回答；没有额外命中本地知识。"
          : "本轮只检索当前对话语境；未读取本地知识库，也未联网。",
      });
    }
    if (Number(evidenceRetrieval.durationMs || 0) > 0) {
      evidenceValue.createSpan({ text: `检索耗时 ${Number(evidenceRetrieval.durationMs)} ms` });
    }
    const qualityRow = overview.createDiv({ cls: "xz-work-key-value is-top" });
    qualityRow.createSpan({ text: "主回答验收" });
    const qualityValue = qualityRow.createDiv({ cls: "xz-work-value-stack" });
    const qualityLabel = qualityEvaluation.status === "passed"
      ? "本地规则检查通过"
      : qualityEvaluation.status === "repairing"
        ? "首次验收未通过 · 正在进行唯一一次修正"
        : qualityEvaluation.status === "repair-required"
          ? "需要修正"
          : qualityEvaluation.status === "accepted-with-limit"
            ? "已保留回答，仍有检查限制"
            : "等待回答草稿";
    qualityValue.createEl("strong", {
      text: qualityLabel,
    });
    qualityValue.createSpan({ text: "本地检查识别明显漏项；不代表语义正确率或完整度评分。" });
    if (qualityEvaluation.supplementError) qualityValue.createSpan({ text: qualityEvaluation.supplementError });
    if (asArray(qualityEvaluation.defects).length) {
      const qualityDefectLabels = {
        "answer-empty": "回答为空",
        "requested-topic-missing": "部分明确请求主题尚未检测到回应",
        "supplement-failed": "定向补充未完成，原回答已保留",
        "semantic-stage-missing": "主回答理解未完成",
        "evidence-stage-missing": "证据阶段未完成",
        "agent-missing": "缺少主 Agent",
        "core-skill-missing": "缺少核心 Skill",
        "substantive-too-thin": "实质性回答过薄",
        "framework-missing": "缺少问题框架",
        "logic-missing": "缺少底层逻辑",
        "calibration-missing": "缺少证据与风险校准",
        "next-step-missing": "缺少下一步",
      };
      qualityValue.createSpan({
        text: `限制项：${asArray(qualityEvaluation.defects)
          .map((code) => qualityDefectLabels[code] || code).join("、")}`,
      });
    }
    const diagnosticHistory = overview.createEl("details", { cls: "xz-turn-diagnostics" });
    diagnosticHistory.createEl("summary", { text: `最近回答检查记录（${diagnostics.length} 条）` });
    diagnosticHistory.createEl("p", { text: "从本次升级后开始记录。字数只用于观察，不表示回答质量。完整历史保存在系统的回合诊断目录。" });
    for (const row of diagnostics) {
      const card = diagnosticHistory.createEl("article", { cls: "xz-cognitive-context" });
      card.createEl("strong", { text: `${new Date(row.completedAt).toLocaleString()} · ${row.answerChars} 字符` });
      card.createEl("p", { text: `输出：${({ concise: "简洁", standard: "标准", expanded: "展开" })[row.outputDepth] || "未记录"} · ${row.agentId || "未记录主能力"}` });
      card.createEl("p", { text: `Skills：${asArray(row.skills).map(skill => skill.id).join("、") || "无"} · 定向补充 ${row.quality?.repairAttempts || 0} 次` });
      card.createEl("p", { text: row.quality?.defects?.length ? `仍有检查限制：${row.quality.defects.join("、")}` : "本地规则未发现明显漏项；语义完整度未测量。" });
    }
    const recoveryRow = overview.createDiv({ cls: "xz-work-key-value is-top" });
    recoveryRow.createSpan({ text: "失败恢复" });
    const recoveryValue = recoveryRow.createDiv({ cls: "xz-work-value-stack" });
    const recoveryPresentation = buildFailureRecoveryPresentation({
      status: traceStatus,
      error: asArray(activeConversation?.messages).filter((message) => message?.status === "failed").at(-1)?.error,
      authenticationRequired: firstText(activeConversation?.providerId, settings.providerId, "codex") === "codex"
        && runtime.providerConnections?.codex?.authenticationRequired === true,
      recovery,
    });
    recoveryValue.createEl("strong", {
      text: recovery.mode === "confirmation-required"
        ? "检测到可能副作用 · 不会自动重放"
        : recoveryPresentation?.authenticationRequired === true
          ? "需要先更新本机认证"
        : recovery.mode === "completed"
          ? "本轮已完整提交，无需恢复"
          : `可从 ${firstText(recovery.resumeFrom, "问题处理")} 安全重试`,
    });
    if (recovery.mode === "confirmation-required") {
      recoveryValue.createSpan({ text: "需要人工确认外部结果后才能继续。" });
    } else if (traceStatus === "failed" && recovery.mode === "resume"
      && recoveryPresentation?.authenticationRequired !== true
      && typeof this.plugin?.retryFailedResponse === "function") {
      const retryButton = recoveryValue.createEl("button", {
        cls: "xz-work-link",
        text: "从安全点重试",
        attr: { type: "button" },
      });
      retryButton.addEventListener("click", async () => {
        retryButton.disabled = true;
        try {
          await this.plugin.retryFailedResponse(activeConversationId);
          new Notice("已从原用户消息重新执行安全阶段；不会自动重放已确认的外部副作用");
        } catch (error) {
          new Notice(`任务恢复未开始：${error?.message || "未知错误"}`);
          retryButton.disabled = false;
        }
      });
    }
    const writePolicyRow = overview.createDiv({ cls: "xz-work-key-value" });
    writePolicyRow.createSpan({ text: "归档写入" });
    writePolicyRow.createEl("strong", { text: PERMISSION_OPTIONS.find((item) => item.id === settings.permissionMode)?.label || "自动整理" });
    const addSkillStatusRows = (label, items) => {
      const row = overview.createDiv({ cls: "xz-work-key-value is-top" });
      row.createSpan({ text: label });
      const tags = row.createDiv({ cls: "xz-tag-list" });
      if (!items.length) tags.createSpan({ cls: "xz-muted-tag", text: "本轮未选择" });
      items.forEach((item) => {
        const id = normalizeId(item);
        const tag = tags.createSpan({ cls: "xz-tag is-soft", text: `${normalizeLabel(item, id)} · ${skillCallLabel(item)}` });
        tag.setAttr("data-skill-call-stage", item.callState?.stage || "historical-unconfirmed");
        tag.setAttr("title", [id, skillCallDescription(item), firstText(item?.reason)].filter(Boolean).join(" · "));
      });
    };
    addSkillStatusRows("本轮 Skill 状态", taskSkills);
    addSkillStatusRows("本轮透镜状态", lensSkills);
    overview.createDiv({ cls: "xz-help-text", text: "已推荐 / 已选择 / 已提交 / 已确认读取 / 本轮完成分别记录。插件读取回执不代表模型已遵循方法。" });
    const reasoningRow = overview.createDiv({ cls: "xz-work-key-value is-top" });
    reasoningRow.createSpan({ text: "推理方法" });
    const reasoningTags = reasoningRow.createDiv({ cls: "xz-tag-list" });
    if (!reasoningOperators.length) {
      reasoningTags.createSpan({ cls: "xz-muted-tag", text: "本轮无需额外推理方法" });
    }
    reasoningOperators.forEach((operator) => {
      const tag = reasoningTags.createSpan({
        cls: "xz-tag is-soft",
        text: normalizeLabel(operator, normalizeId(operator)),
      });
      tag.setAttr("title", firstText(operator?.phase, "受管控推理方法"));
    });
    const gateLabels = {
      "permission-boundary": "权限边界",
      "evidence-calibration": "证据校准",
    };
    const gateRow = overview.createDiv({ cls: "xz-work-key-value is-top" });
    gateRow.createSpan({ text: "强制校验" });
    const gateValue = gateRow.createDiv({ cls: "xz-work-value-stack" });
    gateValue.createEl("strong", {
      text: mandatoryGates.map((gate) => gateLabels[gate] || firstText(gate)).join(" · ") || "权限边界",
    });
    if (coreVersion) gateValue.createSpan({ text: `受管控核心 ${coreVersion}` });
    if (capabilities.length) {
      const capabilityRow = overview.createDiv({ cls: "xz-work-key-value is-top" });
      capabilityRow.createSpan({ text: "本轮能力" });
      const tags = capabilityRow.createDiv({ cls: "xz-tag-list" });
      capabilities.forEach((item) => tags.createSpan({ cls: "xz-tag is-soft", text: firstText(item) }));
    }
    const searchRow = overview.createDiv({ cls: "xz-work-key-value" });
    searchRow.createSpan({ text: "知识检索" });
    searchRow.createEl("strong", { text: knowledgeSearchStatusText(knowledgeSearch) });
    const scopeRow = overview.createDiv({ cls: "xz-work-key-value is-top" });
    scopeRow.createSpan({ text: "实际扫描" });
    const scopeTags = scopeRow.createDiv({ cls: "xz-tag-list" });
    if (!readScopes.length) {
      const emptyScopeText = knowledgeSearch.status === "empty"
        ? "已检索，但未返回扫描范围"
        : knowledgeSearch.status === "failed"
          ? "检索失败"
          : knowledgeSearch.status === "searching"
            ? "正在检索"
            : knowledgeSearch.status === "interrupted"
              ? "检索已停止"
              : "尚未执行检索";
      scopeTags.createSpan({ cls: "xz-muted-tag", text: emptyScopeText });
    }
    readScopes.forEach((root) => scopeTags.createSpan({ cls: "xz-tag is-scope", text: firstText(root) }));
    const matchedScopeRow = overview.createDiv({ cls: "xz-work-key-value is-top" });
    matchedScopeRow.createSpan({ text: "命中范围" });
    const matchedScopeTags = matchedScopeRow.createDiv({ cls: "xz-tag-list" });
    if (!matchedReadRoots.length) {
      matchedScopeTags.createSpan({
        cls: "xz-muted-tag",
        text: knowledgeSearch.status === "empty" ? "0 命中" : "尚无命中",
      });
    }
    matchedReadRoots.forEach((root) => matchedScopeTags.createSpan({ cls: "xz-tag is-scope", text: firstText(root) }));
    if (plannedReadScopes.length) {
      const plannedScopeRow = overview.createDiv({ cls: "xz-work-key-value is-top" });
      plannedScopeRow.createSpan({ text: "计划检索" });
      const plannedScopeTags = plannedScopeRow.createDiv({ cls: "xz-tag-list" });
      plannedReadScopes.forEach((root) => plannedScopeTags.createSpan({ cls: "xz-tag is-scope", text: firstText(root) }));
    }
    const resultRow = overview.createDiv({ cls: "xz-work-key-value is-top" });
    resultRow.createSpan({ text: "知识结果" });
    resultRow.createEl("strong", {
      text: `已确认写入 ${Number(knowledgeSummary.written || 0)} 条 · 等待确认 ${Number(knowledgeSummary.pending || 0)} 条 · 拒绝 ${Number(knowledgeSummary.rejected || 0)} 条`,
    });
    const externalRow = overview.createDiv({ cls: "xz-work-key-value" });
    externalRow.createSpan({ text: "外部发送" });
    externalRow.createEl("strong", { text: work.externalTransfer?.used ? firstText(work.externalTransfer.label, "已使用") : "未使用" });
    overview.createEl("p", {
      cls: "xz-permission-note",
      text: "自动选择 Skill 不等于自动允许高风险操作；知识写入、外部发送与 Codex 执行仍分别受权限控制。",
    });

    this.renderWorkList(body, "读取来源", "book-open", sources, (host, source) => {
      const path = firstText(source?.path, source?.file, typeof source === "string" ? source : "");
      const button = host.createEl("button", { cls: "xz-work-link", attr: { type: "button" } });
      const icon = button.createSpan({ attr: { "aria-hidden": "true" } });
      setIcon(icon, "file-text");
      const copy = button.createDiv();
      copy.createEl("strong", { text: firstText(source?.title, source?.label, path, "知识库资料") });
      const reason = firstText(source?.reason, source?.excerpt);
      if (reason) copy.createEl("span", { text: reason.slice(0, 120) });
      button.disabled = !path;
      if (typeof this.plugin?.openVaultPath !== "function") button.disabled = true;
      if (path) button.addEventListener("click", () => this.openVaultPath(path));
    });

    this.renderWorkList(body, "知识候选", "package-check", candidates, (host, candidate, index) => {
      const item = host.createDiv({ cls: "xz-work-item xz-knowledge-candidate-item" });
      const candidateId = firstText(candidate?.candidateId, candidate?.id);
      const confirmation = this.getKnowledgeConfirmations().find((entry) => (
        firstText(entry?.candidateId) === candidateId
        && (entry?.status === "pending" || !entry?.status)
      ));
      const clarification = this.getClarifications().find((entry) => (
        firstText(entry?.candidateId) === candidateId
        && !["answered", "resolved", "dismissed"].includes(entry?.status)
      ));
      const copy = item.createEl("button", {
        cls: "xz-knowledge-detail-trigger",
        attr: {
          type: "button",
          title: "查看知识候选的完整内容",
          "aria-label": `查看知识候选：${firstText(candidate?.title, candidate?.key, "待整理知识")}`,
        },
      });
      copy.createEl("strong", { text: firstText(candidate?.title, candidate?.key, candidate?.type, "待整理知识") });
      const detail = firstText(candidate?.content, candidate?.summary, candidate?.reason);
      if (detail) copy.createEl("span", { cls: "xz-candidate-claim", text: `候选主张：${detail.slice(0, 180)}` });
      const evidenceCount = Math.max(0, Number(candidate?.evidenceCount) || 0);
      const meta = evidenceCount >= 2
        ? `已在 ${evidenceCount} 个独立回合出现 · 达到候选门槛`
        : "来源已记录 · 等待核对";
      copy.createEl("span", { cls: "xz-candidate-evidence-line", text: meta });
      if (candidate?.knowledgeType === "environment") {
        const environmentMeta = [
          firstText(candidate?.area) ? `分类 ${firstText(candidate.area)}` : "分类待确认",
          firstText(candidate?.freshness) ? `时效 ${firstText(candidate.freshness)}` : "时效待确认",
          firstText(candidate?.reviewAt) ? `复核 ${firstText(candidate.reviewAt).slice(0, 10)}` : "",
        ].filter(Boolean).join(" · ");
        copy.createEl("span", { cls: "xz-candidate-evidence-line", text: environmentMeta });
      }
      copy.createEl("span", { cls: "xz-work-detail-label", text: "查看候选内容与操作" });
      const decision = decisionByCandidate.get(candidateId);
      copy.addEventListener("click", () => this.openKnowledgeCandidateDetails(candidate, decision, index));
      const status = confirmation
        ? "confirm" : (clarification ? "clarify" : firstText(
          decision?.decision,
          candidate?.decision,
          candidate?.reviewState,
          candidate?.status,
          "已判断",
        ));
      const statusControl = item.createEl(confirmation || clarification ? "button" : "span", {
        cls: `xz-status-tag ${this.statusClass(status)}${confirmation || clarification ? " is-actionable" : ""}`,
        text: this.statusLabel(status),
        ...(confirmation || clarification ? { attr: { type: "button", title: "打开处理卡" } } : {}),
      });
      if (confirmation || clarification) {
        statusControl.addEventListener("click", () => this.openKnowledgeCandidateDetails(candidate, decision, index));
      }
    });

    this.renderWorkList(body, "环境影响复核", "refresh-cw", environmentImpactReviews, (host, impact) => {
      const item = host.createDiv({ cls: "xz-work-item xz-environment-impact-item" });
      item.createEl("strong", { text: "环境变化可能影响既有判断" });
      item.createEl("span", { text: firstText(impact?.summary, "检测到需要复核的关联对象。") });
      const targetParts = [
        asArray(impact?.targets?.projects).length ? `项目 ${asArray(impact.targets.projects).length}` : "",
        asArray(impact?.targets?.judgments).length ? `判断 ${asArray(impact.targets.judgments).length}` : "",
        asArray(impact?.targets?.actions).length ? `行动 ${asArray(impact.targets.actions).length}` : "",
      ].filter(Boolean);
      if (targetParts.length) {
        item.createEl("span", {
          cls: "xz-candidate-evidence-line",
          text: `${targetParts.join(" · ")} · 系统只提示复核，不自动修改结论`,
        });
      }
      const sourcePath = firstText(impact?.sourcePath);
      if (sourcePath && typeof this.plugin?.openVaultPath === "function") {
        const open = item.createEl("button", {
          cls: "xz-secondary-button",
          text: "查看原环境记录",
          attr: { type: "button" },
        });
        open.addEventListener("click", () => this.openVaultPath(sourcePath));
      }
    });

    this.renderWorkList(body, "实际写入", "file-check-2", writes, (host, write) => {
      const path = firstText(write?.path, write?.file);
      const item = host.createDiv({ cls: "xz-write-item" });
      const button = item.createEl("button", { cls: "xz-work-link", attr: { type: "button" } });
      const icon = button.createSpan({ attr: { "aria-hidden": "true" } });
      setIcon(icon, "file-pen-line");
      const copy = button.createDiv();
      copy.createEl("strong", { text: firstText(write?.title, path, "知识库变化") });
      copy.createEl("span", { text: firstText(write?.actionLabel, write?.action, write?.status, "已记录") });
      button.disabled = !path;
      if (typeof this.plugin?.openVaultPath !== "function") button.disabled = true;
      if (path) button.addEventListener("click", () => this.openVaultPath(path));
      const transactionId = firstText(write?.transactionId, write?.undoId, write?.id);
      if (transactionId && typeof this.plugin?.undoTransaction === "function" && !["undone", "reverted"].includes(write?.status)) {
        const undo = createIconButton(item, "undo-2", "撤销这次写入", () => this.undoTransaction(transactionId, undo));
        undo.addClass("xz-undo-button");
      }
      if (write?.category || write?.retrieval || write?.tags) this.renderKnowledgeManifest(host, write, { compact: true });
    });

    if (!sources.length && !candidates.length && !environmentImpactReviews.length && !writes.length) {
      const empty = body.createDiv({ cls: "xz-work-empty" });
      const glyph = empty.createDiv({ attr: { "aria-hidden": "true" } });
      setIcon(glyph, "scan-search");
      empty.createEl("strong", { text: "等待本轮工作" });
      empty.createEl("p", { text: "开始对话后，这里会显示读取来源、知识候选与正式写入。" });
    }
  }

  renderWorkList(parent, title, iconName, items, renderItem) {
    const section = parent.createEl("section", { cls: "xz-work-section" });
    const heading = section.createDiv({ cls: "xz-work-heading" });
    const icon = heading.createSpan({ attr: { "aria-hidden": "true" } });
    setIcon(icon, iconName);
    heading.createEl("h3", { text: title });
    heading.createSpan({ cls: "xz-count", text: String(items.length) });
    const list = section.createDiv({ cls: "xz-work-list" });
    if (!items.length) list.createEl("p", { cls: "xz-work-list-empty", text: "本轮暂无" });
    items.forEach((item, index) => renderItem(list, item, index));
  }

  relatedPathFromClarification(clarification) {
    const explicit = firstText(clarification?.relatedPath, clarification?.conflictPath, clarification?.path);
    if (explicit) return explicit;
    const question = firstText(clarification?.question, clarification?.title);
    return question.match(/[“"]([^”"\r\n]+\.md)[”"]/u)?.[1] || "";
  }

  clarificationReviewContext(clarification, index = -1) {
    const conversationId = normalizeId(this.getActiveConversation());
    const work = this.workPanelForConversation(conversationId);
    const candidates = asArray(work.candidates || work.knowledgeCandidates);
    const decisions = asArray(work.decisions);
    const candidateId = firstText(clarification?.candidateId);
    const candidate = candidates.find((item) => firstText(item?.candidateId, item?.id) === candidateId)
      || (index >= 0 ? candidates[index] : null)
      || null;
    const resolvedCandidateId = firstText(candidateId, candidate?.candidateId, candidate?.id);
    const decision = decisions.find((item) => firstText(item?.candidateId) === resolvedCandidateId) || null;
    return {
      candidate,
      decision,
      relatedPath: this.relatedPathFromClarification(clarification),
    };
  }

  openKnowledgeCandidateDetails(candidate, decision, index = -1) {
    const candidateId = firstText(candidate?.candidateId, candidate?.id);
    const clarifications = this.getClarifications();
    const clarification = clarifications.find((item) => firstText(item?.candidateId) === candidateId)
      || (clarifications.length === asArray(this.workPanelForConversation(
        normalizeId(this.getActiveConversation()),
      ).candidates).length ? clarifications[index] : null)
      || null;
    const relatedPath = this.relatedPathFromClarification(clarification);
    const confirmation = this.getKnowledgeConfirmations().find((item) => (
      firstText(item?.candidateId) === candidateId
      && (item?.status === "pending" || !item?.status)
    )) || null;
    const organization = this.plugin?.state?.runtime?.conversationOrganization || null;
    new XingzhiKnowledgeDetailModal(this.app, {
      candidate,
      decision,
      clarification,
      confirmation,
      relatedPath,
      reportPath: firstText(organization?.draftPath),
      onOpenPath: (path) => { void this.openVaultPath(path); },
      onDecision: confirmation && typeof this.plugin?.respondKnowledgeConfirmation === "function"
        ? async (nextDecision) => {
            const result = await this.plugin.respondKnowledgeConfirmation(confirmation.id, nextDecision);
            new Notice(nextDecision === "accept"
              ? (result?.indexStatus === "retry-needed"
                ? "正式知识已写入；索引更新待恢复"
                : "知识已分类写入并完成索引")
              : "已保留来源，本次不写入正式知识");
          }
        : null,
      onClarify: clarification
        ? () => { void this.openClarificationDialog(clarification, index); }
        : null,
    }).open();
  }

  async openClarificationDialog(clarification, index = -1) {
    const context = this.clarificationReviewContext(clarification, index);
    const question = firstText(clarification?.question, clarification?.title, "请补充一项信息");
    const answer = await new XingzhiClarificationModal(this.app, {
      question,
      reason: firstText(clarification?.reason, context.decision?.message, clarification?.description),
      candidate: context.candidate,
      relatedPath: context.relatedPath,
      options: Array.isArray(clarification?.options) ? clarification.options : [],
      onOpenPath: (path) => { void this.openVaultPath(path); },
    }).waitForValue();
    if (!answer) return;
    const candidateTitle = firstText(context.candidate?.title, context.candidate?.key);
    const draft = [
      "针对归档中的待澄清知识，我补充如下：",
      `待澄清问题：${question}`,
      candidateTitle ? `相关知识候选：${candidateTitle}` : "",
      `我的补充：${answer}`,
    ].filter(Boolean).join("\n");
    this.setComposerDraft(draft, { focus: true });
    new Notice("补充内容已放入输入框，请检查后发送");
  }

  statusClass(status) {
    const value = String(status || "").toLowerCase();
    if (["written", "accepted", "approved", "auto-write", "已写入", "自动写入"].some((part) => value.includes(part))) return "is-success";
    if (["rejected", "declined", "conflict", "拒绝", "冲突"].some((part) => value.includes(part))) return "is-danger";
    if (["confirm", "clarify", "pending", "待", "确认", "澄清"].some((part) => value.includes(part))) return "is-warning";
    return "is-neutral";
  }

  statusLabel(status) {
    const labels = {
      "auto-write": "自动写入",
      confirm: "等待确认",
      "needs-confirmation": "等待确认",
      clarify: "需要澄清",
      written: "已写入",
      accepted: "已接受",
      rejected: "已拒绝",
      skipped: "已跳过",
    };
    return labels[status] || status || "待判断";
  }

  renderSettings() {
    const body = this.refs.settingsBody;
    body.empty();
    const intro = body.createEl("section", { cls: "xz-settings-intro" });
    intro.createEl("h3", { text: "连接执行引擎" });
    intro.createEl("p", {
      text: "API Key 会交给 Obsidian 安全密钥库保存。行知的插件配置、知识库、对话和日志都不会保存或显示明文密钥。",
    });
    const callout = intro.createDiv({ cls: "xz-secret-callout" });
    const icon = callout.createSpan({ attr: { "aria-hidden": "true" } });
    setIcon(icon, "key-round");
    const calloutCopy = callout.createDiv();
    calloutCopy.createEl("strong", { text: "密钥与知识库分开保存" });
    calloutCopy.createEl("span", { text: "推荐直接在下方安全录入。原有系统环境变量仍可兼容使用，但不再是必需步骤。" });

    const calibration = body.createEl("section", { cls: "xz-provider-card xz-question-calibration-settings" });
    const calibrationHead = calibration.createDiv({ cls: "xz-provider-card-head" });
    const calibrationTitle = calibrationHead.createDiv();
    calibrationTitle.createEl("h3", { text: "动态展开思考与历史校准" });
    calibrationTitle.createSpan({ cls: "xz-provider-state is-neutral", text: "本地可控" });
    calibration.createEl("p", {
      text: "所有对话都先理解原话与已有思考，再动态寻找相关的遗漏、视角与可能性；不按固定题型或回合数补充。灯泡只把明确的展开请求放入草稿，视角由模型在正常对话中理解后生成。",
    });
    const calibrationToggle = calibration.createEl("label", { cls: "xz-question-calibration-toggle" });
    const calibrationInput = calibrationToggle.createEl("input", { attr: { type: "checkbox" } });
    calibrationInput.checked = stateSettings(this.plugin).questionCalibrationEnabled !== false;
    const calibrationCopy = calibrationToggle.createDiv();
    calibrationCopy.createEl("strong", { text: "显示手动展开思考按钮" });
    calibrationCopy.createSpan({ text: "只控制输入框旁的灯泡；关闭也不影响所有对话遵循底层动态思考规则。不会自动弹窗或新增旧式校准记录。" });
    const calibrationStatus = calibration.createEl("p", {
      cls: "xz-question-calibration-status",
      attr: { role: "status", "aria-live": "polite" },
    });
    calibrationInput.addEventListener("change", async () => {
      calibrationInput.disabled = true;
      try {
        await this.updateSettings({ questionCalibrationEnabled: calibrationInput.checked });
        calibrationStatus.setText(calibrationInput.checked ? "已启用。" : "已关闭；已有本地元数据保留。 ");
      } catch (error) {
        calibrationInput.checked = !calibrationInput.checked;
        calibrationStatus.setText(`设置未保存：${firstText(error?.message, error)}`);
      } finally {
        calibrationInput.disabled = false;
      }
    });
    const calibrationEvents = asArray(this.plugin?.state?.questionCalibrationEvents);
    const habitToggle = calibration.createEl("label", { cls: "xz-question-calibration-toggle" });
    const habitInput = habitToggle.createEl("input", { attr: { type: "checkbox" } });
    habitInput.checked = stateSettings(this.plugin).questionHabitHintsEnabled === true;
    const habitCopy = habitToggle.createDiv();
    habitCopy.createEl("strong", { text: "显示历史表达回顾（可选）" });
    habitCopy.createSpan({ text: "只回顾旧版记录的提示与选择次数，不代表新机制的补盲质量，也不推断人格或能力水平。" });
    habitInput.addEventListener("change", async () => {
      habitInput.disabled = true;
      try {
        await this.updateSettings({ questionHabitHintsEnabled: habitInput.checked });
        calibrationStatus.setText(habitInput.checked ? "已开启近期表达回顾。" : "已关闭近期表达回顾。 ");
      } catch (error) {
        habitInput.checked = !habitInput.checked;
        calibrationStatus.setText(`设置未保存：${firstText(error?.message, error)}`);
      } finally { habitInput.disabled = false; }
    });
    calibration.createEl("p", {
      cls: "xz-question-calibration-privacy",
      text: `本机已保留 ${calibrationEvents.length} 条校准元数据（上限 500）；不重复保存问题全文，不给表达打分。`,
    });
    const calibrationAudit = calibration.createDiv({ cls: "xz-question-calibration-audit" });
    calibrationAudit.createEl("strong", { text: "最近记录" });
    const decisionLabels = {
      "not-needed": "直接发送",
      "sent-original": "选择原问题",
      "accepted-suggestion": "采用建议",
      "edited-suggestion": "修改后发送",
    };
    const recentCalibrationEvents = calibrationEvents.slice(-8).reverse();
    if (!recentCalibrationEvents.length) {
      calibrationAudit.createEl("p", { cls: "xz-cognitive-muted", text: "尚无记录。" });
    } else {
      const list = calibrationAudit.createEl("ul", { cls: "xz-question-calibration-audit-list" });
      for (const event of recentCalibrationEvents) {
        const task = TASK_TYPES[event.taskType];
        const when = Number.isFinite(Date.parse(event.occurredAt))
          ? new Date(event.occurredAt).toLocaleString("zh-CN")
          : "时间未知";
        const offeredCount = asArray(event.offeredPerspectiveCodes).length;
        const selectedCount = asArray(event.selectedPerspectiveCodes).length;
        list.createEl("li", {
          text: `${when} · ${task?.label || "其他问题"} · ${decisionLabels[event.decision] || "已记录"}${offeredCount ? ` · 展示 ${offeredCount} 个角度，选择 ${selectedCount} 个` : ""}`,
        });
      }
    }
    calibration.createEl("p", {
      cls: "xz-question-calibration-privacy",
      text: "以上记录来自旧版本的本地规则，保留供历史查看。新机制在正常模型对话中承接已有思考后动态展开，不把旧提示编号当作真实盲区，不自动保存为个人知识。",
    });
    const habitHints = buildQuestionHabitHints(calibrationEvents, { enabled: stateSettings(this.plugin).questionHabitHintsEnabled === true });
    for (const hint of habitHints) {
      calibration.createEl("p", { text: `${hint.text} ${hint.nextTime} ${hint.boundary}` });
    }
    const clearCalibration = calibration.createEl("button", { text: "清空提问校准记录", attr: { type: "button" } });
    clearCalibration.disabled = !calibrationEvents.length;
    clearCalibration.addEventListener("click", async () => {
      clearCalibration.disabled = true;
      try {
        await this.plugin.clearQuestionCalibrationEvents();
        this.renderSettings();
      } catch (error) {
        clearCalibration.disabled = false;
        calibrationStatus.setText(`记录未清空：${firstText(error?.message, error)}`);
      }
    });

    const providers = body.createDiv({ cls: "xz-provider-settings" });
    const configs = stateSettings(this.plugin).providerConfigs || {};
    // Render the shipped providers plus every user-added compatible endpoint that
    // already has saved configuration, so several gateways can coexist.
    const savedCustomIds = Object.keys(configs || {})
      .filter((id) => isCustomProviderId(id) && id !== "custom")
      .sort((left, right) => left.localeCompare(right, "en"));
    // Cards added in this session have no saved config yet, so keep them in view
    // state until the user fills in an address and saves.
    const draftCustomIds = asArray(this._draftCustomProviderIds)
      .filter((id) => isCustomProviderId(id) && !savedCustomIds.includes(id) && id !== "custom");
    const renderList = [
      ...PROVIDER_FALLBACKS,
      ...[...savedCustomIds, ...draftCustomIds]
        .sort((left, right) => left.localeCompare(right, "en"))
        .map((id) => customProviderFallback(id)),
    ];
    renderList.forEach((provider) => {
      const card = providers.createEl("section", { cls: "xz-provider-card" });
      const head = card.createDiv({ cls: "xz-provider-card-head" });
      const title = head.createDiv();
      title.createEl("h3", { text: provider.label });
      const connection = this.providerConnection(provider.id);
      title.createSpan({ cls: `xz-provider-state ${connection.className}`, text: connection.label });
      const capabilities = head.createDiv({ cls: "xz-capability-tags" });
      provider.capabilities.forEach((capability) => capabilities.createSpan({ text: capability }));

      if (provider.id === "codex") {
        card.createEl("p", { text: "使用本机 Codex App Server，支持持续会话、动态模型、Skills 与执行审批。当前模型先理解问题，在既有权限内按需检索；不预先把每轮原话发送到搜索引擎。普通回答禁止直接写入知识库。请不要让它处理你不愿发送给当前 Codex 服务的敏感内容。" });
        const refresh = card.createEl("button", { cls: "xz-secondary-button", text: "重新读取 Codex 能力", attr: { type: "button" } });
        refresh.disabled = typeof this.plugin?.refreshCapabilities !== "function";
        refresh.addEventListener("click", () => this.refreshCapabilities(refresh));
        return;
      }

      const stateProvider = asArray(this.plugin?.state?.providers).find((item) => normalizeId(item) === provider.id) || {};
      const current = configs[provider.id] || stateProvider || {};
      const fields = card.createDiv({ cls: "xz-provider-fields" });
      const endpointLabel = fields.createEl("label");
      endpointLabel.createSpan({ text: "API 地址" });
      const endpoint = endpointLabel.createEl("input", {
        attr: {
          type: "url",
          placeholder: isCustomProviderId(provider.id) ? "https://api.example.com/v1" : provider.baseUrl,
          autocomplete: "off",
          spellcheck: "false",
        },
      });
      endpoint.value = firstText(current.baseUrl, current.endpoint, provider.baseUrl);
      endpoint.readOnly = !isCustomProviderId(provider.id);
      if (!isCustomProviderId(provider.id)) endpoint.setAttr("aria-readonly", "true");
      const secretLabel = fields.createEl("label", { cls: "xz-provider-secret-field" });
      secretLabel.createSpan({ text: "API Key" });
      const secretRef = secretLabel.createEl("input", {
        attr: {
          type: "password",
          placeholder: "粘贴新的 API Key；留空则继续使用已保存密钥",
          autocomplete: "new-password",
          spellcheck: "false",
          "aria-describedby": "xz-settings-title",
        },
      });
      const credentialStatus = this.providerCredentialStatus(provider.id);
      const credentialHelp = secretLabel.createEl("small", {
        text: credentialStatus.configured
          ? (credentialStatus.source === "environment" ? "已通过系统环境变量配置" : "已安全保存；输入新值可替换")
          : "尚未配置；保存后会立即检测连接",
      });

      const modelLabel = fields.createEl("label", { cls: "xz-provider-model-field" });
      modelLabel.createSpan({ text: "手工模型 ID" });
      const manualModel = modelLabel.createEl("input", {
        attr: {
          type: "text",
          placeholder: "例如供应商文档中的 model id",
          autocomplete: "off",
          spellcheck: "false",
        },
      });
      const selectedProvider = firstText(stateSettings(this.plugin).providerId, "codex");
      manualModel.value = selectedProvider === provider.id ? firstText(stateSettings(this.plugin).model) : firstText(current.model);
      modelLabel.createEl("small", { text: "当 /models 不可用时仍可填写；必须与供应商文档中的 ID 完全一致。" });
      const consentLabel = card.createEl("label", { cls: "xz-external-consent" });
      const consent = consentLabel.createEl("input", { attr: { type: "checkbox" } });
      // A newly added API is locked on its first save by default. Existing users can
      // deliberately clear this switch to disable the provider for every conversation.
      consent.checked = this.hasExternalTransferConsent(provider.id) || !credentialStatus.configured;
      const consentCopy = consentLabel.createDiv();
      consentCopy.createEl("strong", { text: `锁定 ${provider.label} 连接（所有对话可用）` });
      consentCopy.createEl("span", { text: "开启一次后，新建对话、切换对话或重新打开 Obsidian 后仍然有效。外部提供商会接收为完成任务所需的对话、所选 Agent/Skill 定义和受控知识上下文；关闭后所有对话立即停止使用该连接。" });
      const feedback = card.createEl("p", { cls: "xz-field-feedback", attr: { "aria-live": "polite" } });
      const save = card.createEl("button", { cls: "xz-secondary-button", text: "保存连接配置", attr: { type: "button" } });
      save.disabled = typeof this.plugin?.updateSettings !== "function"
        || typeof this.plugin?.saveProviderSecret !== "function";
      save.addEventListener("click", async () => {
        const baseUrl = isCustomProviderId(provider.id) ? endpoint.value.trim() : provider.baseUrl;
        const secret = secretRef.value.trim();
        const model = manualModel.value.trim();
        if (isCustomProviderId(provider.id) && !baseUrl) {
          feedback.setText("请先填写 API 地址，例如 https://api.example.com/v1。");
          feedback.addClass("is-error");
          endpoint.focus();
          return;
        }
        if (baseUrl && !this.isSafeEndpoint(baseUrl)) {
          feedback.setText("API 地址必须使用 HTTPS；仅本机 localhost 可以使用 HTTP。");
          feedback.addClass("is-error");
          endpoint.focus();
          return;
        }
        const expectedRef = isCustomProviderId(provider.id)
          ? customProviderSecretRef(provider.id)
          : provider.secretRef;
        if (!secret && !this.providerCredentialStatus(provider.id).configured) {
          feedback.setText("请先输入 API Key。密钥只会保存到 Obsidian 安全密钥库。");
          feedback.addClass("is-error");
          secretRef.focus();
          return;
        }
        if (model && (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(model) || /[?#\\]/u.test(model))) {
          feedback.setText("模型 ID 格式不正确；请只填写供应商公布的模型标识。 ");
          feedback.addClass("is-error");
          manualModel.focus();
          return;
        }
        feedback.removeClass("is-error");
        save.disabled = true;
        try {
          if (secret) {
            await this.saveProviderSecret(provider.id, secret);
            secretRef.value = "";
          }
          const latestCurrent = stateSettings(this.plugin).providerConfigs?.[provider.id] || {};
          const patch = {
            providerConfigs: {
              [provider.id]: { ...latestCurrent, baseUrl, secretRef: expectedRef, model },
            },
            externalTransferConsents: {
              [provider.id]: consent.checked,
            },
          };
          if (model) {
            patch.providerId = provider.id;
            patch.model = model;
          }
          await this.updateSettings(patch);
          if (consent.checked) await this.plugin.refreshCapabilities?.(provider.id);
          credentialHelp.setText("已安全保存；输入新值可替换");
          const connectionStatus = firstText(
            this.plugin?.state?.runtime?.providerConnections?.[provider.id]?.status,
          ).toLowerCase();
          feedback.setText(!consent.checked
            ? "密钥与连接配置已保存，但连接未锁定；所有对话都不会使用它。"
            : connectionStatus === "connected"
              ? "连接验证成功并已锁定；以后新建或切换对话无需重复设置。"
              : "连接配置已保存并锁定；该接口未能列出模型，将在首次发送时验证手工模型 ID。");
        } catch (error) {
          feedback.setText(firstText(error?.message, "保存失败"));
          feedback.addClass("is-error");
        } finally {
          save.disabled = false;
        }
      });
    });

    // Adding a card only reserves the next id; nothing is sent until the user
    // fills in an address and key and saves that card explicitly.
    const addRow = providers.createDiv({ cls: "xz-provider-add-row" });
    const addFeedback = addRow.createEl("p", { cls: "xz-field-feedback", attr: { "aria-live": "polite" } });
    const addButton = addRow.createEl("button", {
      cls: "xz-secondary-button",
      text: "新增自定义 API",
      attr: { type: "button" },
    });
    addButton.disabled = typeof this.plugin?.updateSettings !== "function";
    addButton.addEventListener("click", () => {
      try {
        const nextId = nextCustomProviderId([
          ...Object.keys(stateSettings(this.plugin).providerConfigs || {}),
          ...asArray(this.plugin?.state?.providers).map((item) => normalizeId(item)),
          ...asArray(this._draftCustomProviderIds),
        ]);
        this._draftCustomProviderIds = [...asArray(this._draftCustomProviderIds), nextId];
        this.renderSettings();
      } catch (error) {
        addFeedback.setText(firstText(error?.message, "添加失败"));
        addFeedback.addClass("is-error");
      }
    });
  }

  providerConnection(providerId) {
    const runtime = this.plugin?.state?.runtime || {};
    const connections = runtime.providerConnections || runtime.connections || {};
    const connection = connections[providerId] || (providerId === "codex" ? runtime.connection : null) || {};
    if (providerId !== "codex" && !this.hasExternalTransferConsent(providerId)) {
      return { label: "未锁定", className: "is-warning" };
    }
    const status = firstText(connection.status).toLowerCase();
    if (["connected", "ready", "online"].includes(status)) return { label: "可用", className: "is-ready" };
    if (status === "configured") return { label: "已配置，待首次调用", className: "is-neutral" };
    if (status === "idle") return { label: providerId === "codex" ? "待检测" : "已授权，待检测", className: "is-neutral" };
    if (["error", "failed", "offline", "disconnected"].includes(status)) return { label: "不可用", className: "is-error" };
    return { label: providerId === "codex" ? "待检测" : "已授权，待检测", className: "is-neutral" };
  }

  isSafeEndpoint(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname));
    } catch (_) {
      return false;
    }
  }

  hasExternalTransferConsent(providerId) {
    if (providerId === "codex") return true;
    if (typeof this.plugin?.hasExternalTransferConsent !== "function") return false;
    try {
      return this.plugin.hasExternalTransferConsent(providerId) === true;
    } catch (_) {
      return false;
    }
  }

  providerCredentialStatus(providerId) {
    if (typeof this.plugin?.providerCredentialStatus !== "function") {
      return { configured: false, source: null };
    }
    try {
      const status = this.plugin.providerCredentialStatus(providerId);
      return status && typeof status === "object"
        ? { configured: status.configured === true, source: firstText(status.source) || null }
        : { configured: false, source: null };
    } catch (_) {
      return { configured: false, source: null };
    }
  }

  async saveProviderSecret(providerId, secret) {
    if (typeof this.plugin?.saveProviderSecret !== "function") {
      throw new Error("当前插件版本不能安全保存 API Key");
    }
    return this.plugin.saveProviderSecret(providerId, secret);
  }

  getSendControlState() {
    const activeConversation = this.getActiveConversation();
    const activeConversationId = normalizeId(activeConversation);
    const turn = this.turnForConversation(activeConversationId);
    const visibleTurnActive = turnIsActive(turn)
      && !isInternalTurn(asArray(activeConversation?.messages), turn?.assistantMessageId);
    const isSending = this.sendingConversationIds.has(activeConversationId);
    const hasText = Boolean(this.refs.composerInput?.value.trim());
    const attachmentQueue = this.attachmentQueueForConversation(activeConversationId);
    const hasAttachments = attachmentQueue.some((item) => item.status !== "completed");
    const attachmentPurpose = this.attachmentPurposeForConversation(activeConversationId);
    const providerId = firstText(stateSettings(this.plugin).providerId, "codex");
    const modelId = firstText(stateSettings(this.plugin).model);
    const hasExternalConsent = this.hasExternalTransferConsent(providerId);
    const hasRequiredModel = providerId === "codex" || Boolean(modelId);
    const hasPendingCapabilityChoice = Boolean(
      this.pendingAgentForConversation(activeConversationId)
      || this.pendingSkillForConversation(activeConversationId),
    );
    return sendControlState({
      hasText,
      hasAttachments,
      turnActive: visibleTurnActive,
      isSending,
      hasPendingCapabilityChoice: hasPendingCapabilityChoice || this.pendingQuestionCalibrationConversations.has(activeConversationId),
      hasExternalConsent,
      hasRequiredModel,
      canSend: hasAttachments
        ? (attachmentPurpose === "reference"
          ? typeof this.plugin?.storeReferenceDocuments === "function"
          : attachmentPurpose === "knowledge"
            ? typeof this.plugin?.ingestDocuments === "function"
            : typeof this.plugin?.sendMessageWithDocuments === "function")
        : typeof this.plugin?.sendMessage === "function",
    });
  }

  syncSendControls() {
    const activeConversation = this.getActiveConversation();
    const activeConversationId = normalizeId(activeConversation);
    const turn = this.turnForConversation(activeConversationId);
    const visibleTurnActive = turnIsActive(turn)
      && !isInternalTurn(asArray(activeConversation?.messages), turn?.assistantMessageId);
    const isSending = this.sendingConversationIds.has(activeConversationId);
    const attachmentBusy = attachmentQueueIsBusy(this.attachmentQueueForConversation(activeConversationId));
    const hasPendingCapabilityChoice = Boolean(
      this.pendingAgentForConversation(activeConversationId)
      || this.pendingSkillForConversation(activeConversationId),
    );
    const sendState = this.getSendControlState();
    this.refs.sendButton.disabled = sendState.disabled;
    this.refs.sendButton.title = sendState.title;
    this.refs.sendButton.setAttr("aria-label", sendState.ariaLabel);
    this.refs.sendButton.toggleAttribute("hidden", visibleTurnActive);
    this.refs.stopButton.toggleAttribute("hidden", !visibleTurnActive);
    this.refs.stopButton.disabled = !visibleTurnActive;
    const hasDraftOrAttachment = Boolean(this.refs.composerInput?.value.trim())
      || this.attachmentQueueForConversation(activeConversationId).length > 0;
    this.refs.composerHelper?.setText(sendState.disabled && hasDraftOrAttachment
      ? sendState.title
      : "Enter 发送 · Shift+Enter 换行");
    this.refs.composer?.toggleClass("is-running", visibleTurnActive);
    const attachmentControlsDisabled = visibleTurnActive || isSending || attachmentBusy;
    this.refs.uploadButton.disabled = attachmentControlsDisabled || hasPendingCapabilityChoice || (
        typeof this.plugin?.ingestDocuments !== "function"
        && typeof this.plugin?.sendMessageWithDocuments !== "function"
      );
    this.refs.fileInput.disabled = this.refs.uploadButton.disabled;
    this.refs.attachmentPurpose.disabled = attachmentControlsDisabled;
    this.refs.clearAttachments.disabled = attachmentControlsDisabled;
    if (this.refs.sourceScopeSelect) this.refs.sourceScopeSelect.disabled = visibleTurnActive || isSending;
    if (this.refs.questionThinkingButton) {
      this.refs.questionThinkingButton.disabled = visibleTurnActive || isSending || this.pendingQuestionCalibrationConversations.has(activeConversationId) || !this.refs.composerInput?.value.trim();
      this.refs.questionThinkingButton.toggleAttribute("hidden", stateSettings(this.plugin).questionCalibrationEnabled === false);
    }
  }

  syncResponsiveState() {
    if (this.historyOpen && this.workPanelOpen) this.workPanelOpen = false;
    const width = Number(this.containerEl?.clientWidth)
      || Number(this.containerEl?.getBoundingClientRect?.().width)
      || 0;
    const compact = width === 0 || width <= 900;
    const sidebarHidden = compact ? !this.historyOpen : this.sidebarCollapsed;
    this.refs.root.toggleClass("is-history-open", this.historyOpen);
    this.refs.root.toggleClass("is-compact", compact);
    this.refs.root.toggleClass("is-sidebar-collapsed", this.sidebarCollapsed);
    this.refs.sidebar?.setAttr("aria-hidden", sidebarHidden ? "true" : "false");
    if (this.refs.sidebar && "inert" in this.refs.sidebar) this.refs.sidebar.inert = sidebarHidden;
    this.refs.root.toggleClass("is-work-panel-open", this.workPanelOpen);
    this.refs.root.toggleClass("is-work-panel-hidden", !this.workPanelOpen);
    this.refs.workPanel.setAttr("aria-hidden", this.workPanelOpen ? "false" : "true");
    if ("inert" in this.refs.workPanel) this.refs.workPanel.inert = !this.workPanelOpen;
    this.syncWorkPanelToggleState();
    this.refs.historyToggle.setAttr("aria-expanded", sidebarHidden ? "false" : "true");
    const action = compact
      ? (this.historyOpen ? "收起" : "打开")
      : (this.sidebarCollapsed ? "显示" : "隐藏");
    this.refs.historyToggle.setAttr("aria-label", `${action}对话历史`);
    this.refs.historyToggle.setAttr("title", `${action}对话历史`);
  }

  syncWorkPanelToggleState(resultCountValue = this.refs.workResultCount?.textContent) {
    const parsedCount = Number(resultCountValue || 0);
    const resultCount = Number.isFinite(parsedCount) ? Math.max(0, Math.trunc(parsedCount)) : 0;
    const action = this.workPanelOpen ? "收起" : "打开";
    const resultHint = resultCount > 0 ? `，本轮已写入 ${resultCount} 项` : "";
    const label = `${action}本轮工作${resultHint}`;
    this.refs.workResultCount?.setText(String(resultCount));
    this.refs.workResultCount?.toggleAttribute("hidden", resultCount === 0 || this.workPanelOpen);
    this.refs.workToggle?.setAttr("aria-label", label);
    this.refs.workToggle?.setAttr("title", label);
    this.refs.workToggle?.setAttr("aria-expanded", this.workPanelOpen ? "true" : "false");
  }

  syncWorkPanelLifecycle() {
    const conversationId = normalizeId(this.getActiveConversation());
    const runtime = this.plugin?.state?.runtime || {};
    const lifecycle = this.workPanelLifecycle.update({
      conversationId,
      turn: this.turnForConversation(conversationId),
      workPanel: this.workPanelForConversation(conversationId),
      approvals: runtime.approvals,
      knowledgeRecovery: runtime.knowledgeRecovery,
    });
    this.workPanelOpen = lifecycle.open;
    if (this.workPanelOpen) this.historyOpen = false;
    this.syncWorkPanelToggleState(lifecycle.writeCount);
  }

  resizeComposer() {
    const input = this.refs.composerInput;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 42), 140)}px`;
  }

  setComposerDraft(value, { focus = false, remember = true } = {}) {
    const draft = typeof value === "string" ? value : "";
    const conversationId = normalizeId(this.getActiveConversation());
    this.draft = draft;
    if (remember && conversationId) this.conversationDrafts.set(conversationId, draft);
    if (!this.refs.composerInput) return;
    this.refs.composerInput.value = draft;
    this.resizeComposer();
    this.syncSendControls();
    if (focus) this.refs.composerInput.focus();
  }

  focusComposer(prefill = "") {
    if (prefill) this.setComposerDraft(prefill);
    this.refs.composerInput.focus();
  }

  replyWith(text) {
    this.focusComposer(text);
    void this.sendCurrentDraft();
  }

  async createConversation() {
    this.unifiedWorkspace?.showChat({ focus: false });
    if (typeof this.plugin?.createConversation !== "function") return;
    try {
      const previousId = normalizeId(this.getActiveConversation());
      if (previousId) this.conversationDrafts.set(previousId, this.refs.composerInput?.value || "");
      await this.plugin.createConversation();
      this.historyOpen = false;
      this.renderState({ force: true });
      const nextId = normalizeId(this.getActiveConversation());
      const nextDraft = this.conversationDrafts.get(nextId) || "";
      this.setComposerDraft(nextDraft, { remember: false });
      this.focusComposer();
    } catch (error) {
      new Notice(`无法创建对话：${firstText(error?.message, error)}`);
    }
  }

  async selectConversation(id) {
    this.unifiedWorkspace?.showChat({ focus: false });
    if (typeof this.plugin?.selectConversation !== "function") return;
    try {
      const previousId = normalizeId(this.getActiveConversation());
      if (previousId) this.conversationDrafts.set(previousId, this.refs.composerInput?.value || "");
      await this.plugin.selectConversation(id);
      this.historyOpen = false;
      this.renderState({ force: true });
      const nextDraft = this.conversationDrafts.get(id) || "";
      this.setComposerDraft(nextDraft, { remember: false });
      this.focusComposer();
    } catch (error) {
      new Notice(`无法打开对话：${firstText(error?.message, error)}`);
    }
  }

  async toggleConversationPin(id) {
    if (typeof this.plugin?.toggleConversationPin !== "function") return;
    try {
      await this.plugin.toggleConversationPin(id);
      this.renderConversationHistory({ force: true });
    } catch (error) {
      new Notice(`无法更新置顶：${firstText(error?.message, error)}`);
    }
  }

  async renameConversation(id) {
    if (typeof this.plugin?.renameConversation !== "function") return;
    const conversation = asArray(this.plugin?.state?.conversations)
      .find((item) => normalizeId(item) === id);
    const current = normalizeLabel(conversation, "新对话");
    const requested = await new XingzhiTextPromptModal(this.app, {
      title: "重命名对话",
      initialValue: current,
      submitLabel: "保存名称",
    }).waitForValue();
    if (requested === null || requested === undefined) return;
    try {
      await this.plugin.renameConversation(id, requested);
      new Notice("对话名称已更新");
      this.renderState({ force: true });
    } catch (error) {
      new Notice(`无法重命名对话：${firstText(error?.message, error)}`);
    }
  }

  async archiveConversation(id) {
    const conversation = asArray(this.plugin?.state?.conversations)
      .find((item) => normalizeId(item) === id);
    try {
      if (conversation?.archivedAt) {
        if (typeof this.plugin?.unarchiveConversation !== "function") return;
        await this.plugin.unarchiveConversation(id);
        new Notice("对话已恢复到历史列表");
      } else if (conversation?.archiveDraft
        && (conversation.archiveDraft.archiveScope === "message-blocks"
          || !["source-review", "stale", "failed"].includes(conversation.archiveDraft.status))) {
        this.openArchiveReview(id);
        return;
      } else {
        if (typeof this.plugin?.backgroundArchiveConversation !== "function") return;
        new Notice("正在后台整理归档内容；归档时补充跨多轮总结、遗漏整理和重大待审项。完成前不会隐藏对话…", 6_000);
        await this.plugin.backgroundArchiveConversation(id);
        new Notice("归档知识卡片已生成，请核对内容、标签和链接后再确认写入");
        this.openArchiveReview(id);
      }
      this.renderState({ force: true });
    } catch (error) {
      new Notice(`归档失败：${firstText(error?.message, error)}`);
      this.renderState({ force: true });
    }
  }

  openMessageBlocks(conversationId, messageId) {
    if (!conversationId || !messageId || typeof this.plugin?.getMessageBlocks !== "function") {
      new Notice("当前消息不能进行段落管理");
      return;
    }
    new XingzhiMessageBlocksModal(this.app, {
      plugin: this.plugin,
      conversationId,
      messageId,
    }).open();
  }

  async retryArchiveConversation(id) {
    if (typeof this.plugin?.retryArchiveConversation !== "function") return;
    try {
      new Notice("正在重新生成归档预览…", 5_000);
      await this.plugin.retryArchiveConversation(id);
      this.renderState({ force: true });
      this.openArchiveReview(id);
    } catch (error) {
      new Notice(`归档重试失败：${firstText(error?.message, error)}`);
      this.renderState({ force: true });
    }
  }

  isCompactLayout() {
    const width = Number(this.refs.root?.clientWidth || 0);
    return width > 0 && width <= 900;
  }

  async discardArchiveDraft(id, draftId) {
    if (typeof this.plugin?.discardArchiveDraft !== "function" || !draftId) return;
    try {
      await this.plugin.discardArchiveDraft(id, draftId);
      new Notice("本次归档草稿已放弃；原始对话和已有知识未被删除");
      this.renderState({ force: true });
    } catch (error) {
      new Notice(`无法放弃归档草稿：${firstText(error?.message, error)}`);
      this.renderState({ force: true });
    }
  }

  openArchiveReview(id) {
    const conversation = asArray(this.plugin?.state?.conversations)
      .find((item) => normalizeId(item) === id);
    if (!conversation?.archiveDraft) {
      new Notice("尚未生成归档预览");
      return;
    }
    if (typeof this.plugin?.openArchiveReview !== "function") {
      new Notice("当前版本不能打开独立归档审核页面");
      return;
    }
    void this.plugin.openArchiveReview(id).catch((error) => {
      new Notice(`无法打开归档审核页面：${firstText(error?.message, error)}`);
    });
  }

  async continueArchiveConversation(id, kind) {
    if (typeof this.plugin?.continueArchiveConversation !== "function") return;
    try {
      await this.plugin.continueArchiveConversation(id);
      this.renderState({ force: true });
      if (kind === "confirm") {
        this.syncWorkPanelLifecycle();
        this.historyOpen = false;
        this.syncResponsiveState();
        this.refs.workPanel.querySelector("button")?.focus();
      } else {
        this.focusComposer();
      }
    } catch (error) {
      new Notice(`无法继续归档：${firstText(error?.message, error)}`);
    }
  }

  async deleteConversation(id) {
    if (typeof this.plugin?.deleteConversation !== "function") return;
    const conversation = asArray(this.plugin?.state?.conversations)
      .find((item) => normalizeId(item) === id);
    const label = normalizeLabel(conversation, "该对话");
    const confirmed = await new XingzhiConfirmationModal(this.app, {
      title: "删除对话",
      message: `确定删除“${label}”吗？对话会从工作台隐藏，但不会删除已写入的知识或原始对话 Markdown。删除最后一个对话时，系统会自动新建一个空白对话。`,
      confirmLabel: "删除对话",
    }).waitForConfirmation();
    if (!confirmed) return;
    try {
      await this.plugin.deleteConversation(id);
      new Notice("对话已从工作台移除；原始记录仍保留在本地知识库");
      this.renderState({ force: true });
    } catch (error) {
      new Notice(`无法删除对话：${firstText(error?.message, error)}`);
    }
  }

  async copyMessageContent(content) {
    const text = String(content || "");
    if (!text) return;
    try {
      await globalThis.navigator?.clipboard?.writeText(text);
      new Notice("内容已复制");
    } catch (_) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand?.("copy");
      textarea.remove();
      if (!copied) throw new Error("系统剪贴板不可用");
      new Notice("内容已复制");
    }
  }

  attachmentQueueForConversation(conversationId = normalizeId(this.getActiveConversation())) {
    return conversationId ? (this.attachmentQueues.get(conversationId) || []) : [];
  }

  attachmentPurposeForConversation(conversationId = normalizeId(this.getActiveConversation())) {
    return normalizeAttachmentPurpose(this.attachmentPurposes.get(conversationId));
  }

  stagePastedDocuments(event) {
    const files = filesFromClipboardData(event?.clipboardData);
    if (!files.length) return;
    event.preventDefault();
    this.stageDocuments(files, { source: "clipboard" });
  }

  async stageSelectedDocuments() {
    const files = [...(this.refs.fileInput?.files || [])];
    this.stageDocuments(files, { source: "picker", resetFileInput: true });
  }

  stageDocuments(files, { source = "picker", resetFileInput = false } = {}) {
    const conversationId = normalizeId(this.getActiveConversation());
    if (!files.length || !conversationId) return;
    if (attachmentQueueIsBusy(this.attachmentQueueForConversation(conversationId))) {
      if (resetFileInput && this.refs.fileInput) this.refs.fileInput.value = "";
      new Notice("当前附件批次正在处理，请完成后再添加文件");
      return;
    }
    const previousItems = this.attachmentQueueForConversation(conversationId);
    const result = appendAttachments(previousItems, files);
    this.attachmentQueues.set(conversationId, result.items);
    this.attachmentReceipts.delete(conversationId);
    if (!this.attachmentPurposes.has(conversationId)) this.attachmentPurposes.set(conversationId, "conversation");
    if (resetFileInput && this.refs.fileInput) this.refs.fileInput.value = "";
    this.renderAttachmentQueue();
    this.syncSendControls();
    const added = Math.max(0, result.items.length - previousItems.length);
    const duplicates = result.rejected.filter((item) => item.reason === "duplicate").length;
    const overflow = result.rejected.filter((item) => item.reason === "queue-limit").length;
    if (source === "clipboard" && added) {
      new Notice(`已从剪贴板添加 ${added} 个文件或图片`);
    }
    if (duplicates || overflow) {
      const details = [
        duplicates ? `${duplicates} 个重复文件已跳过` : "",
        overflow ? `${overflow} 个文件超过 20 项队列上限` : "",
      ].filter(Boolean).join("；");
      new Notice(details);
    }
    return result;
  }

  removeAttachment(id) {
    const conversationId = normalizeId(this.getActiveConversation());
    if (!conversationId) return;
    if (attachmentQueueIsBusy(this.attachmentQueueForConversation(conversationId))) return;
    const next = this.attachmentQueueForConversation(conversationId).filter((item) => item.id !== id);
    if (next.length) this.attachmentQueues.set(conversationId, next);
    else this.attachmentQueues.delete(conversationId);
    this.renderAttachmentQueue();
    this.syncSendControls();
  }

  clearAttachments() {
    const conversationId = normalizeId(this.getActiveConversation());
    if (attachmentQueueIsBusy(this.attachmentQueueForConversation(conversationId))) return;
    if (conversationId) {
      this.attachmentQueues.delete(conversationId);
      this.attachmentReceipts.delete(conversationId);
    }
    this.renderAttachmentQueue();
    this.syncSendControls();
    this.refs.composerInput?.focus();
  }

  retryAttachment(id) {
    const conversationId = normalizeId(this.getActiveConversation());
    if (!conversationId) return;
    if (attachmentQueueIsBusy(this.attachmentQueueForConversation(conversationId))) return;
    this.attachmentQueues.set(
      conversationId,
      updateAttachmentStatus(this.attachmentQueueForConversation(conversationId), [id], "queued"),
    );
    this.renderAttachmentQueue();
    this.syncSendControls();
  }

  async retryAttachmentKnowledge(receipt) {
    const conversationId = normalizeId(this.getActiveConversation());
    if (!conversationId || this.attachmentKnowledgeRetries.has(conversationId)
      || typeof this.plugin?.retryDocumentKnowledgeProcessing !== "function") return;
    const files = asArray(receipt?.files).filter((file) => file?.originalPath);
    if (!files.length) {
      new Notice("没有找到可重试的本地原文件");
      return;
    }
    this.attachmentKnowledgeRetries.add(conversationId);
    this.sendingConversationIds.add(conversationId);
    this.attachmentReceipts.set(conversationId, buildAttachmentReceiptPresentation({
      purpose: "knowledge",
      status: "running",
      files: files.map((file) => ({ ...file, knowledgeStatus: "pending", knowledgeError: null })),
    }));
    this.renderAttachmentQueue();
    this.syncSendControls();
    try {
      const result = await this.plugin.retryDocumentKnowledgeProcessing(files, { conversationId });
      const nextReceipt = buildAttachmentReceiptPresentation({
        purpose: "knowledge",
        status: firstText(result?.status, "completed"),
        error: result?.error,
        files: asArray(result?.files).length ? result.files : files,
        indexStatus: result?.indexStatus,
        queryable: result?.queryable === true,
      });
      this.attachmentReceipts.set(conversationId, nextReceipt);
      new Notice(nextReceipt.canRetryKnowledge
        ? `知识整理仍未完成：${nextReceipt.error || "模型回合未正常完成"}`
        : "知识整理已重新完成");
    } catch (error) {
      const message = firstText(error?.message, error, "知识整理重试失败");
      this.attachmentReceipts.set(conversationId, buildAttachmentReceiptPresentation({
        purpose: "knowledge",
        status: "failed",
        error: message,
        files: files.map((file) => ({ ...file, knowledgeStatus: "failed", knowledgeError: message })),
      }));
      new Notice(`知识整理重试失败：${message}`);
    } finally {
      this.attachmentKnowledgeRetries.delete(conversationId);
      this.sendingConversationIds.delete(conversationId);
      this.renderAttachmentQueue();
      this.syncSendControls();
    }
  }

  renderAttachmentQueue() {
    if (!this.refs.attachmentTray || !this.refs.attachmentList) return;
    this.releaseUnusedAttachmentPreviews();
    const conversationId = normalizeId(this.getActiveConversation());
    const items = this.attachmentQueueForConversation(conversationId);
    const retryingKnowledge = this.attachmentKnowledgeRetries.has(conversationId);
    const busy = attachmentQueueIsBusy(items) || retryingKnowledge || this.sendingConversationIds.has(conversationId);
    this.refs.attachmentTray.toggleAttribute("hidden", items.length === 0);
    this.refs.attachmentTray.toggleClass("is-busy", busy);
    this.refs.attachmentPurpose.value = this.attachmentPurposeForConversation(conversationId);
    this.refs.attachmentPurpose.disabled = busy || items.length === 0;
    this.refs.attachmentPurposeWrap?.toggleAttribute("hidden", items.length === 0);
    this.refs.clearAttachments.disabled = busy;
    this.refs.clearAttachments.setAttr(
      "aria-label",
      "移除全部待发送附件",
    );
    this.refs.clearAttachments.setAttr(
      "title",
      "移除全部待发送附件",
    );
    if (!items.length) {
      this.refs.attachmentList.empty();
      this.refs.attachmentSummary.setText("尚未添加附件");
      return;
    }
    const summary = attachmentQueueSummary(items);
    const batches = groupAttachmentBatches(items);
    this.refs.attachmentSummary.setText([
        `已选择 ${summary.total} 项`,
        `${summary.documents} 份文档`,
        `${summary.images} 张图片`,
        batches.length > 1 ? `将分 ${batches.length} 个安全批次` : "单批处理",
      ].join(" · "));
    this.refs.attachmentList.empty();
    const statusText = {
      queued: "等待处理", processing: "正在读取", completed: "已提交", error: "处理失败",
    };
    for (const item of items) {
      const card = this.refs.attachmentList.createDiv({
        cls: `xz-attachment-card is-${item.status}${item.kind === "image" ? " has-image-preview" : ""}`,
        attr: { role: "listitem" },
      });
      if (item.kind === "image") this.renderQueuedImage(card, item);
      else {
        const icon = card.createSpan({ cls: "xz-attachment-icon", attr: { "aria-hidden": "true" } });
        setIcon(icon, "file-text");
      }
      const copy = card.createDiv({ cls: "xz-attachment-copy" });
      copy.createEl("strong", { text: item.name, attr: { title: item.name } });
      copy.createSpan({ text: `${this.formatFileSize(item.size)} · ${statusText[item.status] || "等待处理"}` });
      if (item.error) copy.createEl("small", { text: item.error, attr: { title: item.error } });
      if (item.status === "error") {
        const retry = createIconButton(card, "refresh-cw", `重试 ${item.name}`, () => this.retryAttachment(item.id), "xz-attachment-action");
        retry.disabled = busy;
      }
      const remove = createIconButton(card, "x", `移除 ${item.name}`, () => this.removeAttachment(item.id), "xz-attachment-action");
      remove.disabled = busy;
    }
  }

  formatFileSize(size) {
    const bytes = Number(size || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  questionThinkingAssessment(text, { forceOffer = false } = {}) {
    const conversation = this.getActiveConversation();
    return assessQuestion(text, {
      hasAttachments: this.attachmentQueueForConversation(normalizeId(conversation)).length > 0,
      messages: asArray(conversation?.messages),
      forceOffer,
    });
  }

  questionThinkingHabitHints() {
    return buildQuestionHabitHints(asArray(this.plugin?.state?.questionCalibrationEvents), {
      enabled: stateSettings(this.plugin).questionHabitHintsEnabled === true,
    });
  }

  async prepareQuestionThinking() {
    const original = this.refs.composerInput?.value.trim() || "";
    const conversationId = normalizeId(this.getActiveConversation());
    if (!original || !conversationId || stateSettings(this.plugin).questionCalibrationEnabled === false
      || this.pendingQuestionCalibrationConversations.has(conversationId)) return;
    this.setComposerDraft(buildDynamicThinkingRequest(original), { focus: true });
  }

  async sendCurrentDraft() {
    let text = this.refs.composerInput?.value.trim() || "";
    const conversationId = normalizeId(this.getActiveConversation());
    const attachments = this.attachmentQueueForConversation(conversationId);
    const hasPendingAttachments = groupAttachmentBatches(attachments).length > 0;
    if ((!text && !attachments.length) || !conversationId) return;
    const previous = this.refs.composerInput?.value || "";
    const providerId = firstText(stateSettings(this.plugin).providerId, "codex");
    const sendState = this.getSendControlState();
    if (sendState.disabled) {
      if (providerId !== "codex" && !this.hasExternalTransferConsent(providerId)) {
        new Notice(`请先在设置中保存并锁定 ${this.providerLabel(providerId)} 连接`);
        this.openSettings();
      } else {
        new Notice(sendState.title);
      }
      return;
    }
    this.sendingConversationIds.add(conversationId);
    const createdAt = new Date().toISOString();
    const optimisticMessage = {
      id: `msg-${crypto.randomUUID()}`,
      role: "user",
      content: text || (hasPendingAttachments ? "已发送附件" : ""),
      status: "optimistic",
      createdAt,
      completedAt: null,
      optimistic: true,
    };
    this.pendingOutgoingMessages.set(conversationId, optimisticMessage);
    if (hasPendingAttachments) {
      const items = groupAttachmentBatches(attachments).flat();
      this.attachmentSends.set(conversationId, {
        messageId: optimisticMessage.id,
        items,
        purpose: this.attachmentPurposeForConversation(conversationId),
        presentation: { status: "reading", detail: "正在读取附件…" },
      });
      this.attachmentQueues.delete(conversationId);
      this.attachmentReceipts.delete(conversationId);
    } else {
      this.attachmentSends.delete(conversationId);
      this.pendingThinkingTurns.set(conversationId, {
        status: "starting",
        phase: "semantic-routing",
        startedAt: createdAt,
        phaseStartedAt: createdAt,
        userMessageId: optimisticMessage.id,
      });
    }
    this.setComposerDraft("");
    this.renderMessages({ force: true });
    this.renderStreamingTurn();
    this.renderAttachmentQueue();
    this.syncSendControls();
    try {
      const requestedSkills = [...(this.nextTurnSkillSelections.get(conversationId) || [])];
      if (hasPendingAttachments) {
        await this.sendAttachmentQueue({ conversationId, text, requestedSkills });
      } else {
        await this.plugin.sendMessage(text, {
          mode: "dialogue",
          conversationId,
          requestedSkills,
          clientUserMessageId: optimisticMessage?.id,
        });
      }
      this.preparedQuestionCalibrations.delete(conversationId);
      this.nextTurnSkillSelections.delete(conversationId);
      this.renderSkillPicker({ force: true });
    } catch (error) {
      const acceptedConversation = asArray(this.getConversations())
        .find((item) => normalizeId(item) === conversationId);
      const messageWasAccepted = Boolean(optimisticMessage
        && asArray(acceptedConversation?.messages)
          .some((message) => message?.id === optimisticMessage.id));
      if (!hasPendingAttachments && optimisticMessage
        && this.pendingOutgoingMessages.get(conversationId)?.id === optimisticMessage.id) {
        this.pendingOutgoingMessages.delete(conversationId);
        if (normalizeId(this.getActiveConversation()) === conversationId) {
          this.renderMessages({ force: true });
        }
      }
      if (hasPendingAttachments || !messageWasAccepted) {
        // Do not discard a new draft the user typed while the upload was pending.
        const currentDraft = normalizeId(this.getActiveConversation()) === conversationId
          ? this.refs.composerInput?.value || "" : this.conversationDrafts.get(conversationId) || "";
        const restoredDraft = currentDraft && currentDraft !== previous ? `${previous}\n\n${currentDraft}` : previous;
        this.conversationDrafts.set(conversationId, restoredDraft);
        if (normalizeId(this.getActiveConversation()) === conversationId) {
          this.setComposerDraft(restoredDraft);
        }
      }
      new Notice(`消息发送失败：${firstText(error?.message, error)}`);
    } finally {
      if (optimisticMessage
        && this.pendingThinkingTurns.get(conversationId)?.userMessageId === optimisticMessage.id) {
        this.pendingThinkingTurns.delete(conversationId);
        if (normalizeId(this.getActiveConversation()) === conversationId) {
          this.renderStreamingTurn();
        }
      }
      this.sendingConversationIds.delete(conversationId);
      this.renderAttachmentQueue();
      this.syncSendControls();
      if (normalizeId(this.getActiveConversation()) === conversationId) this.refs.composerInput.focus();
    }
  }

  async sendAttachmentQueue({ conversationId, text, requestedSkills }) {
    const send = this.attachmentSends.get(conversationId);
    if (!send) return;
    const purpose = send.purpose;
    const batches = groupAttachmentBatches(send.items);
    if (!batches.length) return;
    let completed = 0;
    const receiptFiles = [];
    let lastOperationResult = null;
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const batchInstruction = index === 0
        ? text : `继续处理同一组附件的第 ${index + 1}/${batches.length} 批。${text}`.trim();
      if (index > 0) {
        send.messageId = `msg-${crypto.randomUUID()}`;
        this.pendingOutgoingMessages.set(conversationId, {
          id: send.messageId, role: "user", content: batchInstruction || "已发送附件",
          status: "optimistic", createdAt: new Date().toISOString(), completedAt: null, optimistic: true,
        });
      }
      send.items = batches.slice(index).flat();
      send.presentation = {
        status: "reading",
        detail: batches.length > 1 ? `正在读取附件…（第 ${index + 1}/${batches.length} 批）` : "正在读取附件…",
      };
      if (normalizeId(this.getActiveConversation()) === conversationId) this.renderMessages({ force: true });
      try {
        assertAttachmentBatchWithinLimits(batch);
        const documents = [];
        let batchBytes = 0;
        for (const item of batch) {
          const { bytes, byteLength } = await readBoundedAttachment(item, MAX_ATTACHMENT_BATCH_BYTES - batchBytes);
          batchBytes += byteLength;
          documents.push({ name: item.name, mimeType: item.mimeType, bytes });
        }
        if (purpose === "reference") {
          lastOperationResult = await this.plugin.storeReferenceDocuments(documents, {
            conversationId, instructionText: batchInstruction, clientUserMessageId: send.messageId,
          });
        } else if (purpose === "knowledge") {
          lastOperationResult = await this.plugin.ingestDocuments(documents, {
            conversationId,
            instructionText: batchInstruction,
            clientUserMessageId: send.messageId,
          });
        } else {
          lastOperationResult = await this.plugin.sendMessageWithDocuments(batchInstruction, documents, {
            conversationId,
            purpose,
            requestedSkills,
            waitForCompletion: true,
            clientUserMessageId: send.messageId,
          });
        }
        const operationStatus = firstText(lastOperationResult?.status, lastOperationResult?.assistant?.status, "completed");
        if (["failed", "error", "interrupted", "cancelled"].includes(operationStatus)) {
          const error = new Error(firstText(lastOperationResult?.error?.message, lastOperationResult?.error,
            lastOperationResult?.assistant?.error?.message, lastOperationResult?.assistant?.error,
            operationStatus === "interrupted" || operationStatus === "cancelled" ? "附件处理已停止" : "附件处理失败"));
          error.attachmentFiles = asArray(lastOperationResult?.files);
          throw error;
        }
        receiptFiles.push(...asArray(lastOperationResult?.files));
        completed += batch.length;
      } catch (error) {
        const failedFiles = asArray(error?.attachmentFiles);
        if (purpose === "knowledge" && failedFiles.length) {
          this.attachmentReceipts.set(conversationId, buildAttachmentReceiptPresentation({
            purpose,
            status: "failed",
            files: [...receiptFiles, ...failedFiles],
            error: firstText(error?.message, error, "文档知识整理失败"),
          }));
        }
        const detail = firstText(error?.message, error, "文件处理失败");
        const remaining = batches.slice(index).flat().map((item) => ({
          ...item, status: "error", error: detail,
        }));
        const existing = this.attachmentQueueForConversation(conversationId);
        const existingIds = new Set(existing.map((item) => item.id));
        this.attachmentQueues.set(conversationId, [...existing, ...remaining.filter((item) => !existingIds.has(item.id))]);
        send.items = [];
        send.presentation = { status: "error", detail: `附件未完成，已退回输入区：${detail}` };
        const pending = this.pendingOutgoingMessages.get(conversationId);
        if (pending?.id === send.messageId) {
          this.pendingOutgoingMessages.set(conversationId, {
            ...pending, status: "failed", error: detail,
            content: `${pending.content}\n${remaining.map((item) => item.name).join("、")}`,
          });
        }
        if (normalizeId(this.getActiveConversation()) === conversationId) this.renderMessages({ force: true });
        this.renderAttachmentQueue();
        throw error;
      }
    }
    const operationStatus = firstText(
      lastOperationResult?.status,
      lastOperationResult?.assistant?.status,
      "completed",
    );
    const receipt = buildAttachmentReceiptPresentation({
      purpose,
      status: purpose === "conversation" || purpose === "compare" ? "completed" : operationStatus,
      files: receiptFiles,
      error: lastOperationResult?.error,
      indexStatus: lastOperationResult?.indexStatus,
      queryable: lastOperationResult?.queryable === true,
    });
    this.attachmentReceipts.set(conversationId, receipt);
    this.attachmentSends.delete(conversationId);
    if (normalizeId(this.getActiveConversation()) === conversationId) this.renderMessages({ force: true });
    this.renderAttachmentQueue();
    new Notice(receipt.canRetryKnowledge
      ? `文件已保存并读取，但知识整理未完成：${receipt.error || "模型回合未正常完成"}`
      : (purpose === "reference"
        ? `已将 ${completed} 个文件存入资料库；未分析、未审核、未形成知识`
        : purpose === "knowledge"
          ? `已完成 ${completed} 个文件的知识整理并保留独立来源`
          : `已提交 ${completed} 个附件，回答中会保留对应来源`));
  }

  async stopTurn() {
    if (typeof this.plugin?.stopActiveTurn !== "function") return;
    this.refs.stopButton.disabled = true;
    try {
      await this.plugin.stopActiveTurn(normalizeId(this.getActiveConversation()));
    } catch (error) {
      new Notice(`停止失败：${firstText(error?.message, error)}`);
      this.refs.stopButton.disabled = false;
    }
  }

  async updateSettings(patch) {
    if (typeof this.plugin?.updateSettings !== "function") return;
    try {
      await this.plugin.updateSettings(patch);
    } catch (error) {
      new Notice(`设置未保存：${firstText(error?.message, error)}`);
      throw error;
    }
  }

  async respondApproval(id, decision, actionHost) {
    if (typeof this.plugin?.respondApproval !== "function") return;
    actionHost.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    try {
      await this.plugin.respondApproval(id, decision);
    } catch (error) {
      actionHost.querySelectorAll("button").forEach((button) => { button.disabled = false; });
      new Notice(`权限回应失败：${firstText(error?.message, error)}`);
    }
  }

  async respondAgentRecommendation(id, decision, actionHost) {
    if (typeof this.plugin?.respondAgentRecommendation !== "function") return;
    actionHost.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    try {
      await this.plugin.respondAgentRecommendation(id, decision);
    } catch (error) {
      actionHost.querySelectorAll("button").forEach((button) => { button.disabled = false; });
      new Notice(`Agent 选择失败：${firstText(error?.message, error)}`);
    }
  }

  async respondSkillRecommendation(id, decision, selectedSkills, actionHost) {
    if (typeof this.plugin?.respondSkillRecommendation !== "function") return;
    actionHost.querySelectorAll("button, input").forEach((element) => { element.disabled = true; });
    try {
      await this.plugin.respondSkillRecommendation(id, decision, selectedSkills);
    } catch (error) {
      actionHost.querySelectorAll("button, input").forEach((element) => { element.disabled = false; });
      new Notice(`Skill 选择失败：${firstText(error?.message, error)}`);
    }
  }

  async respondKnowledgeConfirmation(id, decision, actionHost) {
    if (typeof this.plugin?.respondKnowledgeConfirmation !== "function") return;
    actionHost.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    try {
      const result = await this.plugin.respondKnowledgeConfirmation(id, decision);
      if (decision === "accept") {
        new Notice(result?.indexStatus === "retry-needed"
          ? "正式知识已写入；索引更新未完成，已保留可恢复状态"
          : "知识已分类写入，并完成下次调用索引");
      } else {
        new Notice("本次不写入正式知识，来源整理记录仍保留");
      }
    } catch (error) {
      actionHost.querySelectorAll("button").forEach((button) => { button.disabled = false; });
      new Notice(`知识确认失败：${firstText(error?.message, error)}`);
    }
  }

  async undoTransaction(id, button) {
    if (typeof this.plugin?.undoTransaction !== "function") return;
    button.disabled = true;
    try {
      await this.plugin.undoTransaction(id);
      new Notice("已撤销这次知识库写入");
    } catch (error) {
      button.disabled = false;
      new Notice(`撤销失败：${firstText(error?.message, error)}`);
    }
  }

  async openVaultPath(path) {
    if (!path || typeof this.plugin?.openVaultPath !== "function") return;
    try {
      await this.plugin.openVaultPath(path);
    } catch (error) {
      new Notice(`无法打开文件：${firstText(error?.message, error)}`);
    }
  }

  async refreshCapabilities(button = this.refs.connectionButton, providerId = firstText(stateSettings(this.plugin).providerId, "codex")) {
    if (typeof this.plugin?.refreshCapabilities !== "function") return;
    if (button) button.disabled = true;
    try {
      await this.plugin.refreshCapabilities(providerId);
    } catch (error) {
      new Notice(`能力读取失败：${firstText(error?.message, error)}`);
    } finally {
      if (button) button.disabled = false;
    }
  }

  toggleHistoryPanel() {
    const width = Number(this.containerEl?.clientWidth)
      || Number(this.containerEl?.getBoundingClientRect?.().width)
      || 0;
    if (width === 0 || width <= 900) {
      this.historyOpen = !this.historyOpen;
      if (this.historyOpen) {
        const conversationId = normalizeId(this.getActiveConversation());
        this.workPanelOpen = this.workPanelLifecycle.close(conversationId).open;
      }
    } else {
      this.sidebarCollapsed = !this.sidebarCollapsed;
      this.historyOpen = false;
    }
    this.syncResponsiveState();
    if (this.historyOpen) this.refs.newConversation?.focus();
    else this.refs.historyToggle?.focus();
  }

  toggleWorkPanel() {
    const conversationId = normalizeId(this.getActiveConversation());
    const wasOpen = this.workPanelOpen;
    this.workPanelOpen = this.workPanelLifecycle.manualToggle(conversationId).open;
    if (this.workPanelOpen) this.historyOpen = false;
    this.syncResponsiveState();
    if (this.workPanelOpen) this.refs.workPanel.querySelector("button")?.focus();
    else if (wasOpen) this.refs.workToggle?.focus();
  }

  openSettings() {
    this.closeMaintenancePanels();
    this.section = "settings";
    this.settingsOpen = true;
    this.renderSettings();
    this.refs.settingsScrim.removeAttribute("hidden");
    this.refs.settingsDrawer.removeAttribute("hidden");
    this.refs.root.addClass("is-settings-open");
    this.renderPrimaryNavigation();
    const schedule = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
    schedule(() => this.refs.settingsClose.focus());
  }

  closeSettings() {
    if (!this.refs.settingsDrawer) return;
    const wasOpen = this.settingsOpen;
    this.section = "chat";
    this.settingsOpen = false;
    this.refs.settingsScrim.setAttr("hidden", "");
    this.refs.settingsDrawer.setAttr("hidden", "");
    this.refs.root.removeClass("is-settings-open");
    this.renderPrimaryNavigation();
    if (wasOpen) this.refs.settingsButton?.focus();
  }

  openConnectionDiagnostics() {
    this.closeSettings();
    this.recycleBinPanel?.close();
    this.knowledgeHealthPanel?.close();
    this.knowledgeStructurePanel?.close();
    this.userGrowthPanel?.close();
    this.section = "diagnostics";
    this.connectionDiagnosticsPanel?.open();
    this.renderPrimaryNavigation();
  }

  openRecycleBin() {
    this.closeSettings();
    this.connectionDiagnosticsPanel?.close();
    this.knowledgeHealthPanel?.close();
    this.knowledgeStructurePanel?.close();
    this.userGrowthPanel?.close();
    this.section = "recycle-bin";
    this.recycleBinPanel?.open();
    this.renderPrimaryNavigation();
  }

  openKnowledgeHealth() {
    this.closeSettings();
    this.connectionDiagnosticsPanel?.close();
    this.recycleBinPanel?.close();
    this.knowledgeStructurePanel?.close();
    this.userGrowthPanel?.close();
    this.section = "knowledge-health";
    void this.knowledgeHealthPanel?.open();
    this.renderPrimaryNavigation();
  }

  openKnowledgeStructure() {
    this.closeSettings();
    this.connectionDiagnosticsPanel?.close();
    this.recycleBinPanel?.close();
    this.knowledgeHealthPanel?.close();
    this.userGrowthPanel?.close();
    this.section = "knowledge-structure";
    void this.knowledgeStructurePanel?.open();
    this.renderPrimaryNavigation();
  }

  openUserGrowth() {
    this.closeSettings();
    this.connectionDiagnosticsPanel?.close();
    this.recycleBinPanel?.close();
    this.knowledgeHealthPanel?.close();
    this.knowledgeStructurePanel?.close();
    this.section = "user-growth";
    void this.userGrowthPanel?.open();
    this.renderPrimaryNavigation();
  }

  closeMaintenancePanels() {
    this.connectionDiagnosticsPanel?.close();
    this.recycleBinPanel?.close();
    this.knowledgeHealthPanel?.close();
    this.knowledgeStructurePanel?.close();
    this.userGrowthPanel?.close();
    this.section = "chat";
    this.renderPrimaryNavigation();
  }

  handleGlobalKeydown(event) {
    if (event.composedPath?.().some(node => node.classList?.contains("xz-point-modal"))) return;
    if (event.key === "Escape" && closeConversationMenuOnEscape(this.conversationNodes, event)) return;
    if (event.key === "Escape") {
      if (this.settingsOpen) {
        event.preventDefault();
        this.closeSettings();
      } else if (this.connectionDiagnosticsPanel?.opened || this.recycleBinPanel?.opened
        || this.knowledgeHealthPanel?.opened || this.knowledgeStructurePanel?.opened
        || this.userGrowthPanel?.opened) {
        event.preventDefault();
        this.closeMaintenancePanels();
      } else if (this.historyOpen) {
        this.historyOpen = false;
        this.syncResponsiveState();
      } else if (this.workPanelOpen
        && this.containerEl.isShown()
        && this.refs.root.contains(event.target)) {
        event.preventDefault();
        const conversationId = normalizeId(this.getActiveConversation());
        this.workPanelOpen = this.workPanelLifecycle.close(conversationId).open;
        this.syncResponsiveState();
        this.refs.workToggle?.focus();
      }
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n" && this.containerEl.isShown()) {
      event.preventDefault();
      void this.createConversation();
    }
  }

}

module.exports = {
  VIEW_TYPE_XINGZHI,
  XingzhiWorkbenchView,
};