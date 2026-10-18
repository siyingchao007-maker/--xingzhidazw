"use strict";

const crypto = require("node:crypto");

const MAX_MESSAGE_BLOCK_TEXT_LENGTH = 200_000;
const MAX_MESSAGE_BLOCKS = 2_000;
const MESSAGE_CONTENT_DELETED_SENTINEL = "<!-- xingzhi-message-content-deleted -->";

function hashMessageBlockText(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function requireMessageText(value) {
  if (typeof value !== "string") throw new Error("消息正文必须是文本");
  if (!value.trim()) throw new Error("消息正文不能为空");
  if (value.length > MAX_MESSAGE_BLOCK_TEXT_LENGTH) {
    throw new Error(`消息正文超过安全上限（${MAX_MESSAGE_BLOCK_TEXT_LENGTH} 字符）`);
  }
  return value;
}

function sourceLines(source) {
  const lines = [];
  const matcher = /[^\r\n]*(?:\r\n|\n|\r|$)/gu;
  let match;
  while ((match = matcher.exec(source)) !== null) {
    if (!match[0]) break;
    const raw = match[0];
    const text = raw.replace(/(?:\r\n|\n|\r)$/u, "");
    lines.push({
      raw,
      text,
      start: match.index,
      end: match.index + raw.length,
    });
  }
  return lines;
}

function isBlank(line) {
  return !line || /^\s*$/u.test(line.text);
}

function headingLevel(line) {
  const match = line?.text?.match(/^ {0,3}(#{1,6})\s+\S/u);
  return match ? match[1].length : 0;
}

function fenceMarker(line) {
  const match = line?.text?.match(/^ {0,3}(`{3,}|~{3,})/u);
  return match ? { character: match[1][0], length: match[1].length } : null;
}

function isListLine(line) {
  return /^ {0,3}(?:[-+*]|\d+[.)])\s+/u.test(line?.text || "");
}

function isQuoteLine(line) {
  return /^ {0,3}>/u.test(line?.text || "");
}

function isHorizontalRule(line) {
  return /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u.test(line?.text || "");
}

function isTableDelimiter(line) {
  const text = line?.text || "";
  if (!text.includes("|")) return false;
  const cells = text.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|");
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell));
}

function looksLikeTable(lines, index) {
  return Boolean(lines[index]?.text?.includes("|") && isTableDelimiter(lines[index + 1]));
}

function startsStructuralBlock(lines, index) {
  const line = lines[index];
  return Boolean(
    headingLevel(line)
    || fenceMarker(line)
    || isListLine(line)
    || isQuoteLine(line)
    || isHorizontalRule(line)
    || looksLikeTable(lines, index)
  );
}

function consumeTrailingBlanks(lines, index) {
  let cursor = index;
  while (cursor < lines.length && isBlank(lines[cursor])) cursor += 1;
  return cursor;
}

function primitiveBlocks(source) {
  const lines = sourceLines(source);
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    if (isBlank(lines[index])) {
      index += 1;
      continue;
    }
    const startLine = index;
    let endLine = index + 1;
    let type = "paragraph";
    let level = 0;
    const fence = fenceMarker(lines[index]);
    level = headingLevel(lines[index]);
    if (fence) {
      type = "code";
      while (endLine < lines.length) {
        const close = lines[endLine].text.match(/^ {0,3}(`{3,}|~{3,})\s*$/u);
        endLine += 1;
        if (close && close[1][0] === fence.character && close[1].length >= fence.length) break;
      }
    } else if (level) {
      type = "heading";
    } else if (looksLikeTable(lines, index)) {
      type = "table";
      endLine = index + 2;
      while (endLine < lines.length && !isBlank(lines[endLine]) && lines[endLine].text.includes("|")) {
        endLine += 1;
      }
    } else if (isListLine(lines[index])) {
      type = "list";
      while (endLine < lines.length && !isBlank(lines[endLine])) {
        if (headingLevel(lines[endLine]) || fenceMarker(lines[endLine]) || isQuoteLine(lines[endLine])) break;
        endLine += 1;
      }
    } else if (isQuoteLine(lines[index])) {
      type = "quote";
      while (endLine < lines.length && (isQuoteLine(lines[endLine]) || isBlank(lines[endLine]))) {
        if (isBlank(lines[endLine]) && !isQuoteLine(lines[endLine + 1])) break;
        endLine += 1;
      }
    } else if (isHorizontalRule(lines[index])) {
      type = "separator";
    } else {
      while (endLine < lines.length && !isBlank(lines[endLine]) && !startsStructuralBlock(lines, endLine)) {
        endLine += 1;
      }
    }
    endLine = consumeTrailingBlanks(lines, endLine);
    const start = lines[startLine].start;
    const end = lines[Math.max(startLine, endLine - 1)].end;
    blocks.push({ type, level, start, end, content: source.slice(start, end) });
    if (blocks.length > MAX_MESSAGE_BLOCKS) throw new Error("消息段落数量超过安全上限");
    index = endLine;
  }
  return blocks;
}

function blockLabel(block, index) {
  const firstLine = block.content.trim().split(/\r?\n/u)[0]
    .replace(/^ {0,3}#{1,6}\s+/u, "")
    .replace(/^ {0,3}>\s?/u, "")
    .trim();
  return (firstLine || `第 ${index + 1} 段`).slice(0, 120);
}

function finalizeBlocks(blocks) {
  return blocks.map((block, index) => {
    const fingerprint = hashMessageBlockText(`${block.type}\u0000${block.content}`);
    return {
      id: `message-block-${index + 1}-${fingerprint.slice(0, 12)}`,
      index,
      type: block.type,
      label: blockLabel(block, index),
      content: block.content,
      start: block.start,
      end: block.end,
      fingerprint,
    };
  });
}

function parseMessageBlocks(value) {
  const source = requireMessageText(value);
  const primitives = primitiveBlocks(source);
  const grouped = [];
  for (let index = 0; index < primitives.length;) {
    const block = primitives[index];
    if (block.type !== "heading") {
      grouped.push(block);
      index += 1;
      continue;
    }
    let cursor = index + 1;
    while (cursor < primitives.length) {
      const candidate = primitives[cursor];
      if (candidate.type === "heading" && candidate.level <= block.level) break;
      cursor += 1;
    }
    const end = primitives[cursor - 1]?.end ?? block.end;
    grouped.push({
      type: "heading-section",
      level: block.level,
      start: block.start,
      end,
      content: source.slice(block.start, end),
    });
    index = cursor;
  }
  if (!grouped.length) throw new Error("消息正文没有可管理的段落");
  return finalizeBlocks(grouped);
}

function selectedBlockSet(blocks, blockIds) {
  const requested = [...new Set((Array.isArray(blockIds) ? blockIds : [])
    .map((id) => String(id || "").trim())
    .filter(Boolean))];
  if (!requested.length) throw new Error("请至少选择一个段落");
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const selected = requested.map((id) => byId.get(id));
  if (selected.some((block) => !block)) throw new Error("找不到所选段落，请重新打开段落管理");
  return selected.sort((left, right) => left.start - right.start);
}

function selectMessageBlocks(value, blockIds) {
  const source = requireMessageText(value);
  const blocks = parseMessageBlocks(source);
  const selected = selectedBlockSet(blocks, blockIds);
  return {
    content: selected.map((block) => block.content.trim()).filter(Boolean).join("\n\n"),
    blocks: selected,
    sourceHash: hashMessageBlockText(source),
  };
}

function deleteMessageBlocks(value, blockIds) {
  const source = requireMessageText(value);
  const blocks = parseMessageBlocks(source);
  const selected = selectedBlockSet(blocks, blockIds);
  const removedBlocks = selected.map((block) => ({
    id: block.id,
    type: block.type,
    label: block.label,
    content: block.content,
    fingerprint: block.fingerprint,
  }));
  if (selected.length === blocks.length) {
    return {
      content: MESSAGE_CONTENT_DELETED_SENTINEL,
      beforeHash: hashMessageBlockText(source),
      afterHash: hashMessageBlockText(MESSAGE_CONTENT_DELETED_SENTINEL),
      removedBlocks,
      wholeMessage: true,
    };
  }
  let cursor = 0;
  const parts = [];
  for (const block of selected) {
    parts.push(source.slice(cursor, block.start));
    cursor = block.end;
  }
  parts.push(source.slice(cursor));
  const content = parts.join("").replace(/(?:\r\n|\n|\r)[\t ]*(?:(?:\r\n|\n|\r)[\t ]*)+$/u, "");
  if (!content.trim()) throw new Error("不能删除整条消息");
  return {
    content,
    beforeHash: hashMessageBlockText(source),
    afterHash: hashMessageBlockText(content),
    removedBlocks,
    wholeMessage: false,
  };
}

function restoreMessageBlockDeletion(currentContent, record) {
  const current = requireMessageText(currentContent);
  const expectedHash = String(record?.afterHash || "");
  if (!/^[a-f0-9]{64}$/u.test(expectedHash) || hashMessageBlockText(current) !== expectedHash) {
    throw new Error("消息内容已经变化，不能自动恢复，以免覆盖后来新增的内容");
  }
  return requireMessageText(record?.beforeContent);
}

module.exports = {
  MAX_MESSAGE_BLOCKS,
  MAX_MESSAGE_BLOCK_TEXT_LENGTH,
  MESSAGE_CONTENT_DELETED_SENTINEL,
  deleteMessageBlocks,
  hashMessageBlockText,
  parseMessageBlocks,
  restoreMessageBlockDeletion,
  selectMessageBlocks,
};
