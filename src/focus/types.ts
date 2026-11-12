export type FocusChoice = 'on_task' | 'off_task' | 'unclear'

export interface FocusSample {
  atMs: number
  durationMs: number
  choice: FocusChoice
  originalChoice: FocusChoice
  // Scored from the laptop and the iPad together.
  ipad?: boolean
  // Which screen's image decided the choice. Only the iPad decides, when it
  // changed since the previous sample and showed something readable.
  source?: 'laptop' | 'ipad'
  // How sure the model was of each choice (0 to 1), as the model returned it.
  probabilities?: Record<FocusChoice, number>
}

export interface FocusResult {
  task: string
  analyzedAt: number
  model: 'clef-flash'
  // task-v3 when any sample included the iPad; laptop-only samples always use v2.
  rubric: 'task-v2' | 'task-v3'
  samples: FocusSample[]
}

// A sample's position in the session, as m:ss.
export function clockOf(atMs: number): string {
  return `${Math.floor(atMs / 60_000)}:${String(Math.floor(atMs / 1000) % 60).padStart(2, '0')}`
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
