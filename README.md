# dsh-session-import

DSH(DeepSeek Harness)会话日志导入插件:把 `/export` 导出的会话 zip 或裸 `.jsonl` 日志导入为**新的会话**,并在导入时做真实性验证与状态同步。带浏览器端 UI —— 新对话界面「模式选择」右侧的**「导入对话」**按钮 + 完整导入对话框。

- **宿主端(`host.js`)**:`/session-import/*` HTTP 接口(zip/jsonl 解析、结构真实性验证、SHA-256 指纹、导入/预演/删除)
- **浏览器端(`client.js`)**:hero 界面导入按钮、拖拽/选择文件、验证与同步项预览、导入并打开

---

## 功能特性

| 能力 | 说明 |
| --- | --- |
| **导入他人会话** | 解析 `/export` 的 `.zip`(自动识别根目录 `session.jsonl`)或裸 `.jsonl`(含 `text-chunks` 等压缩存储行);始终重新分配会话 ID,不覆盖本机会话 |
| **状态同步** | 可选同步日志中的模型与思考深度(`request/header`)、Agent 预设、权限预设、沙箱模式、审批策略、计划模式;过滤重排后**同步重写**事件顶层与 `data` 内的全部 seq 引用(`sourceEventSeqs`/`surfaceOp`/`messageSeqs`/`inbox.spliced.start`) |
| **置顶导入** | `restamp=1` 把事件时间戳整体平移到当前(保持相对间隔),导入的会话直接排到列表顶部 |
| **真实性验证** | 结构一致性检查(seq 连续、事件配对、未知类型、时间戳回退等)+ SHA-256 指纹 + 可选「预期指纹」强校验,不匹配拒绝导入。详见 [docs/security.md](docs/security.md) |
| **实时可见(免刷新)** | `open=1` 导入后立即把会话恢复为活跃态,宿主通过 `session/created` 事件向所有已连接页面推送 `host/session-added` 帧,侧栏即时出现新会话;删除时同样实时消失 |
| **自定义标题** | 导入时可指定标题(追加一条 `session/title` 事件),留空则沿用日志内标题 |
| **投影预热** | 导入后预热投影缓存,侧栏**无需打开会话**即可显示标题等元数据 |
| **删除/撤销导入** | `POST /session-import/delete` 优雅卸载并移除落盘产物、解除工作区记账 |

## 安装

> 本插件按 DSH 的 profile patch 机制挂载,启动后自动运行,无需手动加载。

1. 把本仓库放到 profile 的 `node_modules` 下(包名即目录名):

   ```bash
   # $DSH_HOME 默认为 ~/.dsh,profile 名按实际部署(此处以 web 为例)
   PROFILE_DIR=~/.dsh/profiles/web
   mkdir -p "$PROFILE_DIR/node_modules/dsh-session-import"
   cp host.js client.js package.json "$PROFILE_DIR/node_modules/dsh-session-import/"
   ```

2. 在 `$PROFILE_DIR/cordis.patch.yml` 追加插件行:

   ```yaml
   - insert:
       - id: session-import
         name: dsh-session-import
   ```

   > 若目录名是 `session-import`,则 `name: session-import`;两种方式等价,取决于第 1 步的目录名。

3. 重启 `dsh web`(宿主端代码在模块缓存中,需重启进程生效;launchd 等托管方式会自动拉起)。
4. **刷新浏览器页面** —— 加载浏览器端插件,新对话界面出现「导入对话」按钮。

关闭插件:删除 patch 中的 insert 条目,或加一行 `- id: session-import` + `disabled: true`。

## 使用

1. 在新对话界面,点「模式选择」右侧的 **导入对话**;
2. 拖入或选择 `.zip` / `.jsonl` 文件,等待解析与验证;
3. 查看**日志概要**与**真实性验证**结果(结构结论 + SHA-256 指纹,可粘贴导出方公布的指纹做强校验);
4. 勾选要同步的状态(模型/思考深度、Agent 预设、权限预设、沙箱模式、审批策略、计划模式);
5. 选择目标工作区、置顶时间戳、自定义标题 → **开始导入**;
6. 导入成功后自动打开新会话,侧栏实时出现(无需刷新)。

## HTTP API

完整接口文档见 [docs/api.md](docs/api.md)。速览:

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/session-import/status` | 插件与依赖状态 |
| POST | `/session-import/analyze` | 解析 + 真实性验证(不落盘) |
| POST | `/session-import/import` | 执行导入(支持 `dryRun=1` 预演、`open=1` 实时恢复) |
| POST | `/session-import/delete` | 删除本插件导入的会话产物 |

## 兼容性与限制

- **事件类型白名单**:解析器内置了与开发时 DSH 构建一致的 `KNOWN_SESSION_EVENT_TYPES`;未知类型(通常来自更新版本写出的日志)会被判为错误并拒绝导入 —— DSH 的冷读校验同样会拒绝这类日志,提前拦截只是把错误前置到导入时。
- **子代理与媒体附件**:导出 zip 内 `subagents/` 下的子代理日志与 `media/` 附件会在预览中提示,但**不导入**(后续版本计划支持整树导入)。
- **快照语义**:导出包是导出时刻的快照;导出后原会话继续产生的消息不在包内,属预期行为。
- **作者身份**:结构校验 + 指纹能发现多数篡改,但当前 DSH 导出不含签名,**无法证明作者身份**;需要强保证时请配合导出方另行公布的 SHA-256 指纹使用。详见 [docs/security.md](docs/security.md)。
- **删除保护**:非本插件导入且处于内存活跃态的会话会被删除接口拒绝(`code: live`);本插件导入并恢复的会话可被安全删除(先优雅卸载再移除产物)。

## 开发与测试

```bash
# 语法检查
node --check host.js && node --check client.js

# 冒烟测试(需本地 dsh web 运行中,默认 http://127.0.0.1:3080)
BASE_URL=http://127.0.0.1:3080 bash test/smoke.sh
```

`test/fixtures/` 提供了一份最小合法日志(`good.jsonl`)与一份被删行篡改的日志(`tampered-gap.jsonl`),用于验证结构校验与指纹逻辑。

## 目录结构

```
dsh-session-import/
├── host.js           # 宿主端插件:路由、zip 解析、验证器、导入/删除
├── client.js         # 浏览器端插件:导入按钮 + 对话框(经 /plugins/…/client.js 下发)
├── package.json      # dsh.client 双面插件包声明(exports ./client)
├── docs/
│   ├── api.md        # HTTP 接口参考
│   └── security.md   # 真实性验证与防篡改说明
├── test/
│   ├── smoke.sh      # 冒烟测试
│   └── fixtures/     # 测试日志样本
├── CHANGELOG.md
└── LICENSE
```

## License

[MIT](LICENSE) © 2026 kinyokun
