# DSH 原生执行契约

本文描述当前实现，不是 skillx.yaml 文件格式，也不代表已实现原始草案全部要求。参见[实现映射](implementation-map.md)。

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

调用方不能读取内部程序、依赖正文或历史证据。它只需要按 `inputSchema` 传入 JSON，并使用经过 `outputSchema` 校验的结果。

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

- `language` 固定为 `typescript`，但程序必须是普通 JavaScript async function body，不能使用 TypeScript 专有语法。
- `program` 最大 64 KiB，发布前只做解析校验，不在生成阶段执行业务动作。
- `inputSchema` 和 `outputSchema` 最大 64 KiB，最大深度 32，必须是有限无环 JSON。
- 输入 Schema 必须是对象根；输出 Schema 使用 DSH 支持的 JSON Schema 子集。
- 程序返回值必须通过输出 Schema 校验，超出输出大小上限会失败。

## 程序可用接口

执行程序运行时可使用三个全局对象：

```js
const input = await __native_capability.input({});
const tools = Object.freeze({
  call: request => __native_capability.tool(request),
  reuse: request => __native_capability.reuse(request)
});
const capabilities = Object.freeze({
  run: request => __native_capability.capability(request),
  reason: request => __native_capability.reason(request)
});
```

生成 Agent 编写程序时看到的是简化入口：

| 入口 | 用途 |
|---|---|
| `input` | 已通过 Schema 校验的输入对象 |
| `await tools.call({ name, arguments })` | 调用 DSH 工具 |
| `await tools.reuse({ stepId })` | 在恢复场景复用同一调用链里已验证的成功步骤 |
| `await capabilities.run({ name, input })` | 调用声明过版本锁的 SkillX 依赖 |
| `await capabilities.reason({ prompt, outputSchema })` | 只在确实需要模型判断时调用受限推理 |

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

完整事件、工具调用、内部实现摘要、恢复记录和用量保存在私有执行目录中。公开回执用于说明这次输出来自哪个能力版本，不能被解释为外部状态永久有效。
