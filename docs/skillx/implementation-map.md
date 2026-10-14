# 原始规范与 DSH 实现映射

[原始草案](reference/specification.md)定义可移植包；[当前执行契约](contract.md)描述本插件实际支持的存储与运行接口。两者不能混称为同一种文件格式。

| 主题 | 原始规范 | 当前 DSH 插件 |
| --- | --- | --- |
| 状态 | 0.1.0-draft，`skillx.dev/v1alpha1` | 原生能力条目，不宣称完整草案兼容 |
| 包结构 | `SKILL.md` + `skillx.yaml`，可附 Schema、执行器 | 原生 Agent 提交候选，存储不可变版本；尚无通用包导入器 |
| Header | 必需 name、description；推荐 license、compatibility、metadata 引用 | 通过 Skill Provider 构造摘要及公开契约，不解析示例 header |
| 版本 | 包版本 SemVer；清单 apiVersion 是另一概念 | 能力整数版本及 revisionId，不能直接与包 SemVer 等同 |
| 接口 | interfaces 映射，direct / llm / agent，defaultInterface | `capability_run` + execution Schema/program |
| 实现入口 | runtime environment/protocol/entry 或 command | 宿主 PTC 中的异步 JavaScript 函数体 |
| 依赖 | 包能力声明、Host 绑定及版本解析 | capabilities.run 调用明确锁定版本的能力 |
| 模型 | 由接口类型及 Host Profile 约束 | 内部 reason、恢复和诊断继承调用方模型配置 |
| 权限 | 清单上限与 Host 授权取交集 | 继承 DSH 调用身份和权限；没有通用清单权限解析层 |
| 发现 | 摘要发现，Host 可按需加载 Guide | 调用方获取公开契约，不加载内部程序及依赖全文 |

## 包示例的定位

[示例](example/README.md)只声明 Guide-only：说明文件齐全不代表有可执行接口。目录中的 Schema、程序与测试数据保留为设计材料，不由清单绑定，也不能直接安装到当前插件。

要实现完整可移植执行包，需要先确定宿主支持的 Runtime Profile，再按草案声明接口、依赖、权限、副作用、重试和错误语义，并实现导入/校验映射。不能仅把 apiVersion 改成 v1，或把 JavaScript 函数路径写进自创 executor 字段，就宣称符合原始规范。

当前业务能力仍由 DSH 原生 Agent 根据证据提取和优化；文档示例不替代该过程。
