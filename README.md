# t3code-dsh-native

Run **DeepSeek Harness (dsh)** as a native provider inside **T3 Code** — threads, model picker,
tool cards, reasoning stream, checkpoints, and cross-provider delegation, using only official
extension points. No T3 fork, no protocol impersonation, no third-party bridge.

Built on DeepSeek Harness. Unofficial community integration.

[中文快速开始](#中文快速开始)

## How it works

```
T3 Code (official Local ACP command driver, driverKind=acpRegistry)
  └─ spawns: dsh --profile t3            (~/.local/bin/dsh wrapper)
       └─ DeepSeek Harness.app bundled CLI (official binary, v0.2.2-rc.x)
            └─ profile "t3" = ACP app bundle + your desktop profile's plugin bundles
                 └─ shared ~/.dsh: credentials, sessions, skills, memory
```

- The `t3` dsh profile is generated from your existing `desktop` profile: every plugin bundle
  is inherited in order (billion-context, dshmarket, ...), `node_modules` is shared by symlink,
  and your `cordis.patch.yml` (default model, settings) is copied. The T3 agent therefore runs
  with the same plugins and defaults as your desktop client.
- Credentials are shared with the desktop client — no second login.
- Branding: display name `dsh`, accent color `#4D6BFE` (official DeepSeek blue, badge renders "DS").

## Requirements

- macOS with **DeepSeek Harness.app** installed (the bundled CLI is the engine)
- **T3 Code** (desktop or server)
- Node.js >= 20

## Install

### Option A — one-click agent template

Paste this into any coding agent with shell access (pi / Claude Code / Codex / OpenCode):

```text
Clone https://github.com/YMaxwellHayes/t3code-dsh-native and integrate dsh into my T3 Code:
1. node scripts/install.mjs   (idempotent; backs up T3 settings; refuses foreign paths)
2. node scripts/verify.mjs --profile t3   (expect 13/13 PASS)
3. Report the result. Do not modify anything outside the project, ~/.local/bin/dsh,
   ~/.dsh/profiles/t3, and the dsh entry in ~/.t3/userdata/settings.json.
```

A ready-to-paste version with the real repository URL is in [docs/AGENT-ONECLICK.md](docs/AGENT-ONECLICK.md).

### Option B — manual (no scripts)

1. Expose the bundled CLI:
   ```sh
   printf '#!/bin/sh\nexec "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" "$@"\n' > ~/.local/bin/dsh
   chmod +x ~/.local/bin/dsh
   ```
2. Create the ACP profile variant (or use the shipped `acp` profile and skip plugin inheritance):
   copy `~/.dsh/profiles/desktop` to `~/.dsh/profiles/t3`, replace app bundles
   (`@deepseek-ai/dsh-web-app`, TUI) with `@deepseek-ai/dsh-acp-app` right after
   `@deepseek-ai/dsh-base` in `package.json` `dsh.profile.bundles`, symlink `node_modules`.
3. T3 Code → **Settings → Providers → Add provider → Show more → Local ACP command**:
   executable `~/.local/bin/dsh` (absolute path), arguments `--profile` and `t3`,
   display name `dsh`. Optionally set accent color `#4D6BFE`.

### Option C — scripts directly

```sh
git clone https://github.com/YMaxwellHayes/t3code-dsh-native
cd t3code-dsh-native
node scripts/install.mjs
node scripts/verify.mjs --profile t3
```

## What you get (verified)

| Capability | Status |
|---|---|
| Top-level threads, streaming, tool cards, reasoning, checkpoints | verified |
| Model picker + reasoning_effort options (off/low/high/max) | verified |
| Cross-provider delegation (e.g. pi → dsh subagent) | verified |
| session list / resume / close, config persistence across resume | verified (3 rounds) |
| Plugin inheritance from desktop client (billion-context etc.) | verified (composition tree) |
| usage_update (context usage) | verified |
| Mid-turn steering, plan cards | limited: dsh speaks ACP v1; T3 queues instead |
| DeepSeek whale main icon | not possible for local ACP instances in official T3 builds (see below) |

## Branding and icon limits (source-verified)

- T3 renders local ACP instances with the generic ACP Registry icon; the instance schema has
  no custom-icon field. The badge (accent color + initials, max 2 uppercase chars) is the only
  official per-instance branding.
- The official route to the real logo is listing dsh in the
  [ACP Registry](https://github.com/agentclientprotocol/registry). A submission draft is in
  `registry-submission/dsh/`. Currently blocked upstream: dsh publishes prerelease versions
  only, while the registry schema requires plain semver and auto-follows npm `latest`.

## Verify / sync / uninstall

```sh
node scripts/verify.mjs --profile t3        # 13-point smoke check
node tests/t3/verify-t3.mjs                 # 23-item matrix (1 known probe limitation, see tests/t3/SUPPLEMENT.md)
node scripts/install.mjs                    # re-run = sync after desktop client changes
```

Uninstall: remove the `dsh` instance from `~/.t3/userdata/settings.json` (backups kept beside
it), delete `~/.dsh/profiles/t3` and `~/.local/bin/dsh`. The desktop client is never modified.

## Project layout

- `scripts/install.mjs` / `scripts/verify.mjs` — installer and smoke check (zero dependencies)
- `tests/` — independent multi-round verification suites and reports (Codex / Claude teammates)
- `assets/` — official logo SVG and app icon (from the dsh repository / desktop app)
- `docs/` — brand guidelines, deep review, one-click agent template
- `registry-submission/dsh/` — draft ACP Registry entry (agent.json + icon)

## 中文快速开始

前提：macOS 已装 DeepSeek Harness 客户端、T3 Code、Node >= 20。

一键：把 [docs/AGENT-ONECLICK.md](docs/AGENT-ONECLICK.md) 里的提示词整段粘贴给任意有 shell
权限的 agent（pi / Claude Code / Codex / OpenCode），它会自动完成安装与 13 项自检。

手动：`node scripts/install.mjs` 然后 `node scripts/verify.mjs --profile t3`。
安装器只做四件事：暴露客户端内置 CLI 为 `dsh` 命令；生成继承你桌面插件的 `t3` profile；
在 T3 注册官方 Local ACP provider（名称 dsh、品牌蓝 #4D6BFE）；写入模型排序与收藏。
凭据与你的桌面客户端共享，无需二次登录。重启 T3 后在 provider 列表选择 dsh 即可开线程。

限制：dsh 的 ACP 为 v1，中途转向会排队；本地 ACP 实例主图标为通用图标（官方发行版无自定义
图标字段），真鲸鱼标需等 dsh 登记 ACP Registry（提交稿已备）。

## License and brand

Code: MIT (see LICENSE). Brand assets belong to DeepSeek; usage follows
[docs/BRAND_GUIDELINES.md](docs/BRAND_GUIDELINES.md): the project name uses the "DSH"
abbreviation, describes itself as built on DeepSeek Harness, and claims no official endorsement.