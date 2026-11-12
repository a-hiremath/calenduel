import { sampleIntervals, type FocusChoice, type FocusResult } from './types'
import { changedFraction, facesNear, frameAt, overlaps, spanAt, webcamStrip } from './layout'
import type { LayoutSpan, Rect } from '../media/timelapse'

// Public endpoint, never an API token. Inference runs behind signed-in auth.
export const FOCUS_ENDPOINT = 'https://calenduel-focus.calenduel-focus.workers.dev'

function waitFor(video: HTMLVideoElement, event: string, action: () => void) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener(event, done)
      video.removeEventListener('error', failed)
    }
    const done = () => { cleanup(); resolve() }
    const failed = () => { cleanup(); reject(new Error('The recording could not be read.')) }
    const timer = setTimeout(failed, 15_000)
    video.addEventListener(event, done, { once: true })
    video.addEventListener('error', failed, { once: true })
    action()
  })
}

// Longest side of an image sent for scoring.
const MAX_SIDE = 1568
// The iPad counts as changed when more than this share of its pixels moved
// between two samples (see IPAD_SIGNATURE_WIDTH and changedFraction). In a
// recorded test, a still iPad measured 0 to 0.0005 and intervals with a few
// handwritten words 0.006 to 0.017.
const IPAD_CHANGE = 0.0015
// The iPad is compared at this width: small enough to be cheap, large enough
// that a written word still moves a few hundred pixels.
const IPAD_SIGNATURE_WIDTH = 320

// Copy `area` of `source` into `target`, scaled down to fit MAX_SIDE.
function crop(source: CanvasImageSource, area: Rect, target: HTMLCanvasElement) {
  const scale = Math.min(1, MAX_SIDE / Math.max(area.w, area.h))
  target.width = Math.max(1, Math.round(area.w * scale))
  target.height = Math.max(1, Math.round(area.h * scale))
  target.getContext('2d')!.drawImage(source, area.x, area.y, area.w, area.h,
    0, 0, target.width, target.height)
  return scale
}

function signature(image: HTMLCanvasElement, scratch: HTMLCanvasElement): Uint8ClampedArray {
  scratch.width = IPAD_SIGNATURE_WIDTH
  scratch.height = Math.max(1, Math.round(IPAD_SIGNATURE_WIDTH * image.height / image.width))
  const ctx = scratch.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(image, 0, 0, scratch.width, scratch.height)
  return ctx.getImageData(0, 0, scratch.width, scratch.height).data
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
  const url = URL.createObjectURL(clip)
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  const canvas = document.createElement('canvas')
  // Two-pane frames (laptop + iPad): the whole frame, then each pane.
  const full = document.createElement('canvas')
  const laptop = document.createElement('canvas')
  const ipad = document.createElement('canvas')
  const small = document.createElement('canvas')
  let previousIpad: Uint8ClampedArray | null = null
  try {
    await waitFor(video, 'loadeddata', () => { video.src = url; video.load() })
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error('The recording has no readable duration.')
    }
    const scale = Math.min(1, 1568 / video.videoWidth)
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    const ctx = canvas.getContext('2d')!
    const result: FocusResult = {
      task, analyzedAt: Date.now(), model: 'clef-flash', rubric: 'task-v2', samples: [],
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
      // The clip is compressed to 30x. Mapping by proportion also tolerates
      // missed capture ticks; this is a sampled estimate, not exact telemetry.
      const time = Math.min(video.duration - 0.001,
        video.duration * interval.atMs / elapsedMs)
      if (Math.abs(video.currentTime - time) > 0.0001) {
        await waitFor(video, 'seeked', () => { video.currentTime = time })
      }
      const frame = frameAt(time)
      const span = spanAt(layout, frame)
      let body: string
      if (span?.ipad) {
        // Laptop and iPad side by side. Hide every webcam area that could be in
        // this frame, then send the two screens as separate images.
        full.width = video.videoWidth
        full.height = video.videoHeight
        const fctx = full.getContext('2d')!
        fctx.drawImage(video, 0, 0)
        fctx.fillStyle = 'black'
        const faces = facesNear(layout, frame)
        for (const face of faces) fctx.fillRect(face.x, face.y, face.w, face.h)
        // Next to an add or remove, a safety mask can cover part of the iPad.
        // Its appearing or vanishing is not writing, so such a sample is never
        // compared (it goes to the laptop) and never becomes the baseline.
        const ipadMasked = faces.some(face => overlaps(face, span.ipad!))
        const laptopScale = crop(full, span.screen, laptop)
        // Same strip as a laptop-only frame, so the laptop image matches what
        // the model was checked on.
        const strip = webcamStrip(laptop.width, laptop.height, laptopScale)
        const lctx = laptop.getContext('2d')!
        lctx.fillStyle = 'black'
        lctx.fillRect(strip.x, strip.y, strip.w, strip.h)
        crop(full, span.ipad, ipad)
        const now = signature(ipad, small)
        const changed = !ipadMasked && previousIpad && previousIpad.length === now.length
          ? changedFraction(previousIpad, now) > IPAD_CHANGE : null
        previousIpad = ipadMasked ? null : now
        body = JSON.stringify({
          task, image: laptop.toDataURL('image/jpeg', 0.8),
          ipad: ipad.toDataURL('image/jpeg', 0.8), ipadChanged: changed,
        })
        result.rubric = 'task-v3'
      } else {
        previousIpad = null // compare iPad frames only across an unbroken stretch
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        // The recorder uses a 25%-wide inset and a 16px margin in output pixels.
        // Mask it before serializing: no webcam pixels leave this browser.
        // Camera aspect ratio is not saved in old clips. Mask the full strip
        // rather than guessing its height and leaking a tall webcam inset.
        const strip = webcamStrip(canvas.width, canvas.height, scale)
        ctx.fillStyle = 'black'
        ctx.fillRect(strip.x, strip.y, strip.w, strip.h)
        // A seek can land on the next frame (the muxer rounds timestamps down),
        // and that frame may already be side by side with the face over the
        // laptop, outside the strip. Hide every face near this frame too.
        for (const face of facesNear(layout, frame)) {
          ctx.fillRect(face.x * scale, face.y * scale, face.w * scale, face.h * scale)
        }
        body = JSON.stringify({ task, image: canvas.toDataURL('image/jpeg', 0.8) })
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
      const answer = await response.json() as { choice: FocusChoice }
      if (!['on_task', 'off_task', 'unclear'].includes(answer.choice)) {
        throw new Error('The model returned an unreadable result.')
      }
      result.samples.push({
        ...interval, choice: answer.choice, originalChoice: answer.choice,
        ...(span?.ipad ? { ipad: true } : {}),
      })
      progress(result.samples.length, intervals.length)
      // Pace post-session requests below the per-user endpoint limit.
      await new Promise<void>(resolve => setTimeout(resolve, 550))
    }
    return result
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
    for (const c of [canvas, full, laptop, ipad, small]) {
      c.width = 0
      c.height = 0
    }
  }
}
