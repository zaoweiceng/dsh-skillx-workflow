# 文档索引

本目录说明 DSH SkillX 插件的概念、契约、运行方式和测试结果。文档口径统一使用“启用 skillx”，表示模型侧可以发现并调用插件发布的 SkillX 能力。

| 文档 | 适合谁看 | 内容 |
|---|---|---|
| [SkillX 介绍](skillx/README.md) | 能力开发者、插件维护者 | SkillX 是什么，和 Skill 的区别，为什么需要契约化能力 |
| [SkillX 编写约定](skillx/conventions.md) | 能力开发者 | 命名、边界、输入输出、权限、副作用和版本规则 |
| [SkillX 契约](skillx/contract.md) | 插件维护者 | 本插件支持的执行契约、Schema 子集和调用语义 |
| [SkillX 示例](skillx/example/README.md) | 新接入开发者 | 编写参考 demo 与实测能力 tested-v2 |
| [插件设计](design.md) | 插件维护者 | DSH Agent、存储、运行、恢复和前端的实现方式 |
| [运行机制](operation.md) | 使用者、维护者 | SkillX 如何被提取、启用、执行、恢复和优化 |
| [测试归档](tests/2026-10-14/README.md) | 评估者 | 启用 skillx 前后的耗时、Token 和模型调用对比 |

## 项目说明

- 插件运行在 DSH 内，使用 DSH 的 Agent、会话、工具、Skill Provider 和 PTC 运行时。
- SkillX 的实现正文、依赖和执行记录留在插件私有存储里；调用方只看到名称、说明、输入输出 Schema 和调用方式。
- 启用 skillx 后，同名能力优先于普通 Skill。未启用时，管理页面仍可查看和手动提取能力，但模型侧不可发现这些能力。
- 测试归档中的 JSON 字段保留原始实验条件名；面向读者的 Markdown 已统一展示为“启用 skillx”。

原始规范全文见 [SkillX 0.1.0-draft](skillx/reference/specification.md)；当前插件的实际可执行范围见[DSH 执行契约](skillx/contract.md)。
