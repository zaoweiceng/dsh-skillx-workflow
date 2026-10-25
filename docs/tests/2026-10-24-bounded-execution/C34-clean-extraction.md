# 全新隔离提取与有界调用验证（C34）

结论：未通过。自动发现与调用有效；新提取的执行语义、故障验收和自主修复未达到要求。之前经过多轮修订的成功产物不能作为这轮从零提取成功的证明。

## 实验隔离及口径

全新 DSH_HOME、空能力库、工作目录、Docker 容器及输出目录；没有复制旧生成能力、历史修订会话或成功输出。仅复制原始 inputs/scripts/audit_pipeline.mjs（只调整 WORK/HERE 路径），挂载固定版本只读运行时。模型均为 TraeX GPT-5.5 medium，镜像与依赖版本同原始任务。原始执行新会话作为唯一提取来源。提取开始仅提交业务要求与三层嵌套/三并行结构要求；未提供具体函数或修复位置提示。没有人工编辑生成物、补写业务成功报告、回退原始整条程序或在试验中改框架代码。

执行上限沿用原始成功基准：203.051 秒 / 677,705 Token；观察器约每 0.5 秒轮询。以下是本次新 OFF/ON 各一轮，不是历史样本拼接。Token 包含输入、缓存读取、输出，开启侧包含关联原生修订会话；提取另列。停止时未结算的请求无法补算，表中为已结算值，不表示硬币数精确上限。

| 本轮 | 关闭耗时（停止墙钟） | 开启耗时（停止墙钟） | 关闭 Token（已结算） | 开启 Token（已结算） |
|---|---:|---:|---:|---:|
| 第 1 次 | 203.090 秒 | 203.413 秒 | 441,569 | 至少 610,171 |

关闭侧：原始业务已生成完整 passed 汇总、7 项故障验收通过；Agent 仍在收尾核验时触及时间上限，未完成会话。开启侧：4 次 capability_run，3 次已派发 capability_revise，包含原生修订成本；触及时间上限时仍未完成业务，也未生成新输出根最终报告。两侧均不得作为完整成功样本计算节省比例。开启侧已结算 Token 已高于关闭侧。

提取独立耗时 573.927 秒，2,003,678 Token，生成 5 个 SkillX、5 个 workflow；未计入上表。

## 实际验收

- 普通任务描述自动发现并调用：通过，未给出能力名。
- 实际调用 root → release → batch → dataset：4 层 workflow，含 Promise.all 分支调用；结构存在，但业务进程未成功，不能据此算复杂 DAG 验收通过。
- 成功并行汇合、局部恢复、CLI 并发安装与中断恢复、复杂库执行及最终归档：未通过。

## 根因

1. 原始 `dataset()` 在分支执行前创建目录；生成的 dataset workflow 将新 outputRoot 直接用作 cwd，没有创建目录。实际 dispatch 确实为 docker exec，所有 manifest 都是 docker。只读探针证明：同一容器同一 Node 可执行文件在已有 cwd 下成功，在缺失 cwd 下报 spawn ENOENT。因此不是已证实的执行目标丢失。详见 dispatch-proof.json、readonly-cwd-probe.json。
2. 根输入将 releaseInput、verificationInput 公开成 additionalProperties:true 的不透明对象，内部还要求 envRepair/moduleCheck/installer 等实现参数。调用方必须再读子能力契约。首次调用缺 prefix；自动组参失败和反复读取占用了执行预算。参数问题未根治。
3. 生成的 acceptance workflow 仅 4 行，运行 release、依赖安装、正常模块检查、单次 CLI 安装后按 passed 汇总；没有原始的故障注入、复用证据、损坏拒复用、实际并发安装和中断恢复。它即使正常检查全绿，也不能证明任务通过。
4. 底层只返回 ENOENT/可执行文件名，没有区分 cwd 不存在。执行 Agent 将其先后误判成 PATH 和容器目标丢失，修订已正确传递的 executionTarget，进一步耗费预算。不能把 Agent 当时的判断当成事实。

## 最小后续方向（本轮未实施）

先修提取结果对原始可执行语义的保存：初始化、目录准备、故障注入与恢复调用闭包不能在重写编排时丢失；已有源码归档/适配机制应真正保留这些原始行为。根能力只暴露业务输入，由编排自身组装内部子输入，避免要求调用者理解 envRepair 等实现参数。对进程启动失败补齐 cwd 与存在性诊断，使修复 Agent 能依据实际失败原因行动。不要靠运行时自动 mkdir、扩大预算或再人工修生成物掩盖问题。

本轮仅验证和只读诊断，没有改框架或生成物。专用服务和容器均已停止，原 3080/PID 46115 保持运行。

## 证据

- comparison.json：隔离条件、计费、验收结论与调用数量。
- raw-acceptance.json：关闭侧 7 项业务验收。
- extraction-start.json / extraction-status.json / extraction-cost.json：唯一提取提交、状态与成本。
- C34-RAW-1.budget.json / C34-ON-1.budget.json：停止时预算观察。
- on-final-measurements.json：主会话与关联修订会话计费。
- dispatch-proof.json / readonly-cwd-probe.json：Docker 派发和 cwd ENOENT 复现（仅只读探针）。
- stopped.png：预算停止后网页状态，显示连接中断；“运行中”是已停止服务的旧前端状态。

完整证据目录：~/.cache/skillx-clean-v34/evidence
