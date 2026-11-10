import { describe, expect, it } from 'vitest'
import { sampleIntervals, summarizeFocus, type FocusSample } from './types'

describe('focus estimates', () => {
  it('weights the partial final interval and excludes unknown evidence', () => {
    const samples: FocusSample[] = [
      { atMs: 0, durationMs: 15_000, choice: 'on_task', originalChoice: 'on_task' },
      { atMs: 15_000, durationMs: 15_000, choice: 'unclear', originalChoice: 'unclear' },
      { atMs: 30_000, durationMs: 5_000, choice: 'off_task', originalChoice: 'off_task' },
    ]
    expect(summarizeFocus(samples)).toEqual({ percent: 75, coverage: 57, onMs: 15_000 })
    expect(summarizeFocus([]).percent).toBeNull()
  })
  it('never invents time or exceeds the sampling cap', () => {
    for (const elapsed of [1, 14_999, 15_000, 15_001, 3_600_001, 86_400_000]) {
      const intervals = sampleIntervals(elapsed)
      expect(intervals.length).toBeLessThanOrEqual(240)
      expect(intervals.reduce((sum, s) => sum + s.durationMs, 0)).toBe(elapsed)
    }
    expect(sampleIntervals(NaN)).toEqual([])
  })
})
