export type FocusChoice = 'on_task' | 'off_task' | 'unclear'
// The second pass's answer: is this the same work as an on-task sample?
export type AnchorChoice = 'same_work' | 'different' | 'unclear'

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
  // The second pass. The first pass called this sample off task from the
  // laptop, so it was compared with the on-task sample at `atMs`. When the
  // model judged it the same work, `choice` and `originalChoice` are on_task;
  // `probabilities` above stay the first pass's.
  anchor?: { atMs: number; choice: AnchorChoice; probabilities?: Record<AnchorChoice, number> }
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
  // The second pass ran: `atMs` lists the on-task samples it compared
  // against, empty when none was sure enough. Absent in older results.
  anchors?: { rubric: 'anchor-v1'; atMs: number[] }
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

// The second pass compares against at most this many samples, one from each
// equal part of the session, and only ones the model was at least this sure
// were on task. Clef's probabilities top out near 0.9.
export const ANCHOR_COUNT = 3
export const ANCHOR_MIN_SURE = 0.75
// "Same work" counts only when the model gives it at least even odds. With
// three answers it can win at 0.46, and in testing (2026-11-13) the one
// different project it let through did: 0.46 against 0.44. Same-work answers
// on real matches were 0.62 or more, different activities 0.46 or less.
export const SAME_WORK_MIN = 0.5

export function countsAsSameWork(choice: AnchorChoice, probabilities?: Record<AnchorChoice, number>): boolean {
  return choice === 'same_work' && (probabilities?.same_work ?? 0) >= SAME_WORK_MIN
}

// The laptop screen decided this sample. Results from before `source` was
// kept don't say which screen decided a two-screen sample, so those count as
// not known to be the laptop.
function laptopDecided(s: FocusSample): boolean {
  return s.ipad ? s.source === 'laptop' : s.source !== 'ipad'
}

// The samples the second pass compares against, as indexes in time order. In
// each third of the session, the on-task sample the model was surest of. A
// sample the laptop decided beats one the iPad decided: the laptop screen is
// what gets compared, and only then was it the screen that was judged. A
// sample the person changed to another label is never an anchor.
export function pickAnchors(samples: FocusSample[]): number[] {
  const rank = (s: FocusSample) => (laptopDecided(s) ? 10 : 0) + (s.probabilities?.on_task ?? 0)
  const anchors: number[] = []
  for (let part = 0; part < ANCHOR_COUNT; part++) {
    const from = Math.floor(part * samples.length / ANCHOR_COUNT)
    const to = Math.floor((part + 1) * samples.length / ANCHOR_COUNT)
    let best = -1
    for (let i = from; i < to; i++) {
      const s = samples[i]
      if (s.originalChoice !== 'on_task' || s.choice !== 'on_task' ||
        (s.probabilities?.on_task ?? 0) < ANCHOR_MIN_SURE) continue
      if (best < 0 || rank(s) > rank(samples[best])) best = i
    }
    if (best >= 0) anchors.push(best)
  }
  return anchors
}

// The second pass rechecks what the first called off task from the laptop.
// An iPad that decided off task stays off: laptop frames say nothing about it.
// A label the person set or pinned by hand is theirs and is never rechecked.
export function needsRecheck(sample: FocusSample): boolean {
  return sample.originalChoice === 'off_task' && sample.choice === 'off_task' &&
    !sample.corrected && laptopDecided(sample)
}

// One-time (2026-11-13): the sessions whose saved result predates the second
// pass and has something for it to recheck. Remove with RecheckAll.tsx.
export function needsSecondPass(session: { task: string; hasClip: boolean; focus?: FocusResult }): boolean {
  const focus = session.focus
  return session.hasClip && !!focus && focus.task === session.task && !focus.anchors &&
    focus.samples.some(needsRecheck)
}

// The anchor nearest in time to sample `i`, the earlier one on a tie. Work
// drifts over a session (code, then the debugger, then notes), so the
// nearest is the likeliest to show the same stage of it.
export function nearestAnchor(samples: FocusSample[], anchors: number[], i: number): number {
  let best = anchors[0]
  for (const a of anchors) {
    if (Math.abs(samples[a].atMs - samples[i].atMs) < Math.abs(samples[best].atMs - samples[i].atMs)) best = a
  }
  return best
}

// The second pass turned this first-pass off-task label into on task.
function flipped(sample: FocusSample): boolean {
  return sample.anchor?.choice === 'same_work' && sample.originalChoice === 'on_task'
}

// The first pass called this off task and the second matched it to on-task
// work, and the person has not changed it since.
export function matchedAnchor(sample: FocusSample): boolean {
  return flipped(sample) && sample.choice === 'on_task'
}

// The samples as the first pass left them, for the estimate without the
// second pass. Hand corrections are kept.
export function firstPass(samples: FocusSample[]): FocusSample[] {
  return samples.map(s => !flipped(s) ? s : {
    ...s, originalChoice: 'off_task',
    choice: s.corrected || s.choice !== s.originalChoice ? s.choice : 'off_task',
  })
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
