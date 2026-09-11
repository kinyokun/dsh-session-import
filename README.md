# dsh-session-import

将 DSH 官方 `/export` 导出的 ZIP 或裸 JSONL 导入为新的、可继续对话的会话。支持整棵子会话树、图片与文件附件；在新会话页面点击「导入对话」完成文件选择、预览和导入。

插件使用 DSH 官方格式迁移目录解析历史日志，通过 `SessionHandle` 写入、验证和关闭会话，然后关联目标工作区。历史消息、系统提示词、模型和其他状态事件完整保留；来源机器的项目文件需要另行同步。

## 兼容性

- 目标运行时：`@deepseek-ai/dsh 0.1.5-rc.1 / 0.1.5-rc.2`。本地运行验证与边界见 [验证记录](docs/verification.md)。
- Node.js：`^22.19.0 || >=24.0.0`。
- 支持 DSH 默认 JSONL 后端的 `none`、`zstd` 两种存储编码。
- 日志格式：官方目录可迁移的 v0、v1、v2，以及当前 v3。官方拒绝迁移的历史形态、损坏日志和未知的新格式会在导入前报错，不通过改写版本号绕过校验。
- 2.x 不再支持 DSH 0.1.0 的旧存储接口；需要旧 DSH 时保留原来的 1.x 插件。

DSH 的接口仍在快速变化。升级后访问 `/api/session-import/status` 检查兼容状态，并运行导入回归检查；不要仅凭插件能加载就认定导入已兼容。

## 安装

```bash
dsh plugin --profile web add github:kinyokun/dsh-session-import
```

安装后重启 `dsh web` 并刷新浏览器。DSH 的插件命令需要可用的 `pnpm`；依赖由安装命令处理。安装包会自动挂载插件，无须再手动增加 `insert` 条目。

从本地源码安装：

```bash
git clone https://github.com/kinyokun/dsh-session-import.git
cd dsh-session-import
dsh plugin --profile web add "$PWD"
```

### 从旧的手动安装迁移

1. 停止准备升级的 `dsh web`，备份对应 profile 的 `cordis.patch.yml` 和旧插件目录。
2. 从 profile patch 中移除以前手动添加的 `id: session-import` 的 **insert 条目**，保留其他插件及会话。不要同时保留自动 bundle 和旧 insert，两者会重复挂载。
3. 将手动复制的 `node_modules/dsh-session-import/`（或者旧别名 `node_modules/session-import/`）移到 profile 外作为备份，再执行上面的安装命令。
4. 重启 DSH 并刷新页面。已导入会话不需要重新导入。

2.x 的宿主代码由多个模块组成，并依赖官方格式库；不要再只复制 `host.js`、`client.js` 和 `package.json`。

### 升级、禁用与卸载

GitHub 安装升级时重新执行安装命令，然后重启 DSH 并刷新页面。

临时禁用可在 profile 的 `cordis.patch.yml` 中添加：

```yaml
- id: session-import
  disabled: true
```

通过官方命令安装的版本，应使用官方命令卸载，以同步移除依赖与 bundle 登记：

```bash
dsh plugin --profile web remove dsh-session-import
```

然后移除本插件的临时禁用覆盖（如有），重启 DSH 并刷新页面。仅删除 `node_modules` 目录会留下无效的 bundle 引用。卸载插件保留会话、附件和恢复记录。

## 使用

新会话页面 → **导入对话** → 选择 ZIP/JSONL → 查看校验结果、子会话和附件数量 → 选择目标工作区 → **开始导入**。

- 每次导入生成新的会话 ID，重建包内父子关系，不覆盖原会话。根会话从包外父会话分离，整棵树关联到所选工作目录。
- 模型、Agent 预设等历史事件完整保留；继续运行所需的模型配置、凭据和插件由目标 DSH 提供。不会从归档安装或执行插件代码。
- 新标题作为事件追加；默认把整棵会话树的最后事件移到当前时间，保留相对时间间隔。可取消「置顶显示」保持原始时间。
- ZIP 中引用的图片和文件必须齐全且 SHA-256 匹配。图片经目标 DSH 的附件接口验证、规范化并更新引用；文件按原字节恢复。
- 裸 JSONL 没有附件字节；若它引用附件，目标 DSH 必须已经保存这些附件，否则导入被拒绝。
- 子会话历史与关系会恢复；是否能继续操作某个子代理，由目标 DSH 的代理类型、预设和所需插件决定。
- 导入成功但自动恢复/打开失败时，界面保留提示，用户可从侧栏打开。不会把打开失败显示成「已打开」。

当前限制：上传最多 256 MiB、ZIP 解压总量最多 512 MiB、最多 256 个会话、最多 4096 个 ZIP 条目、总计最多 100 万个逻辑事件；不支持分卷、加密 ZIP、ZIP64 或符号链接。

## 校验与恢复

结构校验判断官方运行时能否恢复日志；SHA-256 与导出方通过独立渠道提供的指纹比较，可判断文件是否一致。**没有独立可信的指纹或签名时，不能证明文件未被修改，也不能证明作者身份。**

会话文件、校验预览和附件均由当前 DSH 实例处理。API 通过官方 `connection.fetch` 注册，沿用 DSH 的登录 Cookie 与 Host / Origin 访问控制；未登录请求返回 401，跨站请求返回 403。

导入先完整解析并校验，写入结束后关闭全部写句柄，再挂载工作区。正常异常路径会撤销已挂载的根会话，并将本次创建的会话目录移到恢复区。DSH 目前没有公开的删除或多会话事务接口，因此该恢复适配仅支持已验证的 JSONL 布局，并在写入前检查布局。

恢复区位于存储根目录的同级：例如 `~/.dsh/sessions` 对应 `~/.dsh/sessions-import-recovery/`。`imports/` 保存导入记录，`quarantine/` 保存撤销或失败导入的会话目录。记录包含原位置与隔离位置，可在停止 DSH 后按记录恢复；恢复时避免覆盖现有目录。进程或机器崩溃可能留下 `pending` 记录，应据此检查，不代表一次原子提交已完成。

`POST /api/session-import/delete` 仅用于撤销本插件有持久记录、且导入后没有变化的会话树；先用 `dryRun=1` 预览。仍处于打开状态、已继续或发生变化的会话会被拒绝。成功撤销会保留隔离副本。共享的内容寻址附件不删除；异常保存的附件可能保留未引用对象，避免影响其他会话。

## 开发与检查

```bash
npm install
npm run check
npm test
```

测试使用临时目录中的真实 JSONL/附件后端，不连接模型 API，不读取用户会话。完整浏览器验收另见 [验证记录](docs/verification.md)。

[HTTP API](docs/api.md) · [安全边界](docs/security.md) · [更新记录](CHANGELOG.md) · [安全报告](SECURITY.md)

MIT © 2026 kinyokun。感谢 @YuxinZhaozyx 提交 GitHub 安装支持（PR #1）。
