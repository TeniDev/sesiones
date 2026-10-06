// Dashboard local de las sesiones de Claude Code: estado en vivo, bloques (turnos) y waves (Workflow) con tiempos y ETA.
// Solo stdlib de Node. `node server.mjs` sirve en http://127.0.0.1:4777; `node server.mjs --open` lo arranca desacoplado si hace falta y abre el navegador.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const PORT = 4777
const URL_ = `http://127.0.0.1:${PORT}`
const CLOSE_AFTER_MS = 2 * 60_000
const TICK_MS = 2000
const ROOT = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const SESSIONS = path.join(ROOT, 'sessions')
const PROJECTS = path.join(ROOT, 'projects')
const STATE = path.join(ROOT, 'sesiones-dashboard.json')
const PROGRESS = path.join(ROOT, 'sesiones', 'progress') // <sessionId>.json que escribe cada sesión con el skill `progreso`
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const COMMIT_RE = /^\[[^\]\n]+ ([0-9a-f]{7,40})\] (.+)$/m
const EMPTY = Buffer.alloc(0)

const known = new Map()    // sessionId → { sessionId, pid, cwd, name, status, startedAt, endedAt }
const parsed = new Map()   // sessionId → lo extraído de su transcript
const history = new Map()  // workflowName → duraciones (ms) de corridas completadas
const histSeen = new Set()
let booted = false

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const ls = d => { try { return fs.readdirSync(d) } catch { return [] } }
const mtime = f => { try { return fs.statSync(f).mtimeMs } catch { return 0 } }
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const ms = iso => (iso ? Date.parse(iso) || 0 : 0)
const text = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b.text ?? '').join('\n') : '')
const rel = (cwd, f) => { const r = path.relative(cwd, f); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : f }
const sleep = t => new Promise(r => setTimeout(r, t))
const VERSION = readJson(new URL('./.claude-plugin/plugin.json', import.meta.url))?.version ?? 'dev'
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
const summaryOf = s => s?.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)/)?.[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') ?? s ?? ''

// Lee solo lo nuevo de un .jsonl (los transcripts llegan a 50 MB). null = el archivo se reescribió y se relee desde 0.
function readNew(file, rd) {
  let size
  try { size = fs.statSync(file).size } catch { return [] }
  if (size < rd.off) { rd.off = 0; rd.rest = EMPTY; return null }
  if (size === rd.off) return []
  const buf = Buffer.alloc(size - rd.off)
  const fd = fs.openSync(file, 'r')
  try { fs.readSync(fd, buf, 0, buf.length, rd.off) } finally { fs.closeSync(fd) }
  rd.off = size
  const all = rd.rest.length ? Buffer.concat([rd.rest, buf]) : buf
  const cut = all.lastIndexOf(10) + 1
  rd.rest = Buffer.from(all.subarray(cut)) // copia: no retener el buffer grande
  const out = []
  for (const line of all.subarray(0, cut).toString('utf8').split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch {}
  }
  return out
}

function findTranscript(id) {
  for (const d of ls(PROJECTS)) {
    const f = path.join(PROJECTS, d, `${id}.jsonl`)
    if (fs.existsSync(f)) return f
  }
}

function promptText(c) {
  const t = text(c)
  const cmd = t.match(/<command-name>([^<]*)<\/command-name>/)
  if (cmd) return `${cmd[1]} ${t.match(/<command-args>([^<]*)<\/command-args>/)?.[1] ?? ''}`.trim()
  return t.trim()
}

const toolHint = x => {
  const i = x.input ?? {}
  const h = i.file_path ? path.basename(i.file_path) : (i.description || i.command || i.pattern || i.url || '')
  return h ? `${x.name} · ${String(h).split('\n')[0].slice(0, 80)}` : x.name
}

// Un bloque = tu prompt + todo lo que Claude hizo hasta el siguiente prompt tuyo (incluye los turnos que disparan las notificaciones de tareas).
function ingest(p, r) {
  if (r.uuid) { if (p.seen.has(r.uuid)) return; p.seen.add(r.uuid) }
  if (r.type === 'ai-title') { p.title = r.aiTitle; return }
  const ts = ms(r.timestamp)
  if (!ts) return
  p.last = Math.max(p.last, ts)
  const c = r.message?.content
  if (r.type === 'user' && r.origin?.kind === 'human' && !r.isMeta) {
    p.blocks.push({ prompt: promptText(c).slice(0, 3000), start: ts, end: ts, tools: {}, files: new Set(), commits: [], waves: [] })
    return
  }
  const b = p.blocks.at(-1)
  if (!b || r.isSidechain) return
  b.end = Math.max(b.end, ts)
  if (!Array.isArray(c)) return
  for (const x of c) {
    if (x.type === 'tool_use') {
      p.activity = { text: toolHint(x), at: ts }
      b.tools[x.name] = (b.tools[x.name] || 0) + 1
      if (EDIT_TOOLS.has(x.name)) b.files.add(x.input?.file_path || x.input?.notebook_path)
      if (x.name === 'Bash') p.bash.add(x.id)
      if (x.name === 'Workflow') p.pending.set(x.id, x.input ?? {})
    } else if (x.type === 'tool_result') {
      if (p.bash.delete(x.tool_use_id)) {
        const m = text(x.content).match(COMMIT_RE)
        if (m) b.commits.push({ hash: m[1].slice(0, 9), msg: m[2] })
      }
      const res = r.toolUseResult
      if (res?.taskType === 'local_workflow' && res.runId) {
        const input = p.pending.get(x.tool_use_id) ?? {}
        p.pending.delete(x.tool_use_id)
        const w = p.waves.get(res.runId) ?? { runId: res.runId, block: p.blocks.length - 1 }
        Object.assign(w, { name: res.workflowName, summary: res.summary, dir: res.transcriptDir, lastLaunch: ts })
        w.tag = input.args?.wave ?? w.tag ?? ''
        w.script = input.script || w.script
        w.scriptPath = input.scriptPath || w.scriptPath
        delete w.live // una reanudación reescribe el journal
        p.waves.set(res.runId, w)
        if (!b.waves.includes(res.runId)) b.waves.push(res.runId)
      }
    }
  }
}

function phaseTitles(w) {
  let src = w.script
  if (!src && w.scriptPath) try { src = fs.readFileSync(w.scriptPath, 'utf8') } catch {}
  const m = src?.match(/phases\s*:\s*\[([\s\S]*?)\]/) // ponytail: regex sobre el literal `meta`; basta mientras sea un literal puro
  return m ? [...m[1].matchAll(/title\s*:\s*(['"`])(.*?)\1/g)].map(x => x[2]) : []
}

const groupPhases = (titles, agents) =>
  [...new Set([...titles, ...agents.map(a => a.phase)])].map(t => ({ title: t, agents: agents.filter(a => a.phase === t) }))

function finishedWave(w, d) {
  const agents = (d.workflowProgress ?? []).filter(x => x.type === 'workflow_agent').map(a => ({
    label: a.label, phase: a.phaseTitle || 'Sin fase', state: a.state, start: a.startedAt,
    end: a.startedAt + (a.durationMs ?? 0), tools: a.toolCalls ?? 0, tokens: a.tokens ?? 0,
    lastTool: a.lastToolName ?? '', files: [], result: summaryOf(a.resultPreview).slice(0, 600),
  }))
  return {
    runId: w.runId, name: d.workflowName || w.name, tag: w.tag, summary: w.summary, status: d.status,
    start: d.startTime || w.lastLaunch, end: (d.startTime || w.lastLaunch) + (d.durationMs ?? 0),
    progress: 1, tokens: d.totalTokens ?? 0, logs: d.logs ?? [],
    phases: groupPhases((d.phases ?? []).map(x => x.title), agents),
  }
}

function liveWave(w, sessionLive) {
  const L = (w.live ??= { rd: { off: 0, rest: EMPTY }, agents: new Map(), titles: phaseTitles(w) })
  const events = readNew(path.join(w.dir, 'journal.jsonl'), L.rd)
  if (events === null) { delete w.live; return liveWave(w, sessionLive) }
  for (const e of events) {
    if (e.type === 'started') L.agents.set(e.agentId, { id: e.agentId, label: e.label, phase: e.phase || 'Sin fase', rd: { off: 0, rest: EMPTY }, tools: 0, files: new Set(), lastTool: '', start: 0, end: 0, done: false, result: '' })
    if (e.type === 'result' && L.agents.has(e.agentId)) {
      const a = L.agents.get(e.agentId)
      a.done = true
      a.result = (typeof e.result === 'string' ? summaryOf(e.result) : e.result?.summary ?? JSON.stringify(e.result) ?? '').slice(0, 600)
    }
  }
  for (const a of L.agents.values()) {
    for (const r of readNew(path.join(w.dir, `agent-${a.id}.jsonl`), a.rd) ?? []) {
      const ts = ms(r.timestamp)
      if (ts) { a.start ||= ts; a.end = Math.max(a.end, ts) }
      for (const x of Array.isArray(r.message?.content) ? r.message.content : []) {
        if (x.type !== 'tool_use') continue
        a.tools++
        a.lastTool = toolHint(x)
        if (EDIT_TOOLS.has(x.name)) a.files.add(path.basename(x.input?.file_path ?? ''))
      }
    }
  }
  const agents = [...L.agents.values()].map(a => ({
    label: a.label, phase: a.phase, state: a.done ? 'done' : sessionLive ? 'running' : 'interrupted',
    start: a.start, end: a.end, tools: a.tools, tokens: 0, lastTool: a.lastTool, files: [...a.files], result: a.result,
  }))
  const phases = groupPhases(L.titles, agents)
  // ponytail: agentes esperados = el máximo visto en una fase × nº de fases; se equivoca si las fases tienen tamaños muy distintos.
  // Mejora: medianas por fase del historial del mismo workflow.
  const expected = Math.max(agents.length, Math.max(0, ...phases.map(p => p.agents.length)) * phases.length)
  const done = agents.filter(a => a.state === 'done')
  const progress = expected ? done.length / expected : 0
  const lastDone = Math.max(0, ...done.map(a => a.end))
  const h = history.get(w.name) ?? []
  const fromHistory = h.length >= 2
  return {
    runId: w.runId, name: w.name, tag: w.tag, summary: w.summary,
    status: sessionLive ? 'running' : 'interrupted',
    start: w.lastLaunch, end: sessionLive ? null : Math.max(w.lastLaunch, ...agents.map(a => a.end)),
    progress, tokens: 0, logs: [],
    expectedMs: fromHistory ? median(h) : progress && lastDone > w.lastLaunch ? (lastDone - w.lastLaunch) / progress : null,
    etaBasis: fromHistory ? { runs: h.length, min: Math.min(...h), max: Math.max(...h) } : null,
    phases,
  }
}

function waveView(w, sessionDir, sessionLive) {
  w.dir ||= path.join(sessionDir, 'subagents', 'workflows', w.runId)
  const final = path.join(sessionDir, 'workflows', `${w.runId}.json`)
  const fm = mtime(final)
  if (fm && fm >= w.lastLaunch) {
    if (w.final?.mtime !== fm) { const d = readJson(final); if (d) w.final = { mtime: fm, view: finishedWave(w, d) } }
    if (w.final) return w.final.view
  }
  return liveWave(w, sessionLive)
}

function sessionView(k) {
  const p = parsed.get(k.sessionId)
  const live = !k.endedAt
  const state = live ? k.status || 'busy' : 'ended'
  const waves = p ? [...p.waves.values()].map(w => waveView(w, p.file.slice(0, -'.jsonl'.length), live)) : []
  const blocks = (p?.blocks ?? []).map((b, i, all) => ({
    prompt: b.prompt, start: b.start, end: b.end, running: state === 'busy' && i === all.length - 1,
    tools: b.tools, files: [...b.files].filter(Boolean).map(f => rel(k.cwd, f)), commits: b.commits, waves: b.waves,
  }))
  const agents = waves.flatMap(w => w.phases.flatMap(ph => ph.agents))
  return {
    id: k.sessionId, name: k.name, title: p?.title || '', cwd: k.cwd, project: path.basename(k.cwd || ''),
    state, startedAt: k.startedAt, endedAt: k.endedAt, closableAt: k.endedAt ? k.endedAt + CLOSE_AFTER_MS : null,
    last: p?.last || k.startedAt, activity: p?.activity ?? null, declared: declaredProgress(k.sessionId), blocks, waves,
    stats: {
      blocks: blocks.length, files: new Set(blocks.flatMap(b => b.files)).size,
      commits: blocks.reduce((n, b) => n + b.commits.length, 0),
      tools: blocks.reduce((n, b) => n + Object.values(b.tools).reduce((x, y) => x + y, 0), 0),
      waves: waves.length, wavesDone: waves.filter(w => w.status === 'completed').length,
      agents: agents.length, agentsDone: agents.filter(a => a.state === 'done').length,
    },
  }
}

// El % global solo lo conoce la sesión (sabe su plan): lo declara en un json; aquí solo se valida la forma.
function declaredProgress(id) {
  const f = path.join(PROGRESS, `${id}.json`)
  const d = readJson(f)
  if (!d || !Number.isFinite(Number(d.percent))) return null
  const str = v => String(v ?? '').slice(0, 200)
  return {
    percent: Math.max(0, Math.min(100, Number(d.percent))), stage: str(d.stage), step: str(d.step), basis: str(d.basis),
    startedAt: ms(d.startedAt) || null, updatedAt: mtime(f),
    metrics: (Array.isArray(d.metrics) ? d.metrics : []).slice(0, 8).map(m => ({ label: str(m?.label), value: str(m?.value) })),
  }
}

const save = () => fs.writeFileSync(STATE, JSON.stringify([...known.values()]))
export function load() { for (const k of readJson(STATE) ?? []) known.set(k.sessionId, k) }

export function scanHistory() {
  for (const proj of ls(PROJECTS)) for (const sid of ls(path.join(PROJECTS, proj))) {
    const dir = path.join(PROJECTS, proj, sid, 'workflows')
    for (const f of ls(dir)) {
      const fp = path.join(dir, f)
      if (!f.endsWith('.json') || histSeen.has(fp)) continue
      const d = readJson(fp)
      if (!d) continue
      histSeen.add(fp) // ponytail: una corrida reanudada que reescribe su json no se vuelve a contar
      if (d.status === 'completed' && d.durationMs && d.workflowName) {
        if (!history.has(d.workflowName)) history.set(d.workflowName, [])
        history.get(d.workflowName).push(d.durationMs)
      }
    }
  }
}

export function tick(now = Date.now()) {
  const live = new Map()
  for (const f of ls(SESSIONS)) {
    if (!f.endsWith('.json')) continue
    const s = readJson(path.join(SESSIONS, f))
    // ponytail: si el PID se reutiliza tras un crash, la sesión parece viva; comparar procStart con `ps -o lstart` si pasa
    // fuera las headless: `claude -p` se registra con entrypoint sdk-cli (y el Agent SDK con sdk-*) aunque su kind diga interactive
    if (s?.sessionId && alive(s.pid) && s.kind !== 'sdk' && !String(s.entrypoint ?? '').startsWith('sdk-')) live.set(s.sessionId, s)
  }
  let dirty = false
  for (const [id, s] of live) {
    if (!known.get(id) || known.get(id).endedAt) dirty = true
    known.set(id, { sessionId: id, pid: s.pid, cwd: s.cwd, name: s.name, status: s.status, startedAt: s.startedAt, endedAt: null })
  }
  for (const k of known.values()) {
    if (live.has(k.sessionId) || k.endedAt) continue
    // terminó con el servidor apagado: su última actividad es la mejor hora de cierre que hay
    k.endedAt = booted ? now : Math.min(now, mtime(findTranscript(k.sessionId) ?? '') || now)
    dirty = true
  }
  if (dirty) save()
  booted = true
  for (const id of known.keys()) {
    try {
      let p = parsed.get(id)
      if (!p) {
        const file = findTranscript(id)
        if (!file) continue
        parsed.set(id, (p = { file, rd: { off: 0, rest: EMPTY }, seen: new Set(), title: '', blocks: [], waves: new Map(), pending: new Map(), bash: new Set(), last: 0 }))
      }
      const rows = readNew(p.file, p.rd)
      if (rows === null) parsed.delete(id)
      else for (const r of rows) ingest(p, r)
    } catch (e) { console.error(id, e) }
  }
}

const ORDER = { waiting: 0, busy: 1, ended: 3 } // primero lo que necesita tu respuesta
export function snapshot() {
  const out = []
  for (const k of known.values()) {
    try { out.push(sessionView(k)) } catch (e) { console.error(k.sessionId, e) }
  }
  return out.sort((a, b) => (ORDER[a.state] ?? 2) - (ORDER[b.state] ?? 2) || (b.endedAt ?? b.last) - (a.endedAt ?? a.last))
}

// Nunca se quita sola: solo a pedido y pasados 2 min desde que terminó.
export function close(id, now = Date.now()) {
  const k = known.get(id)
  if (!k?.endedAt || now < k.endedAt + CLOSE_AFTER_MS) return false
  known.delete(id)
  parsed.delete(id)
  fs.rmSync(path.join(PROGRESS, `${id}.json`), { force: true })
  save()
  return true
}

const clients = new Set()
let lastJson = ''
function broadcast() {
  const json = JSON.stringify(snapshot())
  if (json === lastJson) return
  lastJson = json
  for (const res of clients) res.write(`data: {"now":${Date.now()},"sessions":${json}}\n\n`)
}

const server = http.createServer((req, res) => {
  // solo localhost: sin esto, una web cualquiera podría leer tus prompts vía DNS rebinding
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host ?? '')) return res.writeHead(403).end()
  if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return res.writeHead(403).end()
  if (req.method === 'GET' && req.url === '/version') return res.writeHead(200).end(VERSION)
  if (req.method === 'POST' && req.url === '/api/quit') return res.writeHead(204).end(() => process.exit(0))
  if (req.method === 'GET' && req.url === '/') {
    return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fs.readFileSync(new URL('./index.html', import.meta.url)))
  }
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(`data: {"now":${Date.now()},"sessions":${lastJson || '[]'}}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  const m = req.method === 'POST' && req.url.match(/^\/api\/close\/([\w-]+)$/)
  if (m) {
    const ok = close(m[1])
    if (ok) broadcast()
    return res.writeHead(ok ? 204 : 409).end()
  }
  res.writeHead(404).end()
})

async function openDashboard() {
  const running = () => fetch(`${URL_}/version`).then(r => r.text(), () => null)
  const old = await running()
  if (old !== VERSION) {
    if (old !== null) { // corre otra versión (se actualizó el plugin): que suelte el puerto
      await fetch(`${URL_}/api/quit`, { method: 'POST' }).catch(() => {})
      for (let i = 0; i < 30 && (await running()) !== null; i++) await sleep(100)
    }
    spawn(process.execPath, [fileURLToPath(import.meta.url)], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    for (let i = 0; i < 50 && (await running()) !== VERSION; i++) await sleep(100)
  }
  const [cmd, ...args] = process.platform === 'win32' ? ['explorer.exe', URL_] : process.platform === 'darwin' ? ['open', URL_] : ['xdg-open', URL_]
  spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref()
  console.log(URL_)
}

// import.meta.main no existe en Node viejo: ahí se compara la ruta del script
const isMain = import.meta.main ?? path.resolve(process.argv[1] ?? '').toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (isMain) {
  if (process.argv[2] === '--open') await openDashboard()
  else {
    server.on('error', e => { if (e.code === 'EADDRINUSE') process.exit(0); throw e })
    server.listen(PORT, '127.0.0.1', () => {
      load()
      scanHistory()
      tick()
      broadcast()
      setInterval(() => { try { tick(); broadcast() } catch (e) { console.error(e) } }, TICK_MS)
      setInterval(scanHistory, 5 * 60_000)
      console.log(URL_)
    })
  }
}
