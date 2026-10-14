# fresh v2：未启用 skillx / 启用 skillx 各3轮

| 条件 | 轮次 | 成功 | 前台秒 | 前台tokens | 模型调用 | 后台tokens |
|---|---:|---|---:|---:|---:|---:|
| 未启用 skillx | 1 | True | 75.594 | 235817 | 10 | 0 |
| 未启用 skillx | 2 | True | 66.044 | 230364 | 10 | 0 |
| 未启用 skillx | 3 | True | 82.111 | 266660 | 11 | 0 |
| 启用 skillx | 1 | True | 47.716 | 130996 | 6 | 0 |
| 启用 skillx | 2 | True | 52.228 | 134727 | 6 | 0 |
| 启用 skillx | 3 | True | 54.199 | 153209 | 7 | 0 |

| 指标 | 未启用 skillx | 启用 skillx | 均值变化 |
|---|---:|---:|---:|
| 平均 / 中位秒 | 74.583 / 75.594 | 51.381 / 52.228 | -31.11% |
| 平均 / 中位tokens | 244280.333 / 235817.000 | 139644.000 / 134727.000 | -42.83% |
| 平均 / 中位调用 | 10.333 / 10.000 | 6.333 / 6.000 | -38.71% |

成功率：未启用 skillx 3/3，启用 skillx 3/3。总tokens：732,841 对 418,932；模型调用：31 对 19。

条件：未启用 skillx 时仅禁用全部 fresh 能力，插件与工具定义保留；启用 skillx 时启用 fresh v2 及声明的 Skill 依赖。自动学习保持启用，但本次实际版本与后台情况以 trace 为准；没有人工修改业务或替代失败轮次。

所有会话与后台状态、原始prompt、模型headers、源码hash及实际version/hash见final-audit.json。前台tokens包含去重原生恢复；后台诊断/学习分列，不加到前台耗时。

最终审计：六轮独立验证全部通过，前后台 usage 与生命周期完整；六轮原始用户 prompt 的 SHA256 一致，最终权限均 danger-full-access / never。请求配置全部 deepseek-official / deepseek-v4-flash、high、maxTokens 256000；8 个源码 hash 均未变化。三次启用 skillx 实际均为 v2、同 execution hash 761ebf82…，每轮 21 次内部原生 dispatch 全部成功，没有内部 reasoning、前台恢复或后台诊断/学习费用。不是以 caller 工具调用次数代替内部工具审计。
