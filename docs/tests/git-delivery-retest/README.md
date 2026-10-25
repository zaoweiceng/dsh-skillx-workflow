# Git 交付复测（2026-10-25）

沿用 [GitHub 已发布实验](https://github.com/zaoweiceng/dsh-skillx-workflow/blob/1f46be29aed7fe54090f8401396536760a0fbe31/docs/tests/2026-10-18/README.md) 的任务、Mock CLI 和原始 workflow（revision `6266b92e-6e6a-465b-bc71-a1bf4a21b4f2`）。GitHub 当前没有对应 PR，此处“MR”是实验生成的本地模拟交付物。

本次仅复测调用，不重新提取、不修改框架或生成物。旧定义迁入隔离副本的当前存储格式，执行程序逐字一致。普通任务描述未指定能力名。TraeX gpt-5.5 / medium；OFF → ON 串行各一轮；相同初始 HEAD、改动、业务参数，路径分别隔离。模型缓存未人工清除。

| 测试 | 关闭耗时 | 开启耗时 | 关闭 Token | 开启 Token |
|---|---:|---:|---:|---:|
| 本轮 | 73.431 秒，中止 | 17.410 秒，完成 | ≥256,157 | 70,615 |
| GitHub 旧实验均值（3轮） | 74.378 秒 | 16.742 秒 | 221,273 | 68,367 |

Token 为原生会话全程 inputTokens + cacheReadTokens + outputTokens，包含发现、读契约、调用、最终答复；提取成本排除。OFF 已结算 9 次请求，ON 完整 3 次。上限沿用旧第一轮原始任务 83.54 秒 / 249,861 Token。OFF 第9次结算后超额，由观察器停止；Token 按整次模型结算更新，不能在结算前精确截断，因此实际已结算超过上限 6,296 Token。73.431 秒按持久化预算停止记录时间减原生 turn/start 计算；中止前仍在执行最终汇报步骤，在途未结算 Token 未知。

**结论：当前开启组仍明显节省调用成本，但没有测出相对旧开启组的改善。** 本轮 ON 比历史 ON 均值耗时增加约4.0%、Token增加约3.3%，模型请求数仍为3。跨日期宿主、可用工具/技能上下文与模型服务均可能变化，且本轮只有一轮，不能据此认定框架发生等幅回退。OFF 中止，不能给出本轮两个完整成功任务的精确节省率，也不能把这行当作完整基线。

开启组自动发现 workflow，调用一次 capability_run；内部6次原生 bash，共0.775秒、0次内部模型请求。调用外没有补写业务产物或回退原程序。框架返回完整的 JSON Pointer 选择结果；验收器按公开返回格式读取 `/status`、`/includedFiles`、`/excludedPaths`，没有放宽业务检查。旧定义没有声明当前 businessOutcome，receipt 显示 unknown；独立验收依据实际 Git、CLI记录及业务结果判定。

ON 全部27项检查通过：单次提交只含 README.md、notes.md，保留 log/，主分支不变，推送到本地 bare origin，恰好创建一个模拟 MR，提交与 MR 正文逐字保留，CLI PATH 前缀正确，最终答复包含完整 SHA/MR URL/文件范围。OFF Git/MR 交付已经产生，但未完成最终答复且遗漏指定 PATH 前缀；不能判完整通过。旧实验 OFF 三轮也遗漏 PATH 前缀，这项质量限制仍然存在。

本次没有验证重新提取质量、三层嵌套或失败恢复；该原始 Git/MR 实验本身不包含这些场景。当前框架在复杂提取场景的变化不能由此推断。

结构化数据见 [comparison.json](comparison.json)。原生会话、fixture、校验记录仅保留在本机隔离目录 `~/.cache/skillx-mr-retest-20261025`，未复制私有会话进仓库。实验只操作新建本机仓库与 Mock CLI，不创建真实远程 MR，不改现有用户仓库和服务。
