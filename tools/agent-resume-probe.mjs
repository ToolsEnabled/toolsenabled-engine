// DOES A RESUMED THREAD REALLY REMEMBER? Live, against the installed codex.
//
// The sibling of tools/agent-rewind-probe.mjs, and for the same reason: the
// unit tests prove we form the call correctly against a fake transport, and
// that is not the same claim as "the agent continues its own conversation
// after the app was closed". This starts a thread in one process, says
// something memorable, KILLS the process, then resumes the thread id in a
// brand-new process and asks the agent what it was told. It costs two small
// turns.
//
// Usage: node tools/agent-resume-probe.mjs [model]
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { startCodexSession, resumeCodexSession } = require('../src/lib/agent-engine/codex-process.js')

const model = process.argv[2] || 'gpt-5.6-terra'
const cwd = mkdtempSync(path.join(tmpdir(), 'resume-probe-'))
const clientInfo = { name: 'toolsenabled-resume-probe', title: 'Resume probe', version: '1' }
const SECRET = 'PERSIMMON-7741'
const out = { model, cwd }

const settled = (session, threadId, text) => new Promise((resolve, reject) => {
  let said = ''
  const timer = setTimeout(() => reject(new Error('turn did not complete in 180s')), 180_000)
  const stop = session.adapter.onEvent(event => {
    if (event.type === 'assistant_text') said += event.text || ''
    if (event.type === 'assistant_text_delta') said += event.text || ''
    if (event.type === 'turn_completed') { clearTimeout(timer); stop(); resolve(said.trim()) }
  })
  session.adapter.sendTurn({ threadId, text }).catch(error => { clearTimeout(timer); stop(); reject(error) })
})

try {
  let first = null
  try {
    first = await startCodexSession({ cwd, clientInfo, threadOptions: { cwd, model, sandbox: 'read-only', approvalPolicy: 'never' } })
    out.threadId = first.threadId
    out.firstReply = await settled(first, first.threadId, `Remember this word for later: ${SECRET}. Reply with just: STORED`)
  } catch (error) {
    out.startError = String(error?.message || error).slice(0, 400)
  } finally {
    /* The app closing is exactly this: the process is gone, the thread is not. */
    first?.close()
  }

  if (out.threadId) {
    let second = null
    try {
      second = await resumeCodexSession({ threadId: out.threadId, cwd, clientInfo, threadOptions: { cwd, model } })
      out.resumed = {
        sameThread: second.threadId === out.threadId,
        turnsRestored: second.turnCount,
        saidRestored: second.turns.flatMap(turn => turn.said).map(line => `${line.who}: ${line.text.slice(0, 60)}`),
        engineModel: second.model,
        engineEffort: second.reasoningEffort,
        threadCwd: second.threadCwd,
      }
      out.answerAfterResume = await settled(second, second.threadId, 'What word did I ask you to remember? Reply with just that word.')
      out.remembered = out.answerAfterResume.includes(SECRET)
    } catch (error) {
      out.resumeError = String(error?.message || error).slice(0, 400)
    } finally {
      second?.close()
    }
  }

  console.log(JSON.stringify(out, null, 1))
  process.exitCode = out.remembered ? 0 : 1
} finally {
  rmSync(cwd, { recursive: true, force: true })
}
