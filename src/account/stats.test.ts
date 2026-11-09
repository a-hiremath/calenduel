import { describe, expect, it } from 'vitest'
import { ACTIVITY_WEEKS, studyStats } from './stats'

const TODAY = '2026-11-09' // a Monday
const MIN = 60_000

// A session starting at noon local time on the given day.
const session = (day: string, minutes: number) => ({
  startedAt: new Date(`${day}T12:00:00`).getTime(),
  elapsedMs: minutes * MIN,
})

describe('studyStats', () => {
  it('is all zeroes with no sessions', () => {
    const stats = studyStats([], TODAY)
    expect(stats).toMatchObject({
      sessions: 0,
      totalMs: 0,
      todayMs: 0,
      weekMs: 0,
      longestSessionMs: 0,
      bestDayMs: 0,
      streak: 0,
      bestStreak: 0,
    })
  })

  it('adds up sessions, today and the last 7 days', () => {
    const stats = studyStats(
      [
        session('2026-11-09', 30),
        session('2026-11-09', 45),
        session('2026-11-03', 60), // 6 days ago: still in the week
        session('2026-11-02', 20), // 7 days ago: not
      ],
      TODAY,
    )
    expect(stats.sessions).toBe(4)
    expect(stats.totalMs).toBe(155 * MIN)
    expect(stats.todayMs).toBe(75 * MIN)
    expect(stats.weekMs).toBe(135 * MIN)
  })

  it('tells the longest session from the best day', () => {
    const stats = studyStats(
      [
        session('2026-11-07', 90),
        session('2026-11-08', 50),
        session('2026-11-08', 50),
      ],
      TODAY,
    )
    expect(stats.longestSessionMs).toBe(90 * MIN)
    expect(stats.bestDayMs).toBe(100 * MIN)
  })

  it('counts a late-evening session toward the local day it started', () => {
    const lateEvening = new Date(2026, 10, 8, 23, 30).getTime()
    const stats = studyStats([{ startedAt: lateEvening, elapsedMs: 90 * MIN }], TODAY)
    expect(stats.todayMs).toBe(0)
    expect(stats.activity.at(-2)).toEqual({ day: '2026-11-08', ms: 90 * MIN })
  })

  it('keeps the best streak after the current one is broken', () => {
    const stats = studyStats(
      [
        session('2026-10-01', 10),
        session('2026-10-02', 10),
        session('2026-10-03', 10),
        session('2026-11-08', 10),
        session('2026-11-09', 10),
      ],
      TODAY,
    )
    expect(stats.streak).toBe(2)
    expect(stats.bestStreak).toBe(3)
  })

  it('counts a streak across a month boundary', () => {
    const stats = studyStats(
      [session('2026-10-31', 10), session('2026-11-01', 10)],
      TODAY,
    )
    expect(stats.streak).toBe(0)
    expect(stats.bestStreak).toBe(2)
  })

  it('lays activity out in whole weeks from a Sunday through today', () => {
    const { activity } = studyStats([session('2026-11-09', 25)], TODAY)
    // 25 full weeks, then Sunday and Monday of this one.
    expect(activity).toHaveLength(7 * (ACTIVITY_WEEKS - 1) + 2)
    expect(new Date(`${activity[0].day}T00:00:00Z`).getUTCDay()).toBe(0)
    expect(activity.at(-1)).toEqual({ day: TODAY, ms: 25 * MIN })
  })

  it('fills the last column when today is a Saturday', () => {
    const { activity } = studyStats([], '2026-11-14')
    expect(activity).toHaveLength(7 * ACTIVITY_WEEKS)
  })
})
