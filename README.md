# dsh-session-import

<p align="center">
  <img alt="license" src="https://img.shields.io/github/license/kinyokun/dsh-session-import">
  <img alt="version" src="https://img.shields.io/github/package-json/v/kinyokun/dsh-session-import">
  <img alt="verified" src="https://img.shields.io/badge/DSH-0.1.0--rc.6%20%E5%AE%9E%E6%B5%8B-blue">
  <img alt="zero deps" src="https://img.shields.io/badge/%E8%BF%90%E8%A1%8C%E6%97%B6%E4%BE%9D%E8%B5%96-0-green">
</p>

DSH(DeepSeek Harness)会话日志导入插件:把 `/export` 导出的会话 zip 或裸 `.jsonl` 日志导入为**新的会话**,导入前做结构真实性验证与 SHA-256 指纹校验,并可按需同步模型/思考深度/Agent 预设/权限/沙箱等状态。自带浏览器端 UI —— 新对话界面「模式选择」右侧的**「导入对话」**按钮 + 完整导入对话框,导入/删除实时推送到页面,**无需刷新**。

## Overview

**解决什么问题**:DSH 的 `/export` 产物没有原生的导入通道;会话的"分享 / 迁移 / 备份回灌"只能靠手工摆弄 session 目录。本插件提供一键导入,并在导入前把"这是不是被改过的文件"讲清楚。

**适合谁**:

- 想在**另一台机器 / 另一个部署**上继续他人会话的人;
- 想**备份后回灌**、或把一个会话**复制成多个分支**做对照实验的人;
- 需要**审计会话日志真伪**(是否被删改)的人。

**双面结构**(与 DSH 的 `dsh.client` 插件包约定一致):

| 端 | 文件 | 职责 |
| --- | --- | --- |
| 宿主 | `host.js` | `/session-import/*` HTTP 接口:zip/jsonl 解析、结构真实性验证、SHA-256、导入(含 `dryRun` 预演、`open=1` 实时恢复)、删除 |
| 浏览器 | `client.js` | hero 界面导入按钮、拖拽/选择文件、验证与同步项预览、导入并打开 |

## Compatibility

| 项目 | 声明 |
| --- | --- |
| 支持的 DSH 版本 | **`@deepseek-ai/dsh 0.1.0-rc.6`**(2026-08-14 安装/加载/导入/删除全流程实测) |
| 已验证环境 | macOS + Node.js 25,`dsh web` profile patch 挂载,zstd 与明文两种持久化编码 |
| 最后验证日期 | 2026-08-14 |
| 已知耦合点 | 解析器内置的 `KNOWN_SESSION_EVENT_TYPES` 白名单与开发时构建一致;DSH 升级引入新事件类型后,新格式日志会被判 `error` 拒绝导入(DSH 自身的冷读校验同样会拒绝),届时同步白名单并升级版本即可 |

DSH mainline 变化很快:升级前建议先跑 `test/smoke.sh` 验证。

## Install / Uninstall

### 安装

1. 把本仓库放进 profile 的 `node_modules`(包名即目录名):

   ```bash
   PROFILE_DIR=~/.dsh/profiles/web        # profile 名按实际部署调整
   mkdir -p "$PROFILE_DIR/node_modules/dsh-session-import"
   cp host.js client.js package.json "$PROFILE_DIR/node_modules/dsh-session-import/"
   ```

2. 在 `$PROFILE_DIR/cordis.patch.yml` 追加插件行:

   ```yaml
   - insert:
       - id: session-import
         name: dsh-session-import
   ```

   > 目录名用 `session-import` 时写 `name: session-import`,二者等价。

3. 重启 `dsh web`(宿主代码在模块缓存中,需进程重启生效;launchd 等托管方式会自动拉起)。
4. **刷新浏览器页面** —— 新对话界面出现「导入对话」按钮。

### 升级

覆盖 `host.js` / `client.js` / `package.json` 后重启 `dsh web` 并刷新页面。已导入的会话不受影响。

### 禁用

在 patch 中追加 `- id: session-import` + `disabled: true`(保留文件,随时可重新启用)。

### 彻底移除

删除 patch 中的 insert 条目与 `node_modules/dsh-session-import/` 目录,重启 `dsh web`。已导入的会话日志保留在 DSH 的 sessions 目录中(它们是普通会话,可用 `POST /session-import/delete` 删除或留用)。

## Quick start

**图形界面(推荐)**:新对话界面 → 「导入对话」→ 拖入 `.zip`/`.jsonl` → 查看验证结果与可同步项 → 选目标工作区 → 「开始导入」→ 会话实时出现在侧栏并自动打开。

**命令行最小示例**:

```bash
# 预览与验证(不落盘)
curl -X POST --data-binary @session.zip \
  -H 'content-type: application/octet-stream' \
  'http://127.0.0.1:3080/session-import/analyze?name=session.zip'

# 导入到指定工作区:置顶时间戳、同步全部状态、导入即恢复(页面实时可见)
curl -X POST --data-binary @session.zip \
  -H 'content-type: application/octet-stream' \
  'http://127.0.0.1:3080/session-import/import?name=session.zip&workspace=%2FUsers%2Falice%2Fprojects%2Fdemo&restamp=1&open=1'

# 删除导入产物(测试/撤销)
curl -X POST 'http://127.0.0.1:3080/session-import/delete?sessionId=session-xxx'
```

## Configuration

本插件**没有持久化设置**;全部行为由导入时的一次性参数控制(接口参数即配置,UI 中的勾选项一一对应):

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `workspace` | —(必填) | 目标工作区绝对路径,或 `original`(沿用日志原始 `cwd`,需本机存在) |
| `restamp` | `1` | 置顶显示:事件时间戳平移到当前,保持相对间隔 |
| `sync` | 全部 | `model,preset,permission,sandbox,approval,plan` 的逗号子集;未列出的组被过滤,seq 引用自动重写 |
| `title` | 空 | 自定义标题(UTF-8 截断至 100 字节) |
| `expectedHash` | 空 | 期望 SHA-256;不匹配拒绝导入(强校验) |
| `open` | `0` | `1` 导入后立即恢复为活跃会话,侧栏免刷新可见 |
| `dryRun` | `0` | `1` 只校验与计算,不落盘 |

**资源上限**:上传原始字节 ≤ 256 MB;zip 单条目解压后 ≤ 1 GiB;拒绝加密 zip。

**环境变量**:无。插件不读取任何环境变量,不产生新的持久化文件(导入的会话写入 DSH 自身的会话存储,删除接口可整体移除)。

## Permissions & data

| 维度 | 说明 |
| --- | --- |
| 读取 | 仅读取你上传的文件(内存中处理,上限 256 MB);导入校验时读取 DSH 自身的会话存储与工作区注册表 |
| 写入 | 只写入 DSH 会话持久化目录(目标工作区下的新会话产物)与工作区记账(挂载/解除);删除接口移除自己导入的产物 |
| 网络 | 无任何出站请求;全部接口走 DSH 本机 webServer 回环地址 |
| 凭据 | 不接触任何 API Key/凭据;SHA-256 在本地计算 |
| 删除行为 | 只删除本插件导入的会话;内存活跃且非本插件导入的会话会被拒绝(`409 live`) |

## Troubleshooting

| 现象 | 原因与处理 |
| --- | --- |
| `400 bad-file` | 文件不可解析:非 zip/jsonl、zip 损坏/加密/超限、首行不是合法会话头、`version ≠ 0`(未来格式)、JSON 行损坏 —— 换原始导出文件重试 |
| `409 hash-mismatch` | 文件指纹与「预期 SHA-256」不一致:疑似被篡改,或粘贴的指纹来自另一个文件 |
| `422 structure` | 结构校验存在 error(seq 断裂/未知类型/非法引用),或导入后装载校验失败 —— 后者已**自动回滚**,不会留下半成品 |
| `409 live` | 删除目标在内存中活跃且不是本插件导入的:先在界面中离开该会话再删 |
| `400 workspace` / `500 workspace-attach` | 目标工作区不存在/不是目录;挂载失败会**自动回滚** |
| `503 persistence / workspace` | 宿主组合缺少对应服务(检查 profile 的 bundle) |
| `resumed: false` | `open=1` 恢复失败(如 preset 组合失效),导入本身成功,会话为冷状态,刷新列表即可见 |
| 导入后侧栏没有新会话 | 未用 `open=1` 且页面未刷新:点会话列表的刷新或直接刷新页面 |

**日志位置**:插件告警走宿主 logger(与 `dsh web` 的标准输出/日志文件一致);接口错误都随 HTTP 响应返回,无需翻日志。

**回滚**:导入失败会回滚;已成功的导入用 `POST /session-import/delete` 整体移除;插件本身出问题按「禁用」章节操作即可。

## Development

```bash
node --check host.js && node --check client.js          # 语法检查
BASE_URL=http://127.0.0.1:3080 bash test/smoke.sh       # 冒烟测试(无副作用)
BASE_URL=… SMOKE_IMPORT=1 bash test/smoke.sh            # 追加真实导入 + 删除闭环
```

- `test/fixtures/` 提供合法样本与被删行篡改样本,用于验证结构校验与指纹逻辑;
- 开发调试建议用 `analyze` 与 `dryRun=1`(不落盘),再用 `open=1` + `delete` 做完整闭环;
- 贡献:欢迎 issue / PR;改动请同步更新 `CHANGELOG.md` 并跑通冒烟测试。

## License & security

- 许可证:[MIT](LICENSE) © 2026 kinyokun
- 安全报告:见 [SECURITY.md](SECURITY.md)(请勿在公开 issue 中贴敏感内容)
- 能力边界(诚实声明):结构验证 + SHA-256 指纹能发现多数篡改,但当前 DSH 导出**不含签名,无法证明作者身份**;需要不可伪造的保证时,配合导出方另行公布的指纹使用,或等待导出端签名能力。详见 [docs/security.md](docs/security.md)
