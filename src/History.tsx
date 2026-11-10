import { useCallback, useEffect, useState } from 'react'
import {
  SESSION_NAME_MAX,
  deleteSession,
  getClip,
  listSessions,
  renameSession,
  type SessionMeta,
} from './db'
import { downloadBlob, timelapseName } from './media/share'
import './History.css'
import FocusScore from './focus/FocusScore'

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function formatTimeOfDay(ms: number): string {
  return new Date(ms)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .replace(' AM', ' am')
    .replace(' PM', ' pm')
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

function SessionCard({ session, onChanged }: { session: SessionMeta; onChanged: () => void }) {
  const [playing, setPlaying] = useState(false)
  const [clipUrl, setClipUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [name, setName] = useState(session.task)

  useEffect(() => {
    return () => { if (clipUrl) URL.revokeObjectURL(clipUrl) }
  }, [clipUrl])

  async function handlePlay() {
    if (clipUrl) {
      setPlaying(true)
      return
    }
    setLoading(true)
    const blob = await getClip(session.id)
    setLoading(false)
    if (!blob) return
    setClipUrl(URL.createObjectURL(blob))
    setPlaying(true)
  }

  async function handleDownload() {
    const blob = clipUrl
      ? await fetch(clipUrl).then((r) => r.blob())
      : await getClip(session.id)
    if (blob) downloadBlob(blob, timelapseName(blob, name.trim() || session.task))
  }

  async function handleDelete() {
    setDeleteError(null)
    // Server first: if this fails, the session is still here to retry, rather
    // than gone locally while still counting toward the competition.
    try {
      const { deleteUploadedSession } = await import('./compete/api')
      await deleteUploadedSession(session.id)
    } catch {
      setDeleteError("Couldn't remove this from your competition stats. Try again.")
      return
    }
    await deleteSession(session.id)
    onChanged()
  }

  // Saved when the field loses focus. Clearing it puts the old name back
  // rather than leaving a session with no name.
  async function handleRename() {
    const next = name.trim() || session.task
    setName(next)
    if (next === session.task) return
    await renameSession(session.id, next)
    onChanged()
  }

  const metPct = session.goalMs > 0
    ? Math.round((session.elapsedMs / session.goalMs) * 100)
    : 0

  return (
    <li className="history-card">
      {playing && clipUrl ? (
        <div className="history-player">
          <video
            src={clipUrl}
            controls
            autoPlay
            onEnded={() => setPlaying(false)}
          />
        </div>
      ) : session.hasClip ? (
        <button
          type="button"
          className="history-play"
          onClick={handlePlay}
          disabled={loading}
        >
          {loading ? '...' : '▶'}
        </button>
      ) : null}

      <div className="history-info">
        <input
          className="history-task"
          aria-label="Session name"
          maxLength={SESSION_NAME_MAX}
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={handleRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <p className="history-meta">
          {formatDate(session.startedAt)} · {formatTimeOfDay(session.startedAt)}
        </p>
        <p className="history-stats">
          <span className="history-duration">{formatDuration(session.elapsedMs)}</span>
          {session.goalMs > 0 && (
            <span className={metPct >= 100 ? 'history-goal met' : 'history-goal'}>
              {metPct >= 100 ? '✓ ' : ''}{metPct}% of goal
            </span>
          )}
        </p>
        {deleteError && <p className="history-error" role="alert">{deleteError}</p>}
      </div>

      <div className="history-actions">
        {session.hasClip && (
          <button type="button" className="history-btn" onClick={handleDownload}>
            Save
          </button>
        )}
        <button type="button" className="history-btn danger" onClick={handleDelete}>
          Delete
        </button>
      </div>
      <FocusScore session={session} onChanged={onChanged} />
    </li>
  )
}

export default function History() {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)

  const refresh = useCallback(async () => {
    setSessions(await listSessions())
  }, [])

  // refresh() only setStates after its await, so this is an async data fetch,
  // not a synchronous cascading render — same pattern as App's auto-load.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { refresh() }, [refresh])

  return (
    <main className="history">
      <h1>Sessions</h1>

      {sessions === null && <p className="history-hint">Loading...</p>}

      {sessions !== null && sessions.length === 0 && (
        <p className="history-hint">No sessions yet. Complete a study session to see it here.</p>
      )}

      {sessions !== null && sessions.length > 0 && (
        <ul className="history-list">
          {sessions.map((s) => (
            <SessionCard key={s.id} session={s} onChanged={refresh} />
          ))}
        </ul>
      )}
    </main>
  )
}
