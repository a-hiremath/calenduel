import { describe, expect, it } from 'vitest'
import { changedFraction, facesNear, frameAt, overlaps, spanAt, webcamStrip } from './layout'
import type { LayoutSpan } from '../media/timelapse'

const full = { x: 0, y: 0, w: 1920, h: 1248 }
const laptopFace = { x: 1421, y: 873, w: 486, h: 362 }
const sideLaptop = { x: 0, y: 198, w: 1312, h: 853 }
const sideIpad = { x: 1328, y: 198, w: 592, h: 853 }
const sideFace = { x: 965, y: 784, w: 334, h: 251 }
const layout: LayoutSpan[] = [
  { fromFrame: 0, screen: full, ipad: null, face: null }, // camera not ready yet
  { fromFrame: 3, screen: full, ipad: null, face: laptopFace },
  { fromFrame: 100, screen: sideLaptop, ipad: sideIpad, face: sideFace }, // iPad added
  { fromFrame: 400, screen: full, ipad: null, face: laptopFace }, // iPad removed
]

describe('focus layout lookup', () => {
  it('maps clip time to the frame on screen', () => {
    expect(frameAt(0)).toBe(0)
    expect(frameAt(1)).toBe(30)
    expect(frameAt(99 / 30)).toBe(99) // float error must not round down a frame
    expect(frameAt(-1)).toBe(0)
  })

  it('finds the span in force', () => {
    expect(spanAt([], 5)).toBeNull()
    expect(spanAt(layout, 0)?.face).toBeNull()
    expect(spanAt(layout, 99)?.ipad).toBeNull()
    expect(spanAt(layout, 100)?.ipad).toEqual(sideIpad)
    expect(spanAt(layout, 399)?.ipad).toEqual(sideIpad)
    expect(spanAt(layout, 10_000)?.ipad).toBeNull()
  })

  it('hides every face that could be on screen near a layout change', () => {
    expect(facesNear(layout, 250)).toEqual([sideFace])
    // Right after the iPad arrives, the old corner face could still be showing.
    expect(facesNear(layout, 101)).toEqual([laptopFace, sideFace])
    expect(facesNear(layout, 98)).toEqual([laptopFace, sideFace])
    expect(facesNear(layout, 50)).toEqual([laptopFace])
    expect(facesNear(layout, 401)).toEqual([sideFace, laptopFace])
  })

  it('knows when a safety mask covers the iPad', () => {
    expect(overlaps(laptopFace, sideIpad)).toBe(true) // old corner face, new iPad pane
    expect(overlaps(sideFace, sideIpad)).toBe(false) // the face sits over the laptop
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 })).toBe(false)
  })

  it('keeps the laptop-only strip identical to the old mask', () => {
    // Old code: x = W - 0.25W - 16*scale - 4, full height.
    const scale = 1568 / 1920
    const strip = webcamStrip(1568, 1019, scale)
    expect(strip.x).toBeCloseTo(1568 - 1568 * 0.25 - 16 * scale - 4)
    expect(strip.w + strip.x).toBeCloseTo(1568)
    expect(strip.h).toBe(1019)
  })
})

describe('iPad change detection', () => {
  const page = (strokes: number) => {
    const data = new Uint8ClampedArray(100 * 100 * 4).fill(40) // dark page
    for (let i = 0; i < strokes; i++) data.fill(230, i * 4, i * 4 + 3) // white ink
    return data
  }
  it('ignores compression shimmer', () => {
    const a = page(0)
    const b = a.map((v, i) => (i % 4 === 3 ? v : v + ((i * 7) % 21) - 10))
    expect(changedFraction(a, b)).toBe(0)
  })
  it('sees new ink', () => {
    expect(changedFraction(page(0), page(50))).toBeCloseTo(0.005)
  })
  it('treats a size change as a full change', () => {
    expect(changedFraction(page(0), new Uint8ClampedArray(16))).toBe(1)
  })
})
