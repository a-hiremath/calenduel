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
  // The person set this label by hand. Smoothing never changes it.
  corrected?: boolean
}

export interface FocusResult {
  task: string
  analyzedAt: number
  model: 'clef-flash'
  // task-v3 when any sample included the iPad; laptop-only samples always use v2.
  rubric: 'task-v2' | 'task-v3'
  // What hid the webcam: only the recorded face box, or (clips without a
  // layout, and results from before the face-only mask) the full right strip.
  mask?: 'face' | 'strip'
  samples: FocusSample[]
}

// A sample's position in the session, as m:ss.
export function clockOf(atMs: number): string {
  return `${Math.floor(atMs / 60_000)}:${String(Math.floor(atMs / 1000) % 60).padStart(2, '0')}`
}

// A blip neighbours must outweigh before it is smoothed: together they span at
// least this many samples. Two lone samples either side of an alternating
// stretch do not, so real back-and-forth is left alone.
const BLIP_CONTEXT = 3

// The label each sample counts as. A single on-task or off-task sample between
// steadier stretches of the other kind is a blip (a glance at a message, or a
// frame that caught a tab switch), so it counts as its neighbours. This works
// both ways: a lone on-task frame inside a distraction does not count either.
// Hand corrections are kept as chosen, and unclear samples are never changed
// and never smooth their neighbours.
export function smoothedChoices(samples: FocusSample[]): FocusChoice[] {
  const runs: { choice: FocusChoice; start: number; length: number }[] = []
  samples.forEach((sample, i) => {
    const last = runs[runs.length - 1]
    if (last && last.choice === sample.choice) last.length++
    else runs.push({ choice: sample.choice, start: i, length: 1 })
  })
  const out = samples.map(sample => sample.choice)
  runs.forEach((run, k) => {
    if (run.length !== 1 || run.choice === 'unclear') return
    const sample = samples[run.start]
    if (sample.corrected || sample.choice !== sample.originalChoice) return
    const other: FocusChoice = run.choice === 'on_task' ? 'off_task' : 'on_task'
    const neighbours = [runs[k - 1], runs[k + 1]].filter(r => r !== undefined)
    if (neighbours.every(r => r.choice === other) &&
      neighbours.reduce((n, r) => n + r.length, 0) >= BLIP_CONTEXT) {
      out[run.start] = other
    }
  })
  return out
}

function tally(samples: FocusSample[], choices: FocusChoice[]) {
  let onMs = 0
  let assessedMs = 0
  let totalMs = 0
  samples.forEach((sample, i) => {
    totalMs += sample.durationMs
    if (choices[i] !== 'unclear') assessedMs += sample.durationMs
    if (choices[i] === 'on_task') onMs += sample.durationMs
  })
  return { onMs, assessedMs, totalMs }
}

const percentOf = (onMs: number, assessedMs: number) =>
  assessedMs ? Math.round(100 * onMs / assessedMs) : null

// The focus estimate, after smoothing out one-sample blips. `rawPercent` is the
// same estimate without smoothing, and `smoothed` counts the blips it changed.
export function summarizeFocus(samples: FocusSample[]) {
  const choices = smoothedChoices(samples)
  const { onMs, assessedMs, totalMs } = tally(samples, choices)
  const raw = tally(samples, samples.map(sample => sample.choice))
  return {
    percent: percentOf(onMs, assessedMs),
    coverage: totalMs ? Math.round(100 * assessedMs / totalMs) : 0,
    onMs,
    rawPercent: percentOf(raw.onMs, raw.assessedMs),
    smoothed: choices.filter((choice, i) => choice !== samples[i].choice).length,
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
