#!/usr/bin/env node
/**
 * verify-acp.mjs — 独立多轮验证套件：dsh (DeepSeek Harness) 经 ACP 接入 T3 Code。
 *
 * 零依赖：node:child_process / node:readline / node:fs。每个进程完整跑一遍套件，
 * 单轮超时 120 秒；失败时打印该步骤的原始帧。
 *
 * 用法：
 *   node verify-acp.mjs                 # 一轮完整套件（退出码 0=全通过 1=有失败）
 *   node verify-acp.mjs --out run-1.json  # 额外把结构化结果写到文件
 *   node verify-acp.mjs --profile acp     # 指定被测 profile（默认 acp）
 */

import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { existsSync, readFileSync, writeFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKDIR = HERE
const DSH_BIN = join(os.homedir(), '.local', 'bin', 'dsh')
const DSH_HOME = join(os.homedir(), '.dsh')
const T3_SETTINGS = join(os.homedir(), '.t3', 'userdata', 'settings.json')
const REQUEST_TIMEOUT = 120_000
const EXPECTED_EFFORTS = ['high', 'low', 'max', 'off']

const argv = process.argv.slice(2)
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}
const outPath = (() => {
  const v = argOf('--out', undefined)
  return v === undefined ? undefined : resolvePath(process.cwd(), v)
})()
const TEST_PROFILE = argOf('--profile', 'acp')

const results = []
const startedAt = Date.now()
const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`

function record(id, name, status, detail, data) {
  results.push({ id, name, status, detail, ...(data === undefined ? {} : { data }) })
  console.log(`${status.padEnd(4)} [${id}] ${name}${detail ? ` — ${detail}` : ''}`)
}
const pass = (id, name, detail, data) => record(id, name, 'PASS', detail, data)
const info = (id, name, detail, data) => record(id, name, 'INFO', detail, data)
const fail = (id, name, detail, data) => record(id, name, 'FAIL', detail, data)
const skip = (id, name, detail) => record(id, name, 'SKIP', detail)

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

/* ------------------------------------------------------------------ *
 * ACP JSON-RPC over stdio 客户端
 * ------------------------------------------------------------------ */

class AcpClient {
  constructor({ command = DSH_BIN, args = ['--profile', TEST_PROFILE], cwd = WORKDIR, label = 'acp' } = {}) {
    this.label = label
    this.frames = []
    this.pending = new Map()
    this.nextId = 0
    this.notificationHandlers = new Set()
    this.serverRequests = []
    this.stderr = ''
    this.exitInfo = undefined
    this.exited = undefined
    this.child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
    this.child.on('error', (err) => { this.stderr += `\n[spawn error] ${err.message}` })
    this.child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal }
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`dsh 已退出 (code=${code}, signal=${signal})，仍在等待 ${p.method} (id=${id})`))
        this.pending.delete(id)
      }
      if (this.exited) this.exited()
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk
      if (this.stderr.length > 200_000) this.stderr = this.stderr.slice(-100_000)
    })
    this.child.stdout.setEncoding('utf8')
    this.rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    this.rl.on('line', (line) => this.onLine(line))
    this.lastActivity = Date.now()
  }

  onLine(line) {
    const trimmed = line.trim()
    if (trimmed === '') return
    this.lastActivity = Date.now()
    let msg
    try {
      msg = JSON.parse(trimmed)
    } catch {
      this.frames.push({ dir: 'nonjson', t: Date.now(), raw: trimmed })
      return
    }
    this.frames.push({ dir: 'in', t: Date.now(), msg })
    if (this.frames.length > 3000) this.frames.splice(0, this.frames.length - 3000)

    if (msg.method !== undefined && msg.id !== undefined) {
      this.serverRequests.push(msg)
      if (msg.method === 'session/request_permission') {
        this.send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
      } else {
        this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } })
      }
      return
    }
    if (msg.method !== undefined) {
      for (const handler of this.notificationHandlers) {
        try { handler(msg) } catch { /* 忽略订阅者异常 */ }
      }
      return
    }
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.pending.delete(msg.id)
      if (msg.error !== undefined) {
        const err = new Error(`${pending.method} failed: ${msg.error.message} (code=${msg.error.code})`)
        err.rpc = msg.error
        pending.reject(err)
      } else {
        pending.resolve(msg.result)
      }
    }
  }

  send(obj) {
    this.frames.push({ dir: 'out', t: Date.now(), msg: obj })
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) throw new Error('dsh stdin 已关闭')
    this.child.stdin.write(`${JSON.stringify(obj)}\n`)
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`等待 ${method} 超时（${timeoutMs}ms, id=${id}）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }) }

  onNotification(handler) {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  /** 等到没有新帧（或超时），确保响应之后到达的通知已入账。 */
  async quiet(quietMs = 200, maxMs = 3000) {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
      if (Date.now() - this.lastActivity >= quietMs) return
      await new Promise((r) => setTimeout(r, 30))
    }
  }

  /** 打印从第 from 帧起的原始帧（默认最后 40 帧），用于失败诊断。 */
  dumpFrames(from, max = 40) {
    const startIdx = Math.max(0, from ?? this.frames.length - max)
    const slice = this.frames.slice(startIdx)
    const shown = slice.slice(-max)
    console.log(`\n----- 原始帧 [${this.label}]（显示 ${shown.length} / 本步骤 ${slice.length} 帧）-----`)
    for (const f of shown) {
      if (f.dir === 'nonjson') console.log(`[nonjson] ${f.raw.slice(0, 500)}`)
      else console.log(`[${f.dir}] ${JSON.stringify(f.msg).slice(0, 1200)}`)
    }
    if (this.stderr.trim() !== '') {
      console.log('----- dsh stderr（尾部 3000 字符）-----')
      console.log(this.stderr.slice(-3000))
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

/* ------------------------------------------------------------------ *
 * 辅助
 * ------------------------------------------------------------------ */

function textOf(update) {
  const c = update?.content
  if (c === undefined || c === null) return ''
  if (Array.isArray(c)) return c.map((i) => (i?.content?.type === 'text' ? i.content.text : JSON.stringify(i))).join('\n')
  if (typeof c === 'object' && c.type === 'text') return String(c.text ?? '')
  return JSON.stringify(c)
}

function jsonOf(value) {
  try {
    const s = JSON.stringify(value)
    return s === undefined ? String(value) : s
  } catch {
    return String(value)
  }
}

/** 执行一个 prompt，收集该会话的 session/update；可选在指定时机 cancel。 */
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
    const update = msg.params.update
    if (update === undefined) return
    updates.push(update)
    if (hooks.cancelOnFirstUpdate) cancel()
    if (hooks.cancelOnSessionUpdate === update.sessionUpdate) cancel()
    if (typeof hooks.onUpdate === 'function') hooks.onUpdate(update)
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
  for (const u of turn.updates) {
    const kind = u.sessionUpdate
    const extra = kind === 'tool_call'
      ? ` id=${u.toolCallId} title=${u.title} status=${u.status} input=${jsonOf(u.rawInput).slice(0, 120)}`
      : kind === 'tool_call_update'
        ? ` id=${u.toolCallId} status=${u.status} text=${textOf(u).slice(0, 120).replace(/\n/g, '\\n')}`
        : kind === 'agent_message_chunk' || kind === 'agent_thought_chunk'
          ? ` text=${textOf(u).slice(0, 80).replace(/\n/g, '\\n')}`
          : kind === 'usage_update' ? ` used=${u.used} size=${u.size}` : ` ${jsonOf(u).slice(0, 160)}`
    console.log(`    - ${kind}${extra}`)
  }
}

/**
 * 步骤包装：成功记 PASS，异常记 FAIL 并打印该步骤原始帧，不中断后续步骤。
 * fn 返回 { detail, data } 或直接返回 detail 字符串。
 */
async function guarded(client, id, name, fn) {
  const frameStart = client?.frames.length ?? 0
  try {
    const out = await fn()
    if (out === undefined || out === null) { pass(id, name, 'ok'); return true }
    if (typeof out === 'string') { pass(id, name, out); return true }
    pass(id, name, out.detail, out.data)
    return out
  } catch (err) {
    fail(id, name, err.message)
    if (process.env.VERIFY_DEBUG === '1' && err.stack) console.log(err.stack)
    if (client) client.dumpFrames(frameStart, 40)
    return undefined
  }
}

/* ------------------------------------------------------------------ *
 * 步骤
 * ------------------------------------------------------------------ */

function readT3Settings() {
  const settings = JSON.parse(readFileSync(T3_SETTINGS, 'utf8'))
  return { settings, instance: settings?.providerInstances?.dsh }
}

async function stepT3Settings() {
  const id = 'T3-01'
  const name = 'T3 settings.json 中 dsh 实例（只读校验）'
  assert(existsSync(T3_SETTINGS), `settings.json 不存在: ${T3_SETTINGS}`)
  const { instance } = readT3Settings()
  assert(instance !== undefined, 'providerInstances.dsh 缺失')
  assert(instance.driver === 'acpRegistry', `driver=${instance.driver}，期望 acpRegistry`)
  assert(instance.enabled === true, 'dsh 实例未启用')
  assert(instance.displayName === 'DeepSeek Harness', `displayName=${instance.displayName}`)
  const cfg = instance.config ?? {}
  assert(cfg.enabled === true, 'config.enabled 不为 true')
  assert(cfg.source === 'local', `config.source=${cfg.source}，期望 local`)
  assert(typeof cfg.commandPath === 'string' && cfg.commandPath.length > 0, 'config.commandPath 缺失')
  assert(existsSync(cfg.commandPath), `commandPath 不存在: ${cfg.commandPath}`)
  assert((statSync(cfg.commandPath).mode & 0o111) !== 0, `commandPath 不可执行: ${cfg.commandPath}`)
  assert(Array.isArray(cfg.commandArgs) && cfg.commandArgs.length === 2 && cfg.commandArgs[0] === '--profile',
    `commandArgs=${jsonOf(cfg.commandArgs)}，期望 ["--profile","<name>"]`)
  const profile = cfg.commandArgs[1]
  const profileDir = join(DSH_HOME, 'profiles', profile)
  assert(existsSync(profileDir), `settings 指向的 profile 目录不存在: ${profileDir}`)
  const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  const bundles = pkg?.dsh?.profile?.bundles ?? []
  assert(bundles.includes('@deepseek-ai/dsh-acp-app'),
    `profile "${profile}" 的 bundles 未包含 @deepseek-ai/dsh-acp-app: ${jsonOf(bundles)}`)
  return {
    detail: `driver=acpRegistry source=local commandPath=${cfg.commandPath} args=${cfg.commandArgs.join(' ')} ` +
      `profile 存在且含 dsh-acp-app bundle（共 ${bundles.length} 个 bundle）`,
    data: { commandPath: cfg.commandPath, commandArgs: cfg.commandArgs, profile, bundles },
  }
}

async function stepVersion() {
  const id = 'T3-02'
  const name = 'dsh CLI 可用性与版本'
  const child = spawn(DSH_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  const code = await new Promise((r) => child.on('exit', (c) => r(c)))
  const version = (out + err).trim()
  assert(code === 0, `dsh --version 退出码 ${code}`)
  assert(/\d+\.\d+\.\d+/.test(version), `版本输出异常: ${version.slice(0, 200)}`)
  return { detail: version, data: { version } }
}

async function stepInitialize(client) {
  const id = 'INIT-01'
  const name = 'initialize 握手'
  const res = await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  })
  assert(typeof res === 'object' && res !== null, 'initialize 返回非对象')
  assert(res.protocolVersion === 1, `protocolVersion=${res.protocolVersion}，期望 1`)
  assert(res.agentInfo?.name === 'deepseek-harness-acp', `agentInfo.name=${res.agentInfo?.name}`)
  assert(typeof res.agentInfo?.version === 'string', 'agentInfo.version 缺失')
  assert(Array.isArray(res.authMethods) && res.authMethods.length === 0,
    `authMethods=${jsonOf(res.authMethods)}，期望 []（共享 ~/.dsh 登录，无需鉴权步骤）`)
  const caps = res.agentCapabilities ?? {}
  const sess = caps.sessionCapabilities ?? {}
  for (const key of ['close', 'list', 'resume']) assert(key in sess, `sessionCapabilities.${key} 缺失`)
  assert(caps.promptCapabilities?.image === false,
    `promptCapabilities.image=${caps.promptCapabilities?.image}，期望 false`)
  assert(caps.mcpCapabilities?.http === true, `mcpCapabilities.http=${caps.mcpCapabilities?.http}，期望 true`)
  return {
    detail: `protocolVersion=1 agent=${res.agentInfo.name}@${res.agentInfo.version} authMethods=[] ` +
      `sessionCaps=${Object.keys(sess).join('/')} image=${caps.promptCapabilities?.image} http=${caps.mcpCapabilities?.http}`,
    data: res,
  }
}

async function stepAuthenticate(client) {
  const id = 'INIT-02'
  const name = 'authenticate 空操作可用（无需凭据步骤）'
  const res = await client.request('authenticate', { methodId: 'noop' }, 30_000)
  assert(typeof res === 'object' && res !== null && Object.keys(res).length === 0,
    `authenticate 返回 ${jsonOf(res)}，期望 {}`)
  return '返回 {}（no-op）'
}

async function stepVersionNegotiation(client) {
  const id = 'INIT-03'
  const name = 'protocolVersion 协商（请求 2，服务端回落到 1）'
  const res = await client.request('initialize', { protocolVersion: 2, clientCapabilities: {} }, 30_000)
  assert(res?.protocolVersion === 1,
    `请求 2 时返回 protocolVersion=${res?.protocolVersion}，期望回落为 1（服务端仅实现 v1）`)
  // 协商后连接仍可用：再发一次 initialize 应幂等成功
  const again = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} }, 30_000)
  assert(again?.protocolVersion === 1, '重复 initialize 后 protocolVersion 异常')
  return { detail: '请求 v2 回落为 v1，重复 initialize 幂等', data: { requested: 2, negotiated: res.protocolVersion } }
}

async function stepNewSession(client) {
  const id = 'SESS-01'
  const name = 'session/new 建会话（带 cwd）'
  const res = await client.request('session/new', { cwd: WORKDIR, mcpServers: [] })
  assert(typeof res?.sessionId === 'string' && res.sessionId.length > 0, 'sessionId 缺失')
  assert(Array.isArray(res.configOptions), 'configOptions 不是数组')
  const realCwd = realpathSync(WORKDIR)
  return {
    detail: `sessionId=${res.sessionId} configOptions=${res.configOptions.length} 项 cwd=${realCwd}`,
    data: { sessionId: res.sessionId, configOptionIds: res.configOptions.map((o) => o.id) },
    raw: res,
  }
}

function checkConfigRead(sessionRes) {
  const id = 'CFG-01'
  const name = 'configOptions 初始读取（model / reasoning_effort）'
  const opts = sessionRes.configOptions
  const modelOpt = opts.find((o) => o.id === 'model')
  assert(modelOpt !== undefined, 'configOptions 无 model 项')
  assert(modelOpt.type === 'select', `model.type=${modelOpt.type}，期望 select`)
  let parsed
  try { parsed = JSON.parse(modelOpt.currentValue) } catch { throw new Error(`model.currentValue 不是 JSON: ${modelOpt.currentValue}`) }
  assert(Array.isArray(parsed) && parsed.length === 2 && parsed.every((s) => typeof s === 'string'),
    `model.currentValue=${modelOpt.currentValue}，期望 ["provider","model"] 数组字符串`)
  const groups = Array.isArray(modelOpt.options) ? modelOpt.options.length : 0
  assert(groups > 0, 'model.options 为空')
  const reasoning = opts.find((o) => o.id === 'reasoning_effort')
  assert(reasoning !== undefined, 'configOptions 无 reasoning_effort 项')
  assert(reasoning.type === 'select', `reasoning_effort.type=${reasoning.type}，期望 select`)
  const values = (reasoning.options ?? []).map((o) => String(o.value)).filter((v) => v !== '')
  const sorted = [...new Set(values)].sort()
  assert(jsonOf(sorted) === jsonOf(EXPECTED_EFFORTS),
    `reasoning_effort 值集=${jsonOf(sorted)}，期望 ${jsonOf(EXPECTED_EFFORTS)}`)
  return {
    detail: `model=${parsed[0]}/${parsed[1]}（${groups} 个 provider 组）` +
      ` reasoning_effort 当前=${reasoning.currentValue} 可选=${values.join('/')}`,
    data: { model: parsed, reasoningCurrent: reasoning.currentValue, reasoningValues: values, groups },
    modelOpt,
    reasoning,
  }
}

async function stepConfigSet(client, sessionId, cfg) {
  const id = 'CFG-02'
  const name = 'configOptions 设置（reasoning_effort=low，回读生效）'
  const res = await client.request('session/set_config_option', {
    sessionId, configId: 'reasoning_effort', value: 'low',
  })
  assert(Array.isArray(res?.configOptions), 'set_config_option 未返回 configOptions')
  const reasoning = res.configOptions.find((o) => o.id === 'reasoning_effort')
  assert(reasoning !== undefined, '返回中缺少 reasoning_effort')
  assert(reasoning.currentValue === 'low', `reasoning_effort.currentValue=${reasoning.currentValue}，期望 low`)

  // 设置后独立读一次完整状态（session/resume 之外没有 getter，这里用 model 重选前先确认）
  const res2 = await client.request('session/set_config_option', {
    sessionId, configId: 'reasoning_effort', value: 'high',
  })
  const back = res2.configOptions.find((o) => o.id === 'reasoning_effort')
  assert(back?.currentValue === 'high', `回写 high 后 currentValue=${back?.currentValue}，期望 high`)

  const res3 = await client.request('session/set_config_option', {
    sessionId, configId: 'reasoning_effort', value: 'low',
  })
  const final = res3.configOptions.find((o) => o.id === 'reasoning_effort')
  assert(final?.currentValue === 'low', `最终 currentValue=${final?.currentValue}，期望 low`)
  const offered = cfg?.data?.reasoningValues ?? cfg?.reasoningValues ?? []
  assert(offered.includes('low'), `reasoning_effort 可选项中没有 low（实际：${jsonOf(offered)}）`)
  return `reasoning_effort low -> high -> low 均回读正确（原值 ${cfg?.data?.reasoningCurrent ?? '?'}）`
}

/**
 * 模型选择规则探测（独立会话，不干扰主流程）。
 * 这些是上游 dsh 的既定行为，记录为 INFO/发现，不作为失败。
 */
async function stepModelSwitch(client) {
  const name = '模型切换行为探测（可选项、reasoning 重置、能否切回）'
  const stateOf = (res) => {
    const model = res.configOptions.find((o) => o.id === 'model')
    const reasoning = res.configOptions.find((o) => o.id === 'reasoning_effort')
    const values = (model?.options ?? []).flatMap((g) => g.options.map((o) => o.value))
    return { model: model?.currentValue, reasoning: reasoning?.currentValue, values }
  }
  const fresh = await client.request('session/new', { cwd: WORKDIR, mcpServers: [] })
  const sid = fresh.sessionId
  try {
    const base = stateOf(fresh)
    await client.request('session/set_config_option', { sessionId: sid, configId: 'reasoning_effort', value: 'low' })
    const proValue = JSON.stringify(['deepseek-official', 'deepseek-v4-pro'])
    const switched = await client.request('session/set_config_option', {
      sessionId: sid, configId: 'model', value: proValue,
    })
    const afterSwitch = stateOf(switched)
    assert(afterSwitch.model === proValue, `切到 deepseek-v4-pro 后 currentValue=${afterSwitch.model}`)

    let back
    try {
      const res = await client.request('session/set_config_option', {
        sessionId: sid, configId: 'model', value: base.model,
      })
      back = { ok: true, current: stateOf(res).model }
    } catch (err) {
      back = { ok: false, code: err.rpc?.code, message: err.rpc?.message ?? err.message }
    }

    info('CFG-03a', '切换模型后 reasoning_effort 回到 provider 默认（上游行为，非缺陷）',
      `设置 low 后切到 deepseek-v4-pro，reasoning_effort 变为 ${afterSwitch.reasoning}；` +
      '对应 model-control.ts: set(model) 使用不含 reasoningEffort 的 selection')
    if (back.ok) {
      info('CFG-03b', '可切回初始模型', `切回 ${base.model} 成功，当前=${back.current}`)
    } else {
      info('CFG-03b', '无法切回初始模型（模型目录中不含它，仅作为当前值被注入选项）',
        `切回 ${base.model} 返回 code=${back.code} ${back.message}；` +
        `切换后 model 可选项=${jsonOf(afterSwitch.values)}`)
    }
    return {
      detail: `初始 model=${base.model} reasoning=${base.reasoning}；切到 deepseek-v4-pro 成功，` +
        `reasoning 重置为 ${afterSwitch.reasoning}；切回初始模型${back.ok ? '成功' : `被拒 code=${back.code}`}`,
      data: { base, afterSwitch, back },
    }
  } finally {
    try { await client.request('session/close', { sessionId: sid }, 60_000) } catch { /* 忽略 */ }
  }
}

async function stepPromptTool(client, sessionId) {
  const name = '真实回合：bash 工具执行 echo，校验 tool_call/tool_call_update 流'
  const turn = await runPrompt(
    client, sessionId,
    '只执行一步：调用 bash 工具运行命令 `echo DSH_ACP_OK`，然后原样回复该命令的输出。不要解释。',
  )
  dumpTurn('prompt#1', turn)
  assert(turn.res?.stopReason === 'end_turn', `stopReason=${turn.res?.stopReason}，期望 end_turn`)
  const calls = turn.updates.filter((u) => u.sessionUpdate === 'tool_call')
  const resultsU = turn.updates.filter((u) => u.sessionUpdate === 'tool_call_update')
  assert(calls.length > 0, '未收到任何 tool_call 更新（agent 未调用工具）')
  assert(resultsU.length > 0, '未收到任何 tool_call_update 更新')
  const completed = resultsU.filter((u) => u.status === 'completed')
  assert(completed.length > 0, `没有 completed 的 tool_call_update（实际状态：${resultsU.map((u) => u.status).join(',')}）`)
  const call = calls[0]
  assert(typeof call.toolCallId === 'string' && call.toolCallId.length > 0, 'tool_call 缺 toolCallId')
  assert(typeof call.title === 'string' && call.title.length > 0, 'tool_call 缺 title')
  assert(call.status === 'in_progress', `tool_call.status=${call.status}，期望 in_progress`)
  assert(typeof call.kind === 'string', 'tool_call 缺 kind')
  assert(call.rawInput !== undefined, 'tool_call 缺 rawInput')
  const match = completed.find((u) => u.toolCallId === call.toolCallId)
  assert(match !== undefined,
    `tool_call_update 的 toolCallId 与 tool_call 不匹配（tool_call=${call.toolCallId} updates=${jsonOf(resultsU.map((u) => u.toolCallId))}）`)
  const toolText = completed.map(textOf).join('\n')
  assert(toolText.includes('DSH_ACP_OK'), `工具输出未包含 DSH_ACP_OK，实际：${toolText.slice(0, 300)}`)
  const msgs = turn.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map(textOf).join('')
  assert(msgs.length > 0, '未收到 assistant 文本（agent_message_chunk）')
  assert(msgs.includes('DSH_ACP_OK'), `assistant 回复未包含 DSH_ACP_OK，实际：${msgs.slice(0, 300)}`)

  // usage_update 观测（软检查）
  const usage = turn.updates.filter((u) => u.sessionUpdate === 'usage_update')
  if (usage.length > 0) {
    const u = usage[0]
    if (typeof u.used === 'number' && typeof u.size === 'number' && u.size > 0) {
      info('USAGE-01', 'usage_update 出现且字段合法', `used=${u.used} size=${u.size}（本轮共 ${usage.length} 条）`)
    } else {
      fail('USAGE-01', 'usage_update 字段非法', jsonOf(u))
    }
  } else {
    info('USAGE-01', 'usage_update 未出现', '本轮未收到 usage_update（DSH 仅在同时具备 usage 与 contextWindow 时上报）')
  }

  return {
    detail: `stopReason=end_turn；tool_call(${call.title}) -> tool_call_update(completed，含 DSH_ACP_OK)；` +
      `assistant 文本含 DSH_ACP_OK；耗时 ${turn.ms}ms；更新 ${turn.updates.length} 条`,
    data: {
      toolTitle: call.title,
      toolCallId: call.toolCallId,
      toolInput: call.rawInput,
      updateKinds: turn.updates.map((u) => u.sessionUpdate),
      usage: usage.map((u) => ({ used: u.used, size: u.size })),
      ms: turn.ms,
    },
  }
}

async function stepConcurrent(client, sessionId) {
  const id = 'CONC-01'
  const name = '并发 prompt 被拒（-32602），随后取消收尾'
  const updates = []
  let cancelIssued = false
  let errorResult
  let firstRes
  const cancel = () => {
    if (cancelIssued) return
    cancelIssued = true
    client.notify('session/cancel', { sessionId })
  }
  const off = client.onNotification((msg) => {
    if (msg.method !== 'session/update' || msg.params?.sessionId !== sessionId) return
    const u = msg.params.update
    updates.push(u)
    if (u.sessionUpdate === 'tool_call' && errorResult === undefined) {
      errorResult = client.request('session/prompt', {
        sessionId, prompt: [{ type: 'text', text: '第二个并发请求' }],
      }, 60_000).then(
        (res) => ({ ok: true, res }),
        (err) => ({ ok: false, rpc: err.rpc, message: err.message }),
      ).finally(cancel)
    }
  })
  const t0 = Date.now()
  try {
    const first = client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: '调用 bash 工具运行 `sleep 20; echo CONC_DONE`，然后回复结果。' }],
    })
    // 等第一个请求在飞行中
    while (errorResult === undefined && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 50))
    assert(errorResult !== undefined, '未观测到 tool_call，无法发起并发请求')
    const outcome = await errorResult
    firstRes = await first.catch((e) => ({ error: e.message }))
    assert(outcome.ok === false, `并发 prompt 未被拒绝，返回 ${jsonOf(outcome.res).slice(0, 200)}`)
    assert(outcome.rpc?.code === -32602, `并发 prompt 错误码=${outcome.rpc?.code}，期望 -32602`)
    assert(/already in flight/i.test(outcome.rpc?.message ?? ''),
      `并发 prompt 错误信息不符：${outcome.rpc?.message}`)
    assert(cancelIssued, '未发出 session/cancel')
    assert(firstRes?.stopReason === 'cancelled', `首个 prompt stopReason=${jsonOf(firstRes)}，期望 cancelled`)
    return `并发请求被拒：code=-32602 msg="${outcome.rpc.message}"；首个 prompt 收尾 stopReason=cancelled`
  } finally {
    off()
    await client.quiet()
  }
}

async function stepCancel(client, sessionId) {
  const id = 'CANCEL-01'
  const name = 'session/cancel 中断进行中的回合（长耗时 bash 工具）'
  const turn = await runPrompt(
    client, sessionId,
    '调用 bash 工具运行 `sleep 30; echo SLEPT_DONE`，然后回复结果。不要做别的事。',
    { cancelOnSessionUpdate: 'tool_call', cancelAfterMs: 20_000 },
  )
  dumpTurn('prompt#2(cancel)', turn)
  assert(turn.cancelled, '未能在回合结束前发出 cancel')
  assert(turn.res?.stopReason === 'cancelled', `stopReason=${turn.res?.stopReason}，期望 cancelled`)
  const toolUpdates = turn.updates.filter((u) => u.sessionUpdate === 'tool_call_update')
  const failed = toolUpdates.filter((u) => u.status === 'failed')
  assert(failed.length > 0, `取消后未出现 failed 的 tool_call_update（实际：${jsonOf(toolUpdates.map((u) => u.status))}）`)
  assert(turn.ms < 20_000, `取消响应耗时 ${turn.ms}ms，期望远小于 sleep 30s`)
  return `cancel 后 stopReason=cancelled，tool_call_update=failed，响应 ${turn.ms}ms`
}

/** 回合进行中立即取消（模型尚未产出时）应立刻收敛为 cancelled。 */
async function stepCancelEarly(client, sessionId) {
  const id = 'CANCEL-02'
  const name = 'session/cancel 在模型产出前立即取消'
  const turn = await runPrompt(
    client, sessionId,
    '请写一段约 800 字的中文散文，不要使用工具。',
    { cancelAfterMs: 400 },
  )
  dumpTurn('prompt#5(cancel-early)', turn)
  assert(turn.cancelled, '未发出 cancel')
  assert(turn.res?.stopReason === 'cancelled', `stopReason=${turn.res?.stopReason}，期望 cancelled`)
  assert(turn.ms < 5_000, `取消响应耗时 ${turn.ms}ms，期望接近即时`)
  return { detail: `模型产出前取消：stopReason=cancelled，${turn.ms}ms 内收敛`, data: { ms: turn.ms } }
}

/**
 * 流式粒度观测：DSH 按「提交后的完整消息」产出 agent_message_chunk，
 * 而非增量 token 流。记录 chunk 数，供 T3 侧体验评估。
 */
async function stepStreaming(client, sessionId) {
  const name = '流式粒度观测（chunk 数量与到达时间）'
  const turn = await runPrompt(
    client, sessionId,
    '请从 1 数到 120，每行一个数字，不要使用工具，不要解释。',
  )
  dumpTurn('prompt#6(streaming)', turn)
  assert(turn.res?.stopReason === 'end_turn', `stopReason=${turn.res?.stopReason}，期望 end_turn`)
  const chunks = turn.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk')
  const text = chunks.map(textOf).join('')
  assert(chunks.length >= 1, '未收到 agent_message_chunk')
  assert(text.includes('120'), `流式回合回复不完整（长度 ${text.length}）`)
  info('STREAM-01', 'agent_message_chunk 为整段投递而非增量流',
    `一次 ${text.length} 字符的回复仅收到 ${chunks.length} 条 agent_message_chunk，` +
    `整回合耗时 ${turn.ms}ms（同回合 tool_call/usage_update 为事件级实时推送）；` +
    '含义：T3 中文字回复无逐字流式效果，只在消息提交时一次性出现')
  return {
    detail: `${text.length} 字符回复、${chunks.length} 条 chunk，整回合 ${turn.ms}ms`,
    data: { chunks: chunks.length, chars: text.length, ms: turn.ms },
  }
}

async function stepErrors(client, sessionId) {
  const name = '错误处理：非法方法 / 未知会话 / 非法 config / 空 prompt / 相对 cwd / 图片 / 目录扩展'
  const checks = []
  const expectError = async (label, method, params, expectedCode) => {
    try {
      const res = await client.request(method, params, 60_000)
      checks.push({ label, ok: false, detail: `未报错，返回 ${jsonOf(res).slice(0, 160)}` })
    } catch (err) {
      const code = err.rpc?.code
      const ok = expectedCode === undefined
        ? typeof code === 'number'
        : code === expectedCode
      checks.push({ label, ok, code, detail: `code=${code} msg=${err.rpc?.message ?? err.message}` })
    }
  }
  const bogus = '00000000-0000-4000-8000-000000000000'
  await expectError('非法方法', 'session/does_not_exist', {}, -32601)
  await expectError('prompt 未知会话', 'session/prompt', { sessionId: bogus, prompt: [{ type: 'text', text: 'x' }] }, -32602)
  await expectError('未知 configId', 'session/set_config_option', { sessionId, configId: 'no_such_option', value: 'x' }, -32602)
  await expectError('非法 reasoning_effort 值', 'session/set_config_option', { sessionId, configId: 'reasoning_effort', value: 'ultra-max' }, -32602)
  await expectError('空 prompt', 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '   ' }] }, -32602)
  await expectError('session/new 相对 cwd', 'session/new', { cwd: 'relative/path', mcpServers: [] }, -32602)
  await expectError('session/new additionalDirectories', 'session/new',
    { cwd: WORKDIR, mcpServers: [], additionalDirectories: [WORKDIR] }, -32602)
  await expectError('session/new 非法 MCP server', 'session/new',
    { cwd: WORKDIR, mcpServers: [{ type: 'sse', name: 'bad', url: 'ftp://x', headers: [] }] }, -32602)
  await expectError('图片 prompt（image 能力为 false）', 'session/prompt',
    { sessionId, prompt: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] }, -32602)
  await expectError('未知会话 close', 'session/close', { sessionId: bogus }, -32602)
  await expectError('session/list 非法 cursor', 'session/list', { cwd: WORKDIR, cursor: '!!not-base64!!' }, -32602)
  await expectError('session/resume 未知会话', 'session/resume', { sessionId: bogus, cwd: WORKDIR, mcpServers: [] }, -32602)
  await expectError('session/new 缺 mcpServers', 'session/new', { cwd: WORKDIR }, -32602)
  await expectError('session/new 缺 cwd', 'session/new', { mcpServers: [] }, -32602)
  await expectError('session/resume 缺 cwd', 'session/resume', { sessionId, mcpServers: [] }, -32602)

  for (const c of checks) console.log(`    · ${c.label}: ${c.detail}`)
  const bad = checks.filter((c) => !c.ok)
  if (bad.length > 0) {
    throw new Error(`${bad.length}/${checks.length} 项错误处理不符合预期：` +
      bad.map((c) => `${c.label} -> ${c.detail}`).join('；'))
  }
  return {
    detail: `${checks.length}/${checks.length} 项均返回预期 JSON-RPC 错误码（` +
      `${checks.map((c) => `${c.label}=${c.code}`).join('，')}）`,
    data: checks,
  }
}

async function stepClose(client, sessionId) {
  const id = 'SESS-02'
  const name = 'session/close 关闭会话'
  const res = await client.request('session/close', { sessionId }, 60_000)
  assert(typeof res === 'object' && res !== null, 'session/close 未返回对象')
  return `返回 ${jsonOf(res)}`
}

async function stepList(client, sessionId) {
  const id = 'LIST-01'
  const name = 'session/list（cwd 过滤、已关闭会话可见、分页）'
  const real = realpathSync(WORKDIR)
  const page1 = await client.request('session/list', { cwd: WORKDIR }, 60_000)
  assert(Array.isArray(page1?.sessions), 'session/list 返回缺少 sessions 数组')
  const all = [...page1.sessions]
  let pages = 1
  let cursor = page1.nextCursor
  let overlap = 0
  while (cursor !== undefined && pages < 10) {
    const next = await client.request('session/list', { cwd: WORKDIR, cursor }, 60_000)
    assert(Array.isArray(next?.sessions), '分页返回缺少 sessions 数组')
    for (const s of next.sessions) if (all.some((p) => p.sessionId === s.sessionId)) overlap++
    all.push(...next.sessions)
    pages++
    cursor = next.nextCursor
  }
  assert(overlap === 0, `分页结果存在重复会话项（${overlap} 条）`)
  const perPageMax = Math.max(page1.sessions.length, ...all.map(() => 0))
  assert(page1.sessions.length <= 100, `单页返回 ${page1.sessions.length} 条，超过配置页大小 100`)
  const found = all.find((s) => s.sessionId === sessionId)
  assert(found !== undefined, `列表中未找到 sessionId=${sessionId}（共 ${all.length} 条 / ${pages} 页）`)
  assert(typeof found.cwd === 'string', '列表项缺 cwd')
  assert(realpathSync(found.cwd) === real, `列表项 cwd=${found.cwd}，期望 ${real}`)
  for (const s of all) {
    if (s.cwd !== undefined) assert(realpathSync(s.cwd) === real, `列表混入其它 cwd：${s.cwd}`)
  }
  return {
    detail: `目标会话在第 ${pages} 页内找到，cwd=${found.cwd}；按 cwd 过滤共 ${all.length} 条、${pages} 页，` +
      `单页上限 ${page1.sessions.length}，分页无重复`,
    data: { count: all.length, pages, firstPageSize: page1.sessions.length, hadNextCursor: page1.nextCursor !== undefined, perPageMax },
  }
}

async function stepResume(client, sessionId) {
  const id = 'RESUME-01'
  const name = 'session/resume 恢复已关闭会话'
  const res = await client.request('session/resume', { sessionId, cwd: WORKDIR, mcpServers: [] }, 120_000)
  assert(Array.isArray(res?.configOptions), 'resume 未返回 configOptions')
  const reasoning = res.configOptions.find((o) => o.id === 'reasoning_effort')
  assert(reasoning !== undefined, 'resume 返回中缺少 reasoning_effort')
  assert(reasoning.currentValue === 'low',
    `恢复后 reasoning_effort=${reasoning.currentValue}，期望 low（应保留会话内选择）`)
  return `resume 成功，configOptions ${res.configOptions.length} 项，reasoning_effort 保持 low`
}

async function stepResumeContinuity(client, sessionId) {
  const id = 'RESUME-02'
  const name = 'resume 后上下文连续性（回忆本会话此前的 bash 命令）'
  const turn = await runPrompt(
    client, sessionId,
    '回顾本会话此前的对话：我给你下达过哪些用 bash 执行的命令？只列出命令字符串本身，每行一个，不要解释。',
  )
  dumpTurn('prompt#3(recall)', turn)
  assert(turn.res?.stopReason === 'end_turn', `stopReason=${turn.res?.stopReason}，期望 end_turn`)
  const text = turn.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map(textOf).join('')
  assert(text.trim().length > 0, '恢复后的会话没有返回文本')
  // 任一会话内出现过的命令字符串都足以证明历史被恢复；模型也可能只提到被取消的那一轮。
  const markers = ['DSH_ACP_OK', 'SLEPT_DONE', 'CONC_DONE']
  const hit = markers.filter((m) => text.includes(m))
  assert(hit.length > 0,
    `恢复后的会话未体现任何此前回合内容（期望包含 ${markers.join(' / ')} 之一），回复：${text.slice(0, 300)}`)
  return {
    detail: `恢复后回忆到此前命令（命中 ${hit.join('/')}）；耗时 ${turn.ms}ms`,
    data: { ms: turn.ms, hits: hit, reply: text.slice(0, 300) },
  }
}

/** 真实 T3 路径：用 settings.json 中记录的 profile 启动 ACP 并跑一个最小回合。 */
async function stepT3ProfileEndToEnd() {
  const id = 'T3-03'
  const name = '端到端：按 T3 settings 的 commandArgs 启动并完成一个最小回合（只读）'
  const { instance } = readT3Settings()
  const cfg = instance.config
  const client = new AcpClient({
    command: cfg.commandPath,
    args: cfg.commandArgs,
    cwd: WORKDIR,
    label: `t3:${cfg.commandArgs.join(' ')}`,
  })
  let sessionId
  try {
    const init = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })
    assert(init.protocolVersion === 1, `protocolVersion=${init.protocolVersion}`)
    assert(init.agentInfo?.name === 'deepseek-harness-acp', `agentInfo.name=${init.agentInfo?.name}`)
    const sess = await client.request('session/new', { cwd: WORKDIR, mcpServers: [] })
    sessionId = sess.sessionId
    const model = sess.configOptions?.find((o) => o.id === 'model')
    const reasoning = sess.configOptions?.find((o) => o.id === 'reasoning_effort')
    assert(model !== undefined && reasoning !== undefined, 't3 profile 的 configOptions 缺少 model/reasoning_effort')
    const turn = await runPrompt(client, sessionId, '只回复字符串 T3_E2E_OK，不要使用任何工具，不要解释。')
    dumpTurn('prompt#4(t3 profile)', turn)
    assert(turn.res?.stopReason === 'end_turn', `stopReason=${turn.res?.stopReason}`)
    const text = turn.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map(textOf).join('')
    assert(text.includes('T3_E2E_OK'), `回复未包含 T3_E2E_OK：${text.slice(0, 300)}`)
    await client.request('session/close', { sessionId }, 60_000)
    sessionId = undefined
    return {
      detail: `按 ${cfg.commandArgs.join(' ')} 启动成功；model=${model.currentValue} reasoning=${reasoning.currentValue}；` +
        `最小回合 end_turn，回复含 T3_E2E_OK（${turn.ms}ms）`,
      data: { model: model.currentValue, reasoningCurrent: reasoning.currentValue, ms: turn.ms },
    }
  } finally {
    if (sessionId !== undefined) {
      try { await client.request('session/close', { sessionId }, 30_000) } catch { /* 忽略清理失败 */ }
    }
    await client.shutdown()
  }
}

async function stepShutdown(client) {
  const id = 'EXIT-01'
  const name = '关闭 stdin 后 dsh 正常退出'
  const { exited, exitInfo } = await client.shutdown()
  assert(exited, '关闭 stdin 后 8 秒内未退出（已强制结束）')
  assert(exitInfo?.code === 0, `退出码 ${exitInfo?.code}，signal=${exitInfo?.signal}`)
  return `退出码 0（signal=${exitInfo?.signal ?? '无'}）`
}

/** 会话存储与 T3 profile 共享：acp profile 建的会话应能被 t3 profile 列出。 */
async function stepCrossProfileVisibility() {
  const { instance } = readT3Settings()
  const cfg = instance.config
  const a = new AcpClient({ label: 'acp:acp' })
  let sid
  try {
    await a.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const s = await a.request('session/new', { cwd: WORKDIR, mcpServers: [] })
    sid = s.sessionId
    await a.request('session/close', { sessionId: sid }, 60_000)
  } finally {
    await a.shutdown()
  }
  const b = new AcpClient({ command: cfg.commandPath, args: cfg.commandArgs, label: 't3:list' })
  try {
    await b.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const sessions = await listAllSessions(b)
    const found = sessions.some((x) => x.sessionId === sid)
    assert(found, `acp profile 创建的会话 ${sid} 未出现在 t3 profile 的 session/list 中（共享存储未生效？）`)
    info('LIST-02', '跨 profile 会话可见性（共享 ~/.dsh/sessions）',
      `acp profile 创建的会话在 t3 profile 的 list 中可见（名单 ${sessions.length} 条）；` +
      '含义：T3 的会话列表也会包含同一 cwd 下由桌面客户端等其它 profile 创建的会话')
    return `acp→t3 会话可见（${sid}）`
  } finally {
    await b.shutdown()
  }
}

/** 翻完所有分页，返回该 cwd 下的完整会话列表。 */
async function listAllSessions(client, cwd = WORKDIR, maxPages = 20) {
  const all = []
  let cursor
  for (let page = 0; page < maxPages; page++) {
    const res = await client.request('session/list', cursor === undefined ? { cwd } : { cwd, cursor }, 60_000)
    assert(Array.isArray(res?.sessions), 'session/list 返回缺少 sessions 数组')
    all.push(...res.sessions)
    cursor = res.nextCursor
    if (cursor === undefined) return all
  }
  throw new Error(`session/list 分页超过 ${maxPages} 页仍未结束（可能 cursor 未推进）`)
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
  console.log('='.repeat(78))
  console.log(`dsh ACP 验证套件  ${new Date().toISOString()}`)
  console.log(`被测 profile: ${TEST_PROFILE}   工作目录: ${WORKDIR}`)
  console.log(`node ${process.version} / ${process.platform} ${process.arch}`)
  console.log('='.repeat(78))

  await guarded(null, 'T3-01', 'T3 settings.json 中 dsh 实例（只读校验）', stepT3Settings)
  await guarded(null, 'T3-02', 'dsh CLI 可用性与版本', stepVersion)

  const client = new AcpClient({ label: `acp:${TEST_PROFILE}` })
  const state = { sessionId: undefined, sessionRes: undefined, cfg: undefined }

  try {
    await guarded(client, 'INIT-01', 'initialize 握手', () => stepInitialize(client))
    await guarded(client, 'INIT-02', 'authenticate 空操作可用（无需凭据步骤）', () => stepAuthenticate(client))
    await guarded(client, 'INIT-03', 'protocolVersion 协商（请求 2，服务端回落到 1）', () => stepVersionNegotiation(client))

    const newOut = await guarded(client, 'SESS-01', 'session/new 建会话（带 cwd）', async () => {
      const res = await stepNewSession(client)
      state.sessionRes = res.raw
      state.sessionId = res.data.sessionId
      return res
    })

    if (newOut !== undefined) {
      await guarded(client, 'CFG-01', 'configOptions 初始读取（model / reasoning_effort）', () => {
        state.cfg = checkConfigRead(state.sessionRes)
        return { detail: state.cfg.detail, data: state.cfg.data }
      })
      await guarded(client, 'CFG-02', 'configOptions 设置（reasoning_effort=low，回读生效）',
        () => stepConfigSet(client, state.sessionId, state.cfg))
      await guarded(client, 'CFG-03', '模型切换行为探测（可选项、reasoning 重置、能否切回）',
        () => stepModelSwitch(client))
      await guarded(client, 'PROMPT-01', '真实回合：bash 工具执行 echo，校验 tool_call/tool_call_update 流',
        () => stepPromptTool(client, state.sessionId))
      await guarded(client, 'CONC-01', '并发 prompt 被拒（-32602），随后取消收尾',
        () => stepConcurrent(client, state.sessionId))
      await guarded(client, 'CANCEL-01', 'session/cancel 中断进行中的回合（长耗时 bash 工具）',
        () => stepCancel(client, state.sessionId))
      await guarded(client, 'CANCEL-02', 'session/cancel 在模型产出前立即取消',
        () => stepCancelEarly(client, state.sessionId))
      await guarded(client, 'STREAM-01', '流式粒度观测（chunk 数量与到达时间）',
        () => stepStreaming(client, state.sessionId))
      await guarded(client, 'ERR-01', '错误处理：非法方法 / 未知会话 / 非法 config / 空 prompt 等',
        () => stepErrors(client, state.sessionId))
      await guarded(client, 'SESS-02', 'session/close 关闭会话', () => stepClose(client, state.sessionId))
      await guarded(client, 'LIST-01', 'session/list（cwd 过滤，已关闭会话可见）',
        () => stepList(client, state.sessionId))
      await guarded(null, 'LIST-02', '跨 profile 会话可见性（acp 建的会话在 t3 profile 可见）',
        stepCrossProfileVisibility)
      const resumeOut = await guarded(client, 'RESUME-01', 'session/resume 恢复已关闭会话',
        () => stepResume(client, state.sessionId))
      if (resumeOut !== undefined) {
        await guarded(client, 'RESUME-02', 'resume 后上下文连续性（回忆本会话此前的 bash 命令）',
          () => stepResumeContinuity(client, state.sessionId))
        try { await client.request('session/close', { sessionId: state.sessionId }, 60_000) } catch { /* 忽略 */ }
      }
    } else {
      for (const [id, name] of [
        ['CFG-01', 'configOptions 初始读取'], ['CFG-02', 'configOptions 设置'],
        ['PROMPT-01', '真实回合'], ['CONC-01', '并发 prompt'], ['CANCEL-01', 'session/cancel'],
        ['CANCEL-02', '模型产出前取消'], ['STREAM-01', '流式粒度'],
        ['ERR-01', '错误处理'], ['SESS-02', 'session/close'], ['LIST-01', 'session/list'],
        ['RESUME-01', 'session/resume'], ['RESUME-02', 'resume 上下文连续性'],
      ]) skip(id, name, '因 session/new 失败而跳过')
    }
  } finally {
    await guarded(client, 'EXIT-01', '关闭 stdin 后 dsh 正常退出', () => stepShutdown(client))
  }

  await guarded(null, 'T3-03', '端到端：按 T3 settings 的 commandArgs 启动并完成一个最小回合（只读）',
    stepT3ProfileEndToEnd)

  const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc }, {})
  const failures = results.filter((r) => r.status === 'FAIL')
  console.log('\n' + '-'.repeat(78))
  console.log(`汇总: PASS=${counts.PASS ?? 0} FAIL=${counts.FAIL ?? 0} INFO=${counts.INFO ?? 0} ` +
    `SKIP=${counts.SKIP ?? 0}  用时 ${Math.round((Date.now() - startedAt) / 1000)}s`)
  if (failures.length > 0) {
    console.log('失败项:')
    for (const f of failures) console.log(`  - [${f.id}] ${f.name}: ${f.detail}`)
  }
  console.log(`结果: ${failures.length === 0 ? '全部通过' : '存在失败'}`)

  if (outPath !== undefined) {
    const frames = client.frames.map((f) => (
      f.dir === 'nonjson'
        ? { dir: 'nonjson', t: f.t, raw: String(f.raw).slice(0, 2000) }
        : { dir: f.dir, t: f.t, msg: JSON.parse(JSON.stringify(f.msg, (k, v) => (
          typeof v === 'string' && v.length > 2000 ? `${v.slice(0, 2000)}…[${v.length} 字符]` : v
        ))) }
    ))
    writeFileSync(outPath, JSON.stringify({
      runId,
      profile: TEST_PROFILE,
      startedAt: new Date(startedAt).toISOString(),
      durationSeconds: Math.round((Date.now() - startedAt) / 1000),
      workdir: WORKDIR,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      counts,
      results,
      frames,
      stderrTail: client.stderr.slice(-8000),
    }, null, 2))
    console.log(`结构化结果已写入: ${outPath}`)
  }

  process.exitCode = failures.length === 0 ? 0 : 1
}

main().catch((err) => {
  console.error('套件崩溃:', err)
  process.exitCode = 2
})