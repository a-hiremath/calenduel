import { describe, expect, it } from 'vitest'
import {
  sampleIntervals, smoothedChoices, summarizeFocus, type FocusChoice, type FocusSample,
} from './types'

describe('focus estimates', () => {
  it('weights the partial final interval and excludes unknown evidence', () => {
    const samples: FocusSample[] = [
      { atMs: 0, durationMs: 15_000, choice: 'on_task', originalChoice: 'on_task' },
      { atMs: 15_000, durationMs: 15_000, choice: 'unclear', originalChoice: 'unclear' },
      { atMs: 30_000, durationMs: 5_000, choice: 'off_task', originalChoice: 'off_task' },
    ]
    expect(summarizeFocus(samples)).toEqual({
      percent: 75, coverage: 57, onMs: 15_000, rawPercent: 75, smoothed: 0,
    })
    expect(summarizeFocus([]).percent).toBeNull()
  })
})

const run = (labels: string, corrected = ''): FocusSample[] => [...labels].map((c, i) => {
  const choice: FocusChoice = c === '+' ? 'on_task' : c === '-' ? 'off_task' : 'unclear'
  const flipped: FocusChoice = choice === 'on_task' ? 'off_task' : 'on_task'
  return {
    atMs: i * 15_000, durationMs: 15_000, choice,
    // 'c' marks a hand correction recorded the old way (choice differs from the
    // model's), 'k' one that kept the model's label but was pinned by hand.
    originalChoice: corrected[i] === 'c' ? flipped : choice,
    ...(corrected[i] === 'k' ? { corrected: true } : {}),
  }
})
const show = (choices: FocusChoice[]) =>
  choices.map(c => c === 'on_task' ? '+' : c === 'off_task' ? '-' : '?').join('')

describe('smoothing one-sample blips', () => {
  it('counts a lone off-task sample inside on-task work as on task', () => {
    expect(show(smoothedChoices(run('+++-+++')))).toBe('+++++++')
    expect(show(smoothedChoices(run('++-+')))).toBe('++++')
    const summary = summarizeFocus(run('+++-+++'))
    expect(summary).toMatchObject({ percent: 100, rawPercent: 86, smoothed: 1 })
  })
  it('works both ways: a lone on-task sample inside a distraction does not count', () => {
    expect(show(smoothedChoices(run('---+---')))).toBe('-------')
  })
  it('smooths a blip at either end when the stretch beside it is long enough', () => {
    expect(show(smoothedChoices(run('-+++')))).toBe('++++')
    expect(show(smoothedChoices(run('+++-')))).toBe('++++')
    expect(show(smoothedChoices(run('-++')))).toBe('-++')
  })
  it('leaves real changes, longer stretches and alternation alone', () => {
    for (const labels of ['+++--+++', '+-+-+-+', '+-+', '+', '-', '']) {
      expect(show(smoothedChoices(run(labels)))).toBe(labels)
    }
  })
  it('never changes or leans on unclear samples', () => {
    expect(show(smoothedChoices(run('++?++')))).toBe('++?++')
    expect(show(smoothedChoices(run('++-?++')))).toBe('++-?++')
    expect(summarizeFocus(run('++?++')).coverage).toBe(80)
  })
  it('keeps hand corrections as chosen', () => {
    expect(show(smoothedChoices(run('+++-+++', '   c   ')))).toBe('+++-+++')
    expect(show(smoothedChoices(run('+++-+++', '   k   ')))).toBe('+++-+++')
    // A corrected neighbour still counts as context.
    expect(show(smoothedChoices(run('++-+', '   k')))).toBe('++++')
  })
})

describe('sampling', () => {
  it('never invents time or exceeds the sampling cap', () => {
    for (const elapsed of [1, 14_999, 15_000, 15_001, 3_600_001, 86_400_000]) {
      const intervals = sampleIntervals(elapsed)
      expect(intervals.length).toBeLessThanOrEqual(240)
      expect(intervals.reduce((sum, s) => sum + s.durationMs, 0)).toBe(elapsed)
    }
    expect(sampleIntervals(NaN)).toEqual([])
  })
})
