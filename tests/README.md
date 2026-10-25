# 自动化回归

保留七组核心测试，文件名按业务责任命名。小用例用于定位具体回归，不把多个不相干断言塞进一个“通过”指标。已移除只验证界面展示、工作区展示状态和模型选择配置细节的三组测试。

| 文件 | 验证目标 |
|---|---|
| [extraction.test.js](extraction.test.js) | 原生提取提交、草稿续写、取消、持久化后发布；不在提取阶段执行业务 |
| [extraction-contract.test.js](extraction-contract.test.js) | 证据要求、依赖责任、循环拒绝、预算估计与大输入 |
| [extraction-evidence.test.js](extraction-evidence.test.js) | 会话与工具配对、失败和终态保留、分页读取、不编造证据 |
| [execution.test.js](execution.test.js) | 宿主发现开关、JS/Python实际进程、参数字面量、超时/取消、输出契约、环境预检与恢复边界 |
| [capability-store.test.js](capability-store.test.js) | 按需发现、发布原子性、并发版本、固定依赖与资源迁移 |
| [revision-lifecycle.test.js](revision-lifecycle.test.js) | 回退与回收、依赖冲突、保留期、清理中断及重试 |
| [workflow-graph.test.js](workflow-graph.test.js) | 从程序生成嵌套、分叉/汇合图，动态部分不虚构顺序 |

## 运行

```sh
npm test
node --test tests/extraction.test.js
node --test tests/execution.test.js
```

依赖按仓库安装；真实进程用例需要 Node.js 和 Python 3。默认 PTC 边界由本地夹具提供，子进程真实运行；需要验证已安装 DSH 的 Node PTC 时指定其模块目录：

```sh
DSH_RUNTIME_MODULES=/path/to/dsh/node_modules node --test tests/execution.test.js
```

本地夹具不能证明真实模型自主提取、容器安装或恢复成功；这些结论使用 [实跑报告](../docs/tests/README.md)，不以单测结果替代。测试只使用临时目录和本机进程，不调用付费模型或创建真实远程 MR。

## 整理时的基线（2026-10-25）

整理前92项：72通过、20失败。删除9项展示与配置细节用例后83项：63通过、同样20项失败。核心用例只合并文件、调整名称，断言未放宽。已有失败集中于提取提交夹具、契约预期、能力加载和执行错误码；本次没有把测试整理扩展为框架修复。更新这些测试前应先确认当前公开契约和实际行为，不能直接删失败断言。
