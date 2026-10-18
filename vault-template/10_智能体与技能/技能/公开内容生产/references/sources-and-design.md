# 设计来源与核验范围

版本：1.0.0。核验日期：2026-10-04。下列项目用于了解已有工作流和设计思路；本包指令、模板及工具独立编写，没有复制其风格库、脚本或素材。

| 项目 | 本次能看到的内容与借鉴方向 | 限制 |
| --- | --- | --- |
| [ziyetsui/wechat-article-skills](https://github.com/ziyetsui/wechat-article-skills) | README 描述风格选择、写作、排版与草稿流程；启发按需读取和分阶段交付 | 830 风格卡是项目自述；本包未导入或逐张审核，不据此声称爆款效果 |
| [daizhouchen/wechat-mp-writer](https://github.com/daizhouchen/wechat-mp-writer) | README 与入口页面可访问；启发证据记录、结构化中间产物和审稿 | 当前 README 自述 25 项量化检查，旧对话的 21 项已不能作为当前值；未运行其发布与审图功能 |
| [JamYang-cloud/wechat-article-writing](https://github.com/JamYang-cloud/wechat-article-writing) | 仓库页面可访问，主题为公众号写作 | 未执行行为测试，不作专业度排名 |
| [songlitong521-oss/gzh-content-skill](https://github.com/songlitong521-oss/gzh-content-skill) | 仓库页面描述风格库、排版与发布流程 | 未验证后台自动化和自学习效果 |
| [KKKKhazix/human-writing](https://github.com/KKKKhazix/human-writing) | README 页面可访问，关注中文创作与改稿的自然表达 | 本次尝试根目录 main 分支的 SKILL.md 地址返回 404；不能据此断言仓库没有入口，未假称完整读过其 Skill |
| [Jachinx-ai/writter-skills](https://github.com/Jachinx-ai/writter-skills) | README 描述从文章、访谈、播客等材料整理中文文章 | 未验证生成质量，未导入其实现 |
| [xcrrr/claude-skills](https://github.com/xcrrr/claude-skills) | 仓库主页可访问 | 旧预览提及的 social-media 具体子路径本次未核验，不把它写成本包依赖 |
| [bestagentkits 微博 Skill](https://github.com/bestagentkits/agency-skills/blob/main/skills/marketing/marketing-weibo-strategist/SKILL.md) | 入口可访问；启发短帖、长帖、话题及平台表达区分 | 算法权重、互动基准、热榜时窗等项目说法未独立核验，本包不采纳为事实或保证 |

## 本包的独立选择

- 采用“事实/自述/推断/价值/未知”与逐条主张映射，不以来源数量或总分伪装确定性。
- 不强制每个观点引用三条事实、不强制每段塞数字、不设万能爆款文章结构。
- 风格样本有作者原文/认可稿/模型草稿/第三方参考区分，防止模型自我强化。
- 编辑附件承载复杂证据账本，读者正文仍提供必要的可检查出处。
- 品牌配置可替换；行知是起始配置，不是通用流程的前提，也不是产品效果证据。
- 发布、图像与视频功能均按宿主实际能力交接，不把写下工作流等同于实现自动化。

## 本地规范与历史上下文

文件结构和入口规范依据本环境的 `skill-creator` 指令；视频接口按本环境的 `video-best-practices` 路由要求衔接。两者是设计参考，不是本包必须安装的运行依赖。

行知候选表达取向参考 2026-09-26 的历史品牌讨论，未在本次重新核验为最终定位。没有导入创始人的私人经历、未确认产品功能、客户数据或商业成绩。

旧对话中的星级排名、“最专业”“最值得拆”等判断不作为本次验证结果。公开仓库存在、README 描述能力、运行功能、真实质量和市场效果是不同的证据层级。

计数辅助工具的扩展 I 与兼容补充区参考 Unicode 官方的 [SIP 区间图](https://www.unicode.org/roadmaps/sip/) 和 [兼容表意文字补充区](https://unicode.org/charts/nameslist/c_2F800.html)。工具按代码列出的区间计数，不承诺覆盖所有新版本字符，不能替代平台字数统计。
