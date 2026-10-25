# 运行机制

本页说明 SkillX 在插件中怎样被提取、启用、执行和优化。是否减少耗时和 Token，需要与同任务原始执行比较，不能由提取成功或 DAG 层数推断。

## 开发者使用路径

```text
完成一次代表性任务
→ 从会话菜单发起 SkillX 提取
→ 等待提取 Agent 生成候选
→ 在 SkillX 页面查看能力
→ 按需启用或停用
→ 后续任务由模型发现并调用 SkillX
→ 用新的执行会话优化能力
```

首次任务仍由 Agent 正常探索。只有当任务结构稳定、执行证据完整时，才适合提取为 SkillX。

## 证据怎样被提取

插件从 DSH 会话事件提取证据，包括：

| 证据 | 用途 |
|---|---|
| 用户消息和助手回复 | 还原任务目标、输入来源和输出要求 |
| 工具调用和结果 | 还原实际操作、参数、状态和失败点 |
| 未完成调用 | 判断中断或异常边界 |
| step 事件和用量 | 比较耗时、模型调用和 Token |
| turn 结束原因 | 判断会话是否完整完成 |
| 模型请求配置 | 保留来源模型作为证据元信息 |

提取 Agent 从历史证据总结可复用输入、必要工具、验证条件和失败边界。

证据保存在插件 `jobs/<任务 ID>.source-<序号>.jsonl`，每阶段提示词提供文件描述、摘要哈希，以及累计最多 32 KiB 的完整短记录，优先提供计划引用的记录；其余证据通过受限工具读取。Agent 通过受限的 `read_native_execution` 工具读取这些固定文件：先分页查看索引或按字面关键词搜索，再读取相关记录；大记录可按字符范围读取局部片段，完整详情则支持分片。预览和局部片段带有完整性标记。工具根据来源会话和记录编号读取冻结文件。

`sourceFiles` 也保留 Bash 命令引用的工作区脚本，附 `commandReferences`；独立 `.mjs` 同时提供函数和常量接口。仅解析 Node/Python 调用路径及字面量标量变量，不执行 Shell，引用不等于命令成功证明。这样可定位在 Bash 内复制和配置的真实入口，避免与仅被阅读的辅助脚本混淆。单候选 `programEdits` 可同时提交顶层 `resourceSources`，复用同一源码捕获/函数适配机制，保留原资源，无需重发整个能力契约。

源码定位支持工作区相对路径以及分号分隔的字面量变量赋值。函数接口包含原始调用位置、参数表达式及 CLI 公共环境覆盖项，避免只复制子脚本而遗漏父调用的执行条件。`esm-functions-v2` 的 `bindings` 是可选配置覆盖：未传值时保留原初始化表达式及其推导关系；只有函数本身的非默认参数必填。返回 void 的准备函数以 JSON `null` 完成，保留原副作用，不必重新编写目录准备等逻辑。已有资源不自动重编译，升级需重新提取。

构建时补齐直接透传对象的子输入契约，检查可静态确定的返回字段、原 CLI 环境覆盖项，以及组合子能力后重放原始完整入口的情况。`BUILD_CONTRACT` 的 `OUTPUT_CONTRACT` / `SOURCE_INVOCATION_ENV` 指向缺失返回字段或调用环境；`SOURCE_ENTRY_REPLAY` 要求直接汇合子结果并独立完成归档。动态表达式仍需实跑，静态通过不等于行为通过。容器进程的缺失工作目录诊断包含 `PROCESS_CWD_UNAVAILABLE` 和实际 `cwd`，不会自动建目录；编排捕获脚本错误时保留简短原始诊断。实跑及所有失败成本见 [复杂工作流自主提取验收](tests/complex-workflow-acceptance/README.md)。

构建同时检查 `.mjs` 资源的模块语法，并汇总没有本地绑定的 `require()` 错误，不能只检查编排入口。该检查不执行资源，不替代真实验收。资源 JSON 协议执行失败时，宿主在进程退出错误被转换前保留脚本错误码；调用方的 `originalFailure.diagnostic` 包含资源路径及至多 500 字符的简短诊断。可确认的缺包错误归外部依赖，路径类缺失保留未知，脚本程序错误归内部实现；不会因此自动重跑业务。

单来源与多来源均按职责选择相关证据，保存来源摘要及完整读取的记录编号。规划引用实际记录，构建必须读取引用及末尾结果；依赖在规划和构建间锁定版本。发布检查结构及来源引用，不执行业务或验收模拟。JSONL 不设固定文件字节上限；较大的证据按相关范围分页读取，磁盘或宿主实际故障仍会明确报错。

提取按可复用职责拆分：单个 SkillX 负责一个具有明确输入输出的操作，变化的端口、路径和服务名作为参数；Workflow 组合这些能力和必要判断，并锁定依赖版本。例如端口定位进程、启动日志冲突诊断可作为独立职责，服务诊断则组合它们。能力粒度由独立复用价值决定。

## SkillX 怎样运转

启用 skillx 后，模型侧流程变短：

```text
发现能力名称和说明
→ 读取输入输出契约
→ 准备 JSON 输入
→ 调用 capability_run
→ 使用输出和回执
```

插件内部流程保持完整：

```text
加载能力版本
→ 加载依赖闭包
→ 校验输入
→ 运行执行程序
→ 调用工具或依赖能力
→ 记录事件
→ 校验输出
→ 返回结果
```

外层模型读取根能力的公开契约并调用 `capability_run`，执行程序负责解析依赖和消费中间工具结果。结果字段需要补充核验时，调用方将必要的只读检查合并为一次工具调用。这个分工是效率提升的主要来源。

普通任务的原生工具定义会直接展示可执行根能力的用途、输入契约、兼容前提和输出 Schema；模型可以按任务选择并调用 `capability_run`，不要求用户指定能力名。已被其他能力引用的依赖保持渐进加载，不向调用者展开整条依赖链。当前根契约合计超过 16 KiB 时仍使用原有发现流程，避免每轮请求都携带一个庞大目录；此限制只控制工具呈现，不限制提取、发布和执行。历史快照使用独立的通用输入分支。执行仍通过既有版本、输入及权限检查。

模型侧 Schema 省去 UI 的 title 和 examples；没有 description 时将 title 保留为说明。类型、必填、枚举、默认注释和业务约束描述均保留，存储 Schema 和 UI 不变。依赖探测命令不属于普通调用接口。调用方不需要读取实现。

可用 `capability_run.select` 提供所需业务字段的 JSON Pointer 列表。完整结果先按原 Schema 校验并留存，返回的 output 是指针到值的映射，delivery.scope=selection。complete 只描述所选视图是否完整，missingPointers 明确列出原始结果中不存在的字段；业务成功与否仍由 receipt.businessOutcome 表达。后续 result_read 始终读取原始完整结果；也可在一次读取中使用 select 取得多个所需字段，不能与旧分页参数混用。未提供 select 时保持既有返回行为。

这些机制减少重复发现和无关结果传输，不保证优于一个调用方已经知道完整用法的现成 CLI 命令。参数组织、结果大小和业务失败仍会影响总成本；失败样本不能从性能报告中删除。

## 执行程序怎样使用工具

执行程序可以调用 DSH 工具，例如 shell、文件、浏览器或其他已注册工具。调用经过宿主：

- 保留原 Agent、root call 和 execution token。
- 使用当前会话的沙箱策略。
- 工具调用事件写入执行记录。
- 失败会被记录为内部问题、外部阻塞或未知问题。

执行程序也可以调用声明过版本锁的其他 SkillX。这样可以把大任务拆成几个稳定能力，但外层模型仍只看到当前能力的公开契约。

## 恢复怎样工作

普通对话中的 `capability_run` 执行已发布程序，不启动 Agent 代行业务或补写成功结果。业务恢复由 workflow 自身实现。输入错误返回精确 Schema 问题；并行依赖异常保留各自的能力身份，避免同码异常覆盖而修错节点。

实现缺陷可通过 `capability_revise` 明确修订：只读作者读取本次证据、修改并发布能力，随后调用方重新调用。修订接口不执行业务，失败调用及修订开销均计入执行成本。工作台的手动诊断入口独立保留。

## 为什么启用 skillx 更快

效率提升来自少做重复工作：

| 成本来源 | 未启用 skillx | 启用 skillx |
|---|---|---|
| 能力理解 | 模型读取 Skill 说明和上下文，自行判断步骤 | 模型只读契约 |
| 计划生成 | 每轮重新规划工具顺序和参数 | 已提取步骤在执行程序里固定 |
| 中间状态解释 | 每个工具结果都回到模型上下文继续推理 | 程序内部消费工具结果 |
| 失败定位 | 调用方继续排查 | 插件保留执行记录并分类恢复 |
| 版本复用 | 依赖聊天记录和临时判断 | 依赖不可变版本和回执 |

## 提取与保存

手动执行与 DSH 对话有独立生命周期。能力详情和执行记录列表的“查看原始记录”在弹窗内分页展示调用参数、结果与失败原因，并关联恢复诊断。所有对话入口先刷新持久化会话目录；跳转失败显示明确错误。人工执行触发的恢复及后台诊断使用“提取模型”中的显式模型配置，普通对话中的恢复沿用调用方模型。恢复结束状态与关联会话同步保存在原执行回执和事件中。

提取仅有职责规划和构建两个阶段，优化仅构建。各阶段使用“提取模型”中保存的模型；不运行候选程序和业务操作，不为提取额外执行业务验收。来源流程本身包含的验证和恢复逻辑仍应保留。已有配置 `contractReview` 不再启用验收阶段。

宿主仅检查 JSON Schema、适用时的 JavaScript 语法、依赖版本与字面调用、证据引用、兼容性声明及错误指引路径。这些是保存格式检查，不能证明业务行为正确。成功完成的候选按批次原子发布；没有独立复用价值时可以跳过。

生成前会提供 [DSH 支持的 JSON Schema 子集](skillx/contract.md#dsh-支持的-json-schema-子集)，提交工具和协议查询使用同一说明。提交时一次汇总所有候选的输入、输出 Schema 问题，避免逐轮发现已存在的限制。

每个候选按职责说明独立消费结果、输入变量及必要依赖。叶节点提取为 SkillX，有能力依赖的节点由宿主标为 workflow；流程通过固定版本依赖编排，不规定产物数量。来源必须包括用户目标、相关操作及最终结果，失败尝试不能替代最终成功机制。优先保留来源中的 CLI/库调用，不为提取重写协议、压缩或编码算法。

提取界面可填写复用目的；API 的可选 `intent` 字段将当前用户目的传入规划、构建及恢复任务，历史来源不替代当前请求。界面不再要求填写节点数量。

规划阶段读取用户目标、相关操作与最终结果，确定每个候选的公开输入、输出 Schema、职责和依赖。输入、输出 Schema 直接进入构建草稿，构建阶段可依据真实源实现修订，不再从职责摘要重新创建一份接口。构建读取规划引用的证据，不重复强制读取整段历史的所有终端结果。

提取各阶段使用原生 Agent 连续对话，不在每一步用宿主拼装数据替换历史，也不强制开启新的模型请求序列。原生工具调用、源代码读取、分页回执及草稿编辑均保留在连续上下文里。分片游标不匹配时仍返回精确的 `nextRead` 参数。

不再要求 `completionCoverage`、`lessonCoverage` 引用当前能力自身的代码片段来证明完整流程，也不把 `Promise.all` 字面调用数量当作业务并行证明。委托依赖的工作由依赖承担；实际业务覆盖、参数传递、并行与恢复均以真实执行验收。依赖声明仍须与真实调用一致，Schema、语法、版本及引用格式检查不变。

程序执行状态与业务结果分开保存、展示和统计。`receipt.status` 表示程序状态，`receipt.businessOutcome` 按能力显式声明的 `execution.outcome` 映射判定。部分完成和阻塞不计业务成功；未声明结果映射的历史版本标为未知，不猜测其任意输出字段含义。

保留一份简洁实现，声明 macOS、Linux、原生 Windows 的支持范围与前提；无法兼容时注明，不额外生成 Windows 流程脚本。

## 提取草稿与预算

### 保存与局部修复

规划和实现草稿保存于 `jobs/<taskId>.<phase>-working-draft.json`，诊断保存于 `jobs/<taskId>.diagnostics.json`。`read_native_draft` 按候选和 JSON pointer 读取字段；同阶段重复读取返回引用。使用当前 `draftDigest` 加 `draftEdits` 或精确 `programEdits` 修复结构问题，摘要过期则拒绝。相同草稿重复出现相同诊断时停止并保留草稿；累计提交次数仅作估计，不强制中止有进展的修复。

生成异常另存于仅本地可读的 `jobs/<taskId>.failure.json`，包含失败阶段、会话 ID 和原始异常。Agent 初始化失败时可能尚无可查看的提取对话，应查此文件；原始异常不返回前端。

工具入参由 DSH 保持只读，插件复制后才修改候选或捕获资源。插件编程错误和文件系统异常以 `GENERATION_INTERNAL_ERROR` 停止并保存诊断，不交给模型改稿，不计入模型提交修复次数。模型提交问题仍受总次数与同一问题重复次数限制；已解决的诊断项计为进展，重新出现的问题仍受重复上限约束。

`repairTargets` / `savedDraft` 是展示投影，其中 `resourceManifest` 和 `path` 是只读派生字段，不是可编辑的候选字段。删除或替换前通过 `read_native_draft` 的候选名与 JSON pointer 确认真实字段；不要用空 `resources` 绕过插件异常。

向提取接口提交 `resumeTaskId` 复用已保存规划和实现；规划尚未通过时，也可以恢复摘要一致的未验证规划草稿，重新读取来源并通过全部校验。宿主核对来源摘要及依赖锁。历史验收资料不再读取。`validateOnly:true` 仅执行静态提交检查并保存回执，不发布，不运行候选程序。

旧提取策略保存的规划不能绕过 `bounded-results-v3` 的证据与问题解决审查继续发布；此类提取需重新规划。已有优化草稿仍按当前规则校验后恢复。

### 随版本保存的脚本资源

提取出的辅助脚本与静态文本依赖属于 SkillX 内部资源，不作为调用方必须查找的路径输入。构建者通过 `resourceSources:{"scripts/helper.py":"来源记录中的确切路径"}` 声明依赖，宿主直接复制 UTF-8 文件，避免模型重写脚本或 Base64 编码。新编写资源可提交 `resources:{"scripts/helper.py":"UTF-8 正文"}`。依赖的本地脚本、相对导入及静态数据应一并保存；运行期秘密和 `.env` 不打包。

每个修订将资源正文及摘要保存在修订记录，并将文件写到 `revisions/<revisionId>/scripts/` 或 `assets/`。执行程序通过 `await resources.path("scripts/helper.py")` 获得当前修订的内部绝对路径，再交给已声明的解释器和原生工具。也可用 `resources.run({path, input})` 直接执行内部 Node/Python 脚本，或用 `processes.run({executable, args})` 通过原生进程接口执行明确的解释器与参数数组，不增加 Bash 包装。文本资源只读，不按可执行文件安装。路径由宿主跨平台解析，不使用源机器的绝对路径；搬迁数据目录不改变资源绑定。正常调用的公开契约不加载脚本正文。

资源提交仅检查路径、UTF-8、体积、字面资源引用和摘要，不执行脚本。拒绝路径逃逸、Windows 保留名和仅大小写不同的资源名。原生 Windows 等系统是否可运行，仍取决于该能力的解释器、工具及兼容性声明；不为了覆盖系统另写流程。资源随修订一起保留与清理。旧版本可通过带独立迁移来源记录的资源迁移修复，保留原始生成证据与输出约定，不冒充新生成或业务验收。

未知配置、变量名、工具位置或依赖来源通过 `ask_user_question` 向用户询问，不猜测、不扫描目录或寻找凭据；无法提问时明确报告缺失信息。已明确提供的业务目录和配置文件可以按约定访问。失败恢复通过 `read_recovery_resource` 定位当前修订及已锁定依赖的内部资源，不把查找脚本的工作交给调用方。

### 执行失败后的内部恢复与维护

正常调用直接执行程序，调用方只提交输入并消费约定输出。正常程序不调用推理 Agent。执行失败后，插件在同次调用内创建恢复子 Agent，读取失败证据与该版本的专属错误指引，检查现场后继续未完成步骤，避免重放已经完成或状态未知的副作用。子 Agent 通过 `submit_recovery` 提交真实输出；宿主校验原输出 Schema，通过后才对调用方返回完成。权限、凭据或预算等无法解除的阻塞必须如实返回，不能伪造成功。

每个提取出的 SkillX / workflow 在自身修订下拥有 `docs/troubleshooting.md`（可按错误主题拆分），物理位置为 `revisions/<revisionId>/docs/`。内容说明该能力的错误症状、原因、诊断、修复方法、续跑边界及输出要求；事实和推测分开。指引随不可变版本保存，正常调用不向模型加载全文，失败时才提供根能力和失败依赖的指引。

恢复任务完成后，另一个独立诊断子 Agent 分析原失败与恢复记录。偶发故障或证据不足只记录诊断，不修改能力；有依据的持续性实现缺陷才形成最小修复方案并启动优化 Agent，保留原输入输出约定及兼容范围。后台维护不重复业务任务，也不阻塞已经完成的调用。缺陷位于失败依赖时可指定该依赖为修复目标，保持契约的修复与上层版本锁更新在同一目录事务中发布。定义修复仍只做静态保存检查，不重新执行线上流程。

### 预算估算

提取按规划、构建串行执行，各阶段共享工作估计；初始时间估计根据来源记录数和字节数计算：

```text
units = max(1, ceil(records / recordsPerBudgetUnit), ceil(bytes / bytesPerBudgetUnit))
estimatedTimeMs = min(totalTimeoutMs, maxTimeoutMs, timeoutMs * units)
```

| 配置 | 默认值与作用 |
|---|---|
| `totalTimeoutMs` | 初始总时间估计 10 分钟，不是截止时间 |
| `timeoutMs` | 每证据单位 10 分钟，用于计算初始估计 |
| `maxTimeoutMs` | 初始时间估计上限 15 分钟 |
| `recordsPerBudgetUnit` / `bytesPerBudgetUnit` | 100 条 / 262,144 字节 |
| `maxSteps` / `maxTotalSteps` | 每阶段 16 步 / 全程 40 步工作估计 |
| `maxTotalTokens` | 初始全程估计 400,000，含缓存读取 |
| `maxOutputTokens` | 全程输出工作估计 64,000 |
| `maxRequestOutputTokens` | 单次请求输出额度 12,000 Token，传给宿主模型配置，实际用量由宿主回报 |
| `maxRepairAttempts` / `maxRepeatedFailures` | 修复上限按候选数量确定 / 同一问题停滞 2 次；达到阈值停止并保留草稿 |

提取不按总字节数、耗时或 Token 强制终止。计划、程序、Schema、资源、草稿及证据取消原有固定字节门槛，职责/完成条件等说明文本也不再因字符数被拒绝；单次交付分页保留全部内容。旧预算配置继续接受并作为成本估计；任务记录 `estimatedFinishAt`，不设置 `deadlineAt`。单次模型输出限制由供应商/配置决定，触及 `max-tokens` 后自动继续，直至提交、用户取消或真实失败。超过一次响应容量的计划/程序可先用 `draftOnly:true` 保存未完成草稿，再通过 `draftDigest/draftEdits` 分多次组装；不带 `draftOnly` 的最终提交才进行全部校验并允许发布，未完成草稿不算提取成功；重复无效结构的停滞保护仍保留。能力执行的进程超时和权限规则不受此变更影响。

提取模型配置见[提取与保存](#提取与保存)。每次请求前，宿主估算输入大小、预留工具 Schema 和单次输出额度，记录剩余额度与预计用量；预计用量超过当前估计时更新估计并继续提取。用户取消、宿主失败和真实模型错误仍正常终止。`GET /skillx-workflow/api/runtime` 可核对实际加载的预算策略。

`GET /skillx-workflow/api/extraction-model` 返回当前提取配置和 DSH 模型目录；向同一路径 `POST` 提交 `provider`、`model`、`reasoningEffort` 保存配置。宿主校验模型和推理档位是否匹配。

## 执行入口与权限

会话内调用 `capability_run` 使用当前调用 Agent 的工作目录和权限。工作台详情页根据输入契约生成表单，锁定所选修订执行，并用幂等键防止网络重试造成重复执行。

工作台直接执行已发布程序，使用宿主进程已有的操作系统权限，未指定工作目录时采用宿主进程工作目录。纯程序使用原生执行上下文，正常执行不创建模型会话；失败时才启动内部恢复子 Agent，在执行记录中提供入口。对话内调用继续遵守当前对话权限。

执行记录可查看参数、结果和关联会话。“执行已完成”表示执行流程结束，业务是否成功还须查看输出中的结果状态。

打开提取对话前刷新 DSH 会话目录。生成阶段释放后，其实时目录项会被移除，但历史仍已持久化；刷新后再导航可打开已结束的阶段，也适用于重启前的提取记录。

新提取和优化的能力必须声明 `compatibility`：`platforms` 使用 `darwin`、`linux`、`win32`，`requirements` 列出运行依赖，`limitations` 说明不支持的系统及实机验证限制。优先采用通用工具和参数化路径，保持一份紧凑实现；不为 Windows 等系统另写一套流程或复制脚本。无法通用时明确限制，不能默认原生 Windows 具有 Bash、WSL 或 Git Bash。使用 Bash 工具的实现不能声明原生 Windows 支持。详情页和原生 skill 契约均展示声明；执行前检查根能力及完整依赖的系统范围，不支持时直接返回原因，不触发自动修复。旧版本缺少声明时显示“尚未声明”，不追认跨平台兼容性。静态检查不等同于 Windows/Linux 实机验证。

## 删除能力

SkillX 和工作流的列表、详情页均提供删除入口。存在其他现存能力依赖时，删除失败并显示引用者；停用的引用者也参与检查。应先删除引用者或通过优化移除依赖。

删除将当前能力及其历史版本移入回收站，执行记录仍保留。已经开始的执行继续使用所加载的依赖快照，新执行从当前目录加载能力。发布与删除核对不可变修订 ID，绑定操作对应的条目版本。

## 执行证据与优化反馈

执行记录独立位于监控面板后的“执行记录”选项卡。学习任务可打开当前生成阶段的 DSH 会话；已发布能力可追溯构建会话。运行数据保存在 profile 的插件数据目录中：

- `jobs/`：任务状态、来源 JSONL、职责计划、实现草稿和静态提交回执（旧任务验收资料仅历史保留）。
- `executions/`：执行头信息、逐步事件和最终回执。

多来源提取与优化以 `sessionIds` 的首个来源作为主来源，记录其原始模型元信息；后续来源可以是纯工具执行会话。各来源的机器执行结果用于证据核验，提取模型由 SkillX 面板配置，当前调用上下文提供权限。

优化 API 的 `reviewFindings` 可提供最多八项审查意见。模型将其作为诊断假设，对照证据核实。只读生成阶段提交非法 JSON 时，符合完整捕获等条件的提交允许原模型在当前生成任务内做一次格式修复；该修复的触发条件是宿主已完整捕获并确认提交 JSON 解析失败。

后台修复须保持输入输出 Schema 原样，修复方案及证据传给独立优化 Agent。没有明确缺陷时复用原版本，不为偶发故障发布新版本。

### 当前版本与历史目录

`skillx/<name>/`、`workflow/<name>/` 仅展示当前版本，包含短说明 `SKILL.md`、机器契约 `manifest.json`、单一 `entry.js` 或 `entry.py`，以及自身 scripts/assets/docs。历史文件保存在平级 `revisions/<revisionId>/`，私有 `.record.json` 保持旧记录和执行契约。最新目录是可读视图，执行仍解析不可变快照；手改视图不会替代正式发布。启动自动迁移旧版散列修订文件，镜像失败显示 `layoutWarning`。Python 入口采用完整 JSON stdin/stdout 程序，JS 入口采用宿主 async function body，详见执行契约。

### 历史快照、回退与回收站

“提取模型”之后依次为“历史快照”“回收站”。历史首页按 SkillX / workflow 能力归组，显示名称、类型与用途，点击后才展示版本列表。快照打开复用正常参数表单及执行记录，传入明确的 snapshotRevisionId，完整加载该修订及其精确依赖；不切换当前版本。旧快照无执行契约时只展示说明，不对历史版本发起接口生成。

回退携带列表加载时的当前修订 ID，避免覆盖并发更新。宿主投影目标及其必要依赖后，先检查所有当前能力的依赖约束；冲突则整次拒绝。成功后当前目录切到选中版本，相关能力的较新快照统一移入回收站。能力目录与回收状态保存在 catalog.json 的 snapshot-catalog-v1 封装内，一次原子替换，文件快照保持不可变。版本序号持续递增，回退不重用旧版本号。

历史版本不再因被替换而到期。删除将该能力的全部版本移入回收站，仍拒绝删除被当前能力引用的条目。回收站在同一行展示创建时间、移入时间、删除倒计时与恢复按钮（窄屏自动换行）。倒计时按距离清理期限的剩余天数向上取整，最低为 0，并每分钟更新。启动及每小时自动清理。仍被历史或尚在保留期内的回收项依赖的版本延后清理，界面显示引用方；实际完成物理清理后保留含 purgedAt 的精简记录，不保留实现内容。

恢复会一并恢复所需的依赖文件。已有同名当前版本时恢复到历史；没有当前版本且依赖约束允许时重新进入正常列表，否则仅恢复到历史。恢复不执行任何业务操作。旧 catalog 自动兼容，仍在磁盘上的旧历史保留，已删除能力的旧修订迁入回收站并沿用原计时。

### Bounded result delivery (bounded-results-v3)

Full output is validated and retained in the execution record before delivery. The ordinary caller receives at most 16 KiB of output; `delivery.complete=false` explicitly marks a mechanical preview, which is not a complete outputSchema instance or business analysis. Authors must still default to concise semantic summaries with decisive evidence, coverage and per-target failures. Business outcome is computed from the full validated value. Output size no longer fails a completed query or triggers model recovery.

`capability_result_read({runId,pointer,offset,limit})` reads an existing result in the same DSH conversation. The pointer is a JSON Pointer; offsets count UTF-16 units in that value's JSON text. Limit is 1..4000 (default 4000); follow nextOffset. Fragments are not independently parseable JSON. Reading does not execute business operations or grant cross-session/workbench access. References share the execution record retention lifetime; missing references never automatically replay a query.

Public parameter descriptions must state mandatory bounds, units, paired-field conditions, defaults and precedence accurately. DSH's Schema subset does not support minimum/maximum: enforce those in the program and describe them as hard requirements, not recommendations. Failed recovery preserves the original error code/category/stage and reports recovery separately. New extraction policy is bounded-results-v3; older plans require a fresh review.

Retained observations are also available when a program deliberately omits bulk detail from its final output: `delivery.observations` points to `capability_result_read({runId,stepId:"index"})`. Select a listed stepId to read that successful native observation. For a tool that returns JSON as a string, explicitly select `jsonTextPointer` (for example `/stdout/text`), then apply `pointer` to the decoded JSON. This reads retained data, does not call a tool again, and does not claim truncated native stdout was complete. Historical failures caused solely by OUTPUT_SIZE_LIMIT can read their already-validated saved implementation output through the same session-bound tool.



## 进程稳定性回归（0.2.2）

`npm test` 覆盖原有条目、进程失败记录、失败观察读取、恢复证据过滤、严格进程调用、资源脚本和可选环境预检。专项用例启动真实 Node/Python 子进程；默认的 PTC 求值仍使用测试夹具。

要连同已安装 DSH 的真正 PTC 进程和 subprocess provider 一起验证，指定其 node_modules 目录：

```sh
DSH_RUNTIME_MODULES=/path/to/dsh/node_modules node --test tests/execution.test.js
```

该命令使用安装目录中的官方 `dsh-ptc-runtime-node` 与 `dsh-subprocess-local`，通过公开运行接口执行，不启动模型、不修改 DSH 配置。Python 不叫 `python3` 时通过 `SKILLX_TEST_PYTHON` 指定。测试在临时目录运行并清理；包含中文、空格、字面 shell 元字符、真实超时/取消、stderr 截断、非 JSON 输出以及依赖预检阻断。真实平台覆盖以验收记录为准，不能据此推断所有操作系统已通过。

### 提取协议与自动流程图

提取协议 `draft-plan-v2`：新计划只需在 `responsibilities` 的 `capability` 条目声明依赖，宿主派生省略的 `dependsOn`。旧显式 `dependsOn` 继续接受且必须完全一致；来源、循环、实际调用和版本锁校验保持不变。规划也可用 `read_native_draft` 按字段读取，并以 `{draftDigest,useDraft:true}` 提交当前草稿；最终提交不绕过任何门禁。

工作流图为只读 `executable-syntax-v1` 投影，从当前实现的语法树与锁定版本依赖自动生成；Agent 不编写图、节点清单或可视化阶段注释。支持直接等待的能力调用、固定数组 `Promise.all`/`allSettled`、无动态调用的条件分支及嵌套工作流。工具并发仍遵循宿主现有规则。无法证明顺序的动态表达式、未等待调用、循环、异常控制区间与外部脚本明确显示为未知，不从注释猜测流程，也不改变执行语义。图不是实际成功执行证明。

提取提交支持将 `useDraft:true` 与 `draftEdits` 或 `programEdits` 同次提交：先在摘要匹配的当前草稿上应用修改，再执行全部验收。它不能与完整候选覆盖混用；`draftOnly:true` 仍只保存、不发布。

动态控制区间的可解析能力调用会按锁定版本递归展开，虚线仅表示源程序中的潜在调用位置；不推断实际执行次数、串并行或成功汇合。循环、异常处理和辅助函数导致的未知控制顺序保持显式标注。图完全从实现生成，Agent 不填写图元数据。

## 0.3 提取执行边界

P0 方案见 [可执行提取设计](design/executable-extraction-v4.md)。提取面板可指定 Linux Docker 目标及本次用途所需的嵌套深度、并行分支数量；默认 local 不会自动识别所有来源命令。容器来源必须选择 Docker，不能仅在说明里记下容器路径。主调用提供 `executionTarget`，宿主绑定并传递给所有依赖，原子资源脚本在目标内执行；具体字段见 [契约](skillx/contract.md#03提取用途与-docker-执行目标)。

工作流图只读生成，提取 Agent 无需维护 DAG 元数据。受管理进程/资源遵循程序 `await` / `Promise.all`；普通原生工具继续互斥。真实并行应查看资源执行区间或分派时间，而非排队时间。

“依据执行记录修订”提交原始会话及失败事实，让作者 Agent 修订已有能力；宿主原子发布并更新父级版本锁。静态提交只证明结构合法，必须另外真实调用核验结果。不要把 `available`、合法 JSON 或进程零退出解释为完整业务成功。当前业务修复与验收不由宿主替作者生成。


### 有证据的调用契约升级

“依据执行记录修订”默认勾选“保持现有输入/输出接口”。当待修问题就是参数暴露过多或结果结构不适合调用时，显式取消该项允许作者升级真实 Schema 和实现，发布新版本；旧调用方需迁移。不要通过运行时恢复适配旧调用，也不要以增大预览阈值代替业务摘要。正常输出应一次包含决策所需的完整结果，失败输出也必须满足相同的 JSON/Schema 约束。示例及完整成本口径见 [调用契约实跑](tests/invocation-cost-analysis/README.md)。

框架不按 skill/workflow 类型强制制造依赖。一个工作流可以在同一程序内编排原生工具，SkillX 也可以复用一个必要的辅助能力；是否拆分由来源职责和独立复用价值决定。显式嵌套/并行场景要求和依赖一致性校验仍有效。

现有脚本可通过 `resourceSources` 复制为自有资源，保存草稿时即完成复制，可直接对资源做局部编辑。`resources.run({path,args})` 以原始 argv 执行 CLI 脚本并返回原始进程结果；不提供 args 时保留 JSON main 协议。执行程序须检查退出状态并按原有结果契约映射返回，不能仅返回尚未生成的报告路径。

大结果预览使用 `{ "$omitted": "/原始结果指针" }` 明确标注省略字段，不把对象改成业务 null，也不返回截断路径。标记的指针可直接用于同一 runId 的 `capability_result_read`；无需重新执行业务。

局部修订按目标和相关失败选择证据，不强制完整重读当前会话的所有历史终端结果。作者仍需读取所选来源的相关证据与当前能力实现；初次提取的目标、结果及规划引用要求保留。这样避免每次修订都随历史编排结果增长而重放阅读成本，不放宽业务验收。

提交修复不设累计次数上限，避免作者逐项纠错时被中断并重新生成。仅在相同草稿重复出现相同诊断、没有进展时保留草稿和诊断后停止。既有 maxRepairAttempts 配置只保留在预算元数据中，不再作为硬中止条件。

局部修订复用已发布且当前 version/revision 均未变化的依赖锁，不强制重新完整读取未改动依赖。新增或已变化的依赖仍须读取当前契约；失败诊断包含具体依赖名与声明/当前版本，避免泛化错误导致盲目重试。

普通 capability_run 的 timeoutMs 按已校验的请求值传给执行账本，不再暗中截为 120 秒；外层 deadline 与账本使用同一预算。接口现有最大值不变，工作台手动诊断流程不在本变更内。

原生调用方修订失败能力时，`capability_revise` 传入失败 `runId`；宿主将本会话保留的真实能力边界输入、契约、输出提供给作者按需读取，不只转述外层错误。`capability_result_read` 的 `implementationId:"index"` 可区分下层执行失败与上层结果映射错误；查询不执行原流程。

规划定义可复用职责，构建确定实际依赖位置。共享环境准备可提升到并行分叉前，分支消费其结果；宿主仍检查声明依赖与代码调用一致，不对任意有副作用的能力调用自动缓存或合并。已验证的目标内运行配置应由实现保留，不要求普通调用方重新搜索。
