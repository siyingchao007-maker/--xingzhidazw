"use strict";

const MAX_SCROLL_ANCESTORS = 12;

function finiteScrollTop(element) {
  return Number.isFinite(element?.scrollTop) ? element.scrollTop : 0;
}

function persistentScrollAncestors(contentEl) {
  const result = [];
  const seen = new Set();
  let current = contentEl;
  while (current && result.length < MAX_SCROLL_ANCESTORS) {
    if (!seen.has(current)) {
      seen.add(current);
      result.push({ element: current, scrollTop: finiteScrollTop(current) });
    }
    current = current.parentElement || null;
  }
  return result;
}

function captureArchiveScrollPosition(root, contentEl) {
  if (!root) return null;
  return {
    rootScrollTop: finiteScrollTop(root),
    persistent: persistentScrollAncestors(contentEl),
  };
}

function setScrollTopWithoutAnimation(element, scrollTop) {
  if (!element || !Number.isFinite(scrollTop)) return;
  const previousBehavior = element.style?.scrollBehavior;
  if (element.style) element.style.scrollBehavior = "auto";
  element.scrollTop = scrollTop;
  if (element.style) element.style.scrollBehavior = previousBehavior || "";
}

function restoreArchiveScrollPosition(root, snapshot, {
  schedule = globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0)),
} = {}) {
  if (!root || !snapshot) return;
  const apply = () => {
    if (root.isConnected === false) return;
    setScrollTopWithoutAnimation(root, snapshot.rootScrollTop);
    for (const item of Array.isArray(snapshot.persistent) ? snapshot.persistent : []) {
      if (item?.element?.isConnected === false) continue;
      setScrollTopWithoutAnimation(item?.element, item?.scrollTop);
    }
  };
  apply();
  schedule(apply);
}

module.exports = {
  captureArchiveScrollPosition,
  restoreArchiveScrollPosition,
};
