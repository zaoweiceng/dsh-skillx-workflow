# 实际 Skill 可见性补充审计

审计对象是原始六会话的持久化 `user/message` 事件，`data.source.kind = skill-catalog`；不是通过本机目录数量推断模型上下文。逐会话路径、压缩日志 SHA256、JSONL 行号及 seq 见 [skill-visibility.json](skill-visibility.json)。所有日志均完整，每会话只出现一份 Skill 目录。

| 条件 | 三轮模型可见目录 | 三轮 skill 工具读取次数 |
|---|---|---|
| 未启用 skillx | 每轮仅 `dsh-remote-deploy`，1 项 | 0 / 0 / 0 |
| 启用 skillx v2 | 每轮 `commit-and-simulate-mr-merge`、`commit-local-changes`、`dsh-remote-deploy`，3 项 | 1 / 2 / 1 |

启用 skillx 组每轮均读取 SkillX 调用契约；W2 额外读取实验 Skill `commit-local-changes` 的调用契约。六轮没有读取 `dsh-remote-deploy` 全文。读取调用契约不代表执行内部实现文档加载。

因此可归档为“日常开发主机环境”，但**不能归因为大量预装 Skill 已进入模型上下文**：实际预装可见仅 1 项，其余 2 项是实验生成能力。

预装项来自 `dsh-remote` 插件运行时注册：当前安装的 `lib/web-deploy-skill.js:144` 调用 `skills.register`，`source: dsh-remote`；`lib/index.js:3680` 通过 `ctx.inject(['skills'])` 注册。排除 filesystem provider 并不能移除这个运行时来源。当前源码用于印证来源；历史可见性以持久化目录为准。

新“无预装 Skill”实验需保留 v2 和实验 Skill 本体及相同模型配置，隔离 filesystem 和运行时注册来源，并在每个新会话中核验实际注入目录：未启用 skillx 为 0 项，启用 skillx 只含上述 2 项实验能力；没有目录事件时还需检查全部注入消息未出现其他目录/全文，不能仅以配置文件作为证明。普通工具、仓库指令不计作 Skill。
