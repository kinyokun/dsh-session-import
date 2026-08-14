# HTTP API 参考

所有接口挂载在 DSH 的共享 `webServer` 前缀 `/session-import` 下。文件上传接口的请求体为**原始文件字节**(`Content-Type: application/octet-stream`),文件名等选项走查询参数。失败响应统一为:

```json
{ "ok": false, "error": { "code": "…", "message": "…" } }
```

---

## GET /session-import/status

插件与依赖状态。

```bash
curl http://127.0.0.1:3080/session-import/status
```

```json
{ "ok": true, "plugin": "session-import", "version": "1.0.0", "persistence": true, "workspaces": true }
```

| 字段 | 说明 |
| --- | --- |
| `persistence` | `sessionPersistence` 服务是否可用(导入必需) |
| `workspaces` | `workspaceRegistry` 服务是否可用(挂载工作区必需) |

---

## POST /session-import/analyze

解析并验证文件,**不落盘**。支持 `/export` 导出的 zip(自动识别根目录 `session.jsonl`)与裸 `.jsonl`。

| 查询参数 | 说明 |
| --- | --- |
| `name` | 文件名(仅用于错误信息与展示) |

```bash
curl -X POST --data-binary @session.zip \
  -H 'content-type: application/octet-stream' \
  'http://127.0.0.1:3080/session-import/analyze?name=session.zip'
```

响应:

```json
{
  "ok": true,
  "preview": {
    "title": "为Cline添加视觉模型插件",
    "counts": { "user": 24, "assistant": 117, "toolCall": 121, "toolResult": 121, "turn": 13, "step": 120 },
    "eventCount": 170392,
    "byteLength": 1542410,
    "lastTime": 1786644095135,
    "sync": {
      "model": { "provider": "deepseek-official", "model": "deepseek-v4-pro", "reasoningEffort": "max", "maxTokens": 256000 },
      "agentPreset": "cordis",
      "permission": "danger-full-access",
      "sandbox": "danger-full-access",
      "approval": "never",
      "plan": null
    },
    "provenance": {
      "originalId": "session-8399966e-…",
      "createdAt": 1786640346440,
      "cwd": "/Users/alice/projects/demo",
      "delegationDepth": 0,
      "headerAgentPreset": "standard"
    },
    "extras": { "subagentLogs": 0, "mediaFiles": 0 }
  },
  "verification": {
    "sha256": "b14bbee1…f57",
    "errors": [],
    "warnings": ["1 个 turn 未闭合(…)"],
    "verdict": "warn"
  }
}
```

- `preview.sync.*` 为日志中**最后一条**对应状态事件的折叠值,`null` 表示日志中没有该项;
- `verification.verdict`: `ok` / `warn`(有可疑点但可导入)/ `error`(结构错误,不可导入);
- 错误码:`400 bad-request`(无法解析/头不合法)、`500 internal`。

---

## POST /session-import/import

执行导入。全部查询参数:

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `name` | `session.log` | 文件名(仅展示) |
| `workspace` | — | 目标工作区:**绝对路径** 或 `original`(沿用日志原始 `cwd`,需本机存在);必填 |
| `restamp` | `1` | `1` 把事件时间戳平移到当前(置顶显示,保持相对间隔);`0` 保留原始时间 |
| `sync` | 全部 | 逗号分隔的同步组:`model,preset,permission,sandbox,approval,plan`;未列出的组对应事件会被过滤,其 seq 引用会被同步重写 |
| `title` | 空 | 自定义标题(空则沿用日志内标题);追加一条 `session/title` 事件 |
| `expectedHash` | 空 | 期望 SHA-256(64 位十六进制);与文件指纹不一致 → `409 hash-mismatch` |
| `open` | `0` | `1` 导入后立即恢复为活跃会话:向已连接页面实时推送 `host/session-added`(侧栏免刷新),会话立即可用 |
| `dryRun` | `0` | `1` 只做全部校验与计算,不落盘、不建会话 |

```bash
curl -X POST --data-binary @session.zip \
  -H 'content-type: application/octet-stream' \
  'http://127.0.0.1:3080/session-import/import?name=session.zip&workspace=%2FUsers%2Falice%2Fprojects%2Fdemo&restamp=1&sync=model,preset,permission,sandbox,approval,plan&open=1'
```

成功响应:

```json
{
  "ok": true,
  "sessionId": "session-14d8fe5b-…",
  "header": { "id": "session-14d8fe5b-…", "cwd": "/Users/alice/projects/demo", "agentPreset": "standard", "createdAt": 1786668585984 },
  "eventCount": 170392,
  "droppedSyncEvents": 0,
  "sha256": "b14bbee1…f57",
  "restamped": true,
  "resumed": true,
  "extras": { "subagentLogs": 0, "mediaFiles": 0 },
  "verification": { "errors": [], "warnings": ["…"], "verdict": "warn" },
  "dryRun": false
}
```

| 错误码 | 含义 |
| --- | --- |
| `409 hash-mismatch` | 文件指纹与 `expectedHash` 不一致(疑似被篡改) |
| `422 structure` | 结构校验存在 error(seq 断裂、未知类型、非法引用等) |
| `400 workspace` | 目标工作区不存在/不是目录/日志无原始 cwd |
| `400 bad-request` | 参数缺失或文件不可解析 |
| `503 persistence` / `503 workspace` | 宿主缺少对应服务 |

`resumed: false` 表示 `open=1` 请求了恢复但失败(降级为冷会话,导入本身成功),常见原因是 `agentLoop` 服务不可用或预设组合失败。

---

## POST /session-import/delete

删除本插件导入的会话产物(撤销导入):先优雅卸载活跃会话(向页面实时推送移除),再删除持久化 artifact、解除工作区记账。

| 查询参数 | 说明 |
| --- | --- |
| `sessionId` | 会话 ID;必填 |

```bash
curl -X POST 'http://127.0.0.1:3080/session-import/delete?sessionId=session-14d8fe5b-…'
```

```json
{ "ok": true, "deleted": true, "sessionId": "session-14d8fe5b-…", "removedPath": "…/session.jsonl.zstd" }
```

| 错误码 | 含义 |
| --- | --- |
| `409 live` | 会话在内存中活跃且**不是**本插件导入的(删除会破坏其后续写盘) |
| `404 not-found` | 会话不存在(可能已删除,或由其他机制管理) |
| `500 internal` | 定位/释放/移除失败 |

> 本插件导入并 `open=1` 恢复的会话由插件持有释放句柄,可安全删除;重启后这些会话回到冷状态,同样可删。
