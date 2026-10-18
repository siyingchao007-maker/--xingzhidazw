"use strict";

const DOCUMENT_SYNTHESIS_PATTERN = /(?:整理|整合|归纳|汇总|综合|融合|合并|重组|重构|去重).{0,16}(?:文件|文档|资料|材料|内容|报告|方案|业务体系|访谈|记录)|(?:文件|文档|资料|材料|内容|报告|访谈|记录).{0,20}(?:整理|整合|归纳|汇总|综合|融合|合并|重组|重构|去重|标出冲突)|纳入.{0,12}(?:业务|公司|产品|知识).{0,6}体系|(?:几份|多份|两份|这些|[三四五六七八九十\d]+份).{0,10}(?:访谈|记录|笔记|资料|材料|内容).{0,20}(?:放在一起|变成一份|统一成|收束成|整理成|去重|标出冲突).{0,12}(?:一版|版本|方案|材料)?/u;
const DOCUMENT_SYNTHESIS_REQUEST_PATTERN = /(?:请|麻烦|帮我|请帮我|需要你|我需要你|希望你|我希望你|我要你)[^\n。；，,;]{0,20}(?:整理|整合|归纳|汇总|综合|融合|合并|重组|重构|去重)|(?:把|将)[^\n。；，,;]{0,28}(?:文件|文档|资料|材料|内容|报告|方案|业务体系|访谈|记录)[^\n。；，,;]{0,28}(?:整理|整合|归纳|汇总|综合|融合|合并|重组|重构|去重|放在一起|变成一份|统一成|收束成)[^\n。；，,;]{0,16}(?:成|为|并形成|并输出|输出|一份|一个|目录|方案|版本|清单)|(?:^|[。；;\n])\s*(?:整理|整合|归纳|汇总|综合|融合|合并|重组|重构|去重)[^\n。；，,;]{0,16}(?:文件|文档|资料|材料|内容|报告|方案|业务体系|访谈|记录)|(?:几份|多份|两份|这些|[三四五六七八九十\d]+份).{0,10}(?:访谈|记录|笔记|资料|材料|内容).{0,20}(?:放在一起|变成一份|统一成|收束成|整理成|去重|标出冲突)/u;
const FINAL_SOLUTION_PATTERN = /最终方案|完整方案|业务方案|产品方案|总体方案|统一方案|形成.{0,8}方案|输出.{0,8}方案|给出.{0,8}方案|(?:团队|大家).{0,8}(?:照着|直接).{0,8}(?:走|用|执行)/u;
const KNOWLEDGE_ORGANIZATION_PATTERN = /(?:整理|规范|优化|重构|检查).{0,14}(?:知识库|知识结构|目录|标签|双向链接|Markdown)|(?:目录|标签|双向链接|Markdown).{0,14}(?:整理|规范|优化|重构|检查)|(?:长期|现有|已有).{0,8}(?:记录|笔记|知识|说法).{0,18}(?:维护|更新|有效|过时|重复|覆盖|冲突|追溯)|(?:记录|笔记|说法|版本).{0,14}(?:互相覆盖|彼此打架|相互矛盾|已经过时|重复出现)|只看到.{0,10}(?:当前|现行|最新|有效).{0,8}(?:结论|版本|说法)|追溯.{0,10}(?:旧|历史|先前).{0,6}(?:版本|说法|记录)/iu;
const JUDGMENT_INTENT_PATTERN = /拿不准|心里没底|靠不住|会不会错|可能.{0,5}(?:错|有问题)|还缺.{0,5}(?:依据|证据|信息)|(?:说法|依据|结论|版本).{0,12}(?:冲突|矛盾|打架|不一致|靠不住)|(?:互相|彼此|相互).{0,8}(?:覆盖|冲突|矛盾|打架)|哪些.{0,8}(?:前提|依据).{0,5}(?:不成立|站不住)/u;
const ACTION_INTENT_PATTERN = /接下来.{0,8}(?:做|推进|开始)|先做(?:哪|什么)|从哪里开始|落到(?:今天|明天|本周)|怎么.{0,8}(?:往前走|推进下去|真正做起来)|第一步.{0,8}(?:做|是什么)|根据.{0,8}(?:结果|变化).{0,8}(?:修正|调整)/u;
const MULTI_PERSPECTIVE_INTENT_PATTERN = /换.{0,5}(?:方式|角度|角色|位置).{0,5}看|站在.{0,12}(?:角度|立场|位置).{0,6}(?:看|判断|考虑)|(?:客户|团队|管理层|员工|合作方|用户).{0,12}(?:分别|各自|不同).{0,6}(?:看|判断)|不同.{0,8}(?:角色|部门|时间尺度|阶段).{0,8}(?:看|判断|结论)|短期.{0,8}长期/u;

function detectIntentSignals(value) {
  const text = typeof value === "string" ? value.slice(0, 20_000) : "";
  return {
    // Mentions such as "我正在整理资料" describe context. Auto-select document
    // synthesis only when the current instruction asks for a transformation.
    documentSynthesis: DOCUMENT_SYNTHESIS_PATTERN.test(text)
      && DOCUMENT_SYNTHESIS_REQUEST_PATTERN.test(text),
    finalSolution: FINAL_SOLUTION_PATTERN.test(text),
    knowledgeOrganization: KNOWLEDGE_ORGANIZATION_PATTERN.test(text),
    judgmentAudit: JUDGMENT_INTENT_PATTERN.test(text),
    actionPlanning: ACTION_INTENT_PATTERN.test(text),
    multiPerspective: MULTI_PERSPECTIVE_INTENT_PATTERN.test(text),
  };
}

module.exports = {
  ACTION_INTENT_PATTERN,
  DOCUMENT_SYNTHESIS_PATTERN,
  DOCUMENT_SYNTHESIS_REQUEST_PATTERN,
  FINAL_SOLUTION_PATTERN,
  JUDGMENT_INTENT_PATTERN,
  KNOWLEDGE_ORGANIZATION_PATTERN,
  MULTI_PERSPECTIVE_INTENT_PATTERN,
  detectIntentSignals,
};
