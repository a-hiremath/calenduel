// The images the focus checker judges for one sample, drawn from the session's
// clip. The analyzer sends these to the model; the correction view draws the
// same ones again, so you correct exactly what the model saw. Both go through
// sampleTime() and draw() below, so they cannot drift apart.

import type { LayoutSpan, Rect } from '../media/timelapse'
import { facesNear, frameAt, overlaps, padRect, spanAt, webcamStrip } from './layout'

// Longest side of an image sent for scoring.
export const MAX_SIDE = 1568
// JPEG quality of an image sent for scoring.
export const JPEG_QUALITY = 0.8

// Where in the clip a sample sits. The clip is compressed (30x); mapping by
// proportion also tolerates missed capture ticks.
export function sampleTime(durationS: number, atMs: number, elapsedMs: number): number {
  return Math.min(durationS - 0.001, durationS * atMs / elapsedMs)
}

export function waitFor(video: HTMLVideoElement, event: string, action: () => void) {
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

export async function seekTo(video: HTMLVideoElement, time: number) {
  if (Math.abs(video.currentTime - time) > 0.0001) {
    await waitFor(video, 'seeked', () => { video.currentTime = time })
  }
}

// Load a clip into a detached, muted video element.
export async function openClip(clip: Blob): Promise<{ video: HTMLVideoElement; close: () => void }> {
  const url = URL.createObjectURL(clip)
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  const close = () => {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
  }
  try {
    await waitFor(video, 'loadeddata', () => { video.src = url; video.load() })
  } catch (e) {
    close()
    throw e
  }
  if (!Number.isFinite(video.duration) || video.duration <= 0) {
    close()
    throw new Error('The recording has no readable duration.')
  }
  return { video, close }
}

export interface SampleImages {
  // The computer screen: the laptop pane, or the whole frame without an iPad.
  screen: HTMLCanvasElement
  // The iPad pane, when the iPad was in the recording at this moment.
  ipad: HTMLCanvasElement | null
  // A webcam mask covers part of the iPad (right next to an add or remove).
  ipadMasked: boolean
}

// Copy `area` of `source` into `target`, scaled down to fit MAX_SIDE.
function crop(source: CanvasImageSource, area: Rect, target: HTMLCanvasElement) {
  const scale = Math.min(1, MAX_SIDE / Math.max(area.w, area.h))
  target.width = Math.max(1, Math.round(area.w * scale))
  target.height = Math.max(1, Math.round(area.h * scale))
  target.getContext('2d')!.drawImage(source, area.x, area.y, area.w, area.h,
    0, 0, target.width, target.height)
  return scale
}

// Draws what the model sees for the video's current frame. The canvases are
// reused on every call, so read or copy them before the next one.
//
// No webcam pixel may leave this browser. Clips recorded since the layout was
// saved say exactly where the face inset was drawn, so only that box (plus a
// small pad) is hidden and the rest of the screen stays readable. Older clips
// have no layout and no camera shape, so they keep the full-height strip down
// the right edge, which covers an inset of any height.
export function frameDrawer(video: HTMLVideoElement, layout: LayoutSpan[]) {
  const screen = document.createElement('canvas')
  const full = document.createElement('canvas')
  const ipad = document.createElement('canvas')
  const knowsFace = layout.some(span => span.face !== null)

  function draw(time: number): SampleImages {
    const frame = frameAt(time)
    const span = spanAt(layout, frame)
    // Every face that could be on screen near this frame: a seek can land a
    // frame off, and the face moves when the iPad comes or goes.
    const faces = facesNear(layout, frame).map(face =>
      padRect(face, video.videoWidth, video.videoHeight))
    if (span?.ipad) {
      // Laptop and iPad side by side. Hide the faces, then cut out the two
      // screens.
      full.width = video.videoWidth
      full.height = video.videoHeight
      const fctx = full.getContext('2d')!
      fctx.drawImage(video, 0, 0)
      fctx.fillStyle = 'black'
      for (const face of faces) fctx.fillRect(face.x, face.y, face.w, face.h)
      const screenScale = crop(full, span.screen, screen)
      if (!knowsFace) {
        const strip = webcamStrip(screen.width, screen.height, screenScale)
        const sctx = screen.getContext('2d')!
        sctx.fillStyle = 'black'
        sctx.fillRect(strip.x, strip.y, strip.w, strip.h)
      }
      crop(full, span.ipad, ipad)
      return { screen, ipad, ipadMasked: faces.some(face => overlaps(face, span.ipad!)) }
    }
    const scale = Math.min(1, MAX_SIDE / video.videoWidth)
    screen.width = Math.round(video.videoWidth * scale)
    screen.height = Math.round(video.videoHeight * scale)
    const ctx = screen.getContext('2d')!
    ctx.drawImage(video, 0, 0, screen.width, screen.height)
    ctx.fillStyle = 'black'
    if (!knowsFace) {
      // The recorder uses a 25%-wide inset and a 16px margin in output pixels.
      const strip = webcamStrip(screen.width, screen.height, scale)
      ctx.fillRect(strip.x, strip.y, strip.w, strip.h)
    }
    for (const face of faces) {
      // Round outwards so scaling never leaves a sliver of the inset.
      const x = Math.floor(face.x * scale)
      const y = Math.floor(face.y * scale)
      ctx.fillRect(x, y, Math.ceil((face.x + face.w) * scale) - x, Math.ceil((face.y + face.h) * scale) - y)
    }
    return { screen, ipad: null, ipadMasked: false }
  }

  function dispose() {
    for (const c of [screen, full, ipad]) {
      c.width = 0
      c.height = 0
    }
  }

  return { draw, dispose }
}

// The images the model was sent for the sample at `atMs`, drawn again from the
// clip, as JPEG data URLs at the quality that was sent. For the correction view.
export async function drawSample(
  clip: Blob, layout: LayoutSpan[], elapsedMs: number, atMs: number,
): Promise<{ screen: string; ipad: string | null }> {
  const { video, close } = await openClip(clip)
  const drawer = frameDrawer(video, layout)
  try {
    const time = sampleTime(video.duration, atMs, elapsedMs)
    await seekTo(video, time)
    const { screen, ipad } = drawer.draw(time)
    return {
      screen: screen.toDataURL('image/jpeg', JPEG_QUALITY),
      ipad: ipad ? ipad.toDataURL('image/jpeg', JPEG_QUALITY) : null,
    }
  } finally {
    close()
    drawer.dispose()
  }
}
