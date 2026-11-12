import { describe, expect, it } from 'vitest'
import { sampleTime } from './frames'
import { sampleIntervals, clockOf } from './types'

describe('sampleTime', () => {
  it('maps a sample to the same clip position by proportion', () => {
    // A 40-minute session in an 80-second clip: 30x.
    expect(sampleTime(80, 0, 2_400_000)).toBe(0)
    expect(sampleTime(80, 600_000, 2_400_000)).toBe(20)
  })
  it('never seeks past the last frame', () => {
    expect(sampleTime(80, 2_400_000, 2_400_000)).toBeCloseTo(79.999)
  })
  it('places every analyzed sample inside the clip', () => {
    const elapsed = 2_398_000
    for (const { atMs } of sampleIntervals(elapsed)) {
      const t = sampleTime(79.6, atMs, elapsed)
      expect(t).toBeGreaterThanOrEqual(0)
      expect(t).toBeLessThan(79.6)
    }
  })
})

describe('clockOf', () => {
  it('formats m:ss', () => {
    expect(clockOf(0)).toBe('0:00')
    expect(clockOf(65_000)).toBe('1:05')
    expect(clockOf(2_385_000)).toBe('39:45')
  })
})
