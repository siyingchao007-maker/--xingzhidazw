"use strict";

const MAX_STRUCTURED_BACKGROUND_ATTEMPTS = 2;
const STRUCTURED_FAILURE_PATTERN = /(?:有效 JSON|无效 JSON|JSON 对象|输出为空或过大|输出必须是对象|缺少分层结果|没有返回完整分层结果|未授权字段|字段必须|字段无效|未知字段|非法字段|无效列表|无效维度|无效状态|无效关系|置信度无效|证据摘录|来源消息|必须且只能包含|不符合.*(?:结构|契约|Schema))/iu;
const OPERATIONAL_FAILURE_PATTERN = /(?:连接|网络|超时|中断|停止|取消|权限不足|访问被拒绝|未获得授权|授权失效|配额|限流|服务不可用|provider|socket|ECONN|ENET|本轮已由用户停止|当前回合尚未结束)/iu;

function isStructuredBackgroundAnalysisError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  if (!message || OPERATIONAL_FAILURE_PATTERN.test(message)) return false;
  return STRUCTURED_FAILURE_PATTERN.test(message);
}

module.exports = {
  MAX_STRUCTURED_BACKGROUND_ATTEMPTS,
  isStructuredBackgroundAnalysisError,
};
