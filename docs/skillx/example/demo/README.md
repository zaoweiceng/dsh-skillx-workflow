# Guide-only SkillX 包示例

按[原始草案](../../reference/specification.md)第 5、6、9、10 节展示最小包结构与推荐 header。本包不声明可执行接口，不能直接作为 DSH 原生能力安装或调用。

| 文件 | 定位 |
| --- | --- |
| `SKILL.md` | 指南及 frontmatter，含名称、描述、兼容说明、清单引用和包版本 |
| `skillx.yaml` | v1alpha1 清单；metadata 与指南一致，guide.entry 指向 SKILL.md |
| `schemas/` | 未来执行接口的输入输出设计材料，当前未绑定 |
| `executors/run.js` | 未接入的内部实现参考，不是标准 Runtime Profile 实现 |
| `tests/cases.json` | 设计样例，不代表运行验收已通过 |

license 未填写，因为示例未确定独立许可证；不要据此推断使用 Apache-2.0。包版本 1.0.0 不代表规范已经发布 v1。

原先的接口数组、mode、executor 等写法不属于原草案，已移除。要扩展为可执行包，需采用 interfaces 映射、defaultInterface 和受支持的 runtime 协议，并完整声明执行策略、能力依赖、权限和副作用。当前 DSH 插件的实际格式见[原生契约](../../contract.md)，不存在仅复制本目录就完成注册的机制。

本例的执行步骤描述内部意图，不能要求黑盒调用方重新逐项执行。工作流提取和优化仍由 DSH 原生 Agent 完成。
