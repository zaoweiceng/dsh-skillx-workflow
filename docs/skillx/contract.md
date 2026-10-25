# DSH 原生执行契约

本文描述本插件能力条目的存储结构、公开契约和运行 SDK。

本插件当前支持 DSH 执行契约。它把 SkillX 存成版本化能力条目，并通过 DSH Skill Provider 暴露给模型。

## 公开给调用方的内容

模型加载某个 SkillX 时，只会看到类似下面的公开契约：

```json
{
  "name": "commit-and-simulate-mr-merge",
  "description": "提交本地变更并完成模拟 MR 合并核验",
  "version": 2,
  "inputSchema": {
    "type": "object",
    "properties": {
      "message": { "type": "string" }
    },
    "required": ["message"],
    "additionalProperties": false
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "commit": { "type": "string" },
      "merged": { "type": "boolean" }
    },
    "required": ["commit", "merged"],
    "additionalProperties": false
  },
  "invocation": {
    "tool": "capability_run",
    "arguments": {
      "name": "commit-and-simulate-mr-merge",
      "input": "Object matching inputSchema"
    }
  }
}
```

调用方按 `inputSchema` 传入 JSON，使用经过 `outputSchema` 校验的结果；实现程序、依赖和历史证据由插件内部管理。

框架将精简的根能力输入契约直接呈现在原生 `capability_run` 工具定义中，普通任务可以按用途自动选择，不需要用户给出能力名或先调用 `skill`。依赖独立调用及大型目录仍渐进加载。该呈现保留所有 Schema 约束，只去除 UI 标签和示例；实际输入仍由原始 Schema 校验。公开契约的 `invocation.arguments.expectedRevisionId` 绑定已读修订。

`capability_run` 可带 `select:["/status","/summary","/report_path"]`，这些参数属于框架调用接口，不进入能力 input。完整结果仍验证和保存；返回 output 形如 `{"/status":"completed","/summary":{...}}`，不存在的字段列入 `delivery.missingPointers`，不会被编造成空值或引起业务重放。`delivery.scope="selection"` 表示 complete/digest/bytes 针对所选视图，fullBytes 表示完整结果字节数。原始结果由已有 runId 和 `capability_result_read` 读取；该工具也支持 select 批量读取多个字段，不能与 pointer/offset/limit/stepId/jsonTextPointer 混用。

## 私有能力条目

插件私有存储中的条目包含：

| 字段 | 含义 |
|---|---|
| `name` | 稳定能力名 |
| `kind` | 能力分类 |
| `description` | 目录发现时展示的短说明 |
| `content` | 面向人的目的、限制和验证说明 |
| `execution` | 可执行契约，包括语言、输入 Schema、输出 Schema 和程序 |
| `dependencies` | 依赖的 SkillX 名称与版本锁 |
| `version` | 从 1 递增的不可变版本 |
| `revisionId` | 单次发布的不可变修订 ID |
| `sourceSessionId` | 来源会话 |
| `generatorSessionId` | 生成该版本的 DSH Agent 会话 |
| `validationNotes` | 已检查证据和已知限制 |

## 执行契约

`execution` 必须满足下面的结构：

```json
{
  "language": "typescript",
  "inputSchema": { "type": "object" },
  "outputSchema": { "type": "object" },
  "program": "const value = input.foo; return { value };"
}
```

当前实现约束：

- `language` 为 `typescript` 或 `python`。前者使用普通 JavaScript async function body，后者是完整 Python 程序，通过 stdin 读取 JSON `{input, context}`，stdout 输出一个符合输出 Schema 的 JSON，日志写 stderr。每项能力只保留一种实现。
- `program` 不设固定字节上限；JavaScript 发布前仅做语法解析，Python 仅检查文本结构，不执行程序或模拟验收。
- `inputSchema` 和 `outputSchema` 不设固定字节上限，最大深度 32，必须是有限无环 JSON。
- 输入和输出 Schema 均使用下面的 DSH JSON Schema 子集，输入根必须显式为 `type: "object"`。
- 程序返回值必须通过输出 Schema 校验，超出输出大小上限会失败。
- 程序返回值还必须是无损 JSON：可选对象字段无值时省略，不能设为 `undefined`；数组不能含 `undefined`，数值不能是 `NaN` 或无穷。多目标结果应省略不适用的单目标字段，不能用未定义值占位。

### 业务完成结果

`execution.outcome` 是本宿主的业务状态映射。新提取能力必须声明，历史版本可缺省并显示“业务结果未声明”。它不改变输入输出 Schema：

```json
{
  "path": "/status",
  "values": {
    "success": "completed",
    "partial": "partial",
    "blocked": "blocked",
    "failed": "failed"
  },
  "reasonPath": "/error/message"
}
```

`path` 和可选的 `reasonPath` 是输出的 JSON pointer，空字符串指输出根；`values` 将已报告的标量字符串映射为四种业务状态。布尔值使用 `"true"` / `"false"` 键。未找到字段或未映射的值为 `unknown`。宿主不会仅凭任意 `ok` 或 `status` 字段猜测结果。

`receipt.status: completed` 仅表示程序已正常返回并通过输出校验；`receipt.businessOutcome` 表示上述业务判定，界面分别展示，成功率按已知业务结果计算。多目标流程必须报告全部必要目标完成才是业务完成；保留逐目标失败证据，不能将部分结果伪装成全部成功。

### DSH 支持的 JSON Schema 子集

这是本宿主的执行限制，不是通用 SkillX 规范，也不等于完整 JSON Schema。构建与优化 Agent 在生成前通过系统提示和提交工具说明获得同一份规则；`read_native_draft(name="__protocol__")` 也返回此规则。

| 关键字 | 支持方式 |
|---|---|
| `type` | 单个字符串：`object`、`array`、`string`、`number`、`integer`、`boolean`、`null`。不支持类型数组或 `"json"`。 |
| `properties` | 仅用于对象，字段名映射到子 Schema。 |
| `required` | 仅用于对象，是字段名字符串数组，字段必须已在 `properties` 声明。 |
| `additionalProperties` | 仅用于对象，只接受布尔值，不接受子 Schema。 |
| `items` | 仅用于数组，是一个子 Schema，不支持元组数组。 |
| `enum`、`const` | 仅用于标量，值必须匹配声明类型；`enum` 非空。不支持对象或数组枚举。 |
| `oneOf` | 至少两个分支，运行值必须恰好匹配一个；同级只允许注释字段，不与 `type` 或其他约束并用。 |
| `title`、`description` | 字符串注释；输入字段使用简短中文 `title`。 |
| `default`、`examples` | JSON 注释，不插入默认值，也不施加校验。 |

每个 Schema 节点必须是对象。`{}` 表示任意 JSON，但不能用于输入根。可空整数写为：

```json
{ "oneOf": [{ "type": "integer" }, { "type": "null" }] }
```

不支持白名单之外的关键字，包括 `$schema`、`$ref`、`$defs`、`definitions`、`anyOf`、`allOf`、`not`、`nullable`、`format`、`pattern`、`minLength`、`maxLength`、`minimum`、`maximum`、`minItems`、`maxItems`、`uniqueItems`。长度、范围、格式等业务约束应由程序显式校验，不得通过删除约束而放弃必要的输入检查。

提交时汇总所有候选的输入和输出 Schema 问题，诊断提供候选名、Schema 字段路径和具体违规项，供同一次局部修复处理。

## 程序可用接口

JavaScript 执行程序可使用以下接口；Python 入口直接由配置的解释器执行，不注入 JavaScript SDK。需要固定版本依赖编排时使用 JS workflow 调用 Python SkillX。

```js
const input = await __native_capability.input({});
const tools = Object.freeze({
  call: request => __native_capability.tool(request),
  reuse: request => __native_capability.reuse(request)
});
const capabilities = Object.freeze({
  run: request => __native_capability.capability(request)
});
const resources = Object.freeze({
  path: path => __native_capability.resource({ path }),
  run: request => __native_capability.script(request)
});
```

生成 Agent 编写程序时看到的是简化入口：

| 入口 | 用途 |
|---|---|
| `input` | 已通过 Schema 校验的输入对象 |
| `await tools.call({ name, arguments })` | 调用 DSH 工具 |
| `await tools.reuse({ stepId })` | 在恢复场景复用同一调用链里已验证的成功步骤 |
| `await capabilities.run({ name, input })` | 调用声明过版本锁的 SkillX 依赖 |
| `await resources.path("scripts/helper.py")` | 解析当前修订中已保存的内部资源路径，由宿主验证摘要；调用方无需提供 |
正常执行不提供推理入口。失败时由宿主创建内部恢复子 Agent，读取当前版本自己的 `docs/`，输出仍通过原 Schema 校验。恢复完成后由另一独立子 Agent 决定是否需要持久修复。

## 失败分类

执行失败会被归到三个层次：

| 类型 | 典型原因 | 处理方式 |
|---|---|---|
| 内部问题 | 程序异常、输出不符合 Schema、依赖版本变化 | 插件尝试同次恢复；必要时安排后台优化 |
| 外部阻塞 | 权限、凭据、审批、用户拒绝、外部服务不可用 | 返回阻塞原因，由调用方或用户处理 |
| 截止时间 | 前台预算耗尽 | 停止业务执行，保留证据，后台维护独立继续 |

## 回执

`capability_run` 返回精简回执：

```json
{
  "runId": "80349b99-d7f3-4bcc-969b-81ae266938fc",
  "status": "completed",
  "capability": {
    "name": "commit-and-simulate-mr-merge",
    "version": 2,
    "revisionId": "0df1f7af-fb80-4b83-bbe4-f5634809e650"
  },
  "outputDigest": "sha256:..."
}
```

完整事件、工具调用、内部实现摘要、恢复记录和用量保存在私有执行目录中。公开回执记录本次输出的能力版本和摘要；外部状态以实际观察时间和条件为准。

## 无 Shell 进程与脚本

`processes.run({executable, args, cwd, stdin, env, inheritEnv, pathPrefix, timeoutMs})` 通过宿主原生进程工具传递参数数组，继承执行权限与沙箱，不拼接 Shell 命令。`executable` 是字符串，`args` 是字符串数组，`inheritEnv` 是明确的环境变量名字符串数组，不能传 `true` / `false`；无需指定时省略或传 `[]`。`env` 是变量名到字符串或 `null` 的映射，`pathPrefix` 是字符串，`timeoutMs` 是整数。生成前提供此类型说明与 `capability_process` 当前接口；明确错误的字面量参数在提交阶段拒绝。

`resources.run({path, input, cwd, inheritEnv})` 内部解析当前修订的脚本路径并按 JSON 协议执行 Node/Python 资源；`inheritEnv` 同样使用字符串数组。Node 脚本导出 `main(input, context)`，其 `context.resources` 提供已打包资源路径，调用方无需定位文件。顶层 JavaScript 程序只接收 `input`、`tools`、`capabilities`、`resources`、`processes`，没有 `context` 变量；顶层选择解释器应使用 `@node` / `@python`。可执行文件缺失可能在解析阶段直接抛错，不能仅按进程 `exitCode === 127` 判断；只按来源证据明确支持的条件回退，不能吞掉业务失败。

`@node` 和 `@python` 使用插件配置 `nodeExecutable`、`pythonExecutable`；CLI 启动方式可在 `executables` 明确配置原生可执行文件或 `{runtime: "node", args: ["用户确认的 CLI JS 入口"]}`。`.cmd/.bat` 不会自动改用 Shell 执行，缺少配置须向用户询问。

### Result delivery boundary

After full outputSchema validation and retention, capability_run returns output plus delivery:{complete,runId,bytes,digest,read}. Small output is complete; output exceeding 16 KiB is a bounded mechanical preview with complete=false, which does not promise to satisfy the business schema. Read required details with capability_result_read using JSON Pointer and nextOffset; do not repeat business operations. Business outcome uses the full result. New authors must produce bounded semantic summaries by default; mechanical previews are only a delivery fallback.

Input property descriptions must accurately declare mandatory bounds, units, combinations, defaults and precedence, matching program validation. Default annotations do not fill inputs. Execution errors retain original code and stage; recovery status is separate.


### 0.2.2：进程判定与运行环境预检

旧条目无需迁移，`processes.run` 仍返回原始进程结果。非零退出、超时、取消、信号终止和 stdout 截断会在回执中记为失败，不再作为成功步骤供 `tools.reuse` 复用；读取原始观察仍可取得失败输出。读取旧恢复证据时也重新检查进程状态。只有 stderr 截断时保留诊断标记，不阻断有效结果。

新增 `processes.checkedRun({...request, acceptedExitCodes: [0]})`；默认仅接受退出码 0，有明确 CLI 契约时可指定其他退出码。失败码为 `PROCESS_EXIT_FAILED`、`PROCESS_TIMEOUT`、`PROCESS_CANCELLED`、`PROCESS_SIGNALLED`、`PROCESS_OUTPUT_TRUNCATED`、`PROCESS_RESULT_UNKNOWN` 或 `PROCESS_ACCESS_DENIED`。Node 脚本资源在序列化前拒绝丢失信息的返回值；`SCRIPT_OUTPUT_NOT_JSON`、`SCRIPT_OUTPUT_INVALID`、`SCRIPT_PROGRAM_FAILED` 区分返回值、stdout 协议和脚本异常。PTC 内未捕获的宿主异常保留原始失败码；程序内可按 `error.message` 匹配稳定码。

能力可以在原有 `compatibility` 中增加可选 `probes`：

```json
{
  "platforms": ["darwin", "linux", "win32"],
  "requirements": ["配置可用的 Node 解释器"],
  "limitations": "仅声明已验证的平台；探针不代替实际业务验收。",
  "probes": [
    {"executable": "@node", "args": ["--version"], "stdoutIncludes": "v", "timeoutMs": 5000}
  ]
}
```

探针必须来自已验证的只读检查，例如 CLI 版本或必要库的 import。宿主在整个静态依赖链业务执行前运行探针；同一次调用中的相同探针去重，默认 5 秒，上限 30 秒，并受整个调用预算约束。探针仍受调用方沙箱与权限约束；“只读”是编写要求，不是对任意命令的额外隔离保证。预检失败标记 `stage: preflight`，说明缺失的可执行文件（`EXECUTABLE_REQUIRED`）、启动条件或输出不符（`ENVIRONMENT_OUTPUT_MISMATCH`），不启动自动修复 Agent，不自动安装依赖。`.cmd/.bat` 仍需显式启动配置（`CLI_LAUNCHER_REQUIRED`）。

没有探针的旧条目不增加执行步骤。预检只是必要条件检查，不能保证服务始终可用、原生库跨平台通用或消除检查后的环境变化。安装锁、断点恢复、系统包管理和通用依赖编排不在本次范围。失败重试前必须确认副作用；超时或退出码失败不意味着什么都没发生。

0.2.2 的 JavaScript 宿主明确提供 `require()` 与动态 `import()`，按执行 cwd 解析模块；由相同 PTC 沙箱约束 I/O。程序自行声明的 `require` 可正常遮蔽宿主入口。嵌套工作流默认不再受全程 100 次调用的数量门槛约束；实际执行截止时间、取消、依赖深度及权限校验仍保留，服务调用者可显式设置 `maxCalls`。

### 0.3：提取用途与 Docker 执行目标

提取请求的 `requirements` 可指定 `target: "local" | "docker"`、`workflowDepth` 与 `parallelBranches`。默认 local、0、0；容器来源需明确选择 Docker，当前不会自动识别任意 Shell/远程传输。数量仅表示本次用途约束，不是通用 SkillX 最小规模。工作流必须组合能力；原子 skill 不得隐藏能力依赖。提交校验真实程序调用与锁定依赖，图仍由宿主自动派生。

Docker 条目保存 `execution.target: "docker"`，宿主为全部入口注入必填的 `input.executionTarget`：`container`，可选 `dockerExecutable`（宿主客户端）、`nodeExecutable` / `pythonExecutable`（容器内解释器）。根调用验证运行中 Linux 容器，子能力继承根目标。容器资源经 stdin 传送到临时目录后执行，不依赖宿主修订目录挂载。目标内 I/O 放在资源脚本，编排只用 JSON 与受管理 SDK；`resources.path` 和绕过目标的通用 `tools.call` 不适用于 Docker 条目。不支持 SSH 或 Windows 容器，也不宣称完整对抗性沙箱。

受管理进程/资源遵循编排程序的 `await` 与 `Promise.all`，无需叶子重复声明并行元数据。独立操作才能并行；共享安装目录需要业务实现自己的安装锁。其他原生工具保留互斥边界。实跑记录 `dispatchedAt` 表示开始实际分派，排队开始时间不能充当业务并发证据。

公开契约同时披露执行目标和验证范围。`available` 只表示当前可执行实现存在；提取提交的静态合法性不等于业务可用。失败后依据原始执行记录修订能力并原子更新父级版本锁，不用运行时恢复掩盖提取缺陷。旧的容器边界丢失产物应停用后重新提取。

作者读取工具 `read_native_capability` 支持可选 `jsonPointer`（例如 `/resources/scripts~1helper.py`）和分页游标；必须返回真实字段，不能以“初始提示已提供”替代资源正文。`read_native_draft` 在同名候选尚未建立时允许读取选中修订，已有草稿优先。普通调用方仍只读取公开契约；这个接口只属于提取/修订作者。

### 提取源文件与草稿

提取工具的 `read_native_execution(view:"source",sourcePath,sessionId)` 只读取源会话明确访问过的文件；读取与后续 `resourceSources` 打包共用缓存内容，不额外计算源文件哈希。缺失文件不会被静默替换。最终提交在必要证据完整交付后才保存；已有草稿允许携带当前 `draftDigest` 整体修订，过期摘要仍会拒绝。

`submit_native_capabilities.programEdits` 默认精确修改主程序；可选 `resourcePath` 指向已有资源脚本。两者都要求当前草稿摘要和唯一匹配的 `before`，执行完整提交校验；资源修订无需重交其余文件。

大型批量记录使用相同的无损分页，不因批量字节数退化成摘要预览。每页交付量为 48 KB；只在全部分页交付后标记证据已读。


提取规划可附初步 `inputSchema`、`outputSchema`；构建必须依据真实脚本确定完整公开契约。保留规划能力身份与职责；依赖边由构建后的真实调用决定，允许共享准备移到父工作流并将已准备结果传给分支，也允许补充有来源支持的小操作依赖。不得以固定依赖位置迫使分支重复安装环境。依赖调用与结果归属须在真实执行中验证；不以重复粘贴代码片段或并行节点数量代替业务验收。各阶段保留原生 Agent 对话连续性。

### 原有 CLI 资源

`resources.run({path:"scripts/task.mjs",args:["--output",input.outputPath]})` 使用原始 argv 执行已归档的脚本，支持 executable、env、stdin，返回与 `processes.run` 一致的进程结果。省略 args 时保留原有 JSON main 协议。不要将 CLI 脚本当作 main 模块加载；执行程序负责检查退出状态和映射业务输出。

### 失败执行的原始边界

`capability_revise` 必须携带当前会话的失败执行 `runId`。作者收到能力边界状态索引，通过 `read_native_draft(name:"__execution__",jsonPointer)` 读取原始输入、输出及执行契约，定位生产者与消费者之间的不一致。普通调用方可用 `capability_result_read(implementationId:"index")` 查看同一索引，再按返回的能力边界 ID 和 `/input`、`/output`、`/execution` 精确读取；读取不重执行业务。修订回执区分实现改动与仅更新依赖锁。

原始进程返回 `{exitCode,signal,timedOut,aborted,stdout:{text,truncated},stderr:{text,truncated}}`，不提供业务 `status`；解析 JSON 应读取 `stdout.text`。

提取保留已成功执行的目标内运行配置作为实现默认值；调用方只需提供独立变化的业务输入与宿主执行目标，必要时可覆盖配置。来源中的固定 venv、Node 私有前缀等不能仅因它们是路径就全部变为必填输入；这不代表把来源机器路径声明为所有平台通用默认值。

构建会检查可静态确定的依赖输入字段：对象字面量、input 展开及其常量别名不能向 additionalProperties:false 的子能力泄漏父级字段；动态表达式仍由运行时 Schema 验证，不自动丢弃字段。全部可确定冲突一次返回。嵌套输入校验失败保留拒收边界原始输入，并在失败记录中给出 repairTarget（参数组装方）；以根能力发起的显式修订会据此选择实际目标，原子更新父级依赖锁，回执明确 requestedName 与实际 name。

草稿保存与发布分开：证据读取未完成时仍保留明确标记为 unvalidated-draft 的已提交代码，随后返回缺失引用记录，不能发布。作者继续编辑同一草稿，不必因证据门禁重交整批代码。带业务失败 outcome 的依赖调用不能以裸 await 或未消费的 Promise.all 丢弃结果；父程序必须检查业务状态、消费真实子结果并完成汇总，不能在子步骤预检查后再运行原始完整入口。

显式修订自动包含最初成功执行的来源会话，并保留能力原 sourceSessionId；当前失败会话作为本次修订证据，不能覆盖原始来源链。已执行的来源脚本优先通过 resourceSources 归档并调用其子操作，作者编写适配和汇总，不能把真实业务校验替换成成功标签。

### 已执行 ESM 脚本的函数资源

当脚本只公开粗粒度 CLI、内部已有所需函数时，resourceSources 的值可为 `{path:"绝对来源.mjs",call:"函数名",arguments:["输入字段"],bindings:{源变量名:"输入字段"}}`，目标资源也使用 .mjs。构建时保留原业务函数体，移出原 import、移除原 main().catch 启动调用，再生成现有 JSON main(input) 接口；entrypoint 可指定原启动函数名。resources.run 沿用现有协议，无新运行时。

read_native_execution(view:source) 对可解析 ESM 脚本提供函数参数和顶层变量清单。作者选择真实函数并绑定调用字段；声明的变量绑定及无默认值函数参数必须提供，未绑定的来源配置保留原值。当前仅支持无 export 的独立 .mjs 脚本及其命名函数声明；已导出模块继续使用普通资源协议，Python/CJS 不适用该适配方式。该功能不自动重排工作流或证明业务完成，仍须真实执行验收。
