# 运行机制

本页说明 SkillX 在插件中怎样被提取、启用、执行和优化，以及为什么启用 skillx 能减少耗时和 Token。

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

单来源与多来源均按职责选择相关证据，保存来源摘要及完整读取的记录编号。规划引用实际记录，构建必须读取引用及末尾结果；依赖在规划和构建间锁定版本。发布检查结构及来源引用，不执行业务或验收模拟。JSONL 每个文件存储上限为 64 MiB，较大的证据按相关范围分页读取。

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

## 执行程序怎样使用工具

执行程序可以调用 DSH 工具，例如 shell、文件、浏览器或其他已注册工具。调用经过宿主：

- 保留原 Agent、root call 和 execution token。
- 使用当前会话的沙箱策略。
- 工具调用事件写入执行记录。
- 失败会被记录为内部问题、外部阻塞或未知问题。

执行程序也可以调用声明过版本锁的其他 SkillX。这样可以把大任务拆成几个稳定能力，但外层模型仍只看到当前能力的公开契约。

## 恢复怎样工作

恢复分为前台恢复和后台维护。

前台恢复发生在同一次 `capability_run` 内。它读取当前输入、程序、执行轨迹和失败信息，在当前权限和证据范围内补全一个经过 Schema 校验的结果。

恢复任务完成后，独立子 Agent 分析是否为实现缺陷；有明确修复方案时才启动优化，偶发故障保持原版本。

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

提取仅有职责规划和构建两个阶段，优化仅构建。各阶段使用“提取模型”中保存的模型；不生成验收样本、模拟工具响应、故障注入或 ZIP/Base64 测试资料，不运行候选程序和业务操作。已有配置 `contractReview` 不再启用验收阶段。

宿主仅检查 JSON Schema、适用时的 JavaScript 语法、依赖版本与字面调用、证据引用、兼容性声明及错误指引路径。这些是保存格式检查，不能证明业务行为正确。成功完成的候选按批次原子发布；没有独立复用价值时可以跳过。

生成前会提供 [DSH 支持的 JSON Schema 子集](skillx/contract.md#dsh-支持的-json-schema-子集)，提交工具和协议查询使用同一说明。提交时一次汇总所有候选的输入、输出 Schema 问题，避免逐轮发现已存在的限制。

每个候选按职责说明独立消费结果、输入变量及必要依赖。稳定操作提取为 SkillX，流程通过固定版本依赖编排；不规定产物数量。来源必须包括用户目标、相关操作及最终结果，失败尝试不能替代最终成功机制。优先保留来源中的 CLI/库调用，不为提取重写协议、压缩或编码算法。

提取策略 `bounded-results-v3` 将工具错误、明确的非零退出码及输出中的失败/阻塞信号作为“需要复核后续处理”的证据标记，不据此自动推断业务结果。该轮标记之后的工具观察必须完整读取，包括超过预填大小限制的结果；通过分片读取，不静默省略。规划必须提交 `completionTrace`：用户目标、业务完成条件、已观察的继续处理分支，以及问题/原因/解决办法/实际证据的经验条目。问题原因不明时注明未知。

分片进度按读取对象与内容摘要保存，重复请求第一页不重置进度。游标不匹配时返回精确的 `nextRead` 工具名和参数；后续生成请求也提供 `pendingReads`，先完成当前读取再切换记录或批次，避免把不同结果的游标混用。

每条经验明确进入程序、前置条件、恢复文档或有依据地舍弃。构建以 `completionCoverage` 和 `lessonCoverage` 指向实际交付物片段；未落实已观察继续步骤或问题解决办法的候选会被拒绝。宿主检查证据已读和片段存在，不声称静态检查能证明业务语义正确。能力发布证据保留对应规划。

程序执行状态与业务结果分开保存、展示和统计。`receipt.status` 表示程序状态，`receipt.businessOutcome` 按能力显式声明的 `execution.outcome` 映射判定。部分完成和阻塞不计业务成功；未声明结果映射的历史版本标为未知，不猜测其任意输出字段含义。

保留一份简洁实现，声明 macOS、Linux、原生 Windows 的支持范围与前提；无法兼容时注明，不额外生成 Windows 流程脚本。

## 提取草稿与预算

### 保存与局部修复

规划和实现草稿保存于 `jobs/<taskId>.<phase>-working-draft.json`，诊断保存于 `jobs/<taskId>.diagnostics.json`。`read_native_draft` 按候选和 JSON pointer 读取字段；同阶段重复读取返回引用。使用当前 `draftDigest` 加 `draftEdits` 或精确 `programEdits` 修复结构问题，摘要过期则拒绝。重复失败和总修复次数均有上限，停止时保留草稿。

生成异常另存于仅本地可读的 `jobs/<taskId>.failure.json`，包含失败阶段、会话 ID 和原始异常。Agent 初始化失败时可能尚无可查看的提取对话，应查此文件；原始异常不返回前端。

工具入参由 DSH 保持只读，插件复制后才修改候选或捕获资源。插件编程错误和文件系统异常以 `GENERATION_INTERNAL_ERROR` 停止并保存诊断，不交给模型改稿，不计入模型提交修复次数。模型提交问题仍受总次数与同一问题重复次数限制；已解决的诊断项计为进展，重新出现的问题仍受重复上限约束。

`repairTargets` / `savedDraft` 是展示投影，其中 `resourceManifest` 和 `path` 是只读派生字段，不是可编辑的候选字段。删除或替换前通过 `read_native_draft` 的候选名与 JSON pointer 确认真实字段；不要用空 `resources` 绕过插件异常。

向提取接口提交 `resumeTaskId` 复用已保存规划和实现；宿主核对来源摘要及依赖锁。历史验收资料不再读取。`validateOnly:true` 仅执行静态提交检查并保存回执，不发布，不运行候选程序。

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
budget = min(totalTimeoutMs, maxTimeoutMs, timeoutMs * units)
```

| 配置 | 默认值与作用 |
|---|---|
| `totalTimeoutMs` | 初始总时间估计 10 分钟，运行中自动调整 |
| `timeoutMs` | 每证据单位 10 分钟，用于计算初始估计 |
| `maxTimeoutMs` | 初始时间估计上限 15 分钟 |
| `recordsPerBudgetUnit` / `bytesPerBudgetUnit` | 100 条 / 262,144 字节 |
| `maxSteps` / `maxTotalSteps` | 每阶段 16 步 / 全程 40 步工作估计 |
| `maxTotalTokens` | 初始全程估计 400,000，含缓存读取 |
| `maxOutputTokens` | 全程输出工作估计 64,000 |
| `maxRequestOutputTokens` | 单次请求输出额度 12,000 Token，传给宿主模型配置，实际用量由宿主回报 |
| `maxRepairAttempts` / `maxRepeatedFailures` | 修复上限按候选数量确定 / 同一问题停滞 2 次；达到阈值停止并保留草稿 |

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

优化 API 的 `reviewFindings` 可提供最多八项、合计 8 KiB 的审查意见。模型将其作为诊断假设，对照证据核实。只读生成阶段提交非法 JSON 时，符合完整捕获等条件的提交允许原模型在当前生成任务内做一次格式修复；该修复的触发条件是宿主已完整捕获并确认提交 JSON 解析失败。

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

Coverage validation reports every invalid completionCoverage/lessonCoverage field together. Ellipses and pseudocode are not exact implementation references; an existing correct implementation requires a reference correction, not a program rewrite. The host verifies textual evidence coverage, not semantic correctness.
