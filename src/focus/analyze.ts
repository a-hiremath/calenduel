import { sampleIntervals, type FocusChoice, type FocusResult, type FocusSample } from './types'
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
  const p = answer.probabilities as Record<string, unknown> | undefined
  if (p && CHOICES.every(k => typeof p[k] === 'number' && Number.isFinite(p[k]))) {
    out.probabilities = Object.fromEntries(CHOICES.map(k =>
      [k, Math.round((p[k] as number) * 100) / 100])) as Record<FocusChoice, number>
  }
  return out
}

export async function analyzeFocus(
  clip: Blob, task: string, elapsedMs: number,
  progress: (done: number, total: number) => void,
  signal: AbortSignal,
  layout: LayoutSpan[] = [],
): Promise<FocusResult> {
  const { focusToken } = await import('../compete/api')
  let token = await focusToken()
  if (!token) throw new Error('Sign in from Compete before analyzing a session.')
  let tokenCheckedAt = Date.now()
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
    progress(0, intervals.length)
    for (const interval of intervals) {
      signal.throwIfAborted()
      if (Date.now() - tokenCheckedAt > 60_000) {
        token = await focusToken()
        if (!token) throw new Error('Sign in again to finish analysis.')
        tokenCheckedAt = Date.now()
      }
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
      const response = await fetch(`${FOCUS_ENDPOINT}/score`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body,
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(detail?.error ?? 'Focus analysis failed. Please try again.')
      }
      const answer = await response.json() as { choice: FocusChoice; source?: unknown; probabilities?: unknown }
      if (!CHOICES.includes(answer.choice)) {
        throw new Error('The model returned an unreadable result.')
      }
      result.samples.push({
        ...interval, choice: answer.choice, originalChoice: answer.choice,
        ...(ipad ? { ipad: true } : {}),
        ...extras(answer),
      })
      progress(result.samples.length, intervals.length)
      // Pace post-session requests below the per-user endpoint limit.
      await new Promise<void>(resolve => setTimeout(resolve, 550))
    }
    return result
  } finally {
    close()
    drawer.dispose()
    small.width = 0
    small.height = 0
  }
}
