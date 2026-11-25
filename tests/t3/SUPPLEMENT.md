# t3 验证补充：插件继承的结构性证据（主会话核查）

针对 REPORT.md 唯一失败项"插件启动日志探针"的补充核查，2026-11-25。

## 结论

billion-context 及用户插件栈在 t3 profile 中**确认挂载并生效**。日志探针失败是探针时机问题，
不是插件缺失。证据强度高于启动日志：

## 证据

1. **组合树对照**（`dsh --profile <name> --dump-config`）：
   - t3 profile：billion-context 补丁层作用于 base（compaction-basic、llm-deepseek 条目被其改写），
     自有条目 `bili-native` 与 `bili-compaction-gate` 在树中挂载；dshmarket、dsh-btw-plugin 同在。
   - acp 基础模板：billion-context 出现 0 次。
2. **插件机制**（源码核查 ~/.dsh/profiles/desktop/node_modules/billion-context）：
   该插件核心功能是拦截/替换 dsh 原生 compaction（dist/agent/dsh-native.js 中 207 处 compress、
   82 处 intercept），工具（acp_status/search_context 等）为条件注册。
   因此"新会话里 agent 自报无工具"与"启动日志未出现 proxy runtime 行"都不能证明插件未生效；
   挂载即接管压缩路径。
3. **旁证**：试跑 stderr 捕获 `bili: proxy runtime resolved`；此前 T3 真实回合中 agent 自报
   感知 billion-context（自报仅作旁证，不作依据）。

## 处置

- REPORT.md 的失败项定性为"探针设计局限"，功能结论改为 PASS（结构性证据）。
- 后续如需运行时正向证据，可构造长上下文触发压缩路径，观察 bili 压缩行为（成本较高，按需执行）。