import {
  countsAsSameWork, nearestAnchor, needsRecheck, pickAnchors, sampleIntervals,
  type AnchorChoice, type FocusChoice, type FocusResult, type FocusSample,
} from './types'
import { changedFraction } from './layout'
import type { LayoutSpan } from '../media/timelapse'
import { FOCUS_ENDPOINT } from './endpoint'
import { JPEG_QUALITY, frameDrawer, openClip, sampleTime, seekTo } from './frames'

// The iPad counts as changed when more than this share of its pixels moved
// between two samples (see IPAD_SIGNATURE_WIDTH and changedFraction). In a
// recorded test, a still iPad measured 0 to 0.0005 and intervals with a few
// handwritten words 0.006 to 0.017.
const IPAD_CHANGE = 0.0015
// The iPad is compared at this width: small enough to be cheap, large enough
// that a written word still moves a few hundred pixels.
const IPAD_SIGNATURE_WIDTH = 320

const CHOICES: FocusChoice[] = ['on_task', 'off_task', 'unclear']
const ANCHOR_CHOICES: AnchorChoice[] = ['same_work', 'different', 'unclear']
// Pause between requests, to stay below the worker's 120 per minute per user.
const PACE_MS = 550

function signature(image: HTMLCanvasElement, scratch: HTMLCanvasElement): Uint8ClampedArray {
  scratch.width = IPAD_SIGNATURE_WIDTH
  scratch.height = Math.max(1, Math.round(IPAD_SIGNATURE_WIDTH * image.height / image.width))
  const ctx = scratch.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(image, 0, 0, scratch.width, scratch.height)
  return ctx.getImageData(0, 0, scratch.width, scratch.height).data
}

// What the worker says besides the choice: which screen decided and how sure
// the model was. Kept so the correction view can show it; absent in results
// from before it was kept.
function extras(answer: { source?: unknown; probabilities?: unknown }): Pick<FocusSample, 'source' | 'probabilities'> {
  const out: Pick<FocusSample, 'source' | 'probabilities'> = {}
  if (answer.source === 'laptop' || answer.source === 'ipad') out.source = answer.source
  const probabilities = rounded(answer.probabilities, CHOICES)
  if (probabilities) out.probabilities = probabilities
  return out
}

function rounded<K extends string>(value: unknown, keys: K[]): Record<K, number> | undefined {
  const p = value as Record<string, unknown> | undefined
  if (!p || !keys.every(k => typeof p[k] === 'number' && Number.isFinite(p[k]))) return undefined
  return Object.fromEntries(keys.map(k => [k, Math.round((p[k] as number) * 100) / 100])) as Record<K, number>
}

export type FocusPhase = 'score' | 'recheck'

// Signs requests to the focus worker, refreshing the token every minute, and
// paces them below the worker's per-user limit.
async function focusClient(signal: AbortSignal) {
  const { focusToken } = await import('../compete/api')
  let token = await focusToken()
  if (!token) throw new Error('Sign in from Compete before analyzing a session.')
  let tokenCheckedAt = Date.now()
  return async function post(path: string, body: string): Promise<unknown> {
    if (Date.now() - tokenCheckedAt > 60_000) {
      token = await focusToken()
      if (!token) throw new Error('Sign in again to finish analysis.')
      tokenCheckedAt = Date.now()
    }
    const response = await fetch(`${FOCUS_ENDPOINT}${path}`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
    })
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { error?: string } | null
      throw new Error(detail?.error ?? 'Focus analysis failed. Please try again.')
    }
    const answer = await response.json()
    await new Promise<void>(resolve => setTimeout(resolve, PACE_MS))
    return answer
  }
}
type Post = Awaited<ReturnType<typeof focusClient>>

export async function analyzeFocus(
  clip: Blob, task: string, elapsedMs: number,
  progress: (done: number, total: number, phase: FocusPhase) => void,
  signal: AbortSignal,
  layout: LayoutSpan[] = [],
): Promise<FocusResult> {
  const post = await focusClient(signal)
  const { video, close } = await openClip(clip)
  const drawer = frameDrawer(video, layout)
  const small = document.createElement('canvas')
  let previousIpad: Uint8ClampedArray | null = null
  try {
    const result: FocusResult = {
      task, analyzedAt: Date.now(), model: 'clef-flash', rubric: 'task-v2', samples: [],
      mask: layout.some(span => span.face !== null) ? 'face' : 'strip',
    }
    const intervals = sampleIntervals(elapsedMs)
    progress(0, intervals.length, 'score')
    for (const interval of intervals) {
      signal.throwIfAborted()
      // A sampled estimate, not exact telemetry: see sampleTime().
      const time = sampleTime(video.duration, interval.atMs, elapsedMs)
      await seekTo(video, time)
      const { screen, ipad, ipadMasked } = drawer.draw(time)
      let body: string
      if (ipad) {
        // Next to an add or remove, a safety mask can cover part of the iPad.
        // Its appearing or vanishing is not writing, so such a sample is never
        // compared (it goes to the laptop) and never becomes the baseline.
        const now = signature(ipad, small)
        const changed = !ipadMasked && previousIpad && previousIpad.length === now.length
          ? changedFraction(previousIpad, now) > IPAD_CHANGE : null
        previousIpad = ipadMasked ? null : now
        body = JSON.stringify({
          task, image: screen.toDataURL('image/jpeg', JPEG_QUALITY),
          ipad: ipad.toDataURL('image/jpeg', JPEG_QUALITY), ipadChanged: changed,
        })
        result.rubric = 'task-v3'
      } else {
        previousIpad = null // compare iPad frames only across an unbroken stretch
        body = JSON.stringify({ task, image: screen.toDataURL('image/jpeg', JPEG_QUALITY) })
      }
      const answer = await post('/score', body) as { choice: FocusChoice; source?: unknown; probabilities?: unknown }
      if (!CHOICES.includes(answer.choice)) {
        throw new Error('The model returned an unreadable result.')
      }
      result.samples.push({
        ...interval, choice: answer.choice, originalChoice: answer.choice,
        ...(ipad ? { ipad: true } : {}),
        ...extras(answer),
      })
      progress(result.samples.length, intervals.length, 'score')
    }

    await secondPass(result, video, drawer, elapsedMs, post, progress, signal)
    return result
  } finally {
    close()
    drawer.dispose()
    small.width = 0
    small.height = 0
  }
}

// The second pass, on a finished first pass; changes `result` in place.
// "Is this the declared task?" asks one frame to prove which assignment it
// belongs to, so the first pass leans on words it can see, such as the
// session name in a file path, and calls a debugger or program output off
// task. Each laptop frame it called off task is now compared with the nearest
// frame from this session it was sure was on task. The same work counts as on
// task; a different activity stays off.
async function secondPass(
  result: FocusResult, video: HTMLVideoElement, drawer: ReturnType<typeof frameDrawer>,
  elapsedMs: number, post: Post,
  progress: (done: number, total: number, phase: FocusPhase) => void, signal: AbortSignal,
) {
  const { samples } = result
  const anchors = pickAnchors(samples)
  result.anchors = { rubric: 'anchor-v1', atMs: anchors.map(a => samples[a].atMs) }
  const recheck = anchors.length ? samples.flatMap((s, i) => needsRecheck(s) ? [i] : []) : []
  const anchorImages = new Map<number, string>()
  const screenAt = async (atMs: number) => {
    const time = sampleTime(video.duration, atMs, elapsedMs)
    await seekTo(video, time)
    return drawer.draw(time).screen.toDataURL('image/jpeg', JPEG_QUALITY)
  }
  progress(0, recheck.length, 'recheck')
  for (const [done, i] of recheck.entries()) {
    signal.throwIfAborted()
    const a = nearestAnchor(samples, anchors, i)
    if (!anchorImages.has(a)) anchorImages.set(a, await screenAt(samples[a].atMs))
    const answer = await post('/compare', JSON.stringify({
      task: result.task, anchor: anchorImages.get(a), image: await screenAt(samples[i].atMs),
    })) as { choice: AnchorChoice; probabilities?: unknown }
    if (!ANCHOR_CHOICES.includes(answer.choice)) {
      throw new Error('The model returned an unreadable result.')
    }
    const probabilities = rounded(answer.probabilities, ANCHOR_CHOICES)
    samples[i] = {
      ...samples[i],
      ...(countsAsSameWork(answer.choice, probabilities) ? { choice: 'on_task', originalChoice: 'on_task' } : {}),
      anchor: { atMs: samples[a].atMs, choice: answer.choice, ...(probabilities ? { probabilities } : {}) },
    }
    progress(done + 1, recheck.length, 'recheck')
  }
}

// One-time (2026-11-13): run only the second pass on a result saved before
// it existed. Hand corrections stay as they are. Remove with RecheckAll.tsx.
export async function recheckFocus(
  clip: Blob, focus: FocusResult, elapsedMs: number, layout: LayoutSpan[],
  progress: (done: number, total: number) => void, signal: AbortSignal,
): Promise<FocusResult> {
  const post = await focusClient(signal)
  const { video, close } = await openClip(clip)
  const drawer = frameDrawer(video, layout)
  try {
    const result: FocusResult = { ...focus, samples: focus.samples.map(s => ({ ...s })) }
    await secondPass(result, video, drawer, elapsedMs, post, (done, total) => progress(done, total), signal)
    return result
  } finally {
    close()
    drawer.dispose()
  }
}
