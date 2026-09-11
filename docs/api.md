# HTTP API（2.x）

所有接口通过官方 `connection.fetch` 注册，必须携带当前 DSH 登录会话的 Cookie，并通过官方 Host / Origin 信任检查。文件请求使用 `application/octet-stream`；插件响应为 JSON，并设置 `Cache-Control: no-store`。认证边界直接返回的 401 / 403 为纯文本。旧 `/session-import/*` 路径已移除。

## GET /api/session-import/status

返回插件版本、`formatVersion`、`compatible` 与不兼容原因 `reason`。仅检查支持的服务/存储能力，不代表某个文件已通过验证。

## POST /api/session-import/analyze?name=export.zip

请求体为官方导出的 ZIP 或裸 JSONL 字节。解析所有会话并调用官方迁移目录，检查关系、附件指纹与归档边界；不写入会话或附件。

成功返回 `ok: true`、`preview`（标题、状态、根会话事件数、总事件数、来源版本、子会话和附件数量）以及 `verification`（`sha256`、`errors`、`warnings`、`verdict`）。无法恢复的文件直接返回 HTTP 400。

## POST /api/session-import/import

请求体同 analyze。查询参数：

| 参数 | 含义 |
| --- | --- |
| `name` | 文件显示名，默认 `session.jsonl` |
| `workspace` | 目标目录绝对路径；`original` 或省略时使用根日志 cwd，必须是本机现有目录 |
| `restamp` | 默认 `1`；`0` 保留原始时间 |
| `title` | 可选根会话标题，最多 100 UTF-8 字节 |
| `expectedHash` | 可选 64 位 SHA-256，不匹配返回 HTTP 409 |
| `dryRun` | `1` 时验证迁移、目标目录和附件可用性，不写入；`sessionId` 为 null |
| `open` | `1` 时导入完成后尝试恢复根会话；失败通过 warnings 返回，已导入数据仍保留 |

成功包含 `sessionId`、`sessionIds`、`sessionCount`、`eventCount`、`sha256`、`extras`、`resumed` 和 `warnings`。`resumed` 仅描述 Host 恢复；浏览器仍需刷新会话列表并打开目标会话。

2.x 完整保留状态事件。旧 `sync` 参数会返回 400，以免旧页面误以为还能选择性删除状态。

## POST /api/session-import/delete?sessionId=…

撤销一整次导入，只接受导入结果中的根 `sessionId`。先追加 `dryRun=1` 获取计划中的会话 ID 列表；此步骤不移动数据。

正式撤销会先验证持久导入记录与当前修订，拒绝改动后的会话和所有仍处于打开状态的会话；然后解除工作区关联，将会话移到恢复区。成功包含 `deleted: true`、`recoverable: true` 和 `recoveryRecord`。未删除共享附件。

## 错误

错误结构为 `{ "ok": false, "error": { "code": "…", "message": "…" } }`。

常见状态：400 文件/参数错误；401 未登录；403 跨站请求；404 接口或导入记录不存在；409 指纹不匹配、修订改变、所有权冲突；413 体积限制；422 附件验证失败；500 写入或恢复失败；503 运行时不兼容或请求繁忙。

失败消息若包含恢复记录路径，应保留记录和隔离副本，不将日志中的敏感内容贴入公开 issue。
