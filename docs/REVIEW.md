# 深度审查报告 — t3code-dsh-native

审查日期：2026-11-25。审查人：主会话（Pi）。方法：代码审读 + 实证检查（权限/协议/启动日志/幂等重跑/真实回合）。

## 审查范围

install.mjs、verify.mjs、t3 profile 变体、T3 实例配置、品牌合规、安全与边界情况。

## 发现与处置

| # | 项目 | 结论 | 证据/处置 |
|---|---|---|---|
| 1 | 备份文件权限 | 通过 | settings.json 备份为 600（仅属主可读），凭据不外泄 |
| 2 | accentColor 字段真实性 | 通过 | T3 安装包含该字段；实例写入后未被服务端重写，#4D6BFE 持久 |
| 3 | session/close 方法名 | 通过 | dsh 官方 README 明确 session/close（停稳取消+drain+flush）；verify 实测 graceful |
| 4 | UI 依赖插件挂起 | 已记录 | 启动 stderr：cot-translation / dsh-think-translate / optional-terminal-panel 等待 UI 服务，pending 态惰性无害；agent 向插件（billion-context）正常激活。已写入 README 限制节 |
| 5 | verify 吞掉 close 错误 | 已修复 | 改为显式断言；重跑 13/13 通过 |
| 6 | 幂等性 | 通过 | 重跑 install：wrapper/实例判定 already current，profile 安全刷新，无重复写入 |
| 7 | 同步语义缺失 | 已修复 | README 增加 Operations 节：重跑 install 即同步桌面变更；node_modules 符号链接自动跟随 |
| 8 | 客户端升级风险 | 已记录 | 包装器路径在 app 包内稳定；升级后重跑 verify 即可确认 |
| 9 | T3 设置并发写 | 已缓解 | 备份+原子 rename；README 提示避免与 UI 编辑同时操作。残余竞态窗口存在，属可接受风险 |
| 10 | 所有权保护 | 通过 | 无标记目录拒绝触碰；外部 wrapper 拒绝覆盖；符号链接目标校验 |
| 11 | 密钥处理 | 通过 | 项目代码零密钥接触（凭据留在 ~/.dsh 共享存储）；零网络调用；零外部依赖 |
| 12 | 品牌合规 | 通过 | 项目名用 dsh 缩写；README 声明 built on / unofficial；displayName 标识真实官方二进制；官方品牌规范文档随附 |
| 13 | 路径含空格 | 通过 | 包装器对 app 路径加引号，exec "$@" 透传参数 |
| 14 | APP_BUNDLES 清单时效 | 残余风险 | 清单来自当前 dsh 版本；未来新增 app bundle 类型需更新 install.mjs（dump-config 可检出） |

## 实证记录

- 自检：13/13 PASS（含 initialize/session/new/configOptions/真实工具回合/usage_update/session/close）
- T3 真实回合：bash 工具卡片渲染正常；agent 自报感知 billion-context 插件与 t3-code MCP 注入
- 启动日志：130 个插件条目组合成功，3 个 UI 插件 pending（预期）
- 幂等重跑：无副作用

## 残余风险（接受）

1. T3 设置并发写竞态（已缓解，窗口极小）
2. dsh 开发者预览版的破坏性变更（官方声明；verify 脚本可快速检出）
3. ACP v1 协议上限（steer/计划卡片等，修复位置在 dsh 上游）

## 结论

项目达到"最原生"标准：仅用官方扩展点（Local ACP command 驱动 + 官方内置 CLI + 官方 profile 机制），
零 fork、零协议伪装、零第三方桥依赖。核心体验与内置 provider 一致并经多轮实测；
与 dsh 原生客户端的差异仅剩 UI 呈现层（headless 固有）与 ACP v1 协议上限（上游事项）。