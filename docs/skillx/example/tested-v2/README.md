# 实测 SkillX 与工作流示例

来自 2026-10-14 v2 六轮对照实验，由 DSH 原生 Agent 提取和优化。本目录逐字节保存两个实际能力的 JSON 修订及 Markdown，可通过归档摘要核对原始执行程序。

| 能力 | 类型 | 版本 | 原始修订 |
|---|---|---:|---|
| commit-local-changes | SkillX（存储 kind 为 skill） | 1 | 37efa295-d5fc-498a-808c-b258140c1fd2 |
| commit-and-simulate-mr-merge | 工作流 | 2 | 0df1f7af-fb80-4b83-bbe4-f5634809e650 |

## 文件与使用边界

- `catalog.json`：原始能力目录、开关和当前修订引用。
- `revisions/*.json`：完整原生修订，包含输入输出 Schema、执行程序、生成证据和验证说明。
- `revisions/*.md`：对应原始说明。
- `manifest.json`：导出来源和逐文件 SHA-256，可核对未改写。

快照用于核对能力定义与实验记录。实测环境包含 DSH 原生运行时、git/curl、隔离 Git 仓库及本地模拟托管服务，复现使用独立的数据目录和实验仓库。

工作流 v2 自身完成 commit、模拟创建及合并 MR、回读验证；两项能力的 `dependencies` 均为空。SkillX v1 是当时同时启用的配套能力，独立于工作流的依赖图。这里保留二者，以忠实呈现实验条件。

快照包含表中被测版本，生成会话 ID 和证据摘要用于追溯。

## 关联材料

- [六轮测试结果](../../../tests/git-delivery-baseline/deepseek.md)
- [当前原生调用契约](../../contract.md)
