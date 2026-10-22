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
- `program` 最大 64 KiB；JavaScript 发布前仅做语法解析，Python 仅检查文本结构，不执行程序或模拟验收。
- `inputSchema` 和 `outputSchema` 最大 64 KiB，最大深度 32，必须是有限无环 JSON。
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
