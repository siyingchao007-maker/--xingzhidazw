---
type: manual
status: current
version: 1.0
updated: 2026-10-03
scope: 当前 Vault 中的 Codex CLI 与 Codex 桌面项目会话
---

# 行知 Codex 双模型开发闭环使用说明

这份说明只讲你每次怎么用。**不用输入启动 Explorer 或 Builder 的终端命令；在 Codex 对话里用普通中文告诉主代理要调用谁。**

## 先记住三句话

- 普通提问、讨论或只读了解：直接问主代理，不必启动子代理。
- 需要调查代码：让主代理调用 `explorer`，并说明“只读调查，不改文件”。
- 需要修改代码：先让 `explorer` 调查；主代理给出方案后，你确认，再让主代理调用 `builder` 实施。

主代理负责判断、定方案和验收。Explorer 只读。Builder 只按已确认方案改代码。不要把 Explorer 和 Builder 当成两个需要你分别打开的 Codex 主聊天。

## 第一次打开项目时

1. 在 Codex 桌面版打开本 Vault 文件夹，或在 PowerShell 中进入这个文件夹后启动 `codex`。
2. 如果 Codex 提示是否信任此项目，确认你打开的是行知商业版 Vault 后再信任它。项目级 `.codex/config.toml` 只会在受信任的项目中加载。
3. 配置刚改过时，新开一个 Codex 对话。CLI 中可以输入 `/status` 查看当前会话状态。

本项目设定的角色是：

| 角色 | 负责什么 | 模型与权限 |
|---|---|---|
| 主代理 | 理解任务、调查、判断和拆解方案、审查与验收 | GPT-5.6 Sol，xhigh |
| Explorer（`explorer`） | 只读调查文件、调用链、状态流、依赖和风险 | GPT-6 Luna，high，只读 |
| Builder（`builder`） | 按主代理确认的方案编码并验证 | GPT-6 Luna，xhigh，可写 |

## 用 Explorer 先调查

在 Codex 对话中复制下面这段，把方括号中的内容换成你的问题：

```text
请按项目根目录 AGENTS.md 工作。

我现在只想先弄清楚问题，暂时不要改代码。请主代理调用已注册的自定义子代理 `explorer`，对下面的问题做只读调查，并等待它完成：

[在这里写问题、报错或想了解的功能]

Explorer 不得修改文件。请它返回相关文件、调用链、状态流、依赖、潜在回归风险和目前还不能确认的事项，并标出证据位置。之后由你作为主代理整理调查结果和候选实施方案；先不要启动 Builder，等我确认。
```

Codex 返回调查结果和方案后，先阅读方案。需要调整时，直接指出要改的范围；认可后，再发下一段。

## 确认方案后让 Builder 实施

```text
我确认采用你刚才给出的方案：[可简写方案，或写“按你刚才列出的方案”]。

请主代理调用已注册的自定义子代理 `builder`，只按这个方案修改。不得擅自重构、扩大范围、无关格式化、新增依赖或修改数据结构。发现方案与实际代码冲突时，Builder 必须停止并向你报告，不得自行改方案。

完成后，Builder 检查项目适用的 build、typecheck、lint、tests 和 git diff，并报告实际运行结果；没有对应命令或当前目录不是 Git 仓库时也要说明。然后由你作为主代理独立审查实际修改、验证结果和 diff，再给我验收结论。
```

**你确认方案后，仍然由主代理调用 Builder。**你不需要打开 Builder 的独立聊天，也不需要手动改模型。

## 只想做一次完整闭环时

任务很清楚、影响范围较小时，可以在一条消息里要求 Codex 按顺序完成：

```text
请按项目根目录 AGENTS.md 完成这个任务：[任务]。

先调用 `explorer` 做只读调查并等待结果。主代理根据调查结果制定并确认一个范围明确的方案；如果涉及架构、数据结构、新增依赖，或方案与实际代码冲突，请先停下来向我汇报。其他情况下，主代理确认方案后再调用 `builder`，严格按方案实施。

Builder 完成后检查适用的 build、typecheck、lint、tests 和 git diff。最后由主代理独立审查实际修改和验证结果，再汇报是否验收。
```

## 查看子代理进度

- Codex 桌面版：在子代理活动区域查看任务；可打开子代理会话看详情。
- Codex CLI：输入 `/agent` 查看或切换已经启动的子代理会话。
- `/agent` 是查看或切换会话的入口，不是启动 Builder 或 Explorer 的命令。启动方式是在任务提示里直接说“调用 `explorer`”或“调用 `builder`”。

## 没有按预期运行时

1. **没有看到 Explorer 或 Builder 活动：**确认你明确写了“调用 `explorer`/`builder`”，并确认打开的是本 Vault 项目。
2. **模型或权限看起来不对：**确认项目已信任，并在配置更新后新开对话。CLI 用 `/status` 查看当前会话状态。
3. **Explorer 被要求写文件，或 Builder 自行改方案：**在对话里要求主代理按根目录 `AGENTS.md` 纠正流程；涉及范围或方案冲突时暂停 Builder。
4. **项目配置没有生效：**在 CLI 终端确认当前目录和配置文件的绝对路径：

   ```powershell
   Get-Location
   Resolve-Path .codex\config.toml
   ```

   这能区分 Vault 内的项目配置与用户目录下的全局配置。Codex 对当前 CLI 会话采用的实际配置，还受项目是否受信任和本轮权限设置影响。

## 本说明基于什么

- 项目规则：[[AGENTS]]。
- 项目配置：`.codex/config.toml`、`.codex/agents/explorer.toml`、`.codex/agents/builder.toml`。
- 本机检查记录：Codex CLI 0.160.0；TOML 语法及角色配置路径已检查，模型目录中能找到 GPT-5.6 Sol 与 GPT-6 Luna。**尚未用一次真实的子代理运行验证 Explorer/Builder 的完整交接。**
- 官方资料：[Codex 子代理](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。
- 已知限制：本机用户级全局配置的严格检查曾报告 `shell_environment_policy.startup_timeout_sec` 不受该 CLI 版本识别。若再次出现，先看报错指出的是全局文件还是本项目文件；不要因此自行更换本项目的模型或角色设置。

返回：[[00_智能体与技能-索引]]
