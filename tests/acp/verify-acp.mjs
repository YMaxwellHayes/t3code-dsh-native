#!/usr/bin/env node
/**
 * verify-acp.mjs — dsh (DeepSeek Harness) ACP 接入的深度验证矩阵（零依赖）。
 *
 * 用法：
 *   node verify-acp.mjs --profile acp
 *   node verify-acp.mjs --profile acp --out rounds/round-1.json
 *
 * 与 scripts/verify.mjs 相比新增/加深：cancel 三种时机、cancel 后恢复、
 * close 打断在飞回合、并发 prompt 拒绝、并行会话隔离、resume 配置保持与上下文连续性、
 * 错误码矩阵（含 content block 类型）、list 语义与 cursor、JSON-RPC 传输层容错、连续多回合稳定性。
 *
 * 每一步独立超时 120 秒；失败时打印该步骤的原始帧与 dsh stderr 尾部。
 * 退出码 0 = 全通过（INFO 不影响），1 = 存在 FAIL，2 = 崩溃。
 */

import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { existsSync, readFileSync, writeFileSync, realpathSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKDIR = resolvePath(HERE, '..')          // tests/
const DSH_BIN = join(os.homedir(), '.local', 'bin', 'dsh')
const DSH_HOME = join(os.homedir(), '.dsh')
const T3_SETTINGS = join(os.homedir(), '.t3', 'userdata', 'settings.json')
const STEP_TIMEOUT = 120_000

const argv = process.argv.slice(2)
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const PROFILE = argOf('--profile', 'acp')
const outArg = argOf('--out', undefined)
const outPath = outArg === undefined ? undefined : resolvePath(process.cwd(), outArg)

const results = []
const startedAt = Date.now()
const runId = `acp-${new Date().toISOString().replace(/[:.]/g, '-')}`

function record(id, name, status, detail, data) {
  const entry = { id, name, status, detail, ...(data === undefined ? {} : { data }) }
  results.push(entry)
  console.log(`${status.padEnd(4)} [${id}] ${name}${detail ? ` — ${detail}` : ''}`)
  return entry
}
const pass = (id, name, detail, data) => record(id, name, 'PASS', detail, data)
const info = (id, name, detail, data) => record(id, name, 'INFO', detail, data)
const fail = (id, name, detail, data) => record(id, name, 'FAIL', detail, data)
const skip = (id, name, detail) => record(id, name, 'SKIP', detail)
const assert = (cond, msg) => { if (!cond) throw new Error(msg) }

const jsonOf = (v) => { try { const s = JSON.stringify(v); return s === undefined ? String(v) : s } catch { return String(v) } }
const textOf = (u) => {
  const c = u?.content
  if (c === undefined || c === null) return ''
  if (Array.isArray(c)) return c.map((i) => (i?.content?.type === 'text' ? i.content.text : JSON.stringify(i))).join('\n')
  if (typeof c === 'object' && c.type === 'text') return String(c.text ?? '')
  return JSON.stringify(c)
}
/** 重新设定超时上限；步骤本身仍以 STEP_TIMEOUT 为界。 */
const withTimeout = (p, label, ms = STEP_TIMEOUT) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: 步骤超时 ${ms}ms`)), ms)),
])

/* ---------------- ACP JSON-RPC over stdio ---------------- */

class AcpClient {
  constructor({ command = DSH_BIN, args = ['--profile', PROFILE], cwd = WORKDIR, label = PROFILE } = {}) {
    this.label = label
    this.frames = []
    this.pending = new Map()
    this.nextId = 0
    this.handlers = new Set()
    this.serverRequests = []
    this.stderr = ''
    this.exitInfo = undefined
    this.exited = undefined
    this.child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
    this.child.on('error', (e) => { this.stderr += `\n[spawn error] ${e.message}` })
    this.child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal }
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`dsh 已退出(code=${code},signal=${signal})，仍在等 ${p.method}(id=${id})`))
        this.pending.delete(id)
      }
      if (this.exited) this.exited()
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (d) => {
      this.stderr += d
      if (this.stderr.length > 100_000) this.stderr = this.stderr.slice(-50_000)
    })
    this.child.stdout.setEncoding('utf8')
    this.rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    this.rl.on('line', (line) => this.onLine(line))
    this.lastActivity = Date.now()
  }

  onLine(line) {
    const raw = line.trim()
    if (raw === '') return
    this.lastActivity = Date.now()
    let msg
    try { msg = JSON.parse(raw) } catch {
      this.frames.push({ dir: 'nonjson', t: Date.now(), raw })
      return
    }
    this.frames.push({ dir: 'in', t: Date.now(), msg })
    if (this.frames.length > 4000) this.frames.splice(0, this.frames.length - 4000)
    // 服务端 -> 客户端 请求
    if (msg.method !== undefined && msg.id !== undefined && msg.id !== null) {
      this.serverRequests.push(msg)
      this.send({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'session/request_permission'
        ? { outcome: { outcome: 'selected', optionId: 'allow-once' } } : {} })
      return
    }
    if (msg.method !== undefined) {
      for (const h of this.handlers) { try { h(msg) } catch { /* 订阅者异常隔离 */ } }
      return
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (p === undefined) { this.frames.push({ dir: 'orphan', t: Date.now(), msg }); return }
      clearTimeout(p.timer)
      this.pending.delete(msg.id)
      if (msg.error !== undefined) {
        const err = new Error(`${msg.error.message} (code=${msg.error.code})`)
        err.rpc = msg.error
        p.reject(err)
      } else p.resolve(msg.result)
    }
  }

  send(obj) {
    this.frames.push({ dir: 'out', t: Date.now(), msg: obj })
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) throw new Error('dsh stdin 已关闭')
    this.child.stdin.write(`${JSON.stringify(obj)}\n`)
  }

  writeRaw(text) {
    this.frames.push({ dir: 'out-raw', t: Date.now(), raw: text })
    this.child.stdin.write(text)
  }

  request(method, params, timeoutMs = STEP_TIMEOUT) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`等待 ${method} 超时(${timeoutMs}ms,id=${id})`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      try { this.send({ jsonrpc: '2.0', id, method, params }) } catch (e) {
        clearTimeout(timer); this.pending.delete(id); reject(e)
      }
    })
  }

  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }) }
  onNotification(h) { this.handlers.add(h); return () => this.handlers.delete(h) }

  async quiet(quietMs = 200, maxMs = 3000) {
    const end = Date.now() + maxMs
    while (Date.now() < end) {
      if (Date.now() - this.lastActivity >= quietMs) return
      await new Promise((r) => setTimeout(r, 30))
    }
  }

  dumpFrames(from, max = 40) {
    const slice = this.frames.slice(Math.max(0, from ?? 0)).slice(-max)
    console.log(`\n----- 原始帧 [${this.label}]（${slice.length} 帧）-----`)
    for (const f of slice) {
      if (f.dir === 'nonjson' || f.dir === 'out-raw') console.log(`[${f.dir}] ${String(f.raw).slice(0, 600)}`)
      else console.log(`[${f.dir}] ${JSON.stringify(f.msg).slice(0, 1500)}`)
    }
    if (this.stderr.trim() !== '') {
      console.log('----- dsh stderr（尾部 2000 字符）-----')
      console.log(this.stderr.slice(-2000))
    }
    console.log('----- 帧结束 -----\n')
  }

  async shutdown() {
    try { this.child.stdin.end() } catch { /* ignore */ }
    const exited = await Promise.race([
      new Promise((r) => { if (this.exitInfo !== undefined) r(true); else this.exited = () => r(true) }),
      new Promise((r) => setTimeout(() => r(false), 8000)),
    ])
    if (!exited) {
      try { this.child.kill('SIGTERM') } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1000))
      try { this.child.kill('SIGKILL') } catch { /* ignore */ }
    }
    try { this.rl.close() } catch { /* ignore */ }
    return { exited, exitInfo: this.exitInfo }
  }
}

/** 执行一个 prompt 并收集该会话的 update；支持 cancel 触发条件。 */
async function runPrompt(client, sessionId, text, hooks = {}) {
  const updates = []
  let cancelled = false
  let cancelTimer
  const cancel = () => {
    if (cancelled) return
    cancelled = true
    client.notify('session/cancel', { sessionId })
  }
  const off = client.onNotification((msg) => {
    if (msg.method !== 'session/update' || msg.params?.sessionId !== sessionId) return
    const u = msg.params.update
    if (u === undefined) return
    updates.push(u)
    if (hooks.cancelOnFirstUpdate) cancel()
    if (hooks.cancelOnSessionUpdate === u.sessionUpdate) cancel()
    if (hooks.onUpdate) hooks.onUpdate(u)
  })
  if (hooks.cancelAfterMs !== undefined) cancelTimer = setTimeout(cancel, hooks.cancelAfterMs)
  const t0 = Date.now()
  try {
    const res = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
    await client.quiet()
    return { res, updates, ms: Date.now() - t0, cancelled }
  } finally {
    if (cancelTimer !== undefined) clearTimeout(cancelTimer)
    off()
  }
}

function dumpTurn(label, turn) {
  console.log(`  · ${label}: stopReason=${turn.res?.stopReason} elapsed=${turn.ms}ms updates=${turn.updates.length}`)
  const kinds = {}
  for (const u of turn.updates) kinds[u.sessionUpdate] = (kinds[u.sessionUpdate] ?? 0) + 1
  console.log(`    kinds=${jsonOf(kinds)}`)
}

/* ---------------- 步骤执行器 ---------------- */

async function guarded(client, id, name, fn) {
  const from = client?.frames.length ?? 0
  try {
    const out = await withTimeout(Promise.resolve().then(fn), `${id} ${name}`)
    if (out === undefined || out === null) { pass(id, name, 'ok'); return true }
    if (typeof out === 'string') { pass(id, name, out); return out }
    pass(id, name, out.detail, out.data)
    return out
  } catch (err) {
    fail(id, name, err.message)
    if (process.env.VERIFY_DEBUG === '1' && err.stack) console.log(err.stack)
    if (client) client.dumpFrames(from, 40)
    return undefined
  }
}

/* ---------------- 各项步骤 ---------------- */

function stepEnv() {
  assert(existsSync(DSH_BIN), `dsh 包装器不存在: ${DSH_BIN}`)
  assert(existsSync(join(DSH_HOME, 'profiles', PROFILE, 'package.json')), `profile ${PROFILE} 不存在`)
  const pkg = JSON.parse(readFileSync(join(DSH_HOME, 'profiles', PROFILE, 'package.json'), 'utf8'))
  const bundles = pkg?.dsh?.profile?.bundles ?? []
  assert(bundles.includes('@deepseek-ai/dsh-acp-app'), `profile ${PROFILE} 缺 dsh-acp-app bundle: ${jsonOf(bundles)}`)
  const settings = existsSync(T3_SETTINGS) ? JSON.parse(readFileSync(T3_SETTINGS, 'utf8')) : undefined
  const inst = settings?.providerInstances?.dsh
  return {
    detail: `profile=${PROFILE} bundles=${bundles.length} dsh-settings=${inst ? `${inst.driver} ${jsonOf(inst.config?.commandArgs)}` : '无'}`,
    data: { profile: PROFILE, bundles, t3Args: inst?.config?.commandArgs },
  }
}

function stepVersion() {
  return new Promise((resolve, reject) => {
    const child = spawn(DSH_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('exit', (code) => {
      const v = out.trim()
      if (code !== 0) return reject(new Error(`dsh --version 退出码 ${code}: ${v.slice(0, 200)}`))
      if (!/\d+\.\d+\.\d+/.test(v)) return reject(new Error(`版本输出异常: ${v.slice(0, 200)}`))
      resolve({ detail: v, data: { version: v } })
    })
  })
}

async function stepInitialize(client) {
  const res = await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  })
  assert(res?.protocolVersion === 1, `protocolVersion=${res?.protocolVersion}`)
  assert(res.agentInfo?.name === 'deepseek-harness-acp', `agentInfo.name=${res.agentInfo?.name}`)
  assert(Array.isArray(res.authMethods) && res.authMethods.length === 0, `authMethods=${jsonOf(res.authMethods)}`)
  const caps = res.agentCapabilities ?? {}
  for (const k of ['close', 'list', 'resume']) assert(k in (caps.sessionCapabilities ?? {}), `sessionCapabilities.${k} 缺失`)
  assert(caps.promptCapabilities?.image === false, `promptCapabilities.image=${caps.promptCapabilities?.image}`)
  return {
    detail: `${res.agentInfo.name}@${res.agentInfo.version} authMethods=[] sessionCaps=${Object.keys(caps.sessionCapabilities).join('/')} ` +
      `image=${caps.promptCapabilities?.image} http=${caps.mcpCapabilities?.http}`,
    data: res,
  }
}

async function stepVersionNegotiation(client) {
  const res = await client.request('initialize', { protocolVersion: 99, clientCapabilities: {} }, 30_000)
  assert(res?.protocolVersion === 1, `请求 99 时返回 protocolVersion=${res?.protocolVersion}，期望回落 1`)
  const again = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 30_000)
  assert(again?.protocolVersion === 1, '重复 initialize 失败')
  return `请求 99 -> 回落 1；重复 initialize 幂等`
}

async function stepNewSession(client) {
  const res = await client.request('session/new', { cwd: WORKDIR, mcpServers: [] })
  assert(typeof res?.sessionId === 'string' && res.sessionId.length > 0, 'sessionId 缺失')
  assert(Array.isArray(res.configOptions) && res.configOptions.length >= 1, `configOptions=${jsonOf(res.configOptions)}`)
  return { detail: `sessionId=${res.sessionId} configOptions=${res.configOptions.map((o) => o.id).join(',')}`,
    data: { sessionId: res.sessionId, ids: res.configOptions.map((o) => o.id) }, raw: res }
}

function stepConfigRead(res) {
  const opts = res.configOptions
  const model = opts.find((o) => o.id === 'model')
  assert(model !== undefined, '缺 model 项')
  assert(model.type === 'select', `model.type=${model.type}`)
  let parsed
  try { parsed = JSON.parse(model.currentValue) } catch { throw new Error(`model.currentValue 非 JSON: ${model.currentValue}`) }
  assert(Array.isArray(parsed) && parsed.length === 2 && parsed.every((x) => typeof x === 'string'),
    `model.currentValue=${model.currentValue}`)
  const reasoning = opts.find((o) => o.id === 'reasoning_effort')
  assert(reasoning !== undefined, '缺 reasoning_effort 项')
  assert(reasoning.type === 'select', `reasoning_effort.type=${reasoning.type}`)
  const values = (reasoning.options ?? []).map((o) => String(o.value)).filter((v) => v !== '')
  const sorted = [...new Set(values)].sort()
  assert(jsonOf(sorted) === jsonOf(['high', 'low', 'max', 'off']), `reasoning 值集=${jsonOf(sorted)}`)
  return {
    detail: `model=${parsed[0]}/${parsed[1]}（${model.options?.length ?? 0} 组） reasoning 当前=${reasoning.currentValue} 可选=${values.join('/')}`,
    data: { model: parsed, reasoningCurrent: reasoning.currentValue, reasoningValues: values },
    modelOpt: model, reasoningOpt: reasoning,
  }
}

async function stepConfigSet(client, sessionId, cfg) {
  const set = async (value) => {
    const r = await client.request('session/set_config_option', { sessionId, configId: 'reasoning_effort', value })
    const o = r.configOptions.find((x) => x.id === 'reasoning_effort')
    assert(o !== undefined, '返回缺 reasoning_effort')
    return o.currentValue
  }
  assert(await set('low') === 'low', '设置 low 回读不符')
  assert(await set('max') === 'max', '设置 max 回读不符')
  assert(await set('off') === 'off', '设置 off 回读不符')
  assert(await set('low') === 'low', '设置 low(还原) 回读不符')
  // 非法值：应 -32602 且不改变状态
  let code
  try { await client.request('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: 'ultra-max' }) }
  catch (e) { code = e.rpc?.code }
  assert(code === -32602, `非法 effort 错误码=${code}`)
  // 重选 model 会把 reasoning 重置为 provider 默认（上游行为），这里再设回 low 供后续 resume 比对
  const after = await client.request('session/set_config_option', {
    sessionId, configId: 'model', value: cfg.modelOpt.currentValue,
  })
  const reset = after.configOptions.find((x) => x.id === 'reasoning_effort')?.currentValue
  const restored = await client.request('session/set_config_option', {
    sessionId, configId: 'reasoning_effort', value: 'low',
  })
  const cur = restored.configOptions.find((x) => x.id === 'reasoning_effort')?.currentValue
  assert(cur === 'low', `重新设置后 reasoning=${cur}`)
  return {
    detail: `low->max->off->low 回读全对；非法值 ultra-max 返回 -32602；模型重选同值后 effort 重置为 ${reset}，再设回 low`,
    data: { afterInvalid: code, reasoningAfterModelReselect: reset, expectedEffortOnResume: cur },
  }
}

async function stepModelSwitch(client) {
  const fresh = await client.request('session/new', { cwd: WORKDIR, mcpServers: [] })
  const sid = fresh.sessionId
  const state = (r) => ({
    model: r.configOptions.find((o) => o.id === 'model')?.currentValue,
    reasoning: r.configOptions.find((o) => o.id === 'reasoning_effort')?.currentValue,
    values: (r.configOptions.find((o) => o.id === 'model')?.options ?? []).flatMap((g) => g.options.map((o) => o.value)),
  })
  try {
    const base = state(fresh)
    await client.request('session/set_config_option', { sessionId: sid, configId: 'reasoning_effort', value: 'low' })
    const pro = JSON.stringify(['deepseek-official', 'deepseek-v4-pro'])
    let switched
    try {
      switched = state(await client.request('session/set_config_option', { sessionId: sid, configId: 'model', value: pro }))
    } catch (e) {
      info('CFG-04', '模型切换探测', `切换到 v4-pro 失败 code=${e.rpc?.code} ${e.rpc?.message}`)
      return '模型切换不可用（目录中无 v4-pro）'
    }
    info('CFG-04a', '切换模型后 reasoning_effort 回到默认（上游行为）',
      `${base.reasoning} -> ${switched.reasoning}（model-control.ts set(model) 用不含 reasoningEffort 的 selection）`)
    let back
    try { back = { ok: true, ...state(await client.request('session/set_config_option', { sessionId: sid, configId: 'model', value: base.model })) } }
    catch (e) { back = { ok: false, code: e.rpc?.code, message: e.rpc?.message } }
    if (back.ok) info('CFG-04b', '可切回初始模型', `当前=${back.model}`)
    else info('CFG-04b', '无法切回初始模型（目录不含该 model，仅作为当前值注入）',
      `code=${back.code} msg=${back.message}`)
    return {
      detail: `初始 ${base.model}/${base.reasoning}；切 v4-pro 成功，reasoning=${switched.reasoning}；切回${back.ok ? '成功' : `被拒(-32602)`}`,
      data: { base, switched, back },
    }
  } finally {
    try { await client.request('session/close', { sessionId: sid }, 30_000) } catch { /* ignore */ }
  }
}

async function stepPromptTool(client, sessionId) {
  const turn = await runPrompt(client, sessionId,
    '只执行一步：调用 bash 工具运行命令 `echo DSH_ACP_OK`，然后原样回复该命令的输出。不要解释。')
  dumpTurn('prompt#1', turn)
  assert(turn.res?.stopReason === 'end_turn', `stopReason=${turn.res?.stopReason}`)
  const calls = turn.updates.filter((u) => u.sessionUpdate === 'tool_call')
  const ups = turn.updates.filter((u) => u.sessionUpdate === 'tool_call_update')
  assert(calls.length > 0, '没有 tool_call')
  assert(ups.some((u) => u.status === 'completed'), `没有 completed 的 tool_call_update: ${jsonOf(ups.map((u) => u.status))}`)
  const call = calls[0]
  assert(typeof call.toolCallId === 'string' && call.toolCallId.length > 0, 'tool_call 缺 toolCallId')
  assert(typeof call.title === 'string' && call.title.length > 0, 'tool_call 缺 title')
  assert(call.status === 'in_progress', `tool_call.status=${call.status}`)
  assert(typeof call.kind === 'string', 'tool_call 缺 kind')
  assert(call.rawInput !== undefined, 'tool_call 缺 rawInput')
  assert(ups.some((u) => u.toolCallId === call.toolCallId), 'toolCallId 不匹配')
  assert(ups.map(textOf).join('\n').includes('DSH_ACP_OK'), '工具输出不含 DSH_ACP_OK')
  const msgs = turn.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map(textOf).join('')
  assert(msgs.includes('DSH_ACP_OK'), `assistant 文本不含 DSH_ACP_OK: ${msgs.slice(0, 200)}`)
  const usage = turn.updates.filter((u) => u.sessionUpdate === 'usage_update')
  if (usage.length > 0) {
    const u = usage[0]
    assert(typeof u.used === 'number' && typeof u.size === 'number' && u.size > 0, `usage_update 字段非法: ${jsonOf(u)}`)
    info('USAGE-01', 'usage_update 字段合法', `used=${u.used} size=${u.size}（${usage.length} 条）`)
  } else info('USAGE-01', 'usage_update 未出现', '本轮未收到 usage_update')
  const msgIds = new Set(turn.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.messageId))
  assert([...msgIds].every((x) => typeof x === 'string'), `agent_message_chunk 缺 messageId: ${jsonOf([...msgIds])}`)
  return {
    detail: `end_turn；tool_call(${call.title})->completed；文本含 DSH_ACP_OK；${turn.ms}ms；update ${turn.updates.length} 条`,
    data: { toolTitle: call.title, kinds: [...new Set(turn.updates.map((u) => u.sessionUpdate))], ms: turn.ms },
  }
}

async function stepMultiTurn(client, sessionId) {
  const seen = []
  const times = []
  for (let i = 1; i <= 3; i++) {
    const marker = `TURN_${i}_OK_${Date.now().toString(36).slice(-4)}`
    const turn = await runPrompt(client, sessionId, `这是第 ${i} 轮。只回复一行：${marker}`)
    dumpTurn(`prompt#multi${i}`, turn)
    assert(turn.res?.stopReason === 'end_turn', `第 ${i} 轮 stopReason=${turn.res?.stopReason}`)
    const text = turn.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map(textOf).join('')
    assert(text.includes(marker), `第 ${i} 轮回复未含 ${marker}: ${text.slice(0, 120)}`)
    seen.push(marker)
    times.push(turn.ms)
  }
  return { detail: `连续 3 轮均 end_turn 且逐轮标记正确（${times.join('/')}ms）`, data: { markers: seen, ms: times } }
}

async function stepParallelSessions(client) {
  const a = (await client.request('session/new', { cwd: WORKDIR, mcpServers: [] })).sessionId
  const b = (await client.request('session/new', { cwd: WORKDIR, mcpServers: [] })).sessionId
  const updates = []
  const off = client.onNotification((m) => {
    if (m.method === 'session/update') updates.push({ sid: m.params.sessionId, u: m.params.update })
  })
  try {
    const pa = runPrompt(client, a, '只回复字符串 PARA_A')
    const pb = runPrompt(client, b, '只回复字符串 PARA_B')
    const [ra, rb] = await Promise.all([pa, pb])
    await client.quiet()
    assert(ra.res?.stopReason === 'end_turn' && rb.res?.stopReason === 'end_turn',
      `stopReason a=${ra.res?.stopReason} b=${rb.res?.stopReason}`)
    const ta = ra.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map(textOf).join('')
    const tb = rb.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map(textOf).join('')
    assert(ta.includes('PARA_A') && tb.includes('PARA_B'), `文本 a=${jsonOf(ta)} b=${jsonOf(tb)}`)
    for (const { sid } of updates) assert(sid === a || sid === b, `收到未知 sessionId 的 update: ${sid}`)
    const leaked = updates.filter(({ sid, u }) => u.sessionUpdate === 'agent_message_chunk' &&
      ((sid === a && textOf(u).includes('PARA_B')) || (sid === b && textOf(u).includes('PARA_A'))))
    assert(leaked.length === 0, '两会话的 update 串流')
    return { detail: `并行两会话各 1 回合均正确路由（A.updates=${ra.updates.length}, B.updates=${rb.updates.length}）`,
      data: { a, b, updateCount: updates.length } }
  } finally {
    off()
    for (const sid of [a, b]) { try { await client.request('session/close', { sessionId: sid }, 30_000) } catch { /* ignore */ } }
  }
}

async function stepConcurrentReject(client, sessionId) {
  let second
  let cancelSent = false
  const cancel = () => { if (!cancelSent) { cancelSent = true; client.notify('session/cancel', { sessionId }) } }
  const turn = runPrompt(client, sessionId, '调用 bash 工具运行 `sleep 20; echo CONC_DONE`，然后回复结果。', {
    onUpdate: (u) => {
      if (u.sessionUpdate === 'tool_call' && second === undefined) {
        second = client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '第二个并发请求' }] }, 60_000)
          .then((r) => ({ ok: true, r }), (e) => ({ ok: false, rpc: e.rpc, message: e.message }))
          .finally(cancel)
      }
    },
  })
  const t = await turn
  assert(second !== undefined, '未观测到 tool_call，无法发起并发请求')
  const out = await second
  assert(out.ok === false, `并发 prompt 未被拒: ${jsonOf(out.r).slice(0, 150)}`)
  assert(out.rpc?.code === -32602, `并发错误码=${out.rpc?.code}`)
  assert(/already in flight/i.test(out.rpc?.message ?? ''), `并发错误信息=${out.rpc?.message}`)
  assert(t.res?.stopReason === 'cancelled', `首个 prompt stopReason=${t.res?.stopReason}`)
  return `并发被拒(-32602, "${out.rpc.message}")；cancel 后首个 prompt=cancelled（${t.ms}ms）`
}

async function stepCancelOnTool(client, sessionId) {
  const turn = await runPrompt(client, sessionId,
    '调用 bash 工具运行 `sleep 30; echo SLEPT_DONE`，然后回复结果。不要做别的事。',
    { cancelOnSessionUpdate: 'tool_call', cancelAfterMs: 20_000 })
  dumpTurn('prompt#cancel-tool', turn)
  assert(turn.cancelled, '未能在回合内发出 cancel')
  assert(turn.res?.stopReason === 'cancelled', `stopReason=${turn.res?.stopReason}`)
  const failed = turn.updates.filter((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'failed')
  assert(failed.length > 0, `取消后无 failed tool_call_update: ${jsonOf(turn.updates.filter((u) => u.sessionUpdate === 'tool_call_update').map((u) => u.status))}`)
  assert(turn.ms < 20_000, `cancel 响应 ${turn.ms}ms，未及时中断`)
  // 取消后同会话仍可用
  const after = await runPrompt(client, sessionId, '刚才那轮被取消了。现在只回复 RECOVERED')
  const text = after.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map(textOf).join('')
  assert(after.res?.stopReason === 'end_turn', `取消后下一轮 stopReason=${after.res?.stopReason}`)
  assert(text.includes('RECOVERED'), `取消后下一轮回复异常: ${text.slice(0, 120)}`)
  return { detail: `tool_call 时 cancel -> cancelled（${turn.ms}ms）且 tool_call_update=failed；随后同会话回合正常`,
    data: { ms: turn.ms, updatesAfter: after.updates.length } }
}

async function stepCancelImmediate(client, sessionId) {
  let cancelAt
  const p = client.request('session/prompt', {
    sessionId, prompt: [{ type: 'text', text: '用 bash 工具运行 `sleep 25`，然后只回复 done。' }],
  })
  // 请求发出后立即 cancel（不等待任何 update）
  client.notify('session/cancel', { sessionId })
  cancelAt = Date.now()
  let res
  try { res = await p } catch (e) { throw new Error(`cancel 后 prompt 报错: ${e.message}`) }
  assert(res?.stopReason === 'cancelled', `立即 cancel 后 stopReason=${res?.stopReason}（期望 cancelled）`)
  const after = await runPrompt(client, sessionId, '只回复 STILL_ALIVE')
  const text = after.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map(textOf).join('')
  assert(text.includes('STILL_ALIVE'), `cancel 后会话不可用: ${text.slice(0, 120)}`)
  return `发送 prompt 后立即 session/cancel -> cancelled；会话随后可用（回收 ${Date.now() - cancelAt}ms）`
}

async function stepCloseDuringPrompt(client) {
  const sid = (await client.request('session/new', { cwd: WORKDIR, mcpServers: [] })).sessionId
  let inflight
  let inFlightStarted = false
  const off = client.onNotification((m) => {
    if (m.method === 'session/update' && m.params.sessionId === sid &&
      m.params.update.sessionUpdate === 'tool_call') inFlightStarted = true
  })
  try {
    inflight = client.request('session/prompt', {
      sessionId: sid, prompt: [{ type: 'text', text: '用 bash 工具运行 `sleep 20`，然后只回复 done。' }],
    })
    const deadline = Date.now() + 60_000
    while (!inFlightStarted && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    assert(inFlightStarted, '未进入工具执行阶段')
    const t0 = Date.now()
    const closed = await client.request('session/close', { sessionId: sid }, 60_000)
    assert(typeof closed === 'object' && closed !== null, `close 返回 ${jsonOf(closed)}`)
    const closeMs = Date.now() - t0
    const settled = await inflight.then((r) => ({ ok: true, r }), (e) => ({ ok: false, rpc: e.rpc, message: e.message }))
    // 可接受两种收尾：回合被取消（cancelled）或请求报 -32602；关键是及时结算不挂起
    if (settled.ok) {
      assert(settled.r?.stopReason === 'cancelled', `在飞回合 close 后 stopReason=${settled.r?.stopReason}`)
    } else {
      assert(settled.rpc?.code === -32602, `在飞回合 close 后错误码=${settled.rpc?.code}`)
    }
    // 已关闭会话：再次 close 报 unknown session
    let again
    try { await client.request('session/close', { sessionId: sid }, 30_000); again = 'ok' }
    catch (e) { again = e.rpc?.code }
    assert(again === -32602, `重复 close 返回 ${again}`)
    return { detail: `close 在飞回合用时 ${closeMs}ms 返回 {}；prompt 以 -32602 结算；重复 close=-32602`,
      data: { closeMs, promptSettled: settled.rpc } }
  } finally {
    off()
    try { await inflight } catch { /* 已在上面结算 */ }
  }
}

async function stepErrors(client, sessionId) {
  const checks = []
  const bogus = '00000000-0000-4000-8000-000000000000'
  const expect = async (label, method, params, code) => {
    try {
      const r = await client.request(method, params, 60_000)
      checks.push({ label, ok: false, detail: `未报错，返回 ${jsonOf(r).slice(0, 120)}` })
    } catch (e) {
      const c = e.rpc?.code
      checks.push({ label, ok: c === code, code: c, detail: `code=${c} msg=${e.rpc?.message ?? e.message}` })
    }
  }
  await expect('未知请求方法', 'session/does_not_exist', {}, -32601)
  await expect('prompt 未知会话', 'session/prompt', { sessionId: bogus, prompt: [{ type: 'text', text: 'x' }] }, -32602)
  await expect('prompt 空数组', 'session/prompt', { sessionId, prompt: [] }, -32602)
  await expect('prompt 空白文本', 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '   ' }] }, -32602)
  await expect('prompt 缺参数', 'session/prompt', {}, -32602)
  await expect('prompt 图片块（image=false）', 'session/prompt',
    { sessionId, prompt: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] }, -32602)
  await expect('prompt 音频块', 'session/prompt',
    { sessionId, prompt: [{ type: 'audio', mimeType: 'audio/wav', data: 'AAAA' }] }, -32602)
  await expect('prompt 内嵌 resource 块', 'session/prompt',
    { sessionId, prompt: [{ type: 'resource', resource: { uri: 'file:///etc/hosts', text: 'hi' } }] }, -32602)
  await expect('未知 configId', 'session/set_config_option', { sessionId, configId: 'no_such', value: 'x' }, -32602)
  await expect('非法 reasoning 值', 'session/set_config_option', { sessionId, configId: 'reasoning_effort', value: 'ultra' }, -32602)
  await expect('未知模型 value', 'session/set_config_option', { sessionId, configId: 'model', value: '["x","y"]' }, -32602)
  await expect('session/new 相对 cwd', 'session/new', { cwd: 'rel/path', mcpServers: [] }, -32602)
  await expect('session/new 缺 cwd', 'session/new', { mcpServers: [] }, -32602)
  await expect('session/new additionalDirectories', 'session/new',
    { cwd: WORKDIR, mcpServers: [], additionalDirectories: [WORKDIR] }, -32602)
  await expect('session/new 不支持的 MCP transport', 'session/new',
    { cwd: WORKDIR, mcpServers: [{ type: 'sse', name: 'x', url: 'https://example.invalid/mcp', headers: [] }] }, -32602)
  await expect('close 未知会话', 'session/close', { sessionId: bogus }, -32602)
  await expect('resume 未知会话', 'session/resume', { sessionId: bogus, cwd: WORKDIR, mcpServers: [] }, -32602)
  await expect('list 非法 cursor', 'session/list', { cwd: WORKDIR, cursor: '!!!' }, -32602)
  await expect('list 相对 cwd', 'session/list', { cwd: 'rel' }, -32602)
  for (const c of checks) console.log(`    · ${c.label}: ${c.detail}`)
  const bad = checks.filter((c) => !c.ok)
  assert(bad.length === 0, `${bad.length}/${checks.length} 项不符: ` + bad.map((c) => `${c.label}(${c.detail})`).join('；'))
  return {
    detail: `${checks.length}/${checks.length} 项返回预期错误码；` +
      `音频/内嵌 resource 被拒，resource_link 可放行`,
    data: checks,
  }
}

async function stepResourceLink(client, sessionId) {
  const turn = await runPrompt(client, sessionId, '只回复 LINK_OK')
  assert(turn.res?.stopReason === 'end_turn', `stopReason=${turn.res?.stopReason}`)
  // 单独用 request 发送含 resource_link 的 prompt 验证放行（runPrompt 只发 text）
  const r = await client.request('session/prompt', {
    sessionId,
    prompt: [
      { type: 'resource_link', uri: 'file:///etc/hosts', name: 'hosts' },
      { type: 'text', text: '只回复 RL_OK' },
    ],
  }, 120_000)
  await client.quiet()
  assert(r?.stopReason === 'end_turn', `resource_link prompt stopReason=${r?.stopReason}`)
  return 'resource_link 块被接受并完成回合（end_turn）'
}

async function stepList(client, activeId) {
  const active = await client.request('session/list', { cwd: WORKDIR }, 60_000)
  assert(Array.isArray(active?.sessions), 'sessions 不是数组')
  assert(!active.sessions.some((s) => s.sessionId === activeId), '活跃会话不应出现在 list 中')
  const real = realpathSync(WORKDIR)
  for (const s of active.sessions) {
    if (s.cwd !== undefined) assert(realpathSync(s.cwd) === real, `list 混入其它 cwd: ${s.cwd}`)
  }
  return { detail: `活跃会话被排除；cwd 过滤返回 ${active.sessions.length} 条 nextCursor=${active.nextCursor ?? '无'}`,
    data: { count: active.sessions.length } }
}

async function stepListCursor(client) {
  const page1 = await client.request('session/list', { cwd: WORKDIR }, 30_000)
  assert(Array.isArray(page1.sessions), '第一页失败')
  // 过去时间的 cursor：所有条目都比它新 -> 0 条
  const past = Buffer.from(JSON.stringify([0, 'a'])).toString('base64url')
  const empty = await client.request('session/list', { cwd: WORKDIR, cursor: past }, 30_000)
  assert(Array.isArray(empty.sessions) && empty.sessions.length === 0,
    `过去 cursor 返回 ${empty.sessions?.length} 条，期望 0`)
  // 未来时间的 cursor：所有条目都“在其后” -> 全量
  const future = Buffer.from(JSON.stringify([4102444800000, 'zzzz'])).toString('base64url')
  const all = await client.request('session/list', { cwd: WORKDIR, cursor: future }, 30_000)
  assert(Array.isArray(all.sessions) && all.sessions.length === page1.sessions.length,
    `未来 cursor 返回 ${all.sessions?.length} 条，期望 ${page1.sessions.length}`)
  // 分页：用第一页 nextCursor 取第二页，必须与第一页不相交
  let paging = '样本不足（未触发分页）'
  if (page1.nextCursor !== undefined) {
    const page2 = await client.request('session/list', { cwd: WORKDIR, cursor: page1.nextCursor }, 30_000)
    const ids1 = new Set(page1.sessions.map((s) => s.sessionId))
    assert((page2.sessions ?? []).every((s) => !ids1.has(s.sessionId)), '第二页与第一页重复')
    paging = `第一页 ${page1.sessions.length} 条 + 第二页 ${page2.sessions.length} 条，无交集`
  }
  const noCwd = await client.request('session/list', {}, 30_000)
  assert(Array.isArray(noCwd.sessions), '无 cwd 的 list 失败')
  return `过去 cursor -> 0 条；未来 cursor -> 全量 ${all.sessions.length} 条；${paging}；无 cwd 返回 ${noCwd.sessions.length} 条`
}

async function stepResume(client, sessionId) {
  const res = await client.request('session/resume', { sessionId, cwd: WORKDIR, mcpServers: [] }, 120_000)
  assert(Array.isArray(res?.configOptions), 'resume 缺 configOptions')
  const effort = res.configOptions.find((o) => o.id === 'reasoning_effort')?.currentValue
  assert(effort === 'low', `resume 后 reasoning=${effort}，期望 low`)
  // resume 进行中的会话应被拒
  let code
  try { await client.request('session/resume', { sessionId, cwd: WORKDIR, mcpServers: [] }, 30_000) }
  catch (e) { code = e.rpc?.code }
  assert(code === -32602, `重复 resume 错误码=${code}`)
  return `resume 成功，reasoning_effort 保持 low；重复 resume -> -32602`
}

async function stepResumeWrongCwd(client, sessionId) {
  let code
  const other = os.tmpdir()
  try { await client.request('session/resume', { sessionId, cwd: other, mcpServers: [] }, 60_000) }
  catch (e) { code = e.rpc?.code }
  assert(code === -32602, `错误 cwd 的 resume 返回 ${code}`)
  return `cwd 不符的 resume 被拒（-32602）`
}

async function stepResumeContinuity(client, sessionId) {
  const turn = await runPrompt(client, sessionId,
    '回顾本会话此前的对话：我给你下达过哪些用 bash 执行的命令？只列出命令字符串本身，每行一个，不要解释。')
  dumpTurn('prompt#recall', turn)
  assert(turn.res?.stopReason === 'end_turn', `stopReason=${turn.res?.stopReason}`)
  const text = turn.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map(textOf).join('')
  const markers = ['DSH_ACP_OK', 'SLEPT_DONE', 'CONC_DONE']
  const hit = markers.filter((m) => text.includes(m))
  assert(hit.length > 0, `恢复后未体现历史（期望之一 ${markers.join('/')}）：${text.slice(0, 300)}`)
  return { detail: `恢复后回忆到 ${hit.join('/')}（${turn.ms}ms）`, data: { hits: hit, ms: turn.ms } }
}

async function stepTransport(client) {
  // 1) 非法 JSON -> -32700 Parse error，进程存活
  client.writeRaw('this is not json\n')
  await new Promise((r) => setTimeout(r, 1200))
  const parseErr = client.frames.filter((f) => f.dir === 'in' && f.msg?.error?.code === -32700)
  assert(parseErr.length > 0, '非法 JSON 未返回 -32700 Parse error')
  // 2) 未知通知 -> 静默忽略，连接存活
  client.notify('session/no_such_notification', {})
  // 3) cancel 未知会话 -> 静默（通知无响应）
  client.notify('session/cancel', { sessionId: 'nope' })
  await new Promise((r) => setTimeout(r, 500))
  const alive = await client.request('session/list', { cwd: WORKDIR }, 15_000)
  assert(Array.isArray(alive.sessions), '非法输入后连接不可用')
  // 4) NDJSON 分帧：多帧在同一 chunk 内也能解析（写两条请求粘在一起）
  const idA = ++client.nextId
  const idB = ++client.nextId
  const waitA = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('粘包 idA 超时')), 15_000); client.pending.set(idA, { resolve: res, reject: rej, timer: t, method: 'list-A' }) })
  const waitB = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('粘包 idB 超时')), 15_000); client.pending.set(idB, { resolve: res, reject: rej, timer: t, method: 'list-B' }) })
  const raw = JSON.stringify({ jsonrpc: '2.0', id: idA, method: 'session/list', params: { cwd: WORKDIR } }) + '\n' +
    JSON.stringify({ jsonrpc: '2.0', id: idB, method: 'session/list', params: { cwd: WORKDIR } }) + '\n'
  client.writeRaw(raw)
  const [ra, rb] = await Promise.all([waitA, waitB])
  assert(Array.isArray(ra.sessions) && Array.isArray(rb.sessions), '粘包帧解析失败')
  return `非法 JSON -> -32700 且存活；未知通知/cancel 被忽略；两帧同 chunk 粘包均正确响应`
}

async function stepShutdown(client) {
  const { exited, exitInfo } = await client.shutdown()
  assert(exited, '关闭 stdin 后 8 秒内未退出')
  assert(exitInfo?.code === 0, `退出码 ${exitInfo?.code} signal=${exitInfo?.signal}`)
  return `stdin EOF 后正常退出，退出码 0`
}

/* ---------------- 主流程 ---------------- */

async function main() {
  console.log('='.repeat(78))
  console.log(`dsh ACP 深度验证  ${new Date().toISOString()}`)
  console.log(`profile=${PROFILE}  workdir=${WORKDIR}  node=${process.version} ${process.platform}`)
  console.log('='.repeat(78))

  await guarded(null, 'ENV-01', '环境：dsh 包装器 / profile / T3 settings 只读校验', stepEnv)
  await guarded(null, 'ENV-02', 'dsh --version', stepVersion)

  const client = new AcpClient({ label: `acp:${PROFILE}` })
  const S = { sessionId: undefined, sessionRes: undefined, cfg: undefined }
  try {
    await guarded(client, 'INIT-01', 'initialize 握手与能力声明', () => stepInitialize(client))
    await guarded(client, 'INIT-02', 'protocolVersion 协商与重复 initialize', () => stepVersionNegotiation(client))

    const newOut = await guarded(client, 'SESS-01', 'session/new 建会话', async () => {
      const r = await stepNewSession(client)
      S.sessionRes = r.raw
      S.sessionId = r.data.sessionId
      return r
    })

    if (newOut !== undefined) {
      await guarded(client, 'CFG-01', 'configOptions 初始读取（model / reasoning_effort）', () => {
        S.cfg = stepConfigRead(S.sessionRes)
        return { detail: S.cfg.detail, data: S.cfg.data }
      })
      await guarded(client, 'CFG-02', 'reasoning_effort 设置生效与非法值拒绝', () => stepConfigSet(client, S.sessionId, S.cfg))
      await guarded(client, 'CFG-03', '模型切换行为探测（可选项 / reasoning 重置 / 回切）', () => stepModelSwitch(client))
      await guarded(client, 'PROMPT-01', '真实回合：bash 工具与 tool_call 流', () => stepPromptTool(client, S.sessionId))
      await guarded(client, 'PROMPT-02', '连续 3 个回合稳定性', () => stepMultiTurn(client, S.sessionId))
      await guarded(client, 'PROMPT-03', '两个会话并行回合互不串流', () => stepParallelSessions(client))
      await guarded(client, 'CONC-01', '同会话并发 prompt 被拒(-32602) 后 cancel 收尾', () => stepConcurrentReject(client, S.sessionId))
      await guarded(client, 'CANCEL-01', 'tool_call 阶段 cancel 与取消后恢复', () => stepCancelOnTool(client, S.sessionId))
      await guarded(client, 'CANCEL-02', '发送后立即 cancel', () => stepCancelImmediate(client, S.sessionId))
      await guarded(client, 'CLOSE-01', 'close 打断在飞回合', () => stepCloseDuringPrompt(client))
      await guarded(client, 'ERR-01', '错误码矩阵（方法/会话/配置/内容块/cwd/cursor）', () => stepErrors(client, S.sessionId))
      await guarded(client, 'ERR-02', 'resource_link 内容块放行', () => stepResourceLink(client, S.sessionId))
      await guarded(client, 'LIST-01', 'session/list 语义（活跃排除 / cwd 过滤）', () => stepList(client, S.sessionId))
      await guarded(client, 'LIST-02', 'session/list cursor 语义', () => stepListCursor(client))
      await guarded(client, 'SESS-02', 'session/close', async () => {
        const r = await client.request('session/close', { sessionId: S.sessionId }, 60_000)
        assert(typeof r === 'object' && r !== null, 'close 未返回对象')
        return `返回 ${jsonOf(r)}`
      })
      await guarded(client, 'RESUME-03', 'cwd 不符的 resume 被拒', () => stepResumeWrongCwd(client, S.sessionId))
      const resOut = await guarded(client, 'RESUME-01', 'session/resume 恢复并保持配置', () => stepResume(client, S.sessionId))
      if (resOut !== undefined) {
        await guarded(client, 'RESUME-02', 'resume 后上下文连续性', () => stepResumeContinuity(client, S.sessionId))
        try { await client.request('session/close', { sessionId: S.sessionId }, 30_000) } catch { /* ignore */ }
      }
      await guarded(client, 'TRANS-01', '传输层：非法 JSON / 未知通知 / 粘包帧', () => stepTransport(client))
    } else {
      for (const [id, name] of [
        ['CFG-01', 'configOptions 读取'], ['CFG-02', 'reasoning 设置'], ['CFG-03', '模型切换'],
        ['PROMPT-01', '真实回合'], ['PROMPT-02', '多回合'], ['PROMPT-03', '并行会话'],
        ['CONC-01', '并发拒绝'], ['CANCEL-01', 'cancel'], ['CANCEL-02', '立即 cancel'],
        ['CLOSE-01', 'close 打断'], ['ERR-01', '错误码'], ['ERR-02', 'resource_link'],
        ['LIST-01', 'list'], ['LIST-02', 'cursor'], ['SESS-02', 'close'],
        ['RESUME-01', 'resume'], ['RESUME-02', 'resume 连续性'], ['RESUME-03', 'resume cwd'],
        ['TRANS-01', '传输层'],
      ]) skip(id, name, '因 session/new 失败而跳过')
    }
  } finally {
    await guarded(client, 'EXIT-01', 'stdin EOF 后正常退出', () => stepShutdown(client))
  }

  const counts = results.reduce((a, r) => { a[r.status] = (a[r.status] ?? 0) + 1; return a }, {})
  const failures = results.filter((r) => r.status === 'FAIL')
  console.log('\n' + '-'.repeat(78))
  console.log(`汇总: PASS=${counts.PASS ?? 0} FAIL=${counts.FAIL ?? 0} INFO=${counts.INFO ?? 0} SKIP=${counts.SKIP ?? 0} ` +
    `用时 ${Math.round((Date.now() - startedAt) / 1000)}s`)
  for (const f of failures) console.log(`  FAIL [${f.id}] ${f.name}: ${f.detail}`)
  console.log(`结果: ${failures.length === 0 ? '全部通过' : '存在失败'}`)

  if (outPath !== undefined) {
    mkdirSync(dirname(outPath), { recursive: true })
    const trim = (v) => JSON.parse(JSON.stringify(v, (k, x) =>
      typeof x === 'string' && x.length > 1500 ? `${x.slice(0, 1500)}…[${x.length}]` : x))
    writeFileSync(outPath, JSON.stringify({
      runId,
      profile: PROFILE,
      startedAt: new Date(startedAt).toISOString(),
      durationSeconds: Math.round((Date.now() - startedAt) / 1000),
      workdir: WORKDIR,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      counts,
      results,
      frames: client.frames.map((f) => (f.raw !== undefined
        ? { dir: f.dir, t: f.t, raw: String(f.raw).slice(0, 1000) }
        : { dir: f.dir, t: f.t, msg: trim(f.msg) })),
      stderrTail: client.stderr.slice(-6000),
    }, null, 2))
    console.log(`结构化结果: ${outPath}`)
  }
  process.exitCode = failures.length === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('套件崩溃:', e)
  process.exitCode = 2
})