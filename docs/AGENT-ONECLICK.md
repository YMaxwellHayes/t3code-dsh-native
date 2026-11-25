# One-click agent template / 一键执行模板

Paste the block below into any coding agent with shell access (pi, Claude Code, Codex,
OpenCode, ...). It performs the full integration and verification autonomously.
把下面整段粘贴给任意有 shell 权限的 agent，即可自动完成接入与验证。

```text
Task: integrate DeepSeek Harness (dsh) into my T3 Code as a native provider.

Repository: https://github.com/YMaxwellHayes/t3code-dsh-native

Steps:
1. git clone https://github.com/YMaxwellHayes/t3code-dsh-native ~/t3code-dsh-native
   (if the directory exists, git -C ~/t3code-dsh-native pull instead)
2. cd ~/t3code-dsh-native && node scripts/install.mjs
   - exposes the DeepSeek Harness.app bundled CLI as ~/.local/bin/dsh
   - creates ~/.dsh/profiles/t3 inheriting my desktop profile's plugins
   - registers the T3 provider instance "dsh" (official Local ACP command driver)
   - idempotent; backs up T3 settings; refuses to touch foreign paths
3. node scripts/verify.mjs --profile t3
   - expect SUMMARY: 13/13 passed; if anything fails, print the failing line and stop
4. Optional deeper matrix: node tests/t3/verify-t3.mjs
   - expect 22/23; the single known FAIL is a plugin-log probe limitation,
     explained in tests/t3/SUPPLEMENT.md (functional status PASS)
5. Report: install log tail, verify summary, and remind me to restart T3 Code
   (or refresh providers in Settings) so the new instance appears.

Constraints: do not modify anything outside ~/t3code-dsh-native, ~/.local/bin/dsh,
~/.dsh/profiles/t3, and the "dsh" entry (plus its model preferences/favorites) in
~/.t3/userdata/settings.json. Never print API keys. No emojis in your report.
```

## Notes / 说明

- Requirements: macOS + DeepSeek Harness.app + T3 Code + Node >= 20.
- Credentials are shared with the desktop client (`~/.dsh`); no second login.
- After install, pick `dsh` in the T3 provider list and start a thread; the model picker
  shows your desktop default first (DeepSeek Account Flash) with reasoning_effort options.
- 安装后在 T3 provider 列表选 dsh 开线程即可；模型选择器首位为你桌面客户端的默认模型。