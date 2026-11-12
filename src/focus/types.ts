export type FocusChoice = 'on_task' | 'off_task' | 'unclear'

export interface FocusSample {
  atMs: number
  durationMs: number
  choice: FocusChoice
  originalChoice: FocusChoice
  // Scored from the laptop and the iPad together.
  ipad?: boolean
}

export interface FocusResult {
  task: string
  analyzedAt: number
  model: 'clef-flash'
  // task-v3 when any sample included the iPad; laptop-only samples always use v2.
  rubric: 'task-v2' | 'task-v3'
  samples: FocusSample[]
}

export function summarizeFocus(samples: FocusSample[]) {
  let onMs = 0
  let assessedMs = 0
  let totalMs = 0
  for (const sample of samples) {
    totalMs += sample.durationMs
    if (sample.choice !== 'unclear') assessedMs += sample.durationMs
    if (sample.choice === 'on_task') onMs += sample.durationMs
  }
  return {
    percent: assessedMs ? Math.round(100 * onMs / assessedMs) : null,
    coverage: totalMs ? Math.round(100 * assessedMs / totalMs) : 0,
    onMs,
  }
}

// Cap long sessions at 240 observations. Each observation represents an equal
// interval of recorded time; the last partial interval keeps its true duration.
export function sampleIntervals(elapsedMs: number) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return []
  const step = Math.max(15_000, Math.ceil(elapsedMs / 240))
  const result = []
  for (let atMs = 0; atMs < elapsedMs; atMs += step) {
    result.push({ atMs, durationMs: Math.min(step, elapsedMs - atMs) })
  }
  return result
}
