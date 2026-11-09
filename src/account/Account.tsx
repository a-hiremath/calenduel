import { useEffect, useState } from 'react'
import { listSessions } from '../db'
import { formatStudyTime, localDay } from '../compete/stats'
import { ACTIVITY_WEEKS, studyStats, type DayActivity, type StudyStats } from './stats'
import './Account.css'

function days(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`
}

function dayLabel(day: string): string {
  // Noon, so the label can't slip onto the neighbouring date in any timezone.
  return new Date(`${day}T12:00:00`).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

// One square per day, a column per week. Shading is relative to your own best
// day in the window, so the grid shows your pattern rather than a fixed target.
function Activity({ activity }: { activity: DayActivity[] }) {
  const max = Math.max(...activity.map((d) => d.ms))
  return (
    <div
      className="activity"
      role="img"
      aria-label={`Study time per day over the last ${ACTIVITY_WEEKS} weeks`}
    >
      {activity.map((d) => (
        <span
          key={d.day}
          className="activity-day"
          data-level={d.ms > 0 ? Math.ceil((d.ms / max) * 4) : 0}
          title={`${dayLabel(d.day)}: ${formatStudyTime(d.ms)}`}
        />
      ))}
    </div>
  )
}

function Stats({ stats }: { stats: StudyStats }) {
  const figures = [
    ['Today', formatStudyTime(stats.todayMs)],
    ['Last 7 days', formatStudyTime(stats.weekMs)],
    ['All time', formatStudyTime(stats.totalMs)],
    ['Sessions', String(stats.sessions)],
    ['Streak', days(stats.streak)],
    ['Best streak', days(stats.bestStreak)],
    ['Longest session', formatStudyTime(stats.longestSessionMs)],
    ['Best day', formatStudyTime(stats.bestDayMs)],
  ]
  return (
    <>
      <dl className="figures">
        {figures.map(([label, value]) => (
          <div key={label} className="figure">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <Activity activity={stats.activity} />
    </>
  )
}

export default function Account() {
  const [stats, setStats] = useState<StudyStats | null>(null)

  useEffect(() => {
    let closed = false
    listSessions().then((sessions) => {
      if (!closed) setStats(studyStats(sessions, localDay(Date.now())))
    })
    return () => {
      closed = true
    }
  }, [])

  return (
    <main className="account">
      <h1>Account</h1>

      <section className="account-section">
        <h2>Stats</h2>
        {stats ? <Stats stats={stats} /> : <p className="account-note">Loading...</p>}
        <p className="account-note">
          Counted from the sessions saved on this device, each toward the day it
          started.
        </p>
      </section>
    </main>
  )
}
