const ACTIVE_HTML_BLOCK = /<(script|style|iframe|object|embed|form|video|audio|picture|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
const ACTIVE_HTML_TAG = /<\/?(?:script|style|iframe|object|embed|form|video|audio|picture|svg|link|meta|input|source)\b[^>]*>/giu;
const HTML_IMAGE_TAG = /<img\b[^>]*>/giu;
const REMOTE_MARKDOWN_IMAGE = /!\[([^\]\r\n]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^\)\r\n]*\)))?\s*\)/giu;
const REFERENCE_MARKDOWN_IMAGE = /!\[(?!\[)([^\]\r\n]*)\]\[([^\]\r\n]*)\]/gu;

function transformRenderableSegment(segment) {
  return segment
    .replace(ACTIVE_HTML_BLOCK, "[外部嵌入内容已隐藏]")
    .replace(HTML_IMAGE_TAG, "[外部 HTML 图片已隐藏，请先保存到知识库后再引用]")
    .replace(ACTIVE_HTML_TAG, "[外部嵌入内容已隐藏]")
    .replace(REMOTE_MARKDOWN_IMAGE, (_match, alt, url) => (
      `[远程图片链接${alt ? `：${alt}` : ""}](${url})`
    ))
    // Reference-style images can resolve to a remote URL later in the document.
    // Keep the reference clickable, but never let it auto-load as an image.
    .replace(REFERENCE_MARKDOWN_IMAGE, (_match, alt, reference) => (
      `[图片引用${alt ? `：${alt}` : ""}][${reference}]`
    ));
}

function prepareMessageMarkdown(markdown) {
  const source = String(markdown ?? "");
  if (!source) return "";

  const lines = source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu) || [source];
  const output = [];
  let renderable = "";
  let fence = null;

  const flushRenderable = () => {
    if (!renderable) return;
    output.push(transformRenderableSegment(renderable));
    renderable = "";
  };

  for (const segment of lines) {
    if (!segment) continue;
    const line = segment.replace(/(?:\r\n|\n|\r)$/u, "");
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1] || "";

    if (!fence && marker) {
      flushRenderable();
      fence = { character: marker[0], length: marker.length };
      output.push(segment);
      continue;
    }

    if (fence) {
      output.push(segment);
      const closing = new RegExp(`^ {0,3}${fence.character === "`" ? "`" : "~"}{${fence.length},}\\s*$`, "u");
      if (closing.test(line)) fence = null;
      continue;
    }

    renderable += segment;
  }

  flushRenderable();
  return output.join("");
}

module.exports = {
  prepareMessageMarkdown,
};
