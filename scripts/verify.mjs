#!/usr/bin/env node
// Post-install smoke check for t3code-dsh-native.
// Usage: node scripts/verify.mjs [--profile t3]
// Checks: CLI wrapper, profile composition, ACP initialize, session/new, configOptions,
// one real prompt round with a bash tool call. Zero dependencies.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const argProfile = process.argv.indexOf('--profile');
const PROFILE = argProfile > -1 ? process.argv[argProfile + 1] : 't3';
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// static checks
const wrapper = join(homedir(), '.local/bin/dsh');
check('dsh wrapper exists', existsSync(wrapper));
const profileDir = join(DSH_HOME, 'profiles', PROFILE);
check(`profile ${PROFILE} exists`, existsSync(profileDir));
if (existsSync(join(profileDir, 'package.json'))) {
  const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  const bundles = pkg.dsh?.profile?.bundles || [];
  check('ACP app bundle present', bundles.includes('@deepseek-ai/dsh-acp-app'));
  check('no desktop app bundle', !bundles.includes('@deepseek-ai/dsh-web-app'));
}
const settingsPath = join(homedir(), '.t3/userdata/settings.json');
if (existsSync(settingsPath)) {
  const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const inst = s.providerInstances?.dsh;
  check('T3 instance registered', inst?.driver === 'acpRegistry' && inst?.config?.commandArgs?.[1] === PROFILE,
    inst ? `args=${JSON.stringify(inst.config?.commandArgs)}` : 'missing');
}

// live ACP checks
const child = spawn(wrapper, ['--profile', PROFILE], { stdio: ['pipe', 'pipe', 'pipe'] });
const rl = createInterface({ input: child.stdout });
let stderr = '';
child.stderr.on('data', d => { stderr += d; });
const pending = new Map();
let nextId = 0;
rl.on('line', line => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  } catch {}
});
function request(method, params, timeoutMs = 120000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
    pending.set(id, { resolve: msg => { clearTimeout(timer); resolve(msg); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const deadline = setTimeout(() => { console.log('FAIL  global deadline\nstderr:', stderr.slice(-500)); child.kill(); process.exit(1); }, 240000);

try {
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 60000);
  check('ACP initialize', !!init.result, init.result ? `protocol v${init.result.protocolVersion}` : JSON.stringify(init.error));

  const session = await request('session/new', { cwd: homedir(), mcpServers: [] }, 60000);
  const sessionId = session.result?.sessionId;
  check('session/new', !!sessionId, sessionId || JSON.stringify(session.error));

  if (sessionId) {
    const opts = session.result?.configOptions || [];
    check('configOptions advertised', opts.length > 0, `${opts.length} options`);

    const updates = [];
    const onLine = line => { try { const m = JSON.parse(line); if (m.method === 'session/update') updates.push(m.params); } catch {} };
    rl.on('line', onLine);
    const prompt = await request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Run exactly this command with your bash tool: echo dsh-native-ok . Then reply with the command output only.' }],
    });
    rl.off('line', onLine);
    const toolUpdates = updates.filter(u => ['tool_call', 'tool_call_update'].includes(u.update?.sessionUpdate));
    const text = updates.filter(u => u.update?.sessionUpdate === 'agent_message_chunk')
      .map(u => u.update?.content?.text || '').join('');
    check('prompt round completed', prompt.result?.stopReason === 'end_turn', `stopReason=${prompt.result?.stopReason}`);
    check('tool call streamed', toolUpdates.length > 0, `${toolUpdates.length} tool updates`);
    check('agent answered with tool output', text.includes('dsh-native-ok'), text.slice(0, 80));
    check('usage_update observed', updates.some(u => u.update?.sessionUpdate === 'usage_update'));
    const close = await request('session/close', { sessionId }, 30000).catch(e => ({ error: { message: e.message } }));
    check('session/close', !close.error, close.error ? JSON.stringify(close.error) : 'graceful');
  }
} catch (err) {
  check('live checks', false, err.message + ' | stderr: ' + stderr.slice(-300));
} finally {
  clearTimeout(deadline);
  child.kill();
}
const failed = results.filter(r => !r.ok).length;
console.log(`\nSUMMARY: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);