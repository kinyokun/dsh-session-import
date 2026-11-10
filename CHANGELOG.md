# Changelog

## 2.2.0 — 2026-11-10

- 支持跨系统导入（Windows ↔ macOS/Linux）：官方格式迁移只接受本机绝对路径，过去 Windows 日志在 Linux 上会整体报错 `format v2 header cwd must be absolute`。现在解析时把无法在本机解析的 header cwd 换成宿主根占位再迁移，原始路径通过 `sourceCwd` / `preview.provenance.cwd`（`cwdOnHost: false`）保留展示。
- 导入接口在日志来自其他系统时拒绝 `original`（省略 `workspace` 同样拒绝），返回 400 `workspace` 提示选择本机目标工作区，避免落到占位根目录；导入面板不再提供「保持日志原始目录」，改为提示并强制选择本机工作区。
- 新增 5 项测试（v0–v3 的跨系统 cwd 修复、选工作区后可导入、拒绝 `original`）。

## 2.1.0 — 2026-11-09

- 适配 DSH 0.2.2-rc.1（会话格式 v4）：
  - 持久化包从默认导出类改为 cordis 插件（`{ name, apply, Config }`），测试按插件装载；
  - 解析时为每个会话用 `createSessionFormatCatalogWithChildren` 提供子会话事实（叶子显式传 `[]`）；
  - 子会话描述符取自子日志里的 `subagent/descriptor` 事件，老格式缺省时退化为中立的 one-shot 描述；
  - 存储适配器不再依赖插件名与 `session.v3.jsonl` 文件名，改为按能力探测并接受当前格式文件名。
- 依赖与 CI cohort 升到 `0.2.2-rc.1`；`install-cohort` 接受任意已发布版本号。

## 2.0.0 — 2026-09-11

- 合并 PR #1 的 GitHub bundle 安装与浏览器模块名称修复，补充旧手动安装迁移、禁用与官方卸载说明。
- 通过官方 session-format-catalog 迁移 v0/v1/v2 日志并验证 v3，移除自维护的旧事件白名单与状态过滤逻辑。
- 使用 SessionHandle 完成写入、flush、重新读取与关闭，适配当前会话与工作区接口。
- 恢复子会话树、图片和文件附件；为所有会话分配新 ID，完整保留历史事件。
- 导入 API 迁至 `/api/session-import/*`，通过官方 connection.fetch 接入登录认证与 Host / Origin 访问控制，关闭旧的未认证路由。
- 限定 ZIP 路径、数量和解压大小，检查 CRC、附件指纹、重复 ID 和父子关系。
- 持久记录本插件的导入；撤销与正常失败路径保留隔离副本，拒绝清理无记录或发生变化的会话。
- 修复不存在的 workspaces.refresh 调用，明确区分已导入、已恢复和已打开，保留打开失败提示。


本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式,版本号遵循语义化版本。

## [1.0.2] - 2026-08-14

### Added

- 导入后**装载校验**:导入落盘后用持久化层的真实读取路径完整回放校验一遍(runtime 级校验,含恢复修复),保证导入的会话一定可打开;失败自动回滚(移除产物 + 解除工作区记账)并返回 `422 structure`
- 工作区挂载失败时自动回滚,不再留下孤立会话产物

### Changed

- 文件解析错误统一为 `400 bad-file`(之前是笼统的 500)
- `sync` 参数校验:未知同步组返回 `400 bad-request`
- 自定义标题按 UTF-8 字节截断(100 字节),避免触发标题服务的字节上限
- 上传文件超过 256 MB 时,浏览器端在选择后立即提示(不再发起上传)
- 断开的连接上不再尝试写响应(忽略 `writeHead` 失败)

### Security

- ZIP 解析加固:拒绝加密条目;单条目解压大小上限 1 GiB(防 zip 炸弹);校验解压后大小与目录声明一致
- 会话头校验要求 `version === 0`(拒绝未来版本格式,给出明确错误)

## [1.0.1] - 2026-08-14

### Fixed

- 修复客户端同步项默认值 bug:宿主 `analyze` 返回的预设字段名为 `agentPreset`,而客户端按 `preset` 读取,导致「Agent 预设(模式)」勾选框**永远默认不勾选**,导入后会话丢失 `agent-preset/selected` 事件、模式显示回落为头部预设(如 标准模式)。现在 `syncValueOf` 会把 `preset` 键映射到 `agentPreset` 字段,默认正确勾选。

## [1.0.0] - 2026-08-14

首个公开版本。

### Added

- 宿主端 `/session-import/*` 接口:`status` / `analyze` / `import`(含 `dryRun` 预演)/ `delete`
- 解析 `/export` 导出的 zip(内建最小 zip 读取器,支持 stored/deflate)与裸 `.jsonl`(含 chunk 压缩存储行展开)
- 导入时重新分配会话 ID、时间戳置顶(`restamp`)、自定义标题、目标工作区选择/挂载
- 状态同步:模型与思考深度、Agent 预设、权限预设、沙箱模式、审批策略、计划模式;过滤重排后重写事件顶层与 `data` 内的全部 seq 引用
- 结构真实性验证(seq 连续性、顶层引用合法性、未知类型白名单、配对检查、时间戳回退检测)与 SHA-256 指纹、预期指纹强校验(`expectedHash`)
- 投影缓存预热(侧栏免打开显示标题等元数据)
- `open=1`:导入后恢复为活跃会话,向已连接页面实时推送 `host/session-added`(侧栏免刷新可见);删除时优雅卸载并实时推送移除
- 浏览器端 UI:hero 界面「模式选择」右侧的「导入对话」按钮 + 导入对话框(拖拽/选择、验证预览、同步勾选、工作区/标题/置顶选项)
- 冒烟测试脚本与测试样本(`test/`)
