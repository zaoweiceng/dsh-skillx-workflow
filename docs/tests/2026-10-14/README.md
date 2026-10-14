# 日常开发环境：启用 skillx v2 三轮对照（历史结果归档）

此目录保留 2026-10-14 已完成的原始测试结果，未重新运行、未覆盖或重算原始会话。环境归类为日常开发 DSH 实例；“安装在本机”与“模型实际可见”不等价。[实际 Skill 可见性审计](skill-visibility.md)确认：B1/B2/B3 每轮仅 1 项预装 Skill；W1/W2/W3 每轮为该 1 项加 2 项实验能力。不能仅凭日常环境标签推断大量预装 Skill 已进入模型上下文。

- DSH 3080，DeepSeek Flash / high / maxTokens 256000，完全权限。
- 相同隔离仓库与本地模拟服务，任务为本地 commit → 创建 MR → 合并 MR → 回读核验，无真实远端提交。
- B1/W1/B2/W2/B3/W3 六次原始尝试，各组成功率 3/3。
- 平均耗时：未启用 skillx 74.583 秒，启用 skillx v2 51.381 秒（减少 31.11%）。
- 平均会话 tokens：244,280.333 → 139,644（减少 42.83%）。
- 三次启用 skillx 均使用同一 v2，无恢复或后台学习调用；辅助标题用量未知，不计成 0。

原报告：[FINAL-AUDIT.md](FINAL-AUDIT.md)。机器可读比较：[comparison.json](comparison.json)；六轮独立验证及逐会话原始 prompt、权限、请求配置见 [final-audit.json](final-audit.json)。

本目录为历史结果归档，未复制 profile 配置、凭据或原生完整对话。新的无预装 Skill 实验独立存放，不与本组混账。
