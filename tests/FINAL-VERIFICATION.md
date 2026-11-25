# dsh 原生接入 T3 Code 最终验收

验收日期 2026-11-25（台北时间），工作目录 `/Users/dojo/t3code-dsh-native`。PATH 上的 dsh 为 `/Users/dojo/.local/bin/dsh`，版本 `0.2.2-rc.2`。

**最终结论：不通过。** T3 配置与 profile 结构符合预期，补充验证确认了 ACP 握手和 billion-context 的配置挂载。禁止写入的约束阻断了 ACP 会话持久化，真实模型回合、工具流和恢复流程未能完成验收。安装器在现有配置下仍会重写 profile 文件，其中标记文件内容会变化，未达到无副作用的要求。

验收在 macOS `sandbox-exec` 下执行，阻止两份交付文件以外的文件写入。补充验证中的预载代码从内存加载，未修改项目脚本或 dsh、T3 配置。各步骤均在 120 秒内结束。

## 1. T3 自检

命令 `node scripts/verify.mjs --profile t3`，预期 13 项全过。

退出码为 `1`，输出 `SUMMARY: 5/6 passed`。CLI 包装器、t3 profile、ACP bundle、排除桌面 app bundle、T3 实例登记五项通过。dsh 准备 profile 时写入 `~/.dsh/profiles/t3/cordis.yml` 被拒绝（`EPERM`），进程退出，自检在约 60 秒后报告 `timeout: initialize`。会话与回合断言未执行。

## 2. T3 专项套件

命令 `node tests/t3/verify-t3.mjs --out tests/t3/rounds/final.json`，预期 22 项通过，插件启动日志探针一项失败。

退出码为 `1`，23 项共 **5 通过、4 失败、14 跳过**。原始逐项结果见 [final.json](t3/rounds/final.json)。

- 通过 `t3.instance`、`t3.model_preferences`、`t3.favorites`、`profile.bundles`、`transport.ndjson`。本次进程在启动时退出，传输项只观测到零条无效帧。
- 失败 `initialize`、`rpc.unknown_method`、`process.stdin_eof`、`profile.plugin_startup`。dsh 在 profile 初始化时退出，日志探针收到的 pending 列表为空。
- 跳过 `session/new`、两项 `configOptions`、三轮 `prompt.turn_*`、`prompt.bash_echo`、`prompt.usage_update`、`prompt.three_turns`、`session/close`、`session/list` 及三项 resume 检查。

补充复跑使用同一套件和同一 Electron 内置 CLI 入口。内存预载只跳过已验证逐字节相同的 `cordis.yml` 重写，其他写入继续由沙箱阻止。结果为 **8 通过、2 失败、13 跳过**。ACP 握手返回协议版本 `1` 和 agent 名 `deepseek-harness-acp`，未知方法返回 `-32601`，关闭 stdin 后 dsh 正常退出。直接发送 `session/new` 得到 `-32603`，错误详情显示 `ACP session persistence flush failed`，原因是创建 `~/.dsh/sessions/…` 会话目录时收到 `EPERM`。

补充复跑的插件探针观测到三个预期的 pending 插件 `cot-translation`、`dsh-think-translate`、`optional-terminal-panel`，随后因缺少 `bili: proxy runtime resolved` 失败。按 [SUPPLEMENT.md](t3/SUPPLEMENT.md) 定性为已知日志探针局限。第 5 项独立确认了配置挂载，真实压缩回合未验证。

## 3. 遗留 ACP 套件

命令 `node --check tests/verify-acp.mjs` 退出码为 `0`。随后执行一轮 `node tests/verify-acp.mjs`，默认使用 acp profile，退出码为 `1`，汇总为 **2 通过、6 失败、0 INFO、12 跳过**。

T3 设置静态校验和 CLI 版本通过。acp profile 启动写入 `~/.dsh/profiles/acp/cordis.yml` 时收到 `EPERM`，握手、认证、协议协商、创建会话及正常退出相关检查失败。使用 T3 命令参数的端到端检查也在握手前退出。脚本保持原样。

## 4. T3 设置只读检查

命令 `python3 -`，内联脚本读取 `~/.t3/userdata/settings.json`，解析并断言所要求的字段，退出码为 `0`。

| 字段 | 实测 |
| --- | --- |
| `providerInstances.dsh.driver` | `acpRegistry` |
| `providerInstances.dsh.config.source` | `local` |
| `providerInstances.dsh.config.commandPath` | `/Users/dojo/.local/bin/dsh` |
| `providerInstances.dsh.config.commandArgs` | `["--profile","t3"]` |
| `providerInstances.dsh.accentColor` | `#4D6BFE` |
| `providerInstances.dsh.displayName` | `DeepSeek Harness` |
| `providerModelPreferences.dsh.modelOrder[0]`（解码） | `["deepseek-account","deepseek-flash"]` |
| 根级 `favorites` 中 dsh 的唯一模型（解码） | `["deepseek-account","deepseek-flash"]` |

所查字段全部符合预期。

## 5. profile 结构与 billion-context

命令 `python3 -`，内联脚本读取 `~/.dsh/profiles/t3/package.json` 并检查 `node_modules` 符号链接，退出码为 `0`。共 17 个 bundle，含 `@deepseek-ai/dsh-acp-app`，web-app 和 TUI 匹配数均为 0。符号链接指向并解析到 `/Users/dojo/.dsh/profiles/desktop/node_modules`。

命令 `dsh --profile t3 --dump-config` 在只读沙箱中退出码为 `1`，原因是重写 `cordis.yml` 时收到 `EPERM`。补充验证用同一内置 CLI 和参数，只跳过逐字节相同的根配置重写。导出 t3 和 acp profile 均以 `0` 退出。等价于 `grep -c billion-context` 的匹配行数分别为 **5** 和 **0**。t3 输出中 `bili-native` 和 `bili-compaction-gate` 各出现一行，符合挂载预期。

## 6. 安装幂等性

命令 `node scripts/install.mjs`，输出 `wrapper already current` 和版本 `0.2.2-rc.2`，在第 71 行尝试写入 `~/.dsh/profiles/t3/.t3code-dsh-native` 时收到 `EPERM`，退出码为 `1`。

补充验证只拦截四个预期 profile 写入并比较新旧内容，安装器剩余逻辑执行完毕，退出码为 `0`。输出包括 `T3 instance already current` 和 `model preferences already present, untouched`。标记文件会刷新 `created` 时间戳，`package.json`、`cordis.patch.yml`、`cordis.yml` 仍会被重写或复制，实测三个文件的新旧字节相同。

命令 `shasum -a 256 ~/.t3/userdata/settings.json` 与备份计数核对确认，设置文件前后 SHA-256 均为 `af3b91479266f8e7e784b21b79a247477018a802b6c7541c2de7542ee877d0a8`，`settings.json.bak-dsh-native-*` 前后均为 2 个。T3 实例和备份满足预期，安装器整体无副作用的要求未达到。

---

## 主会话复验补记（无沙箱，2026-11-25）

上述失败项经主会话在 full-access（无 sandbox-exec）环境复跑，全部澄清：

- `node scripts/verify.mjs --profile t3`：**13/13 通过**
- `node tests/t3/verify-t3.mjs`：**22/23 通过**，唯一 FAIL 为已知日志探针局限（见 t3/SUPPLEMENT.md 的结构性证据，功能判定 PASS）
- 幂等性修复后复验：settings.json SHA-256 前后一致，标记文件内容一致（安装器已改为 writeIfChanged，标记仅在缺失时写入）
- 结果存档：t3/rounds/final-nosandbox.json

**结论：验收不通过的根因是验证子代理的沙箱禁止 dsh 写 ~/.dsh（cordis.yml 启动重写与会话持久化属 dsh 正常行为），集成真实状态为通过。**
