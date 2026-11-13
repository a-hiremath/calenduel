import { getClip, listSessions, saveFocus, type SessionMeta } from '../db'
import { analyzeFocus, recheckFocus } from './analyze'
import { needsSecondPass } from './types'
import type { LayoutSpan } from '../media/timelapse'

// Analyses run here, at module level, rather than inside the History card. A
// card unmounts whenever you switch to Timer or Compete, and the job used to
// be cancelled with it. Now the card only shows the job's state and the job
// runs until it finishes, fails or is cancelled.

export type FocusJob =
  | { status: 'running'; progress: string; cancel: () => void }
  | { status: 'failed'; error: string }

const jobs = new Map<string, FocusJob>()
const listeners = new Set<() => void>()

function set(id: string, job: FocusJob | null) {
  if (job) jobs.set(id, job)
  else jobs.delete(id)
  listeners.forEach((l) => l())
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getJob(id: string): FocusJob | undefined {
  return jobs.get(id)
}

// Clears a failure once the user has seen it and starts over.
export function dismiss(id: string) {
  if (jobs.get(id)?.status === 'failed') set(id, null)
}

export function startAnalysis(id: string, task: string, elapsedMs: number, layout?: LayoutSpan[]) {
  if (jobs.get(id)?.status === 'running') return
  const abort = new AbortController()
  const cancel = () => abort.abort()
  set(id, { status: 'running', progress: 'Reading recording…', cancel })
  void (async () => {
    try {
      const clip = await getClip(id)
      if (!clip) throw new Error('This session has no recording to analyze.')
      const result = await analyzeFocus(clip, task, elapsedMs,
        (done, total, phase) => set(id, { status: 'running', cancel, progress: phase === 'score'
          ? `Analyzing ${done}/${total}…` : `Rechecking off-task intervals ${done}/${total}…` }),
        abort.signal, layout)
      abort.signal.throwIfAborted()
      await saveFocus(id, result)
      set(id, null)
      // Best effort, as after a session: the result is safe locally either
      // way, and Compete syncs it on its next load.
      import('../compete/api').then((m) => m.syncSessions()).catch(console.error)
    } catch (e) {
      if (abort.signal.aborted) set(id, null)
      else set(id, { status: 'failed', error: e instanceof Error ? e.message : 'Analysis failed.' })
    }
  })()
}

// One-time (2026-11-13): recheck the off-task intervals of every session
// analyzed before the second pass existed, one session after another. Remove
// this, needsSecondPass and recheckFocus with RecheckAll.tsx once Adi and Zach
// have run it.
export type BulkRecheck =
  | { status: 'running'; progress: string; cancel: () => void }
  | { status: 'done'; sessions: number }
  | { status: 'failed'; error: string; sessions: number }

let bulk: BulkRecheck | null = null

function setBulk(next: BulkRecheck | null) {
  bulk = next
  listeners.forEach((l) => l())
}

export function getBulk(): BulkRecheck | null {
  return bulk
}

export function dismissBulk() {
  if (bulk?.status !== 'running') setBulk(null)
}

export function startRecheckAll(sessions: SessionMeta[]) {
  if (bulk?.status === 'running' || [...jobs.values()].some((j) => j.status === 'running')) return
  const queue = sessions.filter(needsSecondPass)
  if (queue.length === 0) return
  const abort = new AbortController()
  const cancel = () => abort.abort()
  const status = (n: number, detail: string) =>
    setBulk({ status: 'running', progress: `Session ${n} of ${queue.length}: ${detail}`, cancel })
  // Every queued card shows it is waiting, so no one starts a second
  // analysis that would share the per-user request limit.
  for (const s of queue) set(s.id, { status: 'running', progress: 'Waiting to recheck…', cancel })
  status(1, 'starting…')
  void (async () => {
    let done = 0
    try {
      for (const [k, queued] of queue.entries()) {
        abort.signal.throwIfAborted()
        // Read it again: a correction made while it waited must not be lost.
        const s = (await listSessions()).find((x) => x.id === queued.id)
        const clip = s && needsSecondPass(s) ? await getClip(s.id) : null
        if (s && clip && s.focus) {
          const result = await recheckFocus(clip, s.focus, s.elapsedMs, s.layout ?? [], (d, total) => {
            status(k + 1, `${d}/${total} off-task intervals.`)
            set(s.id, { status: 'running', progress: `Rechecking off-task intervals ${d}/${total}…`, cancel })
          }, abort.signal)
          abort.signal.throwIfAborted()
          // A session renamed during the run keeps its name and loses nothing:
          // it is skipped and can be analyzed again.
          await saveFocus(s.id, result).then(() => { done++ }, () => {})
        }
        set(queued.id, null)
      }
      setBulk({ status: 'done', sessions: done })
    } catch (e) {
      if (abort.signal.aborted) setBulk(null)
      else setBulk({ status: 'failed', error: e instanceof Error ? e.message : 'The recheck failed.', sessions: done })
    } finally {
      for (const s of queue) if (jobs.get(s.id)?.status === 'running') set(s.id, null)
      if (done > 0) import('../compete/api').then((m) => m.syncSessions()).catch(console.error)
    }
  })()
}

