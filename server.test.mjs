// node --test   (arma un ~/.claude falso y recorre: sesión viva → bloques/wave/ETA → termina → regla de 2 min)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sesiones-'))
process.env.CLAUDE_CONFIG_DIR = root
const { tick, snapshot, close, scanHistory } = await import('./server.mjs')

const put = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data) }
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n'
const T0 = Date.parse('2026-10-05T10:00:00Z'), iso = min => new Date(T0 + min * 60_000).toISOString()
const MIN = 60_000

const proj = path.join(root, 'projects', '-tmp-proj')
const wfDir = path.join(proj, 'S1', 'subagents', 'workflows', 'wf_1')
const sessionFile = path.join(root, 'sessions', `${process.pid}.json`)
put(sessionFile, JSON.stringify({ pid: process.pid, sessionId: 'S1', cwd: '/tmp/proj', name: 'proj-01', status: 'busy', startedAt: T0 }))

const prompt = { type: 'user', uuid: 'u1', timestamp: iso(0), origin: { kind: 'human' }, message: { content: [{ type: 'text', text: 'Porta la wave 1\ncon cuidado' }] } }
put(path.join(proj, 'S1.jsonl'), jsonl([
  { type: 'ai-title', aiTitle: 'Migración F6' },
  prompt,
  prompt, // duplicado tras compactar: no debe abrir otro bloque
  { type: 'assistant', uuid: 'a1', timestamp: iso(1), message: { content: [
    { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/tmp/proj/lib/a.dart' } },
    { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'git commit -m x' } },
    { type: 'tool_use', id: 'w1', name: 'Workflow', input: { script: "export const meta = { name: 'f-wave', phases: [{ title: 'Port' }, { title: 'Review' }] }", args: { wave: 'W1' } } },
  ] } },
  { type: 'user', uuid: 'r1', timestamp: iso(2), message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: '[main abc1234def] feat: puerto\n 1 file changed' }] } },
  { type: 'user', uuid: 'r2', timestamp: iso(2), toolUseResult: { status: 'async_launched', taskType: 'local_workflow', workflowName: 'f-wave', runId: 'wf_1', summary: 'Porta una wave', transcriptDir: wfDir },
    message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'Workflow launched' }] } },
]))
put(path.join(wfDir, 'journal.jsonl'), jsonl([
  { type: 'launched' },
  { type: 'started', agentId: 'x1', label: 'port:A', phase: 'Port' },
  { type: 'started', agentId: 'x2', label: 'port:B', phase: 'Port' },
  { type: 'result', agentId: 'x1', result: { summary: 'A portado' } },
]))
put(path.join(wfDir, 'agent-x1.jsonl'), jsonl([
  { timestamp: iso(2), message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x/a.dart' } }] } },
  { timestamp: iso(12), message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/x/a.dart' } }] } },
]))
put(path.join(wfDir, 'agent-x2.jsonl'), jsonl([{ timestamp: iso(3), message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'flutter test' } }] } }]))
// historial: dos corridas previas de f-wave (60 y 80 min) en otra sesión
for (const [id, m] of [['wf_a', 60], ['wf_b', 80]]) put(path.join(proj, 'OLD', 'workflows', `${id}.json`), JSON.stringify({ workflowName: 'f-wave', status: 'completed', durationMs: m * MIN }))

test('sesión viva: bloque, archivos, commit, wave con progreso y ETA', () => {
  scanHistory()
  tick(T0 + 13 * MIN)
  const [s] = snapshot()
  assert.equal(s.state, 'busy')
  assert.equal(s.title, 'Migración F6')
  assert.equal(s.blocks.length, 1)
  assert.deepEqual(s.blocks[0].files, ['lib/a.dart'])
  assert.deepEqual(s.blocks[0].commits, [{ hash: 'abc1234de', msg: 'feat: puerto' }])
  assert.equal(s.blocks[0].running, true)
  const w = s.waves[0]
  assert.equal(w.tag, 'W1')
  assert.equal(w.status, 'running')
  assert.deepEqual(w.phases.map(p => [p.title, p.agents.length]), [['Port', 2], ['Review', 0]])
  assert.equal(w.progress, 1 / 4) // 1 listo de 2 agentes × 2 fases
  assert.equal(w.expectedMs, 80 * MIN) // mediana (elemento central) de [60, 80]
  assert.equal(w.phases[0].agents[0].result, 'A portado')
  assert.equal(w.phases[0].agents[1].lastTool, 'Bash · flutter test')
  assert.deepEqual(s.stats, { blocks: 1, files: 1, commits: 1, tools: 3, waves: 1, wavesDone: 0, agents: 2, agentsDone: 1 })
  assert.equal(s.activity.text, 'Workflow')
  assert.equal(s.declared, null)
})

test('progreso declarado por la sesión: se valida y se acota a 0–100', () => {
  put(path.join(root, 'sesiones', 'progress', 'S1.json'), JSON.stringify({ percent: 140, stage: 'Etapa 2', metrics: [{ label: 'Conflictos', value: 90 }, 'basura'] }))
  const d = snapshot()[0].declared
  assert.equal(d.percent, 100)
  assert.equal(d.stage, 'Etapa 2')
  assert.deepEqual(d.metrics, [{ label: 'Conflictos', value: '90' }, { label: '', value: '' }])
  put(path.join(root, 'sesiones', 'progress', 'S1.json'), JSON.stringify({ stage: 'sin percent' }))
  assert.equal(snapshot()[0].declared, null)
})

test('al terminar queda "Terminada" y solo se puede cerrar pasados 2 min', () => {
  fs.rmSync(sessionFile)
  const end = T0 + 20 * MIN
  tick(end)
  const [s] = snapshot()
  assert.equal(s.state, 'ended')
  assert.equal(s.waves[0].status, 'interrupted')
  assert.equal(close('S1', end + MIN), false)
  tick(end + 10 * MIN)
  assert.equal(snapshot().length, 1) // no se quita sola
  assert.equal(close('S1', end + 2 * MIN), true)
  assert.equal(snapshot().length, 0)
  assert.equal(fs.existsSync(path.join(root, 'sesiones', 'progress', 'S1.json')), false) // cerrar limpia su progreso
})
