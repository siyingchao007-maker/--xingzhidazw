"use strict";

const PATH_DISPLAY_REQUIREMENTS = Object.freeze([
  Object.freeze({ id: "observation-stage", test: /观境/u }),
  Object.freeze({ id: "anchoring-stage", test: /立心/u }),
  Object.freeze({ id: "reality-action-stage", test: /践真/u }),
  Object.freeze({ id: "change-learning-stage", test: /知变/u }),
]);

// This compatibility check measures requested presentation, not whether a
// model has genuinely understood reality or found a useful perspective.
function missingPathDisplay(value, { fullPresentation = false } = {}) {
  const raw = typeof value === "string" ? value : "";
  if (!raw.trim()) return ["answer-empty"];
  if (!fullPresentation) return [];
  const text = raw.replace(/```[\s\S]*?(?:```|$)/gu, " ");
  return PATH_DISPLAY_REQUIREMENTS.filter((item) => !item.test.test(text)).map((item) => item.id);
}

module.exports = { PATH_DISPLAY_REQUIREMENTS, missingPathDisplay };
