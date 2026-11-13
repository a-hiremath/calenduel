import { describe, expect, it } from 'vitest'
import {
  countsAsSameWork, firstPass, matchedAnchor, nearestAnchor, needsRecheck, needsSecondPass, pickAnchors,
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

// '+' on task, '-' off task, '?' unclear; `sure` is p(on_task) per sample.
const scored = (labels: string, sure: number[], ipad = ''): FocusSample[] => [...labels].map((c, i) => {
  const choice: FocusChoice = c === '+' ? 'on_task' : c === '-' ? 'off_task' : 'unclear'
  return {
    atMs: i * 15_000, durationMs: 15_000, choice, originalChoice: choice,
    source: ipad[i] === 'i' ? 'ipad' : 'laptop',
    probabilities: { on_task: sure[i], off_task: 1 - sure[i], unclear: 0 },
  }
})

describe('second pass: choosing anchors', () => {
  it('takes the surest on-task sample from each third of the session', () => {
    const samples = scored('++-+++-++', [.8, .9, .1, .76, .85, .8, .2, .88, .88])
    expect(pickAnchors(samples)).toEqual([1, 4, 7]) // a tie keeps the earlier one
  })
  it('skips a third with nothing sure enough, and never picks an off-task sample', () => {
    expect(pickAnchors(scored('+--+-+', [.74, .1, .1, .9, .2, .6]))).toEqual([3])
    expect(pickAnchors(scored('---', [.9, .9, .9]))).toEqual([])
    expect(pickAnchors([])).toEqual([])
  })
  it('prefers a sample the laptop decided over a surer one the iPad decided', () => {
    const off = [.1, .1, .1, .1]
    expect(pickAnchors(scored('++----', [.89, .76, ...off], 'i '))).toEqual([1])
    // With no laptop sample sure enough, an iPad one still serves.
    expect(pickAnchors(scored('++----', [.89, .7, ...off], 'i '))).toEqual([0])
  })
  it('compares each off-task sample with the nearest anchor, the earlier on a tie', () => {
    const samples = scored('+--+---+', [.9, .1, .1, .9, .1, .1, .1, .9])
    expect(nearestAnchor(samples, [0, 3, 7], 1)).toBe(0)
    expect(nearestAnchor(samples, [0, 3, 7], 2)).toBe(3)
    expect(nearestAnchor(samples, [0, 3, 7], 5)).toBe(3) // 2 from 3, 2 from 7
    expect(nearestAnchor(samples, [0, 3, 7], 6)).toBe(7)
  })
  it('rechecks only what the laptop called off task', () => {
    const samples = scored('-?-+', [.1, .1, .1, .9], '  i ')
    expect(samples.map(needsRecheck)).toEqual([true, false, false, false])
  })
})

describe('second pass: results', () => {
  const matched = (s: FocusSample): FocusSample => ({ ...s, choice: 'on_task', originalChoice: 'on_task',
    anchor: { atMs: 0, choice: 'same_work' } })
  it('counts a matched sample as on task, and reports the estimate without it', () => {
    const samples = scored('++---', [.9, .9, .1, .1, .1])
    samples[2] = matched(samples[2])
    samples[3] = { ...samples[3], anchor: { atMs: 0, choice: 'different' } }
    expect(samples.map(matchedAnchor)).toEqual([false, false, true, false, false])
    expect(summarizeFocus(samples).percent).toBe(60)
    expect(summarizeFocus(firstPass(samples)).percent).toBe(40)
  })
  it('keeps a hand correction of a matched sample, before and after', () => {
    const samples = scored('+-', [.9, .1])
    samples[1] = { ...matched(samples[1]), choice: 'off_task', corrected: true }
    expect(matchedAnchor(samples[1])).toBe(false)
    expect(firstPass(samples)[1]).toMatchObject({ choice: 'off_task', originalChoice: 'off_task' })
    samples[1] = { ...samples[1], choice: 'unclear' }
    expect(firstPass(samples)[1].choice).toBe('unclear')
  })
  it('smooths a matched sample like any other on-task label', () => {
    // A matched sample alone inside a distraction is still a blip.
    const samples = scored('---+---', [.1, .1, .1, .1, .1, .1, .1])
    samples[3] = matched(samples[3])
    expect(smoothedChoices(samples)[3]).toBe('off_task')
  })
})

describe('second pass: how sure "same work" must be', () => {
  const p = (same: number, different: number) => ({ same_work: same, different, unclear: 1 - same - different })
  it('needs at least even odds, not just the top answer', () => {
    expect(countsAsSameWork('same_work', p(.46, .44))).toBe(false) // the one leak in testing
    expect(countsAsSameWork('same_work', p(.5, .4))).toBe(true)
    expect(countsAsSameWork('same_work', p(.76, .2))).toBe(true)
    expect(countsAsSameWork('different', p(.1, .8))).toBe(false)
    expect(countsAsSameWork('same_work')).toBe(false)
  })
  it('leaves an unsure match off task and out of the recheck count', () => {
    const unsure: FocusSample = { atMs: 0, durationMs: 15_000, choice: 'off_task', originalChoice: 'off_task',
      anchor: { atMs: 15_000, choice: 'same_work', probabilities: p(.46, .44) } }
    expect(matchedAnchor(unsure)).toBe(false)
    expect(firstPass([unsure])).toEqual([unsure])
    // Corrected by hand to on task, it is the person's label, not a match.
    expect(matchedAnchor({ ...unsure, choice: 'on_task', corrected: true })).toBe(false)
  })
})

describe('rechecking a saved result', () => {
  it('never rechecks or anchors on a label the person set', () => {
    const samples = scored('+-+-', [.9, .1, .9, .1])
    samples[0] = { ...samples[0], choice: 'off_task', corrected: true } // a confident on-task the person called off
    samples[1] = { ...samples[1], corrected: true } // pinned off by hand
    samples[3] = { ...samples[3], choice: 'on_task' } // changed the old way
    expect(pickAnchors(samples)).toEqual([2])
    expect(samples.map(needsRecheck)).toEqual([false, false, false, false])
  })
  it('skips two-screen samples from before the deciding screen was kept', () => {
    const old: FocusSample = { atMs: 0, durationMs: 15_000, choice: 'off_task', originalChoice: 'off_task', ipad: true }
    expect(needsRecheck(old)).toBe(false)
    expect(needsRecheck({ ...old, source: 'laptop' })).toBe(true)
    expect(needsRecheck({ ...old, ipad: undefined })).toBe(true) // laptop-only: the laptop decided
  })
  it('lists only current, unrechecked results with something to recheck', () => {
    const focus = { task: 'p8', analyzedAt: 0, model: 'clef-flash' as const, rubric: 'task-v2' as const,
      samples: scored('+-', [.9, .1]) }
    const session = { task: 'p8', hasClip: true, focus }
    expect(needsSecondPass(session)).toBe(true)
    expect(needsSecondPass({ ...session, hasClip: false })).toBe(false)
    expect(needsSecondPass({ ...session, task: 'renamed' })).toBe(false)
    expect(needsSecondPass({ ...session, focus: { ...focus, anchors: { rubric: 'anchor-v1', atMs: [] } } })).toBe(false)
    expect(needsSecondPass({ ...session, focus: { ...focus, samples: scored('++', [.9, .9]) } })).toBe(false)
    expect(needsSecondPass({ task: 'p8', hasClip: true })).toBe(false)
  })
})
