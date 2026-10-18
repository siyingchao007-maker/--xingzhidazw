"use strict";

const { normalizedSkillType } = require("./capability-surface.cjs");

function itemId(item) {
  return String(item?.name || item?.id || item || "").trim();
}

function categoryIds(catalog, category) {
  const lens = category === "lens";
  return new Set((Array.isArray(catalog) ? catalog : [])
    .filter((item) => (normalizedSkillType(item) === "cognitive-lens") === lens)
    .map(itemId).filter(Boolean));
}

function categorySelection(values, catalog, category) {
  const ids = categoryIds(catalog, category);
  return [...new Set((Array.isArray(values) ? values : []).map(itemId)
    .filter((id) => ids.has(id)))];
}

function mergeCategorySelection(current, updates, catalog, category) {
  const ids = categoryIds(catalog, category);
  return [...new Set([
    ...(Array.isArray(current) ? current : []).map(itemId).filter((id) => id && !ids.has(id)),
    ...categorySelection(updates, catalog, category),
  ])];
}

module.exports = { categoryIds, categorySelection, mergeCategorySelection };
