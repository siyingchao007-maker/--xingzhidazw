"use strict";
const {
  isPrimarySkillEligible,
  isExplicitOrchestrationRequest,
  isSkillVisibleInDialogue,
  isTextTransformation,
  normalizedSkillType,
  skillTypePolicy,
} = require("./capability-surface.cjs");

const { DEFAULT_AGENT_ID, getAgent } = require("./agent-registry.cjs");
const {
  buildReasoningPlan,
  instructionTextForRouting,
  normalizeKnowledgeWorkflow,
} = require("./reasoning-plan.cjs");
const {
  REASONING_OPERATOR_ORDER,
  getReasoningOperator,
  listReasoningOperators,
} = require("./reasoning-operator-registry.cjs");
const {
  evaluateCognitiveLensMigrationGate,
  publishedCognitiveLensMigrationGate,
} = require("./cognitive-lens-migration.cjs");
const {
  routeCognitiveLenses,
} = require("./cognitive-lens-router.cjs");
const {
  DOCUMENT_SYNTHESIS_PATTERN,
  FINAL_SOLUTION_PATTERN,
  KNOWLEDGE_ORGANIZATION_PATTERN,
  detectIntentSignals,
} = require("./intent-signals.cjs");
const {
  resolveSkillGraph,
  routeDynamicCapabilities,
} = require("./dynamic-capability-runtime.cjs");

const AGENT_MODES = Object.freeze(["orchestrator", "smart-route", "locked"]);
const SKILL_MODES = Object.freeze(["auto", "recommend", "manual"]);
const AGENT_MODE_SET = new Set(AGENT_MODES);
const SKILL_MODE_SET = new Set(SKILL_MODES);
const MAX_SKILL_PREFERENCES = 64;
const MAX_TURN_SKILL_SNAPSHOTS = 6;
const TRAINING_RESPONSE_SKILL_ID = "xingzhi-training-response";
const TRAINING_RESPONSE_MODE_TERM_SOURCE = "(?:训练式回答|训练模式|练习模式|陪练模式)";
const TRAINING_RESPONSE_SESSION_MODE_TERM_SOURCE = "(?:训练模式|练习模式|陪练模式)";
const TRAINING_RESPONSE_DIRECT_REQUEST_PREFIX_SOURCE = "(?:(?:我(?:明确|正式)?要求(?:你|行知|助手)?|我(?:(?:想|要|需要|希望)(?:你)?|决定|准备)|让我们|我们|请(?:你|帮我|给我)?|麻烦(?:你)?|帮我|直接)[，,\\s]*)?";
const TRAINING_RESPONSE_NEGATION_PATTERN = /^\s*(?:(?:我|本人)?(?:不要|不需要|不想|不用|无需|无须|禁止|拒绝|别|取消)(?:再)?[，,\s]*(?:使用|用|采用|启用|开启|进入|切换到|切到|开始|继续)?[，,\s]*(?:训练式回答|训练模式|练习模式|陪练)|(?:这|它)?(?:不是|并非)[，,\s]*(?:训练式回答|训练模式|练习模式|陪练)|(?:训练式回答|训练模式|练习模式|陪练)[，,\s]*(?:不要|不需要|不想|不用|无需|无须|禁止|拒绝|不是每次|仅在|只在))/iu;
const TRAINING_RESPONSE_META_QUESTION_PATTERN = /^\s*(?:(?:我想|我要|我需要|请告诉我|请你|请|帮我)[，,\s]*)?(?:(?:了解|知道|询问|解释|分析|讨论|评价|检查)[，,\s]*)?(?:为什么|为何|如何|怎么|怎样|是否|是不是|什么是)[^，,。；;！？!?\n]{0,16}(?:训练式回答|训练模式|练习模式|陪练模式)|^\s*(?:(?:请告诉我|请你|请)[，,\s]*)?(?:训练式回答|训练模式|练习模式|陪练模式)(?:本身|到底|究竟|具体|这个模式)?[，,：:\s]*(?:为什么|为何|如何|怎么|怎样|是否|是不是|是什么|总是|自动|每次)/iu;
const TRAINING_RESPONSE_MODE_META_SUFFIX_PATTERN = /(?:训练式回答|训练模式|练习模式|陪练模式)(?:本身|到底|究竟|具体|这个模式)?[，,：:\s]*(?:是什么意思|怎么用|如何使用|如何开启|如何进入|如何退出|会发生什么|有什么区别|有何区别|怎么退出|怎么开启)/iu;
const TRAINING_RESPONSE_MODE_CONFIRMATION_QUESTION_PATTERN = /^\s*(?:(?:(?:现在|我们|请|请你)[，,\s]*)?(?:可以[，,\s]*)?(?:使用|用|采用|启用|开启|进入|切换到|切到|切换成|改成|换成|开始|继续)[^。；;！!\n]{0,12}(?:训练式回答|训练模式|练习模式|陪练模式)|(?:训练式回答|训练模式|练习模式|陪练模式)[，,\s]*(?:现在[，,\s]*)?(?:启用|开启|开始|继续))[，,\s]*(?:吗|么|呢|好吗|好不好|可以吗|可不可以|行不行|怎么样|要不要|是否合适|合适吗)[？?]?\s*$/iu;
const TRAINING_RESPONSE_MODE_COMMAND_QUESTION_SENTENCE_PATTERN = /^\s*(?:(?:(?:现在|我们|请|请你)[，,\s]*)?(?:使用|用|采用|启用|开启|进入|切换到|切到|切换成|改成|换成|开始|继续)[^，,。；;！!\n]{0,12}(?:训练模式|练习模式|陪练模式)|(?:训练模式|练习模式|陪练模式))[^，,。；;！!\n]{0,40}[？?]\s*$/iu;
const TRAINING_RESPONSE_MODE_EXIT_QUESTION_PATTERN = /^\s*(?:(?:退出|关闭|停止|取消|结束|关掉)[，,\s]*(?:使用|用)?[，,\s]*(?:训练式回答|训练模式|练习模式|陪练模式|训练|练习|陪练)|(?:训练式回答|训练模式|练习模式|陪练模式)[，,\s]*(?:不用了|不要了|不需要了|无需了|关掉|关闭|取消|停止|结束|退出)|(?:不再|不要再|不用再|别再|不想再|不需要再)[，,\s]*(?:使用|用)?[，,\s]*(?:训练式回答|训练模式|练习模式|陪练模式))[，,\s]*(?:吗|么|呢|好吗|好不好|可以吗|可不可以|行不行|怎么样|要不要|是否合适|合适吗)[？?]?\s*$/iu;
const TRAINING_RESPONSE_MODE_INFORMATION_PATTERN = /(?:进入|开启|启用|使用|用|切换到|切到)[^，,。；;！？!?\n]{0,10}(?:训练式回答|训练模式|练习模式|陪练模式)[^，,。；;！？!?\n]{0,24}(?:需要什么|什么条件|有什么用|有啥用|有何作用|是干嘛的|干嘛的|有必要|值得|有什么|有何|会有什么|会不会|会影响|会怎样|会怎么样|有什么后果|之后是什么效果|是什么效果|效果如何|是否|安全吗|安全性|要不要|能干什么|适合什么|适用场景|收费|费用|方法|步骤|条件|影响|区别|优势|变化|利弊|风险|怎么|如何|是什么意思|翻译|改写|复述)|(?:了解|告诉我|写出|解释|介绍|查询|询问)[^，,。；;！？!?\n]{0,24}(?:进入|开启|启用|使用|用|切换到|切到)[^，,。；;！？!?\n]{0,10}(?:训练式回答|训练模式|练习模式|陪练模式)[^，,。；;！？!?\n]{0,16}(?:方法|步骤|条件|费用|影响|区别|优势|变化|利弊|风险|效果)?/iu;
const TRAINING_RESPONSE_CONTENT_TASK_PATTERN = /(?:翻译|改写|重写|润色|复述|重复|校对|统计字数|测试关键词|日志记录|用户输入|作为文案|写在按钮|放在按钮|按钮文案)[^。；;！!\n]{0,36}(?:训练式回答|训练模式|练习模式|陪练模式|陪我练习|你问我答|模拟客户对话|扮演客户)|(?:训练式回答|训练模式|练习模式|陪练模式|陪我练习|你问我答|模拟客户对话|扮演客户)[^。；;！!\n]{0,28}(?:这句话|这段话|这个词|关键词|术语|文案|文字|内容|翻译成|改写成|写在按钮|放在按钮|作为文案|怎么翻译)/iu;
const TRAINING_RESPONSE_CONTENT_PREFIX_PATTERN = /^\s*(?:(?:请)?(?:翻译|改写|重写|润色|复述|重复|校对|检查|统计字数)|(?:邮件|文档|文章|页面|截图|原文|材料|内容|文案|提示|按钮|标题|术语|引用|示例|案例|对话|AI回复|群聊).{0,12}(?:内容如下|如下|是|为|写着|显示|包含|提到|提示))[：:]/iu;
const TRAINING_RESPONSE_MULTILINE_CONTENT_PREFIX_PATTERN = /^\s*(?:(?:下面|以下)[^\r\n：:]{0,20}(?:文档|附件|邮件|聊天记录|记录|内容|代码|翻译|改写)|(?:文档|附件|邮件|聊天记录|记录|代码)[^\r\n：:]{0,12}(?:内容|如下|是|为)?)[：:]\s*\r?\n/iu;
const TRAINING_RESPONSE_MULTILINE_TRANSFORM_PREFIX_PATTERN = /^\s*(?=[^\r\n：:]{0,72}[：:]\s*\r?\n)(?=[^\r\n]*(?:翻译|改写|重写|润色|复述|解释|是什么意思))(?=[^\r\n]*(?:下面|以下|这句话|这段话|这个词|内容|文字))[^\r\n]+[：:]\s*\r?\n/iu;
const TRAINING_RESPONSE_MULTILINE_HEADER_PATTERN = /^\s*([^\r\n：:]{1,72})[：:][\s“”‘’'"「」『』]*\r?\n/u;
const TRAINING_RESPONSE_DIRECT_TASK_HEADER_PATTERN = /^\s*(?:我的要求|任务要求|最终要求|需要完成的任务|任务|本轮要求|本轮任务|当前任务|操作要求|执行要求|请执行|请照做|请按以下要求执行)\s*$/u;
const TRAINING_RESPONSE_MENTION_PATTERN = /(?:如果|假如|假设|例如|比如|文档|说明|原文|引用|他说|她说|他让我|她让我|别人让我)[^，,。；;！？!?\n]{0,24}(?:训练式回答|训练模式|练习模式|陪练模式)|(?:训练式回答|训练模式|练习模式|陪练模式)[^，,。；;！？!?\n]{0,24}(?:会发生什么|是什么意思|应该吗|是否应该|怎么理解|如何理解)/iu;
const TRAINING_RESPONSE_REPORTED_SPEECH_PREFIX_PATTERN = /^\s*([^。！？!?\n]{0,24}?)(说|表示|要求|让我|提到|提及|写着|写了|显示|包含|提示)[：:，,\s“”‘’'"「」]*([^。！？!?\n]{1,80})/iu;
const TRAINING_RESPONSE_MODE_COMMAND_PATTERN = new RegExp(
  `^\\s*(?:(?:这一轮|这轮|本轮|现在(?:就)?|马上|立刻|接下来)[，,\\s]*)?${TRAINING_RESPONSE_DIRECT_REQUEST_PREFIX_SOURCE}(?:使用|用|采用|启用|开启|进入|切换到|切到|切换成|改成|换成|开始|继续)[^，,。；;！？!?\\n]{0,12}${TRAINING_RESPONSE_MODE_TERM_SOURCE}`,
  "iu",
);
const TRAINING_RESPONSE_SESSION_MODE_COMMAND_PATTERN = new RegExp(
  `^\\s*(?:(?:现在(?:就)?|马上|立刻|接下来)[，,\\s]*)?${TRAINING_RESPONSE_DIRECT_REQUEST_PREFIX_SOURCE}(?:启用|开启|进入|切换到|切到|切换成|改成|换成|开始|继续)[^，,。；;！？!?\\n]{0,12}${TRAINING_RESPONSE_SESSION_MODE_TERM_SOURCE}`,
  "iu",
);
const TRAINING_RESPONSE_CROSS_CLAUSE_START_PATTERN = /^\s*(?:请)?你(?:来)?扮演[^。；;！!?\n]{0,8}(?:客户|面试官|谈判对象|销售对象)[，,]\s*我(?:来)?(?:回答|应答|应对|沟通|谈)/iu;
const TRAINING_RESPONSE_PERSISTENT_SESSION_START_PATTERNS = Object.freeze([
  /^\s*(?:从现在|从这(?:一)?条|从本轮|从这一轮)[，,\s]*(?:开始|起)[，,\s]*(?:请)?[，,\s]*(?:使用|用|启用|开启|进入|切换到|切到)[^，,。；;！？!?\n]{0,10}(?:训练式回答|训练模式|练习模式|陪练模式)/iu,
  /^\s*(?:以后|后面|之后|接下来)[，,\s]*(?:(?:请|都|一直|每轮|每一轮|每次)[，,\s]*)+(?:使用|用|采用|启用|开启)[^，,。；;！？!?\n]{0,8}(?:训练式回答|训练模式|练习模式|陪练模式)/iu,
  /^\s*(?:训练模式|练习模式|陪练模式)[，,\s]*(?:现在[，,\s]*)?(?:启用|开启|开始|继续)(?:吧|。|！|!)?\s*$/iu,
]);
const TRAINING_RESPONSE_POLITE_REQUEST_PREFIX_SOURCE = "(?:(?:(?:请问[，,\\s]*)?(?:你[，,\\s]*)?(?:能|可以|能否|可否|能不能|可不可以|方便))|麻烦(?:你)?)";
const TRAINING_RESPONSE_POLITE_PRACTICE_START_PATTERNS = Object.freeze([
  new RegExp(`^\\s*${TRAINING_RESPONSE_POLITE_REQUEST_PREFIX_SOURCE}[，,\\s]*(?:(?:帮我)?[，,\\s]*(?:陪我|跟我|和我)?[，,\\s]*(?:练习|练一下|演练|角色扮演)|(?:帮我|给我)?[，,\\s]*做[^。；;！!\\n]{0,16}陪练)`, "iu"),
  new RegExp(`^\\s*${TRAINING_RESPONSE_POLITE_REQUEST_PREFIX_SOURCE}[，,\\s]*(?:帮我)?[，,\\s]*(?:模拟|演练)[^。；;！!\\n]{0,18}(?:对话|谈判|沟通|问答|应答|异议处理|面试|拜访|陌拜|电话营销)`, "iu"),
  new RegExp(`^\\s*${TRAINING_RESPONSE_POLITE_REQUEST_PREFIX_SOURCE}[^。；;！!\\n]{0,8}扮演[^。；;！!\\n]{0,8}(?:客户|面试官|谈判对象|销售对象)[^。；;！!\\n]{0,12}(?:我|让我)(?:来)?(?:回答|应答|应对|沟通|谈)`, "iu"),
  new RegExp(`^\\s*${TRAINING_RESPONSE_POLITE_REQUEST_PREFIX_SOURCE}[，,\\s]*(?:帮我)?[，,\\s]*(?:考我|向我提问|问我问题|出题给我)`, "iu"),
  /^\s*(?:我们|咱们)(?:来)?[，,\s]*(?:练习|练一下|演练|角色扮演)/iu,
]);
const TRAINING_RESPONSE_SESSION_START_PATTERNS = Object.freeze([
  TRAINING_RESPONSE_SESSION_MODE_COMMAND_PATTERN,
  /^\s*(?:(?:现在|接下来|请|请你|我要|我想)[，,\s]*)?(?:陪我|跟我|和我|我们来|咱们来).{0,12}(?:练习|演练|陪练|角色扮演)/iu,
  /^\s*(?:(?:现在|接下来|请|请你|我要|我想)[，,\s]*)?(?:你问我答|一问一答|给我.{0,10}陪练)/iu,
  /^\s*(?:请)?你(?:来)?扮演.{0,8}(?:客户|面试官|谈判对象|销售对象).{0,16}我(?:来)?(?:回答|应答|应对|沟通|谈)/iu,
  /^\s*(?:(?:现在|接下来|请|请你|我要|我想)[，,\s]*)?(?:模拟|演练).{0,18}(?:对话|谈判|问答|应答|异议处理|面试|拜访|陌拜|电话营销)/iu,
  /^\s*(?:(?:现在|接下来|请|请你|我要|我想)[，,\s]*)?(?:考我|向我提问|问我问题|出题给我)/iu,
  /^\s*(?:请)?(?:以|作为).{0,8}(?:教练|导师|面试官).{0,16}(?:向我提问|问我|考我|出题)/iu,
  /^\s*(?:以后|后面|接下来)[，,\s]*(?:都|一直)[，,\s]*(?:使用|用|采用)[^，,。；;！？!?\n]{0,8}(?:训练模式|练习模式|陪练模式)/iu,
  ...TRAINING_RESPONSE_PERSISTENT_SESSION_START_PATTERNS,
  ...TRAINING_RESPONSE_POLITE_PRACTICE_START_PATTERNS,
]);
const TRAINING_RESPONSE_SESSION_KEEP_PATTERN = /^\s*(?:(?:我)?(?:不要|不想|拒绝|禁止|别|不用)(?:再)?[，,\s]*(?:退出|停止|关闭|取消|结束|关掉|不使用)[^，,。；;！？!?\n]{0,10}(?:训练式回答|训练模式|练习模式|陪练模式|训练|练习|陪练)|(?:训练式回答|训练模式|练习模式|陪练模式)[，,\s]*(?:不要|不想|不需要|无需|无须|不能|拒绝|禁止|别|不用)(?:再)?[，,\s]*(?:退出|停止|关闭|取消|结束|关掉))/iu;
const TRAINING_RESPONSE_TURN_SKIP_PATTERN = /^\s*(?:(?:(?:这一轮|这轮|本轮|这次|这回|本次|这一条|这条|这个问题|本题|这一题|这题|这一问|这问|本问|接下来这一问)[，,\s]*(?:先)?|先[，,\s]*)(?:(?:不要|不用|别|无需|无须|不需要)(?:再)?[，,\s]*(?:使用|用)?[，,\s]*(?:训练式回答|训练模式|练习模式|陪练模式|陪练|练习)|(?:训练式回答|训练模式|练习模式|陪练模式|陪练|练习)[，,\s]*(?:先)?(?:不要|不用|别|无需|无须|不需要)(?:再)?[，,\s]*(?:使用|用)))/iu;
const TRAINING_RESPONSE_CROSS_CLAUSE_SKIP_PATTERN = /^\s*(?:这一轮|这轮|本轮|这次|这回|本次|这一条|这条|这个问题|本题|这一题|这题|这一问|这问|本问|接下来这一问)[，,\s]*(?:先)?(?:直接回答|普通回答)[^。；;！？!?\n]{0,8}[，,][^。；;！？!?\n]{0,12}(?:不要|不用|别|无需|无须|不需要)(?:再)?[，,\s]*(?:使用|用)?[，,\s]*(?:训练式回答|训练模式|练习模式|陪练模式|陪练|练习)/iu;
const TRAINING_RESPONSE_ORDINARY_TURN_SKIP_PATTERN = /^\s*(?:这一轮|这轮|本轮|这次|这回|本次|这一条|这条|这个问题|本题|这一题|这题|这一问|这问|本问|接下来这一问)[，,\s]*(?:请)?[，,\s]*(?:使用|用|采用|按|直接|回到|切回|改用)?[，,\s]*(?:普通|正常)(?:模式|方式)?(?:回答|回复)?/iu;
const TRAINING_RESPONSE_SESSION_EXIT_PATTERN = /^\s*(?:(?:现在(?:就)?|接下来|还是|马上|立刻|立即|直接)[，,\s]*)?(?:(?:我(?:(?:现在)?(?:决定|希望|想|要)|(?:决定|希望|想|要)现在)|麻烦(?:你|帮我)?|请(?:你|帮我|给我)?|帮我|给我|不得不|只好)[，,\s]*)?(?:(?:马上|立刻|立即|直接|现在(?:就)?)[，,\s]*)?(?:(?:退出|关闭|停止|取消|结束|关掉)[，,\s]*(?:一下)?[，,\s]*(?:使用|用)?[，,\s]*(?:当前的?|这个)?[，,\s]*(?:训练式回答|训练模式|练习模式|陪练模式|训练|练习|陪练)(?:了|吧)?|(?:我)?(?:不想|不需要|无需|无须|不用|不要|别|不再)(?:再)?[，,\s]*(?:使用|用)?[，,\s]*(?:训练式回答|训练模式|练习模式|陪练模式|陪练)(?:了)?|(?:禁止|拒绝)[，,\s]*(?:使用|用|进入|开启)[^，,。；;！？!?\n]{0,8}(?:训练式回答|训练模式|练习模式|陪练模式)|(?:把|将)?[，,\s]*(?:训练式回答|训练模式|练习模式|陪练模式)[，,\s]*(?:(?:不用|不要|不需要|无需|无须|不想|别)(?:再)?[，,\s]*(?:使用|用)(?:了)?|不再[，,\s]*(?:使用|用)(?:了)?|不用了|不要了|不需要了|无需了|关掉|关闭|取消|停止|结束|退出)|(?:别|不要|不想|不需要|不用|无需|无须)[，,\s]*再[，,\s]*(?:陪练|练习)(?:了)?|(?:不能|不要|不得)[，,\s]*不[，,\s]*(?:退出|关闭|停止|取消|结束|关掉)[^，,。；;！？!?\n]{0,10}(?:训练式回答|训练模式|练习模式|陪练模式|训练|练习|陪练)|(?:回到|恢复|切回)[，,\s]*(?:普通|正常)(?:回答|模式))/iu;
const TRAINING_RESPONSE_TRIGGER_PATTERNS = Object.freeze([
  TRAINING_RESPONSE_MODE_COMMAND_PATTERN,
  /^\s*(?:训练式回答|训练模式|练习模式|陪练模式)[，,\s]*(?:现在)?[，,\s]*(?:开始|继续|开启)(?:吧|。|！|!)?$/iu,
  /^\s*(?:(?:现在|接下来)[，,\s]*)?(?:我想|我要|让我|请(?:你)?带我|带我|陪我|跟我|和我|我们来|咱们来).{0,12}(?:练习|演练|角色扮演)/iu,
  /^\s*(?:(?:现在|接下来|请|请你)[，,\s]*)?(?:进入|开启|开始|继续|进行|切换到|切到).{0,12}(?:陪练|模拟对话|角色扮演|问答学习|问答练习|互动测验)/iu,
  /^\s*(?:(?:现在|接下来|请|请你)[，,\s]*)?(?:练习|演练)(?:一下|一次|一场)?.{0,12}(?:话术|问答|对话|回答|应答|面试|谈判|销售|电话营销|陌拜)/iu,
  /^\s*(?:(?:现在|接下来|请|请你)[，,\s]*)?(?:模拟|演练)(?:一下|一次|一场)?.{0,12}(?:对话|谈判|沟通|问答|应答|异议处理|面试|拜访|陌拜|电话营销|销售话术)/iu,
  /^\s*(?:请)?你(?:来)?扮演.{0,8}(?:客户|面试官|谈判对象|销售对象).{0,16}我(?:来)?(?:回答|应答|应对|沟通|谈)/iu,
  /^\s*(?:请)?给我.{0,10}(?:销售|电话|谈判|面试|客户)?陪练/iu,
  /^(?:请)?(?:进入|开始|开启|继续)(?:一下)?训练(?:吧|。|！|!)?$/iu,
  /^\s*(?:请)?(?:以|作为).{0,8}(?:教练|导师|面试官).{0,18}(?:提问|训练|练习|指导|点评|纠正|打分)/iu,
  /^\s*(?:请)?(?:复盘|点评|纠正|批改|打分).{0,16}(?:我|我的|刚才|上一轮|这次).{0,16}(?:回答|话术|表现|练习|作答)/iu,
  /^\s*(?:我|我的).{0,16}(?:回答|话术|表现|练习|作答).{0,16}(?:复盘|点评|纠正|批改|打分)/iu,
  /^\s*(?:(?:现在|接下来|请|请你)[，,\s]*)?(?:考我|向我提问|问我问题|出题给我|一问一答|你问我答|问答练习|模拟客户对话)/iu,
  /^\s*(?:请)?(?:(?:和|跟|陪)我)?\s*(?:开始|开启|进入)?(?:一下)?练习(?:吧|。|！|!)?\s*$/iu,
  /^\s*(?:以后|后面|接下来)[，,\s]*(?:都|一直)[，,\s]*(?:使用|用|采用)[^，,。；;！？!?\n]{0,8}(?:训练模式|练习模式|陪练模式)/iu,
  ...TRAINING_RESPONSE_PERSISTENT_SESSION_START_PATTERNS,
  ...TRAINING_RESPONSE_POLITE_PRACTICE_START_PATTERNS,
]);

const SKILL_DEFINITIONS = Object.freeze({
  [TRAINING_RESPONSE_SKILL_ID]: Object.freeze({
    label: "训练式回答",
    capability: "训练式回答",
    reason: "仅在用户明确要求练习、演练、教练式提问、回答复盘或纠正表现时触发，提供可迁移的问题框架、反馈和下一轮练习。",
  }),
  "xingzhi-document-synthesis": Object.freeze({
    label: "资料整合",
    capability: "多资料整合",
    reason: "把多份文件或资料去重、归纳并映射到目标体系，形成可追溯的统一方案。",
  }),
  "xingzhi-knowledge-organization": Object.freeze({
    label: "知识库整理",
    capability: "知识结构整理",
    reason: "整理现有知识的目录、标签、双向链接与 Markdown 结构，并先形成可审核预览。",
  }),
  "xingzhi-knowledge-packaging": Object.freeze({
    label: "知识分包",
    capability: "知识分包",
    reason: "在用户主动归档或整理时，形成带来源的待确认知识候选。",
  }),
  "xingzhi-judgment-calibration": Object.freeze({
    label: "判断校准",
    capability: "判断校准",
    reason: "检查关键前提、证据、反证、机会成本与失败条件。",
  }),
  "xingzhi-action-feedback": Object.freeze({
    label: "行动反馈",
    capability: "行动反馈",
    reason: "把判断转成可观察行动，并按真实结果复盘。",
  }),
  "xingzhi-multi-perspective": Object.freeze({
    label: "多视角分析",
    capability: "多视角分析",
    reason: "从行知原有知识结构中选择必要视角，标明证据、边界、冲突和行动含义。",
  }),
});

const TASK_LEVELS = Object.freeze([
  "T0_DIRECT",
  "T1_FOCUSED",
  "T2_JUDGMENT",
  "T3_PANEL",
  "T4_GATED",
]);

function classifyTask(text) {
  const input = isTextTransformation(text) ? "" : String(text || "");
  const intents = detectIntentSignals(input);
  if (/升级|迁移|批量|系统配置|后台规则|权限策略|知识库结构|删除|覆盖/gu.test(input)
    && /知识库|后台|系统|规则|配置|文件|目录|权限|写入/gu.test(input)) return "T4_GATED";
  if (intents.multiPerspective
    || /多视角|多个视角|多角度|跨领域|跨域|系统分析|系统性|冲突证据|综合判断|红队/gu.test(input)) {
    return "T3_PANEL";
  }
  if ((intents.documentSynthesis && intents.finalSolution)
    || (intents.knowledgeOrganization && intents.judgmentAudit)) return "T2_JUDGMENT";
  // Explicit examination is different from merely asking for a longer deliverable.
  // Filter quotations and rejected instructions before raising the automatic tier.
  const analyticInstruction = instructionTextForRouting(input);
  if (/(?:深度|深入|全面|全方位|彻底)[^。！？!?\n]{0,24}(?:审计|研究|诊断|剖析|分析)|(?:in[- ]depth|deep|comprehensive|thorough)[^.!?\n]{0,32}(?:audit|research|diagnos(?:is|e)|analysis|analy[sz]e)/iu.test(analyticInstruction)) {
    return "T2_JUDGMENT";
  }
  const combinesPersonalMarketAndMonetization = /(?:会员|个人|我的|自身|现有).{0,24}(?:物料|资料|内容|产品)/u.test(analyticInstruction)
    && /(?:当前|整体|行业|市场|赛道|竞品)/u.test(analyticInstruction)
    && /(?:变现|商业模式|收入|收费|支付|营收)/u.test(analyticInstruction);
  if (combinesPersonalMarketAndMonetization) return "T2_JUDGMENT";
  if (/(?:全方位|全面|完整|详尽).{0,16}(?:资料|材料|信息|内容)|(?:调取|搜集|盘点|汇总).{0,20}(?:资料|材料|信息|内容)/u.test(analyticInstruction)) {
    return "T2_JUDGMENT";
  }
  if (intents.judgmentAudit
    || /是否|应该|判断|决策|选择|取舍|风险|证据|反证|失败.{0,3}条件|机会成本|因果/gu.test(input)) {
    return "T2_JUDGMENT";
  }
  if (intents.documentSynthesis || intents.knowledgeOrganization || intents.actionPlanning
    || /分析|梳理|整理|检索|查询|目标|项目|计划|复盘|解释|比较/gu.test(input)) return "T1_FOCUSED";
  return "T0_DIRECT";
}

function detectDomains(text) {
  const input = String(text || "");
  return /我的|我目前|我现在|个人|职业|关系|家人|朋友|同事|目标|项目|行动|结果|反馈/gu.test(input)
    ? ["PERSONAL"]
    : [];
}

function hasCrossDomainAuthorization() {
  return false;
}

function crossDomainPlan() {
  return {
    status: "not-supported",
    authorized: false,
    blockedDomains: [],
    reason: "行知四核心不注册外来专业领域；相关问题由总控按普通问题处理。",
  };
}

const PERMISSION_BOUNDARY = Object.freeze({
  canElevateKnowledgeWrite: false,
  canElevateExternalTransfer: false,
  canElevateCodexExecution: false,
});

function uniqueSkillNames(value) {
  if (!Array.isArray(value)) return [];
  const names = [];
  const seen = new Set();
  for (const item of value.slice(0, MAX_SKILL_PREFERENCES)) {
    const name = typeof item === "string" ? item.trim() : "";
    if (!name || name.length > 128 || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function explicitlyInvokedSkillNames(value, skills) {
  const input = String(value || "").toLocaleLowerCase("zh-CN");
  const matches = [];
  const actionBefore = /(?:请|帮我)?(?:调用|使用|启用|按|采用|用)(?:一下)?\s*(?:(?:下一|下)轮\s*)?/iu;
  const isNegatedInvocation = (index) => {
    const start = Math.max(
      input.lastIndexOf("。", index - 1),
      input.lastIndexOf("！", index - 1),
      input.lastIndexOf("？", index - 1),
      input.lastIndexOf("!", index - 1),
      input.lastIndexOf("?", index - 1),
      input.lastIndexOf(";", index - 1),
      input.lastIndexOf("；", index - 1),
      input.lastIndexOf(",", index - 1),
      input.lastIndexOf("，", index - 1),
      input.lastIndexOf("\n", index - 1),
    ) + 1;
    const prefix = input.slice(Math.max(start, index - 36), index);
    return /(?:不要|别|勿|禁止|不用|无需|不需要|不必|不想|拒绝|不应|不该)[^，,。！？!?\n]{0,18}(?:调用|使用|启用|按|采用|用)(?:一下)?\s*(?:(?:下一|下)轮\s*)?(?:Skill\s*)?["“「]?\s*$/iu
      .test(prefix) || /(?:不要|别|勿|禁止|不用|无需|不需要|不必|不想|拒绝)(?:再)?\s*$/iu.test(prefix);
  };
  for (const skill of Array.isArray(skills) ? skills : []) {
    const name = typeof skill?.name === "string" ? skill.name.trim() : "";
    if (!name) continue;
    const token = `$${name}`.toLocaleLowerCase("zh-CN");
    let offset = 0;
    while (offset < input.length) {
      const index = input.indexOf(token, offset);
      if (index < 0) break;
      const suffix = input.slice(index + token.length, index + token.length + 1);
      if (!/[a-z0-9_-]/iu.test(suffix) && !isNegatedInvocation(index)) {
        matches.push({ name, index });
        break;
      }
      offset = index + token.length;
    }
    const labels = [...new Set([
      skill?.displayName,
      skill?.label,
      skill?.promptLabel,
      name,
    ].filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim()))];
    for (const label of labels) {
      const escaped = label.split("").map((character) => (
        "\\^$.*+?()[]{}|".includes(character) ? "\\" + character : character
      )).join("");
      const explicitUse = new RegExp(actionBefore.source + "(?:Skill\\s*)?[\"“「]?" + escaped
        + "[\"”」]?(?:\\s*Skill)?", "iu");
      const explicitNextTurn = new RegExp("(?:下一|下)(?:轮|回合|次).{0,18}(?:调用|使用|启用|按|采用|用)\\s*"
        + "(?:Skill\\s*)?[\"“「]?" + escaped + "[\"”」]?(?:\\s*Skill)?", "iu");
      const useMatch = explicitUse.exec(input);
      const nextTurnMatch = explicitNextTurn.exec(input);
      const actionMatch = useMatch || nextTurnMatch;
      const labelIndex = actionMatch
        ? actionMatch.index + actionMatch[0].toLocaleLowerCase("zh-CN").lastIndexOf(label.toLocaleLowerCase("zh-CN"))
        : -1;
      if (actionMatch && !isNegatedInvocation(labelIndex)) {
        matches.push({ name, index: Math.max(0, input.indexOf(label.toLocaleLowerCase("zh-CN"))) });
        break;
      }
    }
  }
  return [...new Set(matches.sort((left, right) => left.index - right.index
    || left.name.localeCompare(right.name)).map((item) => item.name))];
}

function normalizeTurnSkillSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const version = typeof value.version === "string" ? value.version.trim() : "";
  let contentHash = value.contentHash === null
    ? null
    : (typeof value.contentHash === "string" ? value.contentHash.trim().toLowerCase() : "");
  const executionPath = typeof value.path === "string" ? value.path.trim() : "";
  const catalogPath = typeof value.catalogPath === "string" ? value.catalogPath.trim() : "";
  const kind = value.kind === "release" ? "release" : (value.kind === "legacy" ? "legacy" : "");
  if (!/^[a-z0-9][a-z0-9-]{1,127}$/u.test(id)
    || !version || version.length > 64
    || !executionPath || executionPath.length > 1_000 || executionPath.includes("\0")
    || !catalogPath || catalogPath.length > 1_000 || catalogPath.includes("\0")
    || !kind) return null;
  if (/^[a-f0-9]{64}$/u.test(contentHash)) contentHash = `sha256:${contentHash}`;
  if (contentHash !== null && !/^sha256:[a-f0-9]{64}$/u.test(contentHash)) return null;
  if (kind === "release" && contentHash === null) return null;
  return Object.freeze({
    id,
    version,
    contentHash,
    path: executionPath,
    catalogPath,
    kind,
  });
}

function normalizeTurnSkillSnapshots(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value.slice(0, MAX_TURN_SKILL_SNAPSHOTS)) {
    const snapshot = normalizeTurnSkillSnapshot(item);
    if (!snapshot || seen.has(snapshot.id)) continue;
    seen.add(snapshot.id);
    result.push(snapshot);
  }
  return result;
}

function skillRuntimeSnapshot(skill) {
  if (!skill || typeof skill !== "object" || Array.isArray(skill)) return null;
  const release = skill.release && typeof skill.release === "object" && !Array.isArray(skill.release)
    ? skill.release : null;
  return normalizeTurnSkillSnapshot({
    id: skill.name,
    version: release?.resolvedVersion || skill.version,
    contentHash: release?.resolvedHash || skill.contentHash || null,
    path: skill.path,
    catalogPath: release?.snapshotPath || skill.catalogPath || skill.path,
    kind: release ? "release" : "legacy",
  });
}

function skillRuntimeSnapshots(skills) {
  return normalizeTurnSkillSnapshots((Array.isArray(skills) ? skills : [])
    .filter((skill) => skill?.applicationMode !== "advisory").map((skill) => (
    normalizeTurnSkillSnapshot(skill?.runtimeSnapshot) || skillRuntimeSnapshot(skill)
  )));
}

function bindTurnSkillSnapshots(plan, savedSnapshots, options = {}) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.skills)) {
    throw new Error("本轮能力计划缺少 Skill，不能恢复运行快照");
  }
  const snapshots = normalizeTurnSkillSnapshots(savedSnapshots);
  const governingSkills = Array.isArray(plan.governingSkills)
    ? plan.governingSkills
    : plan.skills.filter((skill) => skill?.applicationMode !== "advisory");
  const advisoryIds = new Set((Array.isArray(plan.advisorySkills) ? plan.advisorySkills : [])
    .map((skill) => skill?.name).filter(Boolean));
  if (!Array.isArray(savedSnapshots) || snapshots.length !== savedSnapshots.length) {
    throw new Error("重试 Skill 快照无效或与当前能力计划不一致");
  }
  const currentIds = governingSkills.map((skill) => skill?.name).filter(Boolean);
  const snapshotById = new Map(snapshots
    .filter((snapshot) => currentIds.includes(snapshot.id))
    .map((snapshot) => [snapshot.id, snapshot]));
  const unknownSnapshots = snapshots.filter((snapshot) => (
    !currentIds.includes(snapshot.id) && !advisoryIds.has(snapshot.id)
  ));
  if (currentIds.some((id) => !snapshotById.has(id)) || unknownSnapshots.length) {
    throw new Error("重试 Skill 集合已经变化，不能无声切换运行版本");
  }
  const reboundGoverningSkills = governingSkills.map((skill) => {
    const saved = snapshotById.get(skill.name);
    const current = skillRuntimeSnapshot(skill);
    if (!current || current.kind !== saved.kind) {
      throw new Error(`重试 Skill 类型与当前目录不一致：${skill.name}`);
    }
    if (saved.kind === "release") {
      const expectedCatalogPath = [
        "00_系统/能力运行时/skill-releases",
        saved.id,
        saved.version,
        saved.contentHash.slice("sha256:".length),
        "SKILL.md",
      ].join("/");
      if (saved.catalogPath.replaceAll("\\", "/") !== expectedCatalogPath) {
        throw new Error(`重试 Skill 快照路径与版本哈希不一致：${saved.id}`);
      }
    } else if (saved.version !== current.version || saved.contentHash !== current.contentHash
      || saved.catalogPath !== current.catalogPath) {
      throw new Error(`旧格式 Skill 已经变化，不能把重试伪装成原运行版本：${saved.id}`);
    }
    const resolvedPath = typeof options.resolveExecutionPath === "function"
      ? options.resolveExecutionPath(saved) : saved.path;
    const snapshot = normalizeTurnSkillSnapshot({ ...saved, path: resolvedPath });
    if (!snapshot) throw new Error(`重试 Skill 执行路径无效：${saved.id}`);
    const release = snapshot.kind === "release"
      ? {
          ...(skill.release || {}),
          resolvedVersion: snapshot.version,
          resolvedHash: snapshot.contentHash,
          snapshotPath: snapshot.catalogPath,
          resolvedFrom: "turn-snapshot",
        }
      : skill.release;
    return {
      ...skill,
      version: snapshot.version,
      contentHash: snapshot.contentHash,
      path: snapshot.path,
      catalogPath: snapshot.catalogPath,
      ...(release ? { release } : {}),
      runtimeSnapshot: snapshot,
    };
  });
  const reboundById = new Map(reboundGoverningSkills.map((skill) => [skill.name, skill]));
  const skills = plan.skills.map((skill) => reboundById.get(skill?.name) || skill);
  return {
    ...plan,
    skills,
    governingSkills: reboundGoverningSkills,
    advisorySkills: Array.isArray(plan.advisorySkills) ? plan.advisorySkills : [],
    primarySkill: skills.find((skill) => skill.outputRole === "primary") || null,
  };
}

function catalogAgent(value, availableAgents = []) {
  const id = typeof value === "string" ? value.trim() : "";
  const dynamic = (Array.isArray(availableAgents) ? availableAgents : [])
    .find((item) => item?.id === id && item.enabled !== false);
  if (dynamic) return dynamic;
  try {
    return getAgent(id || DEFAULT_AGENT_ID);
  } catch {
    return getAgent(DEFAULT_AGENT_ID);
  }
}

function safeAgentId(value, availableAgents = []) {
  return catalogAgent(value, availableAgents).id;
}

function normalizeCapabilityPreferences(value = {}, availableAgents = []) {
  return {
    agentMode: AGENT_MODE_SET.has(value.agentMode) ? value.agentMode : "orchestrator",
    agentId: safeAgentId(value.agentId, availableAgents),
    skillMode: SKILL_MODE_SET.has(value.skillMode) ? value.skillMode : "auto",
    selectedSkills: uniqueSkillNames(value.selectedSkills),
    disabledSkills: uniqueSkillNames(value.disabledSkills),
    // The marker is written only by an explicit preferences migration/edit.
    // Normalization must never reinterpret an old saved selection by itself.
    ...(value.skillPreferenceSchemaVersion === 2 ? {
      skillPreferenceSchemaVersion: 2,
      fixedCandidateIds: uniqueSkillNames(value.fixedCandidateIds),
      fixedInvocationIds: uniqueSkillNames(value.fixedInvocationIds),
    } : {}),
    trainingResponseModeActive: value.trainingResponseModeActive === true,
  };
}

function keywordMatches(text, pattern) {
  return String(text || "").match(pattern)?.map((item) => item.trim()).filter(Boolean) || [];
}

function strongResponsibleAgentIntent(text) {
  const input = String(text || "").trim();
  if (!input) return null;
  if (/^(?:改写|翻译|润色|总结|概括|缩写|解释|转述|提炼)\s*[:：]/u.test(input)) return null;
  const crossTime = /(?:结合|回顾|梳理|分析).{0,12}(?:过去|最近|近).{0,12}(?:周|月|季度|半年|一年|一段时间)|(?:成长路径|价值排序|价值观|行为模式).{0,16}(?:变化|演变|发生了什么)/u;
  if (crossTime.test(input)) return "xingzhi-user-continuity";
  const multiSource = /(?:多份|几份|[三四五六七八九十\d]+份).{0,20}(?:访谈|记录|资料|报告|文档|文件).{0,24}(?:去重|整合|合并|对照|冲突)|(?:去重|整合|合并|对照).{0,20}(?:多份|几份|[三四五六七八九十\d]+份).{0,16}(?:访谈|记录|资料|报告|文档|文件)/u;
  const knowledgeStructure = /(?:这条|这份|这些).{0,8}(?:笔记|资料|知识).{0,16}(?:应该|应当).{0,8}(?:放|归到|归入)|(?:检查|修复).{0,12}(?:目录|失效链接|历史稿|知识重复)/u;
  if (multiSource.test(input) || knowledgeStructure.test(input)) return "xingzhi-knowledge-steward";
  const decidedAction = /(?:已经|已).{0,8}(?:决定|确定|选定).{0,20}(?:下一步|最低成本|怎么做|执行|验证)/u;
  if (decidedAction.test(input)) return "xingzhi-action-coach";
  const explicitChoice = /(?:该|要|是否|能否|值不值得).{0,20}(?:继续|辞职|创业|转型|选择|投入|购买|放弃).{0,24}(?:还是|或者|吗|是否|合理|现实)|(?:继续|辞职|创业|转型).{0,20}(?:还是|或者).{0,20}(?:继续|辞职|创业|转型)/u;
  if (explicitChoice.test(input)) return "xingzhi-judgment-calibrator";
  return null;
}

function recommendAgent(text, rawPreferences = {}, availableAgents = []) {
  const agents = Array.isArray(availableAgents) && availableAgents.length
    ? availableAgents.filter((item) => item?.enabled !== false)
    : [getAgent(DEFAULT_AGENT_ID), getAgent("xingzhi-knowledge-steward"), getAgent("xingzhi-judgment-calibrator"), getAgent("xingzhi-action-coach")];
  const preferences = normalizeCapabilityPreferences(rawPreferences, agents);
  if (preferences.agentMode === "locked") {
    const agent = catalogAgent(preferences.agentId, agents);
    return {
      agentId: agent.id,
      label: agent.label,
      status: "locked",
      requiresChoice: false,
      reason: `当前对话已锁定到${agent.label}，不会被本轮关键词静默切换。`,
      signals: [],
    };
  }
  const rawInput = String(text || "");
  const strongIntentAgentId = strongResponsibleAgentIntent(rawInput);
  const input = isTextTransformation(text) && !strongIntentAgentId ? "" : rawInput;
  if (strongIntentAgentId) {
    const strongAgent = agents.find((item) => item.id === strongIntentAgentId && item.enabled !== false);
    if (strongAgent) {
      const automaticallyDispatched = preferences.agentMode === "orchestrator";
      return {
        agentId: strongAgent.id,
        label: strongAgent.label,
        status: automaticallyDispatched ? "automatic" : "recommended",
        requiresChoice: preferences.agentMode === "smart-route",
        reason: `本轮任务已明确落入${strongAgent.label}的职责边界。`,
        signals: ["v2-responsible-agent-intent"],
        confidence: 0.9,
        source: "v2-local-boundary",
      };
    }
  }
  const dynamicRoute = routeDynamicCapabilities({
    instructionText: input,
    agents,
    skills: [],
    defaultAgentId: agents.find((item) => item.isDefault)?.id || DEFAULT_AGENT_ID,
  });
  const dynamicCandidate = agents.find((item) => item.id === dynamicRoute.agentId);
  const dynamicScore = dynamicRoute.agentId === DEFAULT_AGENT_ID
    ? 0
    : (Array.isArray(dynamicCandidate?.intents)
      ? dynamicCandidate.intents.filter((intent) => input.includes(intent)).length
      : 0);
  if (dynamicCandidate && dynamicScore > 0) {
    const automaticallyDispatched = preferences.agentMode === "orchestrator";
    return {
      agentId: dynamicCandidate.id,
      label: dynamicCandidate.label || dynamicCandidate.id,
      status: automaticallyDispatched ? "automatic" : "recommended",
      requiresChoice: preferences.agentMode === "smart-route",
      reason: dynamicRoute.reason,
      signals: dynamicCandidate.intents.filter((intent) => input.includes(intent)).slice(0, 4),
      source: "dynamic-local",
    };
  }
  const intents = detectIntentSignals(input);
  const judgmentSignals = keywordMatches(
    input,
    /(?:是否|要不要|该不该|应不应该).{0,16}(?:离开|接受|选择|转型|投入|购买|继续|放弃)|(?:评估|比较|分析|判断).{0,16}(?:风险|收益|选项|方案|可行性|证据)|(?:做出|帮助.{0,4}做|作出).{0,8}(?:选择|决策)|失败条件|机会成本/gu,
  );
  const actionSignals = keywordMatches(input, /(?:制定|拆解|拆成|安排|分解).{0,24}(?:计划|动作|行动|步骤|任务)|(?:记录|分析|复盘).{0,12}(?:反馈|执行结果|行动)|完成标准|下一步.{0,8}(?:做|执行|推进)/gu);
  const knowledgeSignals = keywordMatches(
    input,
    /(?:整理|检查|维护|修复|归档|更新).{0,16}(?:知识|目录|笔记|资料|标签|来源)|(?:归档|沉淀).{0,8}(?:这|本轮|当前)/gu,
  );
  if (intents.judgmentAudit) judgmentSignals.push("判断依据存在不确定或冲突");
  if (intents.actionPlanning) actionSignals.push("需要形成可推进的先后步骤");
  if (intents.knowledgeOrganization) knowledgeSignals.push("长期记录需要维护现行结论与历史版本");
  if (intents.documentSynthesis) knowledgeSignals.push("多份内容需要收束为统一交付");

  let agentId = DEFAULT_AGENT_ID;
  let signals = [];
  if (intents.knowledgeOrganization || intents.documentSynthesis) {
    agentId = "xingzhi-knowledge-steward";
    signals = knowledgeSignals;
  } else if (judgmentSignals.length >= actionSignals.length && judgmentSignals.length >= knowledgeSignals.length
    && judgmentSignals.length > 0) {
    agentId = "xingzhi-judgment-calibrator";
    signals = judgmentSignals;
  } else if (actionSignals.length >= knowledgeSignals.length && actionSignals.length > 0) {
    agentId = "xingzhi-action-coach";
    signals = actionSignals;
  } else if (knowledgeSignals.length > 0) {
    agentId = "xingzhi-knowledge-steward";
    signals = knowledgeSignals;
  }
  const agent = catalogAgent(agentId, agents);
  const sample = [...new Set(signals)].slice(0, 4);
  const automaticallyDispatched = preferences.agentMode === "orchestrator"
    && agent.id !== DEFAULT_AGENT_ID;
  return {
    agentId: agent.id,
    label: agent.label,
    status: agent.id === DEFAULT_AGENT_ID
      ? "orchestrator"
      : (automaticallyDispatched ? "automatic" : "recommended"),
    requiresChoice: preferences.agentMode === "smart-route" && agent.id !== DEFAULT_AGENT_ID,
    reason: sample.length
      ? (automaticallyDispatched
        ? `本轮识别到${sample.join("、")}等信号，已由总控自动切换到${agent.label}。`
        : `本轮出现${sample.join("、")}等信号，建议由${agent.label}参与；是否切换仍由你决定。`)
      : "没有检测到需要切换专业 Agent 的强信号，继续由行知总控处理。",
    signals: sample,
    confidence: sample.length ? 0.8 : 0.5,
  };
}

function inferredSkillNames(text, agentId, route = {}, reasoningPlan = {}, availableSkills = [], availableAgents = []) {
  const input = String(text || "");
  if ((isTextTransformation(input) && !strongResponsibleAgentIntent(input))
    || /^(?:应该|行业|职业|计划|目标|结果)$/u.test(input.trim())) return [];
  const intents = detectIntentSignals(input);
  const names = [];
  const add = (name) => { if (!names.includes(name)) names.push(name); };
  const agent = catalogAgent(agentId, availableAgents);
  const dynamicRoute = routeDynamicCapabilities({
    instructionText: input,
    agents: availableAgents,
    skills: availableSkills,
    defaultAgentId: DEFAULT_AGENT_ID,
  });
  for (const name of dynamicRoute.skillIds) add(name);
  if (["archive-preview", "message-organize", "document-import"]
    .includes(reasoningPlan.knowledgeWorkflow)) {
    add("xingzhi-knowledge-packaging");
    return names;
  }
  if (agentId !== DEFAULT_AGENT_ID && reasoningPlan.pureMethodRequest !== true) {
    for (const name of agent.recommendedSkills) {
      if (name === "xingzhi-document-synthesis" && !DOCUMENT_SYNTHESIS_PATTERN.test(input)) continue;
      if (name === "xingzhi-knowledge-organization" && !KNOWLEDGE_ORGANIZATION_PATTERN.test(input)) continue;
      if (name !== "xingzhi-knowledge-packaging") add(name);
    }
  }
  if (intents.documentSynthesis) add("xingzhi-document-synthesis");
  if (intents.knowledgeOrganization) add("xingzhi-knowledge-organization");
  if (reasoningPlan.pureMethodRequest !== true && (intents.judgmentAudit
    || agentId === "xingzhi-judgment-calibrator")) {
    add("xingzhi-judgment-calibration");
  }
  if (intents.actionPlanning || agentId === "xingzhi-action-coach") {
    add("xingzhi-action-feedback");
  }
  if (intents.multiPerspective
    || /多角度|多个角度|多视角|换个视角|跨领域|利益相关|利益冲突|冲突模型|时间尺度/gu.test(input)
    || (route.taskLevel === "T3_PANEL" && reasoningPlan.pureMethodRequest !== true)) {
    add("xingzhi-multi-perspective");
  }
  if (reasoningPlan.deliverable === "decision-evaluation"
    && reasoningPlan.pureMethodRequest !== true) {
    add("xingzhi-judgment-calibration");
  }
  const operatorIds = new Set(Array.isArray(reasoningPlan.operatorIds) ? reasoningPlan.operatorIds : []);
  if (["socratic-clarification", "critical-audit", "premortem"]
    .some((id) => operatorIds.has(id))) add("xingzhi-judgment-calibration");
  if (["backcasting", "execution-sequencing"]
    .some((id) => operatorIds.has(id))) add("xingzhi-action-feedback");
  return names;
}

function readScopesForText(text) {
  return buildReasoningPlan({ instructionText: text }).plannedPrefetchRoots;
}

function directTrainingResponseInstruction(value) {
  return String(value || "")
    .replace(/```[\s\S]*?(?:```|$)/gu, " ")
    .replace(/~~~[\s\S]*?(?:~~~|$)/gu, " ")
    .replace(/^[ \t]{0,3}>.*$/gmu, " ")
    .replace(/^(?: {4,}|\t+).*$/gmu, " ")
    .replace(/`[^`\r\n]*`/gu, " ")
    .replace(/“[^”\r\n]*”|‘[^’\r\n]*’|「[^」\r\n]*」|『[^』\r\n]*』|"[^"\r\n]*"|'[^'\r\n]*'/gu, " ")
    .trim();
}

function trainingResponseInstructionClauses(value) {
  return directTrainingResponseInstruction(value)
    .split(/[，,。；;！？!?\n]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasNonDirectiveMultilineTrainingContent(value) {
  const match = TRAINING_RESPONSE_MULTILINE_HEADER_PATTERN.exec(String(value || ""));
  if (!match) return false;
  return !TRAINING_RESPONSE_DIRECT_TASK_HEADER_PATTERN.test(String(match[1] || "").trim());
}

function hasTrainingResponseMetaIntent(value) {
  const instructionText = directTrainingResponseInstruction(value);
  if (!instructionText) return false;
  return TRAINING_RESPONSE_CONTENT_PREFIX_PATTERN.test(instructionText)
    || TRAINING_RESPONSE_MULTILINE_CONTENT_PREFIX_PATTERN.test(instructionText)
    || TRAINING_RESPONSE_MULTILINE_TRANSFORM_PREFIX_PATTERN.test(instructionText)
    || hasNonDirectiveMultilineTrainingContent(instructionText)
    || TRAINING_RESPONSE_CONTENT_TASK_PATTERN.test(instructionText)
    || TRAINING_RESPONSE_MODE_META_SUFFIX_PATTERN.test(instructionText)
    || TRAINING_RESPONSE_MODE_CONFIRMATION_QUESTION_PATTERN.test(instructionText)
    || TRAINING_RESPONSE_MODE_COMMAND_QUESTION_SENTENCE_PATTERN.test(instructionText)
    || TRAINING_RESPONSE_MODE_EXIT_QUESTION_PATTERN.test(instructionText)
    || TRAINING_RESPONSE_MODE_INFORMATION_PATTERN.test(instructionText)
    || TRAINING_RESPONSE_META_QUESTION_PATTERN.test(instructionText)
    || TRAINING_RESPONSE_MENTION_PATTERN.test(instructionText);
}

function hasReportedTrainingResponseIntent(value) {
  const directHeader = TRAINING_RESPONSE_MULTILINE_HEADER_PATTERN.exec(String(value || ""));
  if (directHeader
    && TRAINING_RESPONSE_DIRECT_TASK_HEADER_PATTERN.test(String(directHeader[1] || "").trim())) {
    return false;
  }
  const match = TRAINING_RESPONSE_REPORTED_SPEECH_PREFIX_PATTERN.exec(String(value || ""));
  if (!match) return false;
  const subject = String(match[1] || "").trim();
  const reportingVerb = String(match[2] || "").trim();
  const reportedText = directTrainingResponseInstruction(match[3]);
  if (!reportedText) return false;
  if (reportingVerb === "让我" && /^们/u.test(reportedText)) return false;
  if (/^(?:我|本人)(?:明确|正式)?$/u.test(subject)
    && reportingVerb === "要求"
    && /^(?:(?:你|行知|助手)[，,\s]*)?(?:启用|开启|进入|切换到|切到|开始|继续).{0,12}(?:训练模式|练习模式|陪练模式)/u.test(reportedText)) return false;
  return /(?:训练式回答|训练模式|练习模式|陪练模式)/iu.test(reportedText)
    || TRAINING_RESPONSE_MODE_COMMAND_PATTERN.test(reportedText)
    || TRAINING_RESPONSE_TRIGGER_PATTERNS.some((pattern) => pattern.test(reportedText));
}

function hasExplicitTrainingResponseIntent(value) {
  const instructionText = directTrainingResponseInstruction(value);
  if (!instructionText || hasTrainingResponseMetaIntent(instructionText)) return false;
  if (hasReportedTrainingResponseIntent(instructionText)) return false;
  if (trainingResponseModeAction(instructionText) === "exit") return false;
  if (TRAINING_RESPONSE_CROSS_CLAUSE_START_PATTERN.test(instructionText)) return true;
  return trainingResponseInstructionClauses(instructionText).some((clause) => (
    !TRAINING_RESPONSE_NEGATION_PATTERN.test(clause)
      && TRAINING_RESPONSE_TRIGGER_PATTERNS.some((pattern) => pattern.test(clause))
  ));
}

function trainingResponseModeAction(value) {
  const instructionText = directTrainingResponseInstruction(value);
  if (!instructionText) return "none";
  if (hasTrainingResponseMetaIntent(instructionText)
    || hasReportedTrainingResponseIntent(instructionText)) return "none";
  const clauses = trainingResponseInstructionClauses(instructionText);
  if (TRAINING_RESPONSE_CROSS_CLAUSE_SKIP_PATTERN.test(instructionText)) return "skip";
  if (TRAINING_RESPONSE_ORDINARY_TURN_SKIP_PATTERN.test(instructionText)) return "skip";
  if (clauses.some((clause) => TRAINING_RESPONSE_TURN_SKIP_PATTERN.test(clause))) return "skip";
  if (clauses.some((clause) => TRAINING_RESPONSE_SESSION_KEEP_PATTERN.test(clause))) return "none";
  if (clauses.some((clause) => TRAINING_RESPONSE_SESSION_EXIT_PATTERN.test(clause))) return "exit";
  if (TRAINING_RESPONSE_CROSS_CLAUSE_START_PATTERN.test(instructionText)) return "enter";
  return clauses.some((clause) => (
    !TRAINING_RESPONSE_NEGATION_PATTERN.test(clause)
      && TRAINING_RESPONSE_SESSION_START_PATTERNS.some((pattern) => pattern.test(clause))
  )) ? "enter" : "none";
}

function resolveTrainingResponseModeActive({
  currentActive = false,
  instructionText = "",
  disabledSkills = [],
} = {}) {
  const disabled = disabledSkills?.has?.(TRAINING_RESPONSE_SKILL_ID) === true
    || (Array.isArray(disabledSkills) && disabledSkills.includes(TRAINING_RESPONSE_SKILL_ID));
  if (disabled) return false;
  const action = trainingResponseModeAction(instructionText);
  if (action === "exit") return false;
  if (action === "enter") return true;
  return currentActive === true;
}

function shouldAutoTriggerTrainingResponse({
  instructionText = "",
  knowledgeWorkflow = "none",
  disabledSkills = [],
  availableSkillIds = [],
} = {}) {
  const available = availableSkillIds?.has?.(TRAINING_RESPONSE_SKILL_ID) === true
    || (Array.isArray(availableSkillIds) && availableSkillIds.includes(TRAINING_RESPONSE_SKILL_ID));
  const disabled = disabledSkills?.has?.(TRAINING_RESPONSE_SKILL_ID) === true
    || (Array.isArray(disabledSkills) && disabledSkills.includes(TRAINING_RESPONSE_SKILL_ID));
  if (!available || disabled || knowledgeWorkflow !== "none") return false;
  return hasExplicitTrainingResponseIntent(instructionText);
}

function preferredPrimarySkill(deliverable, chosenNames, skillByName, dynamicallyPreferred = null, instructionText = "") {
  const taskNames = chosenNames.filter((name) => normalizedSkillType(skillByName.get(name)) === "task");
  const hasTaskSkill = taskNames.length > 0;
  const eligible = (name) => chosenNames.includes(name) && isPrimarySkillEligible(skillByName.get(name), {
    deliverable,
    hasTaskSkill,
    explicitOrchestration: isExplicitOrchestrationRequest(instructionText),
  });
  if (!["document-synthesis", "knowledge-package"].includes(deliverable)
    && eligible("xingzhi-training-response")) {
    return "xingzhi-training-response";
  }
  const genericPrimarySkills = new Set([
    "xingzhi-document-synthesis",
    "xingzhi-knowledge-packaging",
    "xingzhi-action-feedback",
    "xingzhi-judgment-calibration",
    "xingzhi-multi-perspective",
    "xingzhi-knowledge-organization",
  ]);
  if (!["document-synthesis", "knowledge-package"].includes(deliverable)
    && dynamicallyPreferred
    && !genericPrimarySkills.has(dynamicallyPreferred)
    && eligible(dynamicallyPreferred)) {
    return dynamicallyPreferred;
  }
  const preferred = {
    "document-synthesis": "xingzhi-document-synthesis",
    "knowledge-package": "xingzhi-knowledge-packaging",
    "execution-plan": "xingzhi-action-feedback",
    "decision-evaluation": "xingzhi-judgment-calibration",
    "multi-perspective-analysis": "xingzhi-multi-perspective",
  }[deliverable];
  if (preferred && eligible(preferred)) return preferred;
  if (dynamicallyPreferred && eligible(dynamicallyPreferred)) return dynamicallyPreferred;
  const fallbackOrder = [
    ...(deliverable === "analysis" || deliverable === "explanation"
      ? ["xingzhi-multi-perspective"]
      : []),
    "xingzhi-judgment-calibration",
    "xingzhi-action-feedback",
    "xingzhi-multi-perspective",
    "xingzhi-knowledge-organization",
    "xingzhi-document-synthesis",
    "xingzhi-knowledge-packaging",
  ];
  return fallbackOrder.find(eligible)
    || taskNames.find(eligible)
    || chosenNames.find(eligible)
    || null;
}

function activeReleaseIdentity(skill) {
  const release = skill?.release;
  if (!release || release.degraded === true
    || !["active", "active-pending-health", "rolled-back"].includes(release.status)
    || release.resolvedFrom !== "active"
    || typeof release.resolvedVersion !== "string"
    || typeof release.resolvedHash !== "string") return null;
  return {
    skillId: skill.name,
    skillVersion: release.resolvedVersion,
    contentHash: release.resolvedHash,
  };
}

function cognitiveLensMigrationStates(skillsByName, diagnostics) {
  const states = new Map();
  for (const operator of listReasoningOperators()) {
    const binding = operator.skillBinding;
    if (binding?.activation !== "gated" || states.has(binding.skillId)) continue;
    const skill = skillsByName.get(binding.skillId);
    const identity = activeReleaseIdentity(skill);
    const liveGate = evaluateCognitiveLensMigrationGate({
      ...(identity || {
        skillId: binding.skillId,
        skillVersion: skill?.version,
        contentHash: skill?.contentHash,
      }),
      diagnostics,
    });
    const publishedGate = identity ? publishedCognitiveLensMigrationGate({
      ...identity,
      evaluation: skill?.migrationEvaluation,
    }) : null;
    const gate = liveGate.qualifyingCases > 0 || !publishedGate ? liveGate : publishedGate;
    states.set(binding.skillId, { binding, identity, gate });
  }
  return states;
}

function buildTurnCapabilityPlan({
  text,
  routingText,
  intentText,
  referenceText = "",
  preferences: rawPreferences,
  availableSkills = [],
  availableAgents = [],
  authorizedReadScopes,
  requestedSkills = [],
  agentOverride = null,
  archiveMode = false,
  knowledgeWorkflow: rawKnowledgeWorkflow = "none",
  continuityRoots = [],
  semanticDecision = null,
  internalWorkflow = false,
  cognitiveLensShadowDiagnostics = [],
  deferAgentSkillIds = [],
} = {}) {
  const hasReferenceText = typeof referenceText === "string" && referenceText.trim().length > 0;
  const instructionText = typeof routingText === "string"
    ? routingText
    : (hasReferenceText ? "" : String(text || ""));
  const visibleInstructionText = instructionTextForRouting(instructionText);
  const visibleIntentText = instructionTextForRouting(
    typeof intentText === "string" ? intentText : instructionText,
  );
  const trainingModeActionForTurn = trainingResponseModeAction(
    typeof intentText === "string" ? intentText : instructionText,
  );
  const trainingModeExplicitExit = trainingModeActionForTurn === "exit";
  const trainingModeSkippedForTurn = trainingModeActionForTurn === "skip";
  const agentCatalog = Array.isArray(availableAgents) && availableAgents.length
    ? availableAgents.filter((item) => item?.enabled !== false)
    : [getAgent(DEFAULT_AGENT_ID), getAgent("xingzhi-knowledge-steward"), getAgent("xingzhi-judgment-calibrator"), getAgent("xingzhi-action-coach")];
  const preferences = normalizeCapabilityPreferences(rawPreferences, agentCatalog);
  const requestedWorkflow = normalizeKnowledgeWorkflow(rawKnowledgeWorkflow);
  const knowledgeWorkflow = requestedWorkflow === "none" && archiveMode === true
    ? "archive-preview"
    : requestedWorkflow;
  const trainingModeSuppressedForTurn = trainingModeExplicitExit
    || trainingModeSkippedForTurn
    || knowledgeWorkflow !== "none";
  const semanticRoute = knowledgeWorkflow === "none" && !isTextTransformation(instructionText)
    && semanticDecision?.source === "semantic-model"
    && Number.isFinite(semanticDecision.confidence) && semanticDecision.confidence >= 0.65
    ? semanticDecision : null;
  const semanticSelectedSkills = semanticRoute
    ? (Array.isArray(semanticRoute.skillIds) ? semanticRoute.skillIds : [])
      .map((id) => (Array.isArray(availableSkills) ? availableSkills : []).find((skill) => skill?.name === id))
      .filter((skill) => skill?.enabled !== false && isSkillVisibleInDialogue(skill))
    : [];
  const semanticPureLensRoute = semanticSelectedSkills.length > 0
    && semanticSelectedSkills.every((skill) => normalizedSkillType(skill) === "cognitive-lens");
  const taskLevel = knowledgeWorkflow !== "none"
    ? "T4_GATED"
    : (semanticRoute?.taskLevel || classifyTask(visibleInstructionText));
  let reasoningPlan = buildReasoningPlan({
    instructionText,
    referenceText,
    taskLevel,
    knowledgeWorkflow,
    continuityRoots,
  });
  const explicitlySelectedOperatorIds = reasoningPlan.methodSelectionMode === "explicit"
    ? [...reasoningPlan.operatorIds] : [];
  const advisoryOperatorIds = reasoningPlan.methodSelectionMode === "explicit"
    ? []
    : [...new Set([
        ...reasoningPlan.operatorIds,
        ...(Array.isArray(semanticRoute?.operatorIds) ? semanticRoute.operatorIds : []),
      ].filter((id) => getReasoningOperator(id)))];
  if (semanticRoute) {
    reasoningPlan = {
      ...reasoningPlan,
      deliverable: semanticRoute.deliverable || reasoningPlan.deliverable,
      outputDepth: semanticRoute.outputDepth || reasoningPlan.outputDepth,
      methodSelectionMode: explicitlySelectedOperatorIds.length ? "explicit" : "none",
      pureMethodRequest: false,
      operatorIds: explicitlySelectedOperatorIds,
      operators: explicitlySelectedOperatorIds.map((id) => getReasoningOperator(id)),
      omittedOperatorIds: [],
      plannedPrefetchRoots: Array.isArray(semanticRoute.readRoots)
        ? [...semanticRoute.readRoots] : reasoningPlan.plannedPrefetchRoots,
      riskLevel: semanticRoute.riskLevel || "low",
    };
  } else if (reasoningPlan.methodSelectionMode !== "explicit") {
    reasoningPlan = {
      ...reasoningPlan,
      methodSelectionMode: "none",
      operatorIds: [],
      operators: [],
      omittedOperatorIds: [],
    };
  }
  const domains = detectDomains(visibleInstructionText);
  const crossDomain = crossDomainPlan();
  const route = { taskLevel, domains, crossDomain, archiveMode: knowledgeWorkflow !== "none" };
  const recommendation = semanticRoute
    ? (() => {
        const locked = preferences.agentMode === "locked";
        const routePureLensToDefault = semanticPureLensRoute && !locked && !agentOverride;
        const agentId = routePureLensToDefault
          ? (agentCatalog.find((item) => item.isDefault)?.id || DEFAULT_AGENT_ID)
          : (locked ? preferences.agentId : safeAgentId(semanticRoute.agentId, agentCatalog));
        const agent = catalogAgent(agentId, agentCatalog);
        return {
          agentId,
          label: agent.label,
          status: routePureLensToDefault
            ? "orchestrator"
            : locked
            ? "locked"
            : (agentId === DEFAULT_AGENT_ID ? "orchestrator" : "automatic"),
          requiresChoice: !routePureLensToDefault && !locked
            && preferences.agentMode === "smart-route" && agentId !== DEFAULT_AGENT_ID,
          reason: routePureLensToDefault
            ? "本轮语义路由只选择认知透镜，由行知总控负责最终回答。"
            : locked
            ? `当前对话已锁定到${agent.label}，语义路由不能覆盖该锁定。`
            : String(semanticRoute.reason || "已按本轮语义目标选择执行角色。").slice(0, 600),
          signals: [],
          source: "semantic-model",
          confidence: semanticRoute.confidence,
        };
      })()
    : recommendAgent(visibleInstructionText, preferences, agentCatalog);
  const effectiveAgentId = agentOverride ? safeAgentId(agentOverride, agentCatalog) : recommendation.agentId;
  const effectiveAgent = catalogAgent(effectiveAgentId, agentCatalog);
  const agentAllowedSkills = Array.isArray(effectiveAgent.allowedSkillIds) && effectiveAgent.allowedSkillIds.length
    && !effectiveAgent.allowedSkillIds.includes("*")
    ? new Set(effectiveAgent.allowedSkillIds) : null;
  // Only actual canonical Skills may defer the old Agent table to the final
  // canonical coordinator. Unregistered extensions retain the legacy filter.
  const deferredAgentSkills = new Set(deferAgentSkillIds);
  const discoveredByName = new Map((Array.isArray(availableSkills) ? availableSkills : [])
    .filter((skill) => skill && skill.enabled !== false && typeof skill.name === "string"
      && (internalWorkflow ? true : isSkillVisibleInDialogue(skill))
      && (!agentAllowedSkills || agentAllowedSkills.has(skill.name)
        || deferredAgentSkills.has(skill.name)
        || skill.name === TRAINING_RESPONSE_SKILL_ID
        || normalizedSkillType(skill) === "cognitive-lens"))
    .map((skill) => [skill.name, skill]));
  const migrationStates = cognitiveLensMigrationStates(
    discoveredByName,
    cognitiveLensShadowDiagnostics,
  );
  const availableByName = new Map([...discoveredByName]
    .filter(([name]) => !migrationStates.has(name) || migrationStates.get(name).gate.passed));
  const dynamicRouteAudit = routeDynamicCapabilities({
    instructionText: visibleInstructionText,
    agents: agentCatalog,
    skills: [...discoveredByName.values()],
    defaultAgentId: agentCatalog.find((item) => item.isDefault)?.id || DEFAULT_AGENT_ID,
  });
  const disabled = new Set(preferences.disabledSkills);
  const fixedItemEligible = (name) => availableByName.has(name) && !disabled.has(name)
    && !(trainingModeSuppressedForTurn && name === TRAINING_RESPONSE_SKILL_ID);
  const hasFixedPreferenceFields = preferences.skillPreferenceSchemaVersion === 2;
  const fixedCandidateNames = (hasFixedPreferenceFields ? preferences.fixedCandidateIds
    : preferences.skillMode === "auto" ? preferences.selectedSkills : [])
    .filter(fixedItemEligible);
  const fixedGoverningNames = (hasFixedPreferenceFields ? preferences.fixedInvocationIds
    : preferences.skillMode !== "auto" ? preferences.selectedSkills : [])
    .filter(fixedItemEligible);
  const fixedNames = uniqueSkillNames([...fixedCandidateNames, ...fixedGoverningNames]);
  const sessionNames = preferences.trainingResponseModeActive === true
    && !trainingModeSuppressedForTurn
    && availableByName.has(TRAINING_RESPONSE_SKILL_ID)
    && !disabled.has(TRAINING_RESPONSE_SKILL_ID)
    ? [TRAINING_RESPONSE_SKILL_ID] : [];
  const persistentNames = [...fixedNames];
  for (const name of sessionNames) if (!persistentNames.includes(name)) persistentNames.push(name);
  const trainingResponseTriggered = !trainingModeSuppressedForTurn && shouldAutoTriggerTrainingResponse({
    instructionText: visibleIntentText,
    knowledgeWorkflow,
    disabledSkills: disabled,
    availableSkillIds: availableByName,
  });
  const routedRecommendedNames = (semanticRoute
    ? (Array.isArray(semanticRoute.skillIds) ? semanticRoute.skillIds : [])
    : inferredSkillNames(
        visibleInstructionText,
        effectiveAgentId,
        route,
        reasoningPlan,
        [...availableByName.values()],
        agentCatalog,
      ))
    .filter((name) => availableByName.has(name)
      && !disabled.has(name)
      && (!migrationStates.has(name) || migrationStates.get(name).gate.passed)
      && (name !== TRAINING_RESPONSE_SKILL_ID || trainingResponseTriggered));
  const recommendedNames = [];
  const operatorMigrationNames = reasoningPlan.operators
    .map((operator) => operator.skillBinding)
    .filter((binding) => binding?.activation === "gated"
      && migrationStates.get(binding.skillId)?.gate.passed
      && availableByName.has(binding.skillId)
      && !disabled.has(binding.skillId))
    .map((binding) => binding.skillId);
  for (const name of [
    ...operatorMigrationNames,
    ...routedRecommendedNames,
  ]) {
    if (!recommendedNames.includes(name)) recommendedNames.push(name);
  }
  const directExplicitNames = explicitlyInvokedSkillNames(
    visibleInstructionText,
    [...discoveredByName.values()],
  );
  const oneTurnNames = uniqueSkillNames([...requestedSkills, ...directExplicitNames])
    .filter((name) => {
      const skill = discoveredByName.get(name);
      return skill && !disabled.has(name)
        && (availableByName.has(name) || normalizedSkillType(skill) === "cognitive-lens")
        && !(trainingModeSuppressedForTurn && name === TRAINING_RESPONSE_SKILL_ID);
    });

  let proposedNames = [];
  if (preferences.skillMode === "recommend") {
    proposedNames = uniqueSkillNames([...fixedCandidateNames, ...recommendedNames])
      .filter((name) => !fixedGoverningNames.includes(name)
      && !oneTurnNames.includes(name));
  }
  const explicitMethodSkillNames = reasoningPlan.methodSelectionMode === "explicit"
    ? operatorMigrationNames : [];
  const governingRootNames = uniqueSkillNames([
    ...fixedGoverningNames,
    ...sessionNames,
    ...explicitMethodSkillNames,
    ...oneTurnNames,
  ]).filter((name) => availableByName.has(name) && !disabled.has(name));
  proposedNames = proposedNames.filter((name) => !governingRootNames.includes(name));
  const automaticCandidateNames = preferences.skillMode === "auto"
    ? uniqueSkillNames([...fixedCandidateNames, ...recommendedNames])
    : (preferences.skillMode === "recommend" ? proposedNames : []);
  const advisoryCandidateNames = automaticCandidateNames
    .filter((name) => !governingRootNames.includes(name)
      && availableByName.has(name) && !disabled.has(name));

  const governingLensRequests = [];
  const advisoryLensRequests = [];
  const addLensRequest = (requests, skillId, source) => {
    const skill = discoveredByName.get(skillId);
    if (!skill || normalizedSkillType(skill) !== "cognitive-lens") return;
    requests.push({ skillId, source });
  };
  for (const name of governingRootNames) {
    const source = oneTurnNames.includes(name) ? "explicit-skill"
      : sessionNames.includes(name) ? "session-mode"
        : fixedGoverningNames.includes(name) ? "fixed" : "explicit-operator";
    addLensRequest(governingLensRequests, name, source);
  }
  for (const name of advisoryCandidateNames) {
    addLensRequest(advisoryLensRequests, name, fixedNames.includes(name) ? "fixed" : "automatic-skill");
  }
  for (const operator of reasoningPlan.operators) {
    const binding = operator?.skillBinding;
    if (binding?.activation === "gated") {
      addLensRequest(governingLensRequests, binding.skillId, "explicit-operator");
    }
  }
  for (const operatorId of advisoryOperatorIds) {
    const binding = getReasoningOperator(operatorId)?.skillBinding;
    if (binding?.activation === "gated") {
      addLensRequest(advisoryLensRequests, binding.skillId, "automatic-operator");
    }
  }
  const lensAvailabilityOverrides = new Map([...migrationStates].map(([skillId, state]) => [
    skillId,
    state.gate.passed === true && state.identity
      ? { available: true }
      : {
          available: false,
          reasonCode: state.identity ? "migration-gate" : "unavailable-version",
        },
  ]));
  const governingNonLensNames = governingRootNames.filter((name) => (
    normalizedSkillType(discoveredByName.get(name)) !== "cognitive-lens"
  ));
  const cognitiveLensRouting = routeCognitiveLenses({
    skills: [...discoveredByName.values()],
    requests: governingLensRequests,
    taskLevel,
    nonLensSkillIds: governingNonLensNames,
    nonLensContextBytes: governingNonLensNames.reduce((total, name) => {
      const instructionBytes = availableByName.get(name)?.instructionBytes;
      return total + (Number.isSafeInteger(instructionBytes) && instructionBytes > 0 ? instructionBytes : 0);
    }, 0),
    availabilityOverrides: lensAvailabilityOverrides,
  });
  const advisoryLensRouting = routeCognitiveLenses({
    skills: [...discoveredByName.values()],
    requests: advisoryLensRequests.filter((request) => !governingLensRequests
      .some((governing) => governing.skillId === request.skillId)),
    taskLevel,
    // Passive candidates carry no Skill body, so fixed automatic task Skills must not
    // consume the active-lens count or its instruction budget.
    nonLensSkillIds: [],
    nonLensContextBytes: 0,
    availabilityOverrides: lensAvailabilityOverrides,
  });
  const governingSeedNames = uniqueSkillNames([
    ...governingNonLensNames,
    ...cognitiveLensRouting.selectedSkillIds,
  ]);

  const dynamicallyPreferred = governingRootNames.find((name) => recommendedNames.includes(name)) || null;
  let primarySkillName = !semanticRoute
    && KNOWLEDGE_ORGANIZATION_PATTERN.test(visibleInstructionText)
    && governingSeedNames.includes("xingzhi-knowledge-organization")
    ? "xingzhi-knowledge-organization"
    : preferredPrimarySkill(
        reasoningPlan.deliverable,
        governingSeedNames,
        availableByName,
        dynamicallyPreferred,
        visibleInstructionText,
      );
  const trainingSkillAuthorized = governingSeedNames.includes(TRAINING_RESPONSE_SKILL_ID);
  const dependencyAvailableSkills = [...availableByName.values()]
    .filter((skill) => !disabled.has(skill.name)
      && (skill.name !== TRAINING_RESPONSE_SKILL_ID || trainingSkillAuthorized));
  const dependencyGraph = resolveSkillGraph({
    primarySkillId: primarySkillName,
    requestedSkillIds: governingSeedNames,
    skills: dependencyAvailableSkills,
    authorizedReadScopes,
    instructionText: visibleInstructionText,
    deliverable: reasoningPlan.deliverable,
    allowWorkflow: internalWorkflow,
  });
  const governingNames = dependencyGraph.orderedSkillIds;
  primarySkillName = dependencyGraph.primarySkillId;
  const advisoryLensNames = advisoryLensRouting.selectedSkillIds
    .filter((name) => !governingNames.includes(name));
  const advisoryNames = uniqueSkillNames([...advisoryCandidateNames, ...advisoryLensNames])
    .filter((name) => !governingNames.includes(name));
  const allSelectedNames = uniqueSkillNames([...governingNames, ...advisoryNames]);
  const pureLensRequest = governingNames.length > 0
    && governingNames.every((name) => normalizedSkillType(availableByName.get(name)) === "cognitive-lens");
  const routePureLensToDefault = pureLensRequest && preferences.agentMode !== "locked" && !agentOverride;
  const finalAgentId = routePureLensToDefault
    ? (agentCatalog.find((item) => item.isDefault)?.id || DEFAULT_AGENT_ID)
    : effectiveAgentId;
  const finalRecommendation = routePureLensToDefault
    ? {
        ...recommendation,
        agentId: finalAgentId,
        label: catalogAgent(finalAgentId, agentCatalog).label,
        status: "orchestrator",
        requiresChoice: false,
        reason: "本轮明确调用认知透镜，由行知总控负责综合并提交最终回答。",
      }
    : recommendation;

  const dependencySource = new Map((dependencyGraph.loadingReasons || [])
    .filter((item) => item?.id && item.parentId)
    .map((item) => [item.id, "dependency"]));
  const sourceForGoverned = (name) => {
    if (dependencySource.has(name)) return "dependency";
    if (oneTurnSet.has(name)) return "one-turn";
    if (sessionSet.has(name)) return "session-mode";
    if (trainingResponseTriggered && name === TRAINING_RESPONSE_SKILL_ID) return "automatic-trigger";
    if (fixedSet.has(name)) return "fixed";
    if (operatorMigrationNames.includes(name) && explicitMethodSkillNames.includes(name)) return "operator-migration";
    return "explicit-method";
  };
  const sourceForAdvisory = (name) => fixedNames.includes(name) ? "fixed-advisory"
    : (advisoryLensRouting.selectedSkillIds.includes(name) ? "automatic-lens" : "automatic");
  const annotate = (name, source, applicationMode = "governing") => {
    const skill = availableByName.get(name);
    const definition = SKILL_DEFINITIONS[name] || {};
    const typePolicy = skillTypePolicy(skill);
    const annotated = {
      ...skill,
      ...(skill?.release ? { release: { ...skill.release } } : {}),
      name,
      label: skill?.displayName || skill?.label || definition.label || name,
      promptLabel: definition.label || name,
      capability: definition.capability || skill?.displayName || name,
      skillType: typePolicy.skillType,
      primaryEligible: typePolicy.primaryEligible,
      controlsFinalLayout: typePolicy.controlsFinalLayout,
      applicationMode,
      // Selection is a plan, not a read receipt.
      instructionLoaded: false,
      reason: applicationMode === "advisory"
        ? "这是本轮自动识别的可选方法提示；不加载 Skill 正文，不限制主模型如何回答，也不申请额外读取或工具权限。"
        : source === "dependency"
        ? "由本轮主要能力声明为必需或满足条件的辅助依赖；已通过循环、冲突、版本和预算校验。"
        : source === "operator-migration"
          ? "旧推理方法已通过该活动 Skill 版本的影子迁移门槛；本轮只加载固定快照，不再并行注入旧正文。"
        : source === "automatic-trigger"
          ? "本轮检测到明确的练习、演练、教练式提问或回答复盘意图，因此触发训练式回答；它不提升任何权限。"
        : source === "session-mode"
          ? "已由你明确进入当前对话的训练模式；后续回合持续加载，直到你明确退出或停止。它不提升任何权限。"
        : source === "fixed"
        ? "已固定到本对话，每轮按需加载；它仍不能提升任何权限。"
        : source === "one-turn"
          ? "由你明确指定仅用于本轮；发送完成后不会保留。"
          : (definition.reason || skill?.description || "与本轮任务相符。"),
      source,
    };
    return {
      ...annotated,
      runtimeSnapshot: applicationMode === "governing" ? skillRuntimeSnapshot(annotated) : null,
    };
  };
  const fixedSet = new Set(fixedNames);
  const sessionSet = new Set(sessionNames);
  const oneTurnSet = new Set(oneTurnNames);
  const skills = [
    ...governingNames.map((name) => ({
      ...annotate(name, sourceForGoverned(name), "governing"),
      outputRole: name === primarySkillName ? "primary" : "supporting",
    })),
    ...advisoryNames.map((name) => ({
      ...annotate(name, sourceForAdvisory(name), "advisory"),
      outputRole: "supporting",
    })),
  ];
  const governingSkills = skills.filter((skill) => skill.applicationMode === "governing");
  const advisorySkills = skills.filter((skill) => skill.applicationMode === "advisory");
  const selectedByName = new Map(governingSkills.map((skill) => [skill.name, skill]));
  // 只有明确调用的透镜才把它绑定的方法加入本轮 reasoningBlock。
  {
    const selectedLensOperatorIds = [];
    for (const selectedSkill of governingSkills) {
      if (selectedSkill?.skillType !== "cognitive-lens") continue;
      // Skill 本体上的字段是 recommendedOperators（见 38941 的配置校验）；
      // operatorIds 只存在于 buildCognitiveLensCandidateIndex(8294) 转换后的候选索引里。
      // 这里拿到的是目录对象，所以必须先读 recommendedOperators，否则恒为空、整块空转。
      const rawLensOperators = selectedSkill.recommendedOperators
        || selectedSkill.operators
        || selectedSkill.operatorIds
        || selectedSkill.compiledFrom?.recommendedOperators
        || selectedSkill.compiledFrom?.operatorIds
        || [];
      const lensOperatorIds = Array.isArray(rawLensOperators) ? rawLensOperators : [];
      for (const operatorId of lensOperatorIds) {
        const id = String(operatorId || "").trim();
        if (id && !selectedLensOperatorIds.includes(id)) selectedLensOperatorIds.push(id);
      }
    }
    if (selectedLensOperatorIds.length) {
      const mergedIds = [...reasoningPlan.operatorIds];
      for (const id of selectedLensOperatorIds) {
        if (!mergedIds.includes(id) && getReasoningOperator(id)) mergedIds.push(id);
      }
      const orderedIds = REASONING_OPERATOR_ORDER.filter((id) => mergedIds.includes(id));
      if (orderedIds.length !== reasoningPlan.operatorIds.length) {
        reasoningPlan = {
          ...reasoningPlan,
          operatorIds: orderedIds,
          operators: orderedIds.map((id) => getReasoningOperator(id)).filter(Boolean),
          omittedOperatorIds: reasoningPlan.omittedOperatorIds
            .filter((id) => !orderedIds.includes(id)),
          methodSelectionMode: reasoningPlan.methodSelectionMode === "none"
            ? "explicit"
            : reasoningPlan.methodSelectionMode,
        };
      }
    }
  }
  reasoningPlan = {
    ...reasoningPlan,
    operators: reasoningPlan.operators.map((operator) => {
      const binding = operator.skillBinding;
      if (binding?.activation !== "gated") {
        return { ...operator, instructionSource: "registry" };
      }
      const state = migrationStates.get(binding.skillId);
      const selected = selectedByName.get(binding.skillId);
      const usesActiveSkill = state?.gate.passed === true && state.identity
        && selected?.runtimeSnapshot?.version === state.identity.skillVersion
        && selected.runtimeSnapshot.contentHash === state.identity.contentHash;
      return {
        ...operator,
        instructionSource: usesActiveSkill ? "active-skill" : "legacy-fallback",
        migrationGate: state?.gate || null,
        ...(usesActiveSkill ? {
          resolvedSkill: {
            skillId: state.identity.skillId,
            version: state.identity.skillVersion,
            contentHash: state.identity.contentHash,
          },
        } : {}),
      };
    }),
  };
  const proposedSkills = proposedNames.map((name) => annotate(name, "recommended", "advisory"));
  const excludedSkills = [...disabled]
    .filter((name) => availableByName.has(name))
    .map((name) => ({ name, reason: "已在本对话禁用，禁用优先于固定、自动推荐和本轮请求。" }));
  const capabilities = [];
  for (const skill of [...skills, ...proposedSkills]) {
    if (skill.capability && !capabilities.includes(skill.capability)) capabilities.push(skill.capability);
  }
  if (capabilities.includes("判断校准") && !capabilities.includes("风险与失败条件")) {
    capabilities.push("风险与失败条件");
  }
  const plannedPrefetchRoots = reasoningPlan.plannedPrefetchRoots;
  const readScopes = plannedPrefetchRoots;
  if (readScopes.includes("05_目标与项目") && !capabilities.includes("目标与项目检索")) {
    capabilities.push("目标与项目检索");
  }
  const executionPipeline = [
    {
      id: "semantic-understanding",
      label: "语义理解",
      status: "completed",
      selections: [semanticRoute ? "语义模型" : "本地安全理解"],
    },
    {
      id: "evidence-retrieval",
      label: "证据检索",
      status: "ready",
      selections: [],
    },
    {
      id: "agent-routing",
      label: "Agent 路由",
      status: "selected",
      selections: [catalogAgent(finalAgentId, agentCatalog).label],
    },
    {
      id: "skill-routing",
      label: "Skill 组合",
      status: "selected",
      selections: governingSkills.map((skill) => skill.label),
    },
    {
      id: "planning",
      label: "计划与执行准备",
      status: "ready",
      selections: reasoningPlan.operators.map((operator) => operator.label),
    },
    {
      id: "execution",
      label: "Agent 执行",
      status: "ready",
      selections: [],
    },
    {
      id: "quality-evaluation",
      label: "主回答质量验收",
      status: "ready",
      selections: [],
    },
    {
      id: "response-commit",
      label: "回答提交",
      status: "ready",
      selections: [],
    },
  ];

  return {
    semanticDecision: semanticRoute ? { ...semanticRoute } : null,
    routingSource: semanticRoute ? "semantic-model" : "local-intent",
    routingConfidence: semanticRoute?.confidence ?? recommendation.confidence ?? 0.5,
    routingReason: semanticRoute?.reason || recommendation.reason,
    routingRiskLevel: semanticRoute?.riskLevel || null,
    routingAudit: semanticRoute
      ? {
          candidates: (Array.isArray(semanticRoute.skillIds) ? semanticRoute.skillIds : [])
            .map((id) => ({ id, score: null, matched: [] })),
          rejected: [],
        }
      : {
          candidates: dynamicRouteAudit.candidates.map((item) => ({ ...item, matched: [...item.matched] })),
          rejected: dynamicRouteAudit.rejected
            .filter((item) => !allSelectedNames.includes(item.id))
            .map((item) => ({ ...item })),
        },
    cognitiveLensRouting,
    taskLevel,
    domains,
    crossDomain,
    archiveMode: knowledgeWorkflow !== "none",
    knowledgeWorkflow,
    executionSemantics: "single-agent-skill-composition",
    preferences,
    agent: { ...finalRecommendation, agentId: finalAgentId, label: catalogAgent(finalAgentId, agentCatalog).label },
    requiresAgentChoice: finalRecommendation.requiresChoice && !agentOverride,
    requiresSkillChoice: preferences.skillMode === "recommend" && proposedSkills.length > 0
      && oneTurnNames.length === 0,
    fixedSkills: fixedNames.map((name) => annotate(
      name,
      fixedGoverningNames.includes(name) ? "fixed" : "fixed-advisory",
      fixedGoverningNames.includes(name) ? "governing" : "advisory",
    )),
    proposedSkills,
    skills,
    governingSkills,
    governingRootIds: governingSeedNames,
    advisorySkills,
    primarySkill: governingSkills.find((skill) => skill.outputRole === "primary") || null,
    dependencyGraph,
    allowedToolIds: [...dependencyGraph.allowedToolIds],
    excludedSkills,
    capabilities,
    executionPipeline,
    reasoningPlan,
    plannedPrefetchRoots: authorizedReadScopes === undefined ? plannedPrefetchRoots
      : plannedPrefetchRoots.filter(scope => authorizedReadScopes.includes(scope)),
    readScopes: dependencyGraph.orderedSkillIds.length ? [...dependencyGraph.effectiveReadScopes]
      : authorizedReadScopes === undefined ? readScopes : readScopes.filter(scope => authorizedReadScopes.includes(scope)),
    permissionBoundary: { ...PERMISSION_BOUNDARY },
  };
}

function reconcileCoordinatedCapabilityPlan(plan, availableSkills, originalPlan = plan) {
  const retained = new Set((plan.skills || []).map(skill => skill.name));
  let skills = plan.skills || [], graph = plan.dependencyGraph;
  if (plan.coordinationTrace?.omittedSkills?.length) {
    const metadata = availableSkills.filter(skill => retained.has(skill.name)).map(skill => ({ ...skill,
      optionalDependencies: (skill.optionalDependencies || []).filter(value => retained.has(typeof value === "string" ? value : value?.id)),
    }));
    graph = resolveSkillGraph({ primarySkillId: skills.find(skill => skill.outputRole === "primary")?.name,
      requestedSkillIds: [...retained], skills: metadata, authorizedReadScopes: graph?.effectiveReadScopes });
    const byName = new Map(skills.map(skill => [skill.name, skill]));
    skills = graph.orderedSkillIds.map(id => byName.get(id));
  }
  const omitted = plan.coordinationTrace?.omittedSkills || [];
  const reason = [plan.agent?.reason, ...omitted.map(row => `未加载可选辅助 ${row.id}：${row.reason}`)].filter(Boolean).join(" ");
  const operators = (plan.reasoningPlan?.operators || []).filter(operator => !operator.resolvedSkill
    || retained.has(operator.resolvedSkill.skillId || operator.resolvedSkill.id));
  const removedCapabilities = new Set((originalPlan.skills || []).filter(skill => !retained.has(skill.name))
    .map(skill => skill.capability).filter(Boolean));
  for (const skill of skills) removedCapabilities.delete(skill.capability);
  return { ...plan, agent: { ...plan.agent, reason }, skills, governingSkills: skills,
    primarySkill: skills.find(skill => skill.outputRole === "primary") || null,
    dependencyGraph: graph, allowedToolIds: graph ? [...graph.allowedToolIds] : plan.allowedToolIds,
    readScopes: omitted.length && graph ? [...graph.effectiveReadScopes] : plan.readScopes,
    capabilities: (plan.capabilities || []).filter(value => !removedCapabilities.has(value)),
    reasoningPlan: { ...plan.reasoningPlan, operators, operatorIds: operators.map(operator => operator.id) },
    cognitiveLensRouting: plan.cognitiveLensRouting ? { ...plan.cognitiveLensRouting,
      selectedSkillIds: (plan.cognitiveLensRouting.selectedSkillIds || []).filter(id => retained.has(id)) } : plan.cognitiveLensRouting,
    executionPipeline: (plan.executionPipeline || []).map(stage => stage.id === "agent-routing"
      ? { ...stage, selections: [plan.agent.label] } : stage.id === "skill-routing"
        ? { ...stage, selections: skills.map(skill => skill.label) } : stage.id === "planning"
          ? { ...stage, selections: operators.map(operator => operator.label) } : stage),
  };
}

module.exports = {
  AGENT_MODES,
  PERMISSION_BOUNDARY,
  SKILL_DEFINITIONS,
  SKILL_MODES,
  TASK_LEVELS,
  bindTurnSkillSnapshots,
  buildTurnCapabilityPlan,
  reconcileCoordinatedCapabilityPlan,
  classifyTask,
  detectDomains,
  hasCrossDomainAuthorization,
  normalizeCapabilityPreferences,
  normalizeTurnSkillSnapshots,
  readScopesForText,
  recommendAgent,
  hasExplicitTrainingResponseIntent,
  resolveTrainingResponseModeActive,
  shouldAutoTriggerTrainingResponse,
  skillRuntimeSnapshots,
  trainingResponseModeAction,
};