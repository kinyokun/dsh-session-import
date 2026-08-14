# 测试样本

| 文件 | 说明 |
| --- | --- |
| `good.jsonl` | 最小合法会话日志:头行 + 权限/沙箱/审批/预设、一个完整轮次(turn/step 闭合)、request/header(模型配置)、user/assistant 消息与标题事件 |
| `tampered-gap.jsonl` | 由 `good.jsonl` 删除第 8 行(user/message)得到 —— seq 出现空洞,结构验证应判 `error` 并拒绝导入 |

样本不含任何真实对话内容,可安全提交与传播。
