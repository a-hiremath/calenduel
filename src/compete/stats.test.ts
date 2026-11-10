import { describe, expect, it } from 'vitest'
import {
  addDays,
  currentStreak,
  dailyStandings,
  focusPercent,
  formatStudyTime,
  headToHead,
  localDay,
  type DailyTotal,
} from './stats'

const TODAY = '2026-11-09'
const SINCE = '2026-11-01'
const MIN = 60_000

const total = (
  userId: string,
  day: string,
  totalMs: number,
  focusMs = 0,
  analyzedMs = focusMs ? totalMs : 0,
): DailyTotal => ({ userId, day, totalMs, focusMs, analyzedMs })

describe('dates', () => {
  it('uses the local calendar date, not the UTC one', () => {
    const lateEvening = new Date(2026, 10, 9, 23, 30).getTime()
    expect(localDay(lateEvening)).toBe('2026-11-09')
  })

  it('crosses month and year boundaries', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('steps one date at a time across a DST change', () => {
    expect(addDays('2026-11-02', -1)).toBe('2026-11-01')
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09')
  })
})

describe('dailyStandings', () => {
  const people = [
    { id: 'me', name: 'Me' },
    { id: 'a', name: 'Ada' },
    { id: 'b', name: 'Ben' },
  ]

  it('ranks by time today and ignores other days', () => {
    const rows = dailyStandings(
      [
        total('me', TODAY, 100),
        total('a', TODAY, 300),
        total('b', TODAY, 200),
        total('me', '2026-11-08', 9999),
      ],
      people,
      TODAY,
    )
    expect(rows.map((r) => [r.id, r.rank, r.totalMs])).toEqual([
      ['a', 1, 300],
      ['b', 2, 200],
      ['me', 3, 100],
    ])
  })

  it('gives equal times the same rank and skips the next one', () => {
    const rows = dailyStandings(
      [total('me', TODAY, 300), total('a', TODAY, 300), total('b', TODAY, 100)],
      people,
      TODAY,
    )
    expect(rows.map((r) => r.rank)).toEqual([1, 1, 3])
  })

  it('still lists people who have not studied today', () => {
    const rows = dailyStandings([], people, TODAY)
    expect(rows.map((r) => [r.rank, r.totalMs])).toEqual([
      [1, 0],
      [1, 0],
      [1, 0],
    ])
  })
})

describe('currentStreak', () => {
  it('counts back from today', () => {
    expect(
      currentStreak(new Set(['2026-11-09', '2026-11-08', '2026-11-07']), TODAY),
    ).toBe(3)
  })

  it('stays alive when the last study day was yesterday', () => {
    expect(currentStreak(new Set(['2026-11-08', '2026-11-07']), TODAY)).toBe(2)
  })

  it('is broken by a whole missed day', () => {
    expect(currentStreak(new Set(['2026-11-07', '2026-11-06']), TODAY)).toBe(0)
  })

  it('stops at the first gap', () => {
    expect(currentStreak(new Set(['2026-11-09', '2026-11-07']), TODAY)).toBe(1)
  })
})

describe('headToHead', () => {
  it('scores each finished day for whoever studied more', () => {
    const h = headToHead(
      [
        total('me', '2026-11-05', 200),
        total('them', '2026-11-05', 100),
        total('me', '2026-11-06', 100),
        total('them', '2026-11-06', 200),
        total('them', '2026-11-07', 50),
        total('me', '2026-11-08', 75),
        total('them', '2026-11-08', 75),
      ],
      'me',
      'them',
      SINCE,
      TODAY,
    )
    expect(h).toMatchObject({ wins: 1, losses: 2, ties: 1 })
  })

  it('does not score today while it is still being played', () => {
    const h = headToHead(
      [total('me', TODAY, 500), total('them', TODAY, 100)],
      'me',
      'them',
      SINCE,
      TODAY,
    )
    expect(h).toMatchObject({ wins: 0, losses: 0, ties: 0 })
    expect(h.myTotalMs).toBe(500)
    expect(h.recent[0]).toEqual({ day: TODAY, myMs: 500, theirMs: 100 })
  })

  it('ignores everything before the friendship began', () => {
    const h = headToHead(
      [total('me', '2026-10-31', 500), total('me', SINCE, 100)],
      'me',
      'them',
      SINCE,
      TODAY,
    )
    expect(h).toMatchObject({ wins: 1, myTotalMs: 100 })
  })

  it('does not count a day neither person studied', () => {
    const h = headToHead([], 'me', 'them', SINCE, TODAY)
    expect(h).toMatchObject({ wins: 0, losses: 0, ties: 0 })
  })

  it('does not treat a zero-length day as studying', () => {
    const h = headToHead(
      [total('me', '2026-11-08', 0)],
      'me',
      'them',
      SINCE,
      TODAY,
    )
    expect(h).toMatchObject({ ties: 0, myStreak: 0 })
  })

  it('lists the last seven days, newest first', () => {
    const { recent } = headToHead([], 'me', 'them', SINCE, TODAY)
    expect(recent).toHaveLength(7)
    expect(recent[0].day).toBe(TODAY)
    expect(recent[6].day).toBe('2026-11-03')
  })
})

describe('focus time', () => {
  const people = [
    { id: 'me', name: 'Me' },
    { id: 'zach', name: 'Zach' },
  ]

  it('shows beside today\'s standings but never changes the ranking', () => {
    const rows = dailyStandings(
      [total('me', TODAY, 60 * MIN, 50 * MIN), total('zach', TODAY, 90 * MIN, 10 * MIN)],
      people,
      TODAY,
    )
    expect(rows.map((r) => [r.id, r.rank, r.focusMs])).toEqual([
      ['zach', 1, 10 * MIN],
      ['me', 2, 50 * MIN],
    ])
  })

  it('sums since the friendship began, like total time', () => {
    const h = headToHead(
      [
        total('me', addDays(SINCE, -1), 60 * MIN, 60 * MIN),
        total('me', SINCE, 60 * MIN, 30 * MIN),
        total('me', TODAY, 60 * MIN, 20 * MIN),
        total('zach', SINCE, 60 * MIN),
      ],
      'me',
      'zach',
      SINCE,
      TODAY,
    )
    expect([h.myFocusMs, h.theirFocusMs]).toEqual([50 * MIN, 0])
    expect([h.myAnalyzedMs, h.theirAnalyzedMs]).toEqual([120 * MIN, 0])
  })

  it('is a share of analyzed time, not of all time studied', () => {
    // 2h studied, but only the 1h session was analyzed: 45 of 60 minutes.
    expect(focusPercent(45 * MIN, 60 * MIN)).toBe(75)
    expect(focusPercent(0, 0)).toBeNull()
  })
})

describe('formatStudyTime', () => {
  it('formats minutes and hours', () => {
    expect(formatStudyTime(0)).toBe('0m')
    expect(formatStudyTime(59_999)).toBe('0m')
    expect(formatStudyTime(12 * 60_000)).toBe('12m')
    expect(formatStudyTime(65 * 60_000)).toBe('1h 05m')
  })
})
