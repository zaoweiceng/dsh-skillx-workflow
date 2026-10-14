---
name: commit-local-changes
description: 检查当前仓库的本地变更，按输入的提交信息创建 Git commit，并返回 commit hash 和提交摘要。
compatibility: Guide-only SkillX package; no executable interface is declared.
metadata:
  skillx.manifest: skillx.yaml
  skillx.version: "1.0.0"
---

# 本地变更提交

## 适用场景

当用户已经完成文件修改，并明确要求把当前工作区变更提交为一个本地 Git commit 时使用。

## 输入

- `message`：Git commit message。
- `includeStatus`：是否在输出中返回提交前的 `git status --short` 摘要。

## 输出

- `commit`：提交后的 `HEAD` commit hash。
- `summary`：`git commit` 返回的提交摘要。
- `statusBefore`：可选。提交前的工作区状态摘要。

## 内部实现参考（不是调用方执行指令）

- 先读取 `git status --short`，确认有可提交变更。
- 执行 `git add -A` 后再执行 `git commit -m <message>`。
- 提交完成后读取 `git rev-parse HEAD`，把 commit hash 放入输出。
- 输出必须符合 `schemas/output.schema.json`。

## 副作用

该能力会修改当前仓库的 Git 历史，创建一个本地 commit。

## 不适用场景与失败处理

不用于 push、真实 MR 创建/合并，或未明确范围的批量提交。无变更、Git 命令失败或提交结果未知时，应停止并核实状态，不能盲目重试有副作用的操作。

## 工具与安全边界

实现需要宿主允许的 Git 工具和工作区访问。此包仅为 Guide-only，没有授予执行权限；正文不能扩大宿主授权。若能力以后以 DSH 原生契约发布，调用方应调用该能力并消费结果，而不是重复内部步骤。

## 示例输入

```json
{"message":"docs: update guide","includeStatus":true}
```

此输入仅说明预期契约，不表示本包已注册可执行接口。
