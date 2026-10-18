# Tool Contract

本目录描述 v2 运行时需要的副作用接口。

**它不是 Tool 实现。**

除两个 v1 配置已经明确引用的 runtime hook 外，本批次新定义的持久化 Tool 都标为：

```text
implementationStatus: contract-only
```

这意味着：

> 架构已经知道需要什么接口，但当前源包不能证明这些 API 已经存在。

## 源包明确存在的 runtime hook 名称

```text
xingzhi_search_knowledge
xingzhi_submit_knowledge_candidates
```

v2 canonical 分别映射：

```text
xingzhi-tool-search-knowledge
xingzhi-tool-submit-knowledge-candidate
```

## 新增 contract-only Tool

来自现有 Workflow 对持久化行为的要求：

```text
store raw conversation
write structured memory
upsert observation
write growth event
update continuity state
```

它们属于 v2 工程化接口，不声称已经实现。
