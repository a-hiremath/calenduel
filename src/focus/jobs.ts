import { getClip, saveFocus } from '../db'
import { analyzeFocus } from './analyze'
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
        (done, total) => set(id, { status: 'running', progress: `Analyzing ${done}/${total}…`, cancel }),
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
