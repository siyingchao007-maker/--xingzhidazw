"use strict";

const MAX_SOURCE_BYTES = 16 * 1024;
const MAX_LAYERS = 8;
const MAX_NODES = 24;
const MAX_LINKS = 7;
const STATUS_LABELS = Object.freeze({
  fact: "事实",
  reported: "自述",
  inference: "推断",
  candidate: "候选",
  unknown: "未知",
});
const LINK_DIRECTIONS = new Set(["none", "down", "both"]);

function fail(message) {
  throw new Error(`结构图无效：${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label}包含不支持的字段「${key}」`);
  }
}

function textLength(value) {
  return [...value].length;
}

function assertXmlSafeText(value, field) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
      || code === 0xfffe || code === 0xffff) fail(`${field}含有 SVG 不支持的字符`);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) fail(`${field}含有无效 Unicode 字符`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(`${field}含有无效 Unicode 字符`);
    }
  }
}

function boundedText(value, { field, maximum, allowEmpty = false }) {
  if (typeof value !== "string") fail(`${field}必须是文字`);
  assertXmlSafeText(value, field);
  const text = value.trim();
  const length = textLength(text);
  if ((!allowEmpty && length === 0) || length > maximum) {
    fail(`${field}长度必须为${allowEmpty ? "0" : "1"}—${maximum}个字符`);
  }
  return text;
}

function parseMessageDiagram(source) {
  if (typeof source !== "string") fail("内容必须是 JSON 文字");
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) fail("源码超过 16KB");
  let input;
  try {
    input = JSON.parse(source);
  } catch (_error) {
    fail("JSON 语法无法解析");
  }
  if (!isRecord(input)) fail("顶层必须是对象");
  assertKnownKeys(input, new Set(["title", "layers", "links"]), "顶层");

  const diagram = {};
  if (Object.hasOwn(input, "title")) {
    diagram.title = boundedText(input.title, { field: "标题", maximum: 120 });
  }
  if (!Array.isArray(input.layers) || input.layers.length < 1 || input.layers.length > MAX_LAYERS) {
    fail("层数必须为 1—8 层");
  }
  let nodeCount = 0;
  diagram.layers = input.layers.map((layer, layerIndex) => {
    if (!Array.isArray(layer) || layer.length < 1 || layer.length > 4) {
      fail(`第 ${layerIndex + 1} 层必须包含 1—4 个节点`);
    }
    nodeCount += layer.length;
    if (nodeCount > MAX_NODES) fail("节点总数不能超过 24 个");
    return layer.map((node, nodeIndex) => {
      if (!isRecord(node)) fail(`第 ${layerIndex + 1} 层第 ${nodeIndex + 1} 个节点必须是对象`);
      assertKnownKeys(node, new Set(["label", "description", "status"]), "节点");
      const normalized = {
        label: boundedText(node.label, { field: "节点名称", maximum: 80 }),
        status: Object.hasOwn(node, "status") ? node.status : "unknown",
      };
      if (!Object.hasOwn(STATUS_LABELS, normalized.status)) fail("节点状态必须是 fact/reported/inference/candidate/unknown");
      if (Object.hasOwn(node, "description")) {
        normalized.description = boundedText(node.description, {
          field: "节点说明", maximum: 160, allowEmpty: true,
        });
      }
      return normalized;
    });
  });

  if (Object.hasOwn(input, "links") && !Array.isArray(input.links)) fail("links 必须是方向列表");
  const suppliedLinks = input.links || [];
  if (suppliedLinks.length > MAX_LINKS || suppliedLinks.length > diagram.layers.length - 1) {
    fail("links 最多描述 7 组相邻层关系");
  }
  for (const direction of suppliedLinks) {
    if (!LINK_DIRECTIONS.has(direction)) fail("层间方向必须是 none/down/both");
  }
  diagram.links = Array.from({ length: diagram.layers.length - 1 }, (_, index) => suppliedLinks[index] || "none");
  return diagram;
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
  })[character]);
}

function wrapText(value, maximum) {
  const paragraphs = String(value || "").split(/\r\n|\n|\r/u);
  const lines = [];
  for (const paragraph of paragraphs) {
    const remaining = [...paragraph];
    while (remaining.length > maximum) {
      let splitAt = -1;
      for (let index = maximum - 1; index > 0; index -= 1) {
        if (/\s/u.test(remaining[index])) { splitAt = index + 1; break; }
      }
      lines.push(remaining.splice(0, splitAt > 0 ? splitAt : maximum).join(""));
    }
    lines.push(remaining.join(""));
  }
  return lines.length ? lines : [""];
}

function textElement({ x, y, value, className, fontSize = 14, fill = "#26312d", weight = 400, anchor = "start" }) {
  const lines = Array.isArray(value) ? value : [value];
  return `<text x="${x}" y="${y}" font-family="system-ui, sans-serif" font-size="${fontSize}" fill="${fill}" font-weight="${weight}" text-anchor="${anchor}"${className ? ` class="${className}"` : ""}>${lines.map((line, index) => `<tspan x="${x}"${index ? ` dy="${fontSize + 4}"` : ""}>${escapeXml(line)}</tspan>`).join("")}</text>`;
}

function renderMessageDiagramSvg(diagram) {
  const normalized = parseMessageDiagram(JSON.stringify(diagram));
  const width = 1000;
  const padding = 28;
  const gap = 12;
  const titleLines = normalized.title ? wrapText(normalized.title, Math.floor((width - padding * 2) / 21)) : [];
  let cursorY = normalized.title ? 43 + titleLines.length * 26 + 28 : 30;
  const rows = [];

  normalized.layers.forEach((layer, layerIndex) => {
    const nodeWidth = (width - padding * 2 - gap * (layer.length - 1)) / layer.length;
    const labelLineLimit = Math.max(8, Math.floor((nodeWidth - 28) / 14));
    const descriptionLineLimit = Math.max(8, Math.floor((nodeWidth - 28) / 12));
    const nodeLayouts = layer.map((node) => {
      const labelLines = wrapText(node.label, labelLineLimit);
      const descriptionLines = node.description ? wrapText(node.description, descriptionLineLimit) : [];
      const cardHeight = 26 + labelLines.length * 26 + (descriptionLines.length ? 8 + descriptionLines.length * 16 : 0) + 28;
      return { node, labelLines, descriptionLines, cardHeight };
    });
    const rowHeight = Math.max(84, ...nodeLayouts.map((item) => item.cardHeight));
    rows.push({ layerIndex, y: cursorY, height: rowHeight, nodes: nodeLayouts });
    cursorY += 29 + rowHeight + (layerIndex < normalized.layers.length - 1 ? 34 : 18);
  });

  const height = cursorY + 8;
  const chunks = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">`,
    `<title>${escapeXml(diagram.title || "行知结构图")}</title>`,
    `<rect x="0" y="0" width="${width}" height="${height}" rx="16" fill="#fbfaf6" stroke="#d8d4ca" stroke-width="1"/>`,
  ];
  if (normalized.title) chunks.push(textElement({ x: padding, y: 43, value: titleLines, fontSize: 21, weight: 700 }));

  for (const row of rows) {
    const layerY = row.y;
    chunks.push(textElement({
      x: padding, y: layerY + 16, value: `第 ${row.layerIndex + 1} 层`, fontSize: 12, fill: "#6c746e", weight: 650,
    }));
    const nodeTop = layerY + 26;
    const nodeWidth = (width - padding * 2 - gap * (row.nodes.length - 1)) / row.nodes.length;
    row.nodes.forEach(({ node, labelLines, descriptionLines }, nodeIndex) => {
      const x = padding + nodeIndex * (nodeWidth + gap);
      chunks.push(`<rect x="${x}" y="${nodeTop}" width="${nodeWidth}" height="${row.height}" rx="10" fill="#ffffff" stroke="#d8d4ca" stroke-width="1.2"/>`);
      const labelY = nodeTop + 26;
      chunks.push(textElement({ x: x + 14, y: labelY, value: labelLines, fontSize: 14, weight: 700 }));
      const descriptionY = labelY + labelLines.length * 26 + 2;
      if (descriptionLines.length) {
        chunks.push(textElement({ x: x + 14, y: descriptionY, value: descriptionLines, fontSize: 12, fill: "#5d6862" }));
      }
      const statusY = nodeTop + row.height - 12;
      chunks.push(textElement({ x: x + 14, y: statusY, value: STATUS_LABELS[node.status], fontSize: 10, fill: "#7a6650", weight: 650 }));
    });
  }

  for (let index = 0; index < normalized.links.length; index += 1) {
    const direction = normalized.links[index];
    if (direction === "none") continue;
    const upper = rows[index];
    const lower = rows[index + 1];
    const x = width / 2;
    const startY = upper.y + 26 + upper.height + 5;
    const endY = lower.y + 19;
    chunks.push(`<line x1="${x}" y1="${startY}" x2="${x}" y2="${endY - 5}" stroke="#9a8d77" stroke-width="1.5"/>`);
    if (direction === "down" || direction === "both") {
      chunks.push(`<polygon points="${x - 4},${endY - 8} ${x + 4},${endY - 8} ${x},${endY - 2}" fill="#9a8d77"/>`);
    }
    if (direction === "both") {
      chunks.push(`<polygon points="${x - 4},${startY + 8} ${x + 4},${startY + 8} ${x},${startY + 2}" fill="#9a8d77"/>`);
    }
  }
  chunks.push("</svg>");
  return chunks.join("");
}

function extractMessageDiagramBlocks(markdown) {
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
    while (closingIndex < lines.length && !closingPattern.test(lineText(lines[closingIndex]))) closingIndex += 1;
    if (closingIndex >= lines.length) {
      output.push(...lines.slice(cursor));
      break;
    }
    if (!/^xingzhi-diagram(?:[ \t]+.*)?$/iu.test(rawInfo.trim())) {
      output.push(...lines.slice(cursor, closingIndex + 1));
      cursor = closingIndex + 1;
      continue;
    }
    const diagramSource = lines.slice(cursor + 1, closingIndex).join("");
    const index = blocks.push({ source: diagramSource }) - 1;
    const newline = lineEnding(lines[cursor]) || "\n";
    const closingNewline = lineEnding(lines[closingIndex]);
    output.push(`${indent}\`\`\`${MESSAGE_DIAGRAM_PLACEHOLDER_LANGUAGE}${newline}${index}${newline}${indent}\`\`\`${closingNewline}`);
    cursor = closingIndex + 1;
  }
  return { markdown: output.join(""), blocks };
}

const MESSAGE_DIAGRAM_PLACEHOLDER_LANGUAGE = "xingzhi-diagram-placeholder";

module.exports = {
  extractMessageDiagramBlocks,
  parseMessageDiagram,
  renderMessageDiagramSvg,
  MESSAGE_DIAGRAM_PLACEHOLDER_LANGUAGE,
};
