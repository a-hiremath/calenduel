import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  addFriend,
  ensureProfile,
  fetchDailyTotals,
  fetchFriendSessions,
  FRIEND_SESSION_LIMIT,
  isSignedIn,
  listFriends,
  removeFriend,
  signIn,
  signOut,
  syncSessions,
  type Friend,
  type FriendSession,
  type Profile,
} from './api'
import {
  dailyStandings,
  formatStudyTime,
  headToHead,
  localDay,
  type DailyTotal,
} from './stats'
import './Compete.css'

const REFRESH_MS = 60_000

interface Board {
  profile: Profile
  friends: Friend[]
  totals: DailyTotal[]
  failedUploads: number
  today: string // read at each refresh, so the board rolls over at midnight
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.'
}

function shortDay(day: string): string {
  // Noon, so the label can't slip onto the neighbouring date in any timezone.
  return new Date(`${day}T12:00:00`).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

// In the viewer's own timezone, so a friend abroad can fall on a different date
// than the day the session counted toward.
function sessionStart(startedAt: string): string {
  return new Date(startedAt).toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// Mounted only while its section is open, so each opening fetches fresh sessions
// and closed cards cost nothing.
function FriendSessions({ friendId }: { friendId: string }) {
  const [sessions, setSessions] = useState<FriendSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let closed = false
    fetchFriendSessions(friendId)
      .then((rows) => {
        if (!closed) setSessions(rows)
      })
      .catch((err) => {
        if (!closed) setError(errorText(err))
      })
    return () => {
      closed = true
    }
  }, [friendId])

  if (error) return <p className="compete-error" role="alert">{error}</p>
  if (!sessions) return <p className="compete-note">Loading...</p>
  if (sessions.length === 0) {
    return <p className="compete-note">No sessions since you connected.</p>
  }

  return (
    <>
      <table className="compete-table">
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id}>
              <th scope="row">{sessionStart(s.startedAt)}</th>
              <td>{formatStudyTime(s.elapsedMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {sessions.length === FRIEND_SESSION_LIMIT && (
        <p className="compete-note">Showing the latest {FRIEND_SESSION_LIMIT}.</p>
      )}
    </>
  )
}

function FriendCard({
  friend,
  me,
  totals,
  today,
  onRemoved,
}: {
  friend: Friend
  me: Profile
  totals: DailyTotal[]
  today: string
  onRemoved: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const h = headToHead(totals, me.id, friend.id, friend.since, today)

  async function handleRemove() {
    setError(null)
    try {
      await removeFriend(friend.id)
      onRemoved()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <li className="rival">
      <div className="rival-head">
        <h3 className="rival-name">{friend.name}</h3>
        <p className="rival-since">since {shortDay(friend.since)}</p>
      </div>

      <table className="compete-table">
        <thead>
          <tr>
            <th scope="col" />
            <th scope="col">You</th>
            <th scope="col">{friend.name}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Days won</th>
            <td>{h.wins}</td>
            <td>{h.losses}</td>
          </tr>
          <tr>
            <th scope="row">Total time</th>
            <td>{formatStudyTime(h.myTotalMs)}</td>
            <td>{formatStudyTime(h.theirTotalMs)}</td>
          </tr>
          <tr>
            <th scope="row">Streak</th>
            <td>{plural(h.myStreak, 'day')}</td>
            <td>{plural(h.theirStreak, 'day')}</td>
          </tr>
        </tbody>
      </table>
      {h.ties > 0 && <p className="compete-note">{plural(h.ties, 'tied day')}</p>}

      <details className="rival-days">
        <summary>Last 7 days</summary>
        <table className="compete-table">
          <tbody>
            {h.recent.map((d) => (
              <tr key={d.day}>
                <th scope="row">{d.day === today ? 'Today' : shortDay(d.day)}</th>
                <td className={d.myMs > d.theirMs ? 'ahead' : undefined}>
                  {formatStudyTime(d.myMs)}
                </td>
                <td className={d.theirMs > d.myMs ? 'ahead' : undefined}>
                  {formatStudyTime(d.theirMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <details
        className="rival-days"
        onToggle={(e) => setSessionsOpen(e.currentTarget.open)}
      >
        <summary>Study sessions</summary>
        {sessionsOpen && <FriendSessions friendId={friend.id} />}
      </details>

      <div className="rival-actions">
        {confirming ? (
          <>
            <span className="compete-note">Your record resets if you reconnect.</span>
            <button type="button" className="compete-btn danger" onClick={handleRemove}>
              Remove {friend.name}
            </button>
            <button
              type="button"
              className="compete-btn"
              onClick={() => setConfirming(false)}
            >
              Keep
            </button>
          </>
        ) : (
          <button
            type="button"
            className="compete-link"
            onClick={() => setConfirming(true)}
          >
            Remove friend
          </button>
        )}
      </div>
      {error && <p className="compete-error" role="alert">{error}</p>}
    </li>
  )
}

function InviteForm({
  inviteCode,
  onAdded,
}: {
  inviteCode: string
  onAdded: () => void
}) {
  // An invite link fills in the code but doesn't act on it: connecting shares
  // your daily totals, so that should take a click, not just following a link.
  const [code, setCode] = useState(
    () => new URLSearchParams(window.location.search).get('invite') ?? '',
  )
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [adding, setAdding] = useState(false)

  async function handleCopy() {
    setError(null)
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/?invite=${inviteCode}`,
      )
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError(`Couldn't copy the link. Your code is ${inviteCode}.`)
    }
  }

  async function handleAdd(event: FormEvent) {
    event.preventDefault()
    setMessage(null)
    setError(null)
    setAdding(true)
    try {
      const name = await addFriend(code)
      setMessage(`You and ${name} are now competing.`)
      setCode('')
      window.history.replaceState(null, '', '/?tab=compete')
      onAdded()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setAdding(false)
    }
  }

  return (
    <section className="compete-section">
      <h2>Add a friend</h2>
      <p className="compete-note">
        Friends see your name and your sessions from the day you connect: when
        each one started and how long it lasted. They never see your clips. Only
        share your link with people you want to compete against.
      </p>

      <div className="invite-row">
        <code className="invite-code">{inviteCode}</code>
        <button type="button" className="compete-btn" onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy invite link'}
        </button>
      </div>

      <form className="invite-row" onSubmit={handleAdd}>
        <input
          className="invite-input"
          aria-label="Friend's invite code"
          placeholder="Friend's code"
          autoComplete="off"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button
          type="submit"
          className="compete-btn"
          disabled={adding || code.trim() === ''}
        >
          Add friend
        </button>
      </form>

      {message && <p className="compete-note" role="status">{message}</p>}
      {error && <p className="compete-error" role="alert">{error}</p>}
    </section>
  )
}

export default function Compete() {
  // null = still finding out.
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const active = await isSignedIn()
      setSignedIn(active)
      if (!active) return
      // Upload first, so your own numbers on this page are never behind.
      const failedUploads = await syncSessions()
      const [profile, friends, totals] = await Promise.all([
        ensureProfile(),
        listFriends(),
        fetchDailyTotals(),
      ])
      setBoard({ profile, friends, totals, failedUploads, today: localDay(Date.now()) })
      setError(null)
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  // Keeps the scoreboard current without a realtime connection: refresh on open,
  // on returning to the tab, and once a minute while it's actually being viewed.
  useEffect(() => {
    // refresh() only setStates after its first await, so this is an async data
    // fetch rather than a synchronous cascading render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, REFRESH_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  async function handleSignIn() {
    setError(null)
    try {
      await signIn()
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function handleSignOut() {
    setError(null)
    try {
      await signOut()
      setBoard(null)
      setSignedIn(false)
    } catch (err) {
      setError(errorText(err))
    }
  }

  const standings = board
    ? dailyStandings(
        board.totals,
        [{ id: board.profile.id, name: board.profile.name }, ...board.friends],
        board.today,
      )
    : []

  return (
    <main className="compete">
      <h1>Compete</h1>

      {error && <p className="compete-error" role="alert">{error}</p>}

      {signedIn === null && !error && <p className="compete-note">Loading...</p>}

      {signedIn === false && (
        <section className="compete-section">
          <p className="compete-lead">
            Every day is a contest. Whoever studies the most by midnight wins it,
            and your record builds up day by day.
          </p>
          <button type="button" className="compete-btn primary" onClick={handleSignIn}>
            Sign in with Google
          </button>
          <p className="compete-note">
            Signing in uploads the start time and length of your sessions so they
            can count and friends you add can see them. Your clips stay on this
            device.
          </p>
        </section>
      )}

      {signedIn && !board && !error && <p className="compete-note">Loading...</p>}

      {board && (
        <>
          {board.failedUploads > 0 && (
            <p className="compete-error" role="alert">
              {plural(board.failedUploads, 'session')} couldn't be uploaded and
              {board.failedUploads === 1 ? " isn't" : " aren't"} counted yet. Check
              that your computer's clock is right.
            </p>
          )}

          <section className="compete-section">
            <h2>Today</h2>
            <ol className="standings">
              {standings.map((s) => (
                <li
                  key={s.id}
                  className={
                    s.rank === 1 && s.totalMs > 0 ? 'standing leading' : 'standing'
                  }
                >
                  <span className="standing-rank">{s.rank}</span>
                  <span className="standing-name">
                    {s.id === board.profile.id ? 'You' : s.name}
                  </span>
                  <span className="standing-time">{formatStudyTime(s.totalMs)}</span>
                </li>
              ))}
            </ol>
            <p className="compete-note">
              Sessions count once you press Stop, toward the day they started.
            </p>
          </section>

          {board.friends.length > 0 && (
            <section className="compete-section">
              <h2>Head to head</h2>
              <ul className="rivals">
                {board.friends.map((f) => (
                  <FriendCard
                    key={f.id}
                    friend={f}
                    me={board.profile}
                    totals={board.totals}
                    today={board.today}
                    onRemoved={refresh}
                  />
                ))}
              </ul>
            </section>
          )}

          <InviteForm inviteCode={board.profile.inviteCode} onAdded={refresh} />

          <button type="button" className="compete-link" onClick={handleSignOut}>
            Sign out {board.profile.name}
          </button>
        </>
      )}
    </main>
  )
}
