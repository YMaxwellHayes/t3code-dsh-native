# DeepSeek Harness T3 profile 验证报告

2026-11-25（台北时间）。使用 PATH 上的 `dsh` v0.2.2-rc.2 和 Node.js v22.23.2，经 stdio NDJSON 直接调用 `dsh --profile t3`。正式三轮串行执行，每轮启动独立进程和新会话。每个 JSON-RPC 请求的超时为 120 秒。

**每轮 22 项通过、1 项失败。** ACP 能力、T3 配置和静态 bundle 核对三轮均通过。失败项是额外的插件启动日志探针，三轮均未捕获 `billion-context` 的正向初始化日志。试跑捕获了该日志。

## 能力矩阵

| 检查项 | 第 1 轮 | 第 2 轮 | 第 3 轮 | 验证证据 |
| --- | --- | --- | --- | --- |
| T3 实例 | PASS | PASS | PASS | `acpRegistry`，参数 `["--profile","t3"]`，主题色 `#4D6BFE` |
| T3 模型偏好 | PASS | PASS | PASS | 5 条模型路由，首选为 DeepSeek Account Flash，隐藏列表为空 |
| T3 收藏 | PASS | PASS | PASS | `dsh` 收藏 DeepSeek Account Flash |
| profile bundle 继承 | PASS | PASS | PASS | 17 条 bundle，含 ACP app；共享 desktop 的依赖目录 |
| `initialize` | PASS | PASS | PASS | ACP v1，声明 `close`、`list`、`resume` |
| `session/new` | PASS | PASS | PASS | 以测试目录创建新会话并得到唯一会话 ID |
| 读取 `configOptions` | PASS | PASS | PASS | 模型 ID 可解析为双元素 JSON 数组；effort 值为 `off`、`low`、`high`、`max` |
| 设置并读回 `reasoning_effort` | PASS | PASS | PASS | `high` → `off`；设置响应返回 `off`，模型路由保持一致 |
| 提示词第 1 回合 | PASS | PASS | PASS | `end_turn`；助手回复 `dsh-t3-echo` |
| 提示词第 2 回合 | PASS | PASS | PASS | `end_turn`；助手回复 `OK2` |
| 提示词第 3 回合 | PASS | PASS | PASS | `end_turn`；助手回复 `OK3` |
| 真实 bash 工具 | PASS | PASS | PASS | 按同一 `toolCallId` 匹配 `tool_call` 与 `completed`，工具结果包含 `echo dsh-t3-echo` 的预期 stdout |
| `usage_update` | PASS | PASS | PASS | 每轮工具回合发送 2 条有效用量通知；其余两个回合各发送 1 条 |
| 同一会话连续 3 回合 | PASS | PASS | PASS | 全部 9 个回合正常结束 |
| 非法方法 | PASS | PASS | PASS | JSON-RPC 错误码 `-32601` |
| `session/close` | PASS | PASS | PASS | 会话关闭请求成功 |
| `session/list` | PASS | PASS | PASS | 以 cwd 过滤，首页包含刚关闭的会话 |
| `session/resume` | PASS | PASS | PASS | 原会话 ID 恢复成功 |
| 恢复后读回 effort | PASS | PASS | PASS | 恢复结果仍返回 `off` |
| 关闭已恢复会话 | PASS | PASS | PASS | 恢复后的 `session/close` 成功 |
| stdin EOF | PASS | PASS | PASS | 分别在 105、96、91 毫秒后退出，退出码均为 0 |
| NDJSON 输出 | PASS | PASS | PASS | stdout 无非 JSON-RPC 帧 |
| 插件启动日志探针 | FAIL | FAIL | FAIL | 预期的 3 条 UI 等待日志齐全，缺少 `billion-context` 的初始化日志 |

正式结果和控制台输出分别保存在各轮 JSON 和日志中。[第 1 轮 JSON](rounds/round-1.json) · [第 1 轮日志](rounds/round-1.log) · [第 2 轮 JSON](rounds/round-2.json) · [第 2 轮日志](rounds/round-2.log) · [第 3 轮 JSON](rounds/round-3.json) · [第 3 轮日志](rounds/round-3.log)

## T3 集成和插件继承

- 只读核对 `~/.t3/userdata/settings.json`。实例命令为 `/Users/dojo/.local/bin/dsh`，驱动为 `acpRegistry`，传入 `["--profile","t3"]`，主题色为 `#4D6BFE`。`providerModelPreferences.dsh.modelOrder` 首项及 `favorites` 中的 dsh 项均为 `["deepseek-account","deepseek-flash"]`。[第 1 轮配置快照](rounds/round-1.json)
- 直接调用 CLI 时，会话默认路由为 `["deepseek-official","deepseek-v4-flash"]`，正式三轮均使用该路由。T3 收藏和排序通过配置文件核对，本次测试范围为 ACP 和静态配置。[验证脚本](verify-t3.mjs)
- `~/.dsh/profiles/t3/package.json` 声明 17 条 bundle，其中从 desktop 继承 16 条（包含 `@deepseek-ai/dsh-base`），新增 `@deepseek-ai/dsh-acp-app`，移除 `@deepseek-ai/dsh-web-app` 和 `@deepseek-harness-tui/dsh-tui`。两套 profile 的 `node_modules` 解析到同一路径。继承列表包含 `billion-context`、`dshmarket`、`@wlv-zedd/dsh-btw-plugin`、`dsh-think-translate` 和 `dsh-context`。[完整 bundle 列表](rounds/round-1.json)
- 三轮均收到启动警告，列出的三个条目分别是等待 `sessionController` 的 `cot-translation`、等待 `webServer` 的 `dsh-think-translate`、等待 `terminalController` 的 `optional-terminal-panel`。[第 1 轮启动记录](rounds/round-1.json)
- 试跑的 stderr 包含 `[v=0.1.213] bili: proxy runtime resolved: /Users/dojo/.local/bin/node`，证实该次启动进入了插件的代理运行时初始化路径。正式三轮的启动警告均只列出上述 UI 条目。[试跑记录](rounds/pilot.json)

## 问题清单

1. **插件探针依赖日志。** 正式三轮均缺少探针要求的 `bili: proxy runtime resolved`，因此脚本每轮退出码为 1。该行在试跑出现，正式三轮的插件运行时状态缺少同等强度的正向证据。
2. **试跑发生一次 EOF 退出超时。** 试跑完成全部 ACP 会话检查后，进程在 5 秒内仍未退出，脚本使用 `SIGKILL` 清理。正式套件单独计入退出检查，三轮均自然退出。试跑超时的原因未确定。[试跑记录](rounds/pilot.json)

## 复跑

从项目根目录执行，脚本仅使用 Node.js 标准库。每次运行会按 dsh 的常规流程持久化测试会话。`--out` 可省略。

```sh
node tests/t3/verify-t3.mjs --out tests/t3/rounds/recheck.json
```
