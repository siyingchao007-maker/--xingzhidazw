"use strict";

const ACTIVE_TURN_STATUSES = new Set([
  "running",
  "in_progress",
  "streaming",
  "starting",
  "waiting",
  "waiting_approval",
]);

function turnIsActive(turn) {
  return ACTIVE_TURN_STATUSES.has(String(turn?.status || "").trim().toLowerCase());
}

function capabilityControlsLocked({ turn, canUpdate }) {
  return turnIsActive(turn) || canUpdate !== true;
}

function sendControlState(input = {}) {
  let title = "";
  if (input.turnActive === true) title = "当前回复进行中";
  else if (input.isSending === true) title = "消息正在发送";
  else if (input.hasPendingCapabilityChoice === true) title = "请先处理本轮 Agent 或 Skill 推荐";
  else if (input.hasExternalConsent !== true) title = "请先在设置中保存并锁定此提供商连接";
  else if (input.hasRequiredModel !== true) title = "请先发现或填写外部模型";
  else if (input.canSend !== true) title = "当前插件版本不能发送消息";
  else if (input.hasText !== true && input.hasAttachments !== true) title = "请输入消息或添加附件后发送";

  if (!title) {
    if (input.hasText !== true && input.hasAttachments === true) {
      return { disabled: false, title: "发送附件", ariaLabel: "发送附件" };
    }
    return { disabled: false, title: "发送消息", ariaLabel: "发送消息" };
  }
  return {
    disabled: true,
    title,
    ariaLabel: `发送消息（${title}）`,
  };
}

module.exports = {
  capabilityControlsLocked,
  sendControlState,
  turnIsActive,
};
