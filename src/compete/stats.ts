// The rules of the competition, as pure functions: no network, no React, no
// clock. "today" is always passed in, which is what makes them testable.

export interface DailyTotal {
  userId: string
  day: string // YYYY-MM-DD
  totalMs: number
  focusMs: number // experimental: the part of analyzed sessions judged on task
  analyzedMs: number // the length of the sessions that focus was measured on
}

export interface Person {
  id: string
  name: string
}

export interface Standing extends Person {
  rank: number
  totalMs: number
  focusMs: number
  analyzedMs: number
}

export interface DayComparison {
  day: string
  myMs: number
  theirMs: number
}

export interface HeadToHead {
  wins: number
  losses: number
  ties: number
  myTotalMs: number
  theirTotalMs: number
  myFocusMs: number
  theirFocusMs: number
  myAnalyzedMs: number
  theirAnalyzedMs: number
  myStreak: number
  theirStreak: number
  recent: DayComparison[] // newest first, today included
}

const RECENT_DAYS = 7

// The calendar date in the viewer's own timezone. toISOString() would give the
// UTC date, which is already "tomorrow" on a US evening.
export function localDay(ms: number): string {
  const d = new Date(ms)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const date = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${date}`
}

// Done in UTC, where every day is exactly 24 hours, so DST can't skip a date.
export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

function totalsFor(totals: DailyTotal[], userId: string): Map<string, number> {
  const byDay = new Map<string, number>()
  for (const t of totals) {
    if (t.userId === userId && t.totalMs > 0) byDay.set(t.day, t.totalMs)
  }
  return byDay
}

// Focus never decides a day, so it is only ever summed beside the totals.
function focusSince(totals: DailyTotal[], userId: string, since: string) {
  let focusMs = 0
  let analyzedMs = 0
  for (const t of totals) {
    if (t.userId !== userId || t.day < since) continue
    focusMs += t.focusMs
    analyzedMs += t.analyzedMs
  }
  return { focusMs, analyzedMs }
}

// Out of the time that was analyzed, not all time studied: an unanalyzed
// session says nothing about focus. Null when nothing has been analyzed.
export function focusPercent(focusMs: number, analyzedMs: number): number | null {
  return analyzedMs > 0 ? Math.round((100 * focusMs) / analyzedMs) : null
}

// Today's leaderboard, most time first. People level on time share a rank.
export function dailyStandings(
  totals: DailyTotal[],
  people: Person[],
  today: string,
): Standing[] {
  const rows = people
    .map((p) => {
      const day = totals.find((t) => t.userId === p.id && t.day === today)
      return {
        ...p,
        totalMs: day?.totalMs ?? 0,
        focusMs: day?.focusMs ?? 0,
        analyzedMs: day?.analyzedMs ?? 0,
      }
    })
    .sort((a, b) => b.totalMs - a.totalMs)

  let rank = 0
  return rows.map((row, i) => {
    if (i === 0 || row.totalMs !== rows[i - 1].totalMs) rank = i + 1
    return { ...row, rank }
  })
}

// Consecutive days studied, ending today. A streak isn't broken until a whole
// day has been missed, so one that reaches yesterday is still alive today.
export function currentStreak(studiedDays: Set<string>, today: string): number {
  let day = studiedDays.has(today) ? today : addDays(today, -1)
  let streak = 0
  while (studiedDays.has(day)) {
    streak += 1
    day = addDays(day, -1)
  }
  return streak
}

// The record between two people since they connected. Today isn't scored until
// it's over, and a day neither person studied is nobody's win or tie.
export function headToHead(
  totals: DailyTotal[],
  myId: string,
  theirId: string,
  since: string,
  today: string,
): HeadToHead {
  const mine = totalsFor(totals, myId)
  const theirs = totalsFor(totals, theirId)

  let wins = 0
  let losses = 0
  let ties = 0
  let myTotalMs = 0
  let theirTotalMs = 0

  for (const day of new Set([...mine.keys(), ...theirs.keys()])) {
    if (day < since) continue
    const myMs = mine.get(day) ?? 0
    const theirMs = theirs.get(day) ?? 0
    myTotalMs += myMs
    theirTotalMs += theirMs

    if (day >= today) continue
    if (myMs > theirMs) wins += 1
    else if (theirMs > myMs) losses += 1
    else ties += 1
  }

  const myFocus = focusSince(totals, myId, since)
  const theirFocus = focusSince(totals, theirId, since)

  const recent: DayComparison[] = []
  for (let i = 0; i < RECENT_DAYS; i++) {
    const day = addDays(today, -i)
    recent.push({
      day,
      myMs: day >= since ? (mine.get(day) ?? 0) : 0,
      theirMs: day >= since ? (theirs.get(day) ?? 0) : 0,
    })
  }

  return {
    wins,
    losses,
    ties,
    myTotalMs,
    theirTotalMs,
    myFocusMs: myFocus.focusMs,
    theirFocusMs: theirFocus.focusMs,
    myAnalyzedMs: myFocus.analyzedMs,
    theirAnalyzedMs: theirFocus.analyzedMs,
    myStreak: currentStreak(new Set(mine.keys()), today),
    theirStreak: currentStreak(new Set(theirs.keys()), today),
    recent,
  }
}

// "1h 05m", "12m", or "0m".
export function formatStudyTime(ms: number): string {
  const totalMin = Math.floor(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}
