#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (argv.length && (argv.length !== 2 || argv[0] !== '--out' || !argv[1])) {
  console.error('Usage: node verify-t3.mjs [--out result.json]');
  process.exit(2);
}

const cwd = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const timeoutMs = 120_000;
const startedAt = new Date().toISOString();
const results = [];
const preferredModel = '["deepseek-account","deepseek-flash"]';

async function check(id, test, skipReason) {
  const start = Date.now();
  let row;
  let result;
  try {
    if (skipReason) {
      row = { id, status: 'SKIP', detail: skipReason };
    } else {
      result = await test();
      row = { id, status: 'PASS', evidence: result };
    }
  } catch (error) {
    row = { id, status: 'FAIL', detail: error.message };
  }
  results.push({ ...row, elapsedMs: Date.now() - start });
  const evidence = id === 'session/new' && result ? { sessionId: result.sessionId } : row.evidence;
  console.log(row.status, id, row.detail ?? JSON.stringify(evidence ?? {}));
  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const settingsPath = join(homedir(), '.t3', 'userdata', 'settings.json');
const profilesPath = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles');
const profilePath = join(profilesPath, 't3');
await check('t3.instance', () => {
  const instance = readJson(settingsPath).providerInstances?.dsh;
  assert.equal(instance?.driver, 'acpRegistry');
  assert.deepEqual(instance.config?.commandArgs, ['--profile', 't3']);
  assert.equal(instance.accentColor, '#4D6BFE');
  return { driver: instance.driver, commandPath: instance.config.commandPath,
    commandArgs: instance.config.commandArgs, accentColor: instance.accentColor };
});
await check('t3.model_preferences', () => {
  const preferences = readJson(settingsPath).providerModelPreferences?.dsh;
  assert.equal(preferences?.modelOrder?.[0], preferredModel);
  assert.equal(new Set(preferences.modelOrder).size, preferences.modelOrder.length);
  for (const model of preferences.modelOrder) {
    const route = JSON.parse(model);
    assert.ok(Array.isArray(route) && route.length === 2 && route.every(v => typeof v === 'string' && v));
  }
  assert.deepEqual(preferences.hiddenModels, []);
  return { modelOrder: preferences.modelOrder, hiddenModels: preferences.hiddenModels };
});
await check('t3.favorites', () => {
  const favorites = readJson(settingsPath).favorites?.filter(entry => entry.provider === 'dsh');
  assert.ok(favorites?.some(entry => entry.model === preferredModel), '缺少 dsh 的 DeepSeek Flash 收藏');
  return favorites;
});
await check('profile.bundles', () => {
  const base = '@deepseek-ai/dsh-base';
  const acp = '@deepseek-ai/dsh-acp-app';
  const web = '@deepseek-ai/dsh-web-app';
  const tui = '@deepseek-harness-tui/dsh-tui';
  const desktopPath = join(profilesPath, 'desktop');
  const desktop = readJson(join(desktopPath, 'package.json')).dsh.profile.bundles;
  const bundles = readJson(join(profilePath, 'package.json')).dsh.profile.bundles;
  assert.ok(bundles.includes(acp));
  assert.ok(!bundles.includes(web));
  assert.deepEqual(bundles.filter(bundle => bundle !== acp), desktop.filter(bundle => ![web, tui].includes(bundle)));
  assert.equal(bundles.length, 17);
  assert.equal(realpathSync(join(profilePath, 'node_modules')), realpathSync(join(desktopPath, 'node_modules')));
  return {
    acp, sharedCount: bundles.length - 1, pluginCountExcludingBase: bundles.length - 2,
    base, excludedDesktopBundles: [web, tui], sharedNodeModules: true, bundles,
  };
});

const child = spawn('dsh', ['--profile', 't3'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
const exited = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
const updates = [];
let sessionId;
const pluginLog = [];
const transportErrors = [];
const pending = new Map();
let nextId = 0;
let transportFailure;
let permissionToolId;

function failTransport(error) {
  transportFailure ??= error;
  for (const finish of pending.values()) finish(error);
}

child.on('error', failTransport);
child.stdin.on('error', failTransport);
child.on('exit', (code, signal) => failTransport(new Error(`dsh 退出（code=${code}, signal=${signal}）`)));
stderr.on('line', line => {
  if (/\bbili:|billion-context|\bdid not activate\b|: pending \(waiting for/i.test(line)) {
    pluginLog.push(line.replace(/(https?:\/\/)[^\s]+/gi, '$1[redacted]'));
  }
});

lines.on('line', line => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
    assert.equal(message?.jsonrpc, '2.0');
  } catch {
    transportErrors.push('stdout 收到非 JSON-RPC 帧');
    return;
  }
  if (message.method && message.id !== undefined) {
    const allow = permissionToolId !== undefined && message.params?.toolCall?.toolCallId === permissionToolId
      && message.params?.sessionId === sessionId;
    const option = allow && message.params?.options?.find(item => item.kind === 'allow_once');
    const reply = message.method === 'session/request_permission'
      ? { result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } }
      : { error: { code: -32601, message: 'Method not found' } };
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply }) + '\n');
  } else if (message.method === 'session/update') {
    updates.push(message.params);
    const update = message.params?.update;
    if (update?.sessionUpdate === 'tool_call' && isExpectedTool(update)) {
      permissionToolId = update.toolCallId;
    }
  } else if (message.id !== undefined) {
    pending.get(message.id)?.(null, message);
  }
});

function request(method, params) {
  if (transportFailure) return Promise.reject(transportFailure);
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const finish = (error, response) => {
      clearTimeout(timer);
      pending.delete(id);
      if (error) reject(error);
      else resolve(response);
    };
    const timer = setTimeout(() => finish(new Error(`${method} 超时（${timeoutMs} ms）`)), timeoutMs);
    pending.set(id, finish);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
      error => { if (error) finish(error); });
  });
}

async function rpc(method, params) {
  const response = await request(method, params);
  if (response.error) throw new Error(`${method} [${response.error.code}]: ${response.error.message}`);
  assert.ok(Object.hasOwn(response, 'result'), `${method} 缺少 result`);
  return response.result;
}

const effortOption = options => options?.find(item => item.id === 'reasoning_effort');
const marker = 'dsh-t3-echo';
const command = `echo ${marker}`;

function isExpectedTool(update) {
  return /^bash$/i.test(update.title) && update.rawInput?.command?.trim() === command;
}

function sessionUpdatesSince(offset, sessionId) {
  return updates.slice(offset).filter(params => params?.sessionId === sessionId).map(params => params.update);
}

async function prompt(sessionId, text) {
  const offset = updates.length;
  const response = await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  const events = sessionUpdatesSince(offset, sessionId);
  const reply = events.filter(item => item.sessionUpdate === 'agent_message_chunk' && item.content?.type === 'text')
    .map(item => item.content.text).join('').trim();
  return { stopReason: response?.stopReason, events, reply };
}

const initialization = await check('initialize', async () => {
  const result = await rpc('initialize', {
    protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'verify-t3', version: '1' },
  });
  assert.equal(result?.protocolVersion, 1);
  assert.equal(result.agentInfo?.name, 'deepseek-harness-acp');
  return { protocolVersion: result.protocolVersion, agentInfo: result.agentInfo,
    sessionCapabilities: result.agentCapabilities?.sessionCapabilities ?? {} };
});
const session = await check('session/new', async () => {
  const result = await rpc('session/new', { cwd, mcpServers: [] });
  assert.ok(typeof result?.sessionId === 'string' && result.sessionId);
  return { sessionId: result.sessionId, configOptions: result.configOptions };
}, initialization ? undefined : 'initialize 未通过');
sessionId = session?.sessionId;
const withoutSession = sessionId ? undefined : 'session/new 未通过';

const initial = await check('configOptions.read', () => {
  const model = session.configOptions?.find(item => item.id === 'model');
  const effort = effortOption(session.configOptions);
  const modelRoute = JSON.parse(model?.currentValue ?? 'null');
  assert.ok(Array.isArray(modelRoute) && modelRoute.length === 2 && modelRoute.every(v => typeof v === 'string' && v));
  assert.equal(effort?.type, 'select');
  const values = effort.options.map(item => item.value);
  assert.ok(values.includes(effort.currentValue));
  return { model: model.currentValue, currentValue: effort.currentValue, values };
}, withoutSession);
const changed = await check('configOptions.set_readback', async () => {
  const requested = ['off', 'low', ...initial.values].find(value => value !== initial.currentValue && initial.values.includes(value));
  assert.notEqual(requested, undefined, '没有其他可选的 reasoning_effort');
  const response = await rpc('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: requested });
  const readback = effortOption(response?.configOptions)?.currentValue;
  assert.equal(readback, requested);
  assert.equal(response.configOptions.find(item => item.id === 'model')?.currentValue, initial.model);
  return { previous: initial.currentValue, requested, readback };
}, initial ? undefined : 'configOptions.read 未通过');

let firstTurn;
const turns = [];
const prompts = [
  [`Use bash: ${command}. Reply with stdout only.`, marker],
  ['Reply with OK2 only.', 'OK2'],
  ['Reply with OK3 only.', 'OK3'],
];

for (const [index, [instruction, expected]] of prompts.entries()) {
  const turn = await check(`prompt.turn_${index + 1}`, async () => {
    const response = await prompt(sessionId, instruction);
    if (index === 0) firstTurn = response;
    assert.equal(response.stopReason, 'end_turn');
    assert.equal(response.reply, expected);
    return { stopReason: response.stopReason, reply: response.reply,
      usageUpdates: response.events.filter(item => item.sessionUpdate === 'usage_update').length };
  }, withoutSession);
  turns.push(turn);
}

await check('prompt.bash_echo', () => {
  const call = firstTurn?.events.find(item => item.sessionUpdate === 'tool_call' && isExpectedTool(item));
  assert.ok(call?.toolCallId, '缺少执行指定 echo 的 bash tool_call');
  const completion = firstTurn.events.find(item => item.sessionUpdate === 'tool_call_update'
    && item.toolCallId === call.toolCallId && item.status === 'completed');
  assert.ok(completion, '同一 toolCallId 缺少 completed 更新');
  const stdout = completion.content?.filter(item => item.type === 'content' && item.content?.type === 'text')
    .map(item => item.content.text).join('\n');
  assert.ok(stdout?.split(/\r?\n/).some(line => line.trim() === marker), '工具结果缺少预期 stdout');
  return { command, toolCallId: call.toolCallId, status: completion.status, stdout: marker };
}, withoutSession);
await check('prompt.usage_update', () => {
  const usage = firstTurn?.events.filter(item => item.sessionUpdate === 'usage_update') ?? [];
  assert.ok(usage.length, '工具回合缺少 usage_update');
  assert.ok(usage.every(({ used, size }) => Number.isFinite(used) && used > 0 && Number.isFinite(size) && size > 0),
    'usage_update 的 used 或 size 无效');
  return usage.map(({ used, size }) => ({ used, size }));
}, withoutSession);
await check('prompt.three_turns', () => {
  assert.ok(turns.every(Boolean), '同一会话的三个连续回合存在失败');
  return { turns: turns.length };
}, withoutSession);
await check('rpc.unknown_method', async () => {
  const response = await request('verify-t3/nonexistent', {});
  assert.equal(response.error?.code, -32601);
  assert.equal(Object.hasOwn(response, 'result'), false);
  return { code: response.error.code };
});

const closed = await check('session/close', async () => {
  await rpc('session/close', { sessionId });
  return { sessionId };
}, withoutSession);
await check('session/list', async () => {
  const result = await rpc('session/list', { cwd });
  assert.ok(Array.isArray(result?.sessions));
  assert.ok(result.sessions.some(item => item.sessionId === sessionId && item.cwd === cwd),
    '按 cwd 过滤的首页缺少刚关闭的会话');
  return { count: result.sessions.length, foundSession: sessionId };
}, closed ? undefined : 'session/close 未通过');

const resumeAdvertised = Object.hasOwn(initialization?.sessionCapabilities ?? {}, 'resume');
const resumed = await check('session/resume', async () => {
  const result = await rpc('session/resume', { sessionId, cwd, mcpServers: [] });
  const readback = effortOption(result?.configOptions)?.currentValue;
  assert.equal(typeof readback, 'string');
  return { sessionId, readback, expected: changed?.requested };
}, !closed ? 'session/close 未通过' : resumeAdvertised ? undefined : 'initialize 未声明 resume');
if (resumed) {
  await check('session/resume.readback', () => {
    assert.equal(resumed.readback, changed.requested);
    return { readback: resumed.readback };
  }, changed ? undefined : 'configOptions.set_readback 未通过');
  await check('session/resume.close', async () => {
    await rpc('session/close', { sessionId });
    return { sessionId };
  });
} else {
  await check('session/resume.readback', null, 'session/resume 未完成');
  await check('session/resume.close', null, 'session/resume 未完成');
}

await check('process.stdin_eof', async () => {
  const eofAt = Date.now();
  const interventions = [];
  child.stdin.end();
  const term = setTimeout(() => {
    if (child.kill('SIGTERM')) interventions.push('SIGTERM');
  }, 5000);
  const kill = setTimeout(() => {
    if (child.kill('SIGKILL')) interventions.push('SIGKILL');
  }, 10_000);
  try {
    const exit = await exited;
    const observed = { ...exit, interventions, elapsedMs: Date.now() - eofAt };
    assert.ok(!interventions.length && exit.code === 0 && exit.signal === null,
      `stdin EOF 后退出异常 ${JSON.stringify(observed)}`);
    return observed;
  } finally {
    clearTimeout(term);
    clearTimeout(kill);
  }
});
await check('transport.ndjson', () => {
  assert.deepEqual(transportErrors, []);
  return { nonJsonRpcFrames: transportErrors.length };
});
await check('profile.plugin_startup', () => {
  const pendingPlugins = pluginLog.flatMap(line => line.match(/^([^ ]+) .*: pending \(waiting for/)?.[1] ?? []);
  assert.deepEqual([...new Set(pendingPlugins)].sort(), ['cot-translation', 'dsh-think-translate', 'optional-terminal-panel']);
  assert.ok(pluginLog.some(line => line.includes('bili: proxy runtime resolved')), '缺少 billion-context 初始化日志');
  return { pendingPlugins, billionContextRuntimeResolved: true };
});

const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
for (const row of results) counts[row.status]++;
const report = { profile: 't3', startedAt, finishedAt: new Date().toISOString(), cwd, counts, results, pluginLog };
if (argv[1]) writeFileSync(argv[1], JSON.stringify(report, null, 2) + '\n');
console.log('SUMMARY', JSON.stringify(counts));
process.exitCode = counts.FAIL ? 1 : 0;
