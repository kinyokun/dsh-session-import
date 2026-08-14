# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式,版本号遵循语义化版本。

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
