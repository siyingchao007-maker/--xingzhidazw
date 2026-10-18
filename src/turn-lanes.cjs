"use strict";

const TURN_LANES = Object.freeze({
  dialogue: "dialogue",
  background: "background",
});

const BACKGROUND_TURN_FLAGS = Object.freeze([
  "internalArchive",
  "internalKnowledgeMerge",
  "internalKnowledgeOrganization",
  "internalDocumentImport",
  "internalKnowledgeGovernance",
  "internalUserContinuity",
]);

function turnLane(value = {}) {
  if (value?.internalTurn === true) return TURN_LANES.background;
  return BACKGROUND_TURN_FLAGS.some((flag) => value?.[flag] === true)
    ? TURN_LANES.background
    : TURN_LANES.dialogue;
}

function turnLaneKey(conversationId, lane = TURN_LANES.dialogue) {
  const normalizedId = String(conversationId || "").trim();
  if (!normalizedId) throw new Error("回合通道缺少对话编号");
  const normalizedLane = lane === TURN_LANES.background
    ? TURN_LANES.background
    : TURN_LANES.dialogue;
  return `${normalizedLane}:${normalizedId}`;
}

module.exports = {
  TURN_LANES,
  turnLane,
  turnLaneKey,
};
