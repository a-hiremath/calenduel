// Your own study stats, as pure functions like the competition's rules: no
// React, no storage, and "today" is passed in, which is what makes them testable.

import { addDays, currentStreak, localDay } from '../compete/stats'

export interface DayActivity {
  day: string // YYYY-MM-DD
  ms: number
}

export interface StudyStats {
  sessions: number
  totalMs: number
  todayMs: number
  weekMs: number // the last 7 days, today included
  longestSessionMs: number
  bestDayMs: number
  streak: number
  bestStreak: number
  // Every day from a Sunday through today, oldest first, so a grid seven cells
  // tall has whole weeks as its columns.
  activity: DayActivity[]
}

export const ACTIVITY_WEEKS = 26

// The longest run of consecutive days in the set.
function longestStreak(studiedDays: Set<string>): number {
  let best = 0
  for (const day of studiedDays) {
    // Only count forward from the first day of each run.
    if (studiedDays.has(addDays(day, -1))) continue
    let length = 1
    while (studiedDays.has(addDays(day, length))) length += 1
    best = Math.max(best, length)
  }
  return best
}

// A session counts entirely toward the day it started, in the viewer's own
// timezone: the same rule the competition scores by.
export function studyStats(
  sessions: { startedAt: number; elapsedMs: number }[],
  today: string,
): StudyStats {
  const byDay = new Map<string, number>()
  let totalMs = 0
  let longestSessionMs = 0
  for (const s of sessions) {
    const day = localDay(s.startedAt)
    byDay.set(day, (byDay.get(day) ?? 0) + s.elapsedMs)
    totalMs += s.elapsedMs
    longestSessionMs = Math.max(longestSessionMs, s.elapsedMs)
  }

  let weekMs = 0
  for (let i = 0; i < 7; i++) weekMs += byDay.get(addDays(today, -i)) ?? 0

  // Parsed as UTC to match addDays, so this is the weekday of the date itself.
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay()
  const activity: DayActivity[] = []
  for (let back = weekday + 7 * (ACTIVITY_WEEKS - 1); back >= 0; back--) {
    const day = addDays(today, -back)
    activity.push({ day, ms: byDay.get(day) ?? 0 })
  }

  const studiedDays = new Set(byDay.keys())
  return {
    sessions: sessions.length,
    totalMs,
    todayMs: byDay.get(today) ?? 0,
    weekMs,
    longestSessionMs,
    bestDayMs: Math.max(0, ...byDay.values()),
    streak: currentStreak(studiedDays, today),
    bestStreak: longestStreak(studiedDays),
    activity,
  }
}
