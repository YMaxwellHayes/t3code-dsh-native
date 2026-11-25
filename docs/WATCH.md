# Stable-release watch / 稳定版监视

Daily scheduled task (09:00 local) checks npm dist-tags and GitHub releases for a
plain-semver stable dsh release. When found, it automatically:

1. updates registry-submission/dsh/agent.json (version + npx pin)
2. forks agentclientprotocol/registry and opens the "Add DeepSeek Harness (dsh)" PR
   with the monochrome icon and verification evidence
3. commits the updated draft back to this repo and reports the PR link

Until then it reports a one-line status. Manual trigger: ask the agent to run the
watch prompt now.
