# 2.0.0 验证记录

验证日期：2026-09-11。全部使用合成日志、隔离的 DSH_HOME 和临时工作区，没有读取或修改用户的真实会话。

## 本机结果

环境：macOS、Node.js 25.4.0、Google Chrome（Playwright 控制）。

| 检查 | DSH 0.1.5-rc.1 | DSH 0.1.5-rc.2 |
| --- | --- | --- |
| 语法检查 | 通过 | 通过 |
| 真实持久化/附件测试 | 19/19 通过 | 19/19 通过 |
| v0 日志：选择 → 预览 → 导入 → 打开 → 续聊 | 通过 | 通过 |
| 官方 `/export` ZIP → 再次导入 | 通过 | 通过 |
| 子会话、PNG、二进制文件与可恢复撤销 | 通过 | 通过 |
| 未登录 401、跨站 403、浏览器异常检查 | 通过 | 通过 |

存储测试覆盖 v0/v1/v2 → v3 官方迁移、none/zstd 后端、独立实例重新打开、继续追加、种子历史边界、缺失/损坏附件、非法归档、指纹不一致、无写入预演、写入/挂载失败恢复、重启后撤销、活跃或已变化会话拒绝撤销。

rc.1 在独立目录安装完整、固定版本的官方依赖图。rc.2 使用本机已安装的官方运行时。普通 npm 自动解析 rc.1 的 caret peer 可能混入 rc.2；回归脚本因此固定整个官方依赖图，不使用 `--force` 跳过冲突。

已用 `npm pack` 打包并通过官方 `dsh plugin --profile web add <tarball>` 安装到隔离 profile，确认插件依赖和 bundle 登记；在同一 profile 启动真实 DSH 后，导入、续聊、ZIP 往返、认证冒烟和官方卸载均通过。测试辅助脚本与本地测试模型不包含在安装包中。

## 可复现检查

常规开发环境：

```bash
npm install
npm run check
npm test
npx playwright install chromium
npm run test:web
```

按指定 DSH 发布批次检查，在独立检出目录运行：

```bash
DSH_VERSION=0.1.5-rc.1 node test/install-cohort.js
npm run check
npm test
npm run test:web
```

`test:web` 会启动独立 DSH 实例、执行浏览器流程、关闭测试实例。通过后删除测试目录；`KEEP_DSH_TEST_DATA=1` 保留截图和原生导出包。macOS 可设置 `PW_BROWSER_CHANNEL=chrome` 使用已安装的 Chrome。`DSH_PLUGIN_PACKAGE` 可指定打包文件，测试会使用官方命令在同一隔离 profile 安装、验证并卸载。保留的服务日志包含该测试实例的登录链接，应保密。

已登录实例的轻量检查：把 Cookie 请求头值放入私有文件，通过 `DSH_COOKIE_FILE` 指定，避免把凭据写进命令或仓库。

```bash
BASE_URL=http://127.0.0.1:3080 DSH_COOKIE_FILE=/private/path/cookie.txt bash test/smoke.sh
```

默认仅进行只读和 dry-run 检查；设置 `SMOKE_IMPORT=1` 才会创建测试会话并立即可恢复撤销。可用 `SMOKE_WORKSPACE` 指定现有测试目录。

GitHub Actions 配置了 Node.js 22/24 × DSH rc.1/rc.2；Node 24 还运行 Chromium 浏览器验收。线上执行结果以仓库 Actions 为准。

## 证据边界

- 续聊走真实 DSH AgentLoop 和界面；模型由本地确定性测试适配器提供。适配器必须收到导入前的用户与助手历史才返回成功标记。没有调用付费模型 API。
- 验证了子会话日志、种子边界、父子关系和附件恢复；不代表所有第三方子代理、工具、凭据和目标目录配置都可原样继续执行。
- 默认 JSONL 后端通过检查；其他持久化后端会被拒绝。插件恢复适配依赖该后端的诊断定位方法，布局改变需要再次适配。
- 故障注入覆盖正常异常路径，不提供断电、磁盘损坏或多个进程同时操作同一存储的事务保证。崩溃后的 pending/recovery-required 记录需保留并检查。
- 本次没有更新用户正在使用的 DSH 安装或会话库，也没有向 npm 发布插件包。
