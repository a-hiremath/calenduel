import { CLIP_FPS, type LayoutSpan, type Rect } from '../media/timelapse'

// Which clip frame is on screen at `seconds`: frame i is shown from i / CLIP_FPS.
export function frameAt(seconds: number): number {
  return Math.max(0, Math.floor(seconds * CLIP_FPS + 1e-6))
}

// The layout in force at `frame` (spans are in recording order).
export function spanAt(layout: LayoutSpan[], frame: number): LayoutSpan | null {
  let found: LayoutSpan | null = null
  for (const span of layout) {
    if (span.fromFrame > frame) break
    found = span
  }
  return found
}

// Every webcam area that could be on screen within `slack` frames of `frame`.
// Seeking can land a frame off, and the face moves when the iPad comes or goes,
// so hiding all of them is how no webcam pixel ever leaves the browser.
export function facesNear(layout: LayoutSpan[], frame: number, slack = 2): Rect[] {
  const faces: Rect[] = []
  layout.forEach((span, i) => {
    const end = i + 1 < layout.length ? layout[i + 1].fromFrame - 1 : Infinity
    if (span.face && span.fromFrame <= frame + slack && end >= frame - slack) faces.push(span.face)
  })
  return faces
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

// The strip the analyzer has always blacked out on a laptop screen: the inset's
// width (25%) plus its margin and border, full height, at the right edge. Kept
// identical for the laptop pane so its image looks like the validated input.
export function webcamStrip(width: number, height: number, scale = 1): Rect {
  const w = width * 0.25 + 16 * scale + 4
  return { x: width - w, y: 0, w, h: height }
}

// Fraction of pixels whose grey level moved by more than `step` between two
// same-sized RGBA images. Video compression shimmer stays under the step; new
// handwriting, a scroll or a page turn does not.
export function changedFraction(a: Uint8ClampedArray, b: Uint8ClampedArray, step = 40): number {
  if (a.length !== b.length || a.length === 0) return 1
  let changed = 0
  for (let i = 0; i < a.length; i += 4) {
    const ga = a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114
    const gb = b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114
    if (Math.abs(ga - gb) > step) changed++
  }
  return changed / (a.length / 4)
}
