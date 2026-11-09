import { useEffect, useRef, useState } from 'react'
import Stopwatch from './Stopwatch'
import { useTimelapseRecorder } from './session/useTimelapseRecorder'
import { downloadBlob, timelapseName } from './media/share'
import { DEFAULT_SESSION_NAME, SESSION_NAME_MAX, saveSession } from './db'
import { formatStudyTime } from './compete/stats'
import {
  clearActive,
  HEARTBEAT_MS,
  interruptedSession,
  tabId,
  writeActive,
  type ActiveSession,
} from './session/activeSession'
import './SessionTimer.css'

type Status = 'idle' | 'starting' | 'running' | 'encoding' | 'done'

// Resuming carries on the same session, gap included, so it's only offered
// soon after it stopped: a refresh, not a laptop closed overnight.
const RESUME_WINDOW_MS = 10 * 60_000

// Error names like QuotaExceededError are the useful part when someone sends a
// screenshot of a failure.
function describe(e: unknown): string {
  if (e instanceof Error) return e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message
  return String(e)
}

export default function SessionTimer({
  onActiveChange,
  onSessionSaved,
}: {
  onActiveChange: (active: boolean) => void
  onSessionSaved?: () => void
}) {
  const [status, setStatus] = useState<Status>('idle')
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [stoppedAt, setStoppedAt] = useState<number | null>(null)
  const [clip, setClip] = useState<Blob | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Optional, and never required to start: Start stays one click. It can be
  // typed before or during the session, and is fixed once Stop is pressed
  // (after that, rename it on the Sessions page).
  const [name, setName] = useState('')
  const task = name.trim() || DEFAULT_SESSION_NAME
  // A session cut off by a refresh or a closed tab, read once on load.
  const [interrupted, setInterrupted] = useState<ActiveSession | null>(() =>
    interruptedSession(Date.now()),
  )
  const [notice, setNotice] = useState<string | null>(null)

  // Destructured into locals: the refs lint rule can't classify properties read
  // off the returned object, but a bare ref passed to a ref prop is fine.
  // onInterrupted = stop the session if the browser's "Stop sharing" is hit.
  const { faceVideoRef, streaming, begin, end } =
    useTimelapseRecorder(() => handleStop())
  // Guards the stop path against firing twice (Stop button + screen-share end).
  const stoppingRef = useRef(false)

  // A session is "in progress" from the moment Start is pressed through saving.
  // The parent uses this to hide the nav for a distraction-free screen.
  const inProgress =
    status === 'starting' || status === 'running' || status === 'encoding'

  // Lift that state to the parent. onActiveChange is a stable setState fn, so
  // this fires only when inProgress actually flips.
  useEffect(() => {
    onActiveChange(inProgress)
  }, [inProgress, onActiveChange])

  // While running, keep a record that outlives the page, refreshed on a
  // heartbeat and once more as the page goes away.
  useEffect(() => {
    if (status !== 'running' || startedAt === null) return
    const beat = () =>
      writeActive({ startedAt, name: task, lastSeen: Date.now(), tabId: tabId() })
    beat()
    const timer = setInterval(beat, HEARTBEAT_MS)
    window.addEventListener('pagehide', beat)
    return () => {
      clearInterval(timer)
      window.removeEventListener('pagehide', beat)
    }
  }, [status, startedAt, task])

  // Ask before a refresh or close throws away a session in progress.
  useEffect(() => {
    if (!inProgress) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [inProgress])

  // One click does everything: screen picker, camera, recording, stopwatch.
  // (getDisplayMedia needs this click's user gesture — it can't run on load.)
  // resumeFrom carries on an interrupted session from its original start.
  async function handleStart(resumeFrom?: number) {
    setError(null)
    setNotice(null)
    setStatus('starting')
    try {
      await begin()
      setStartedAt(resumeFrom ?? Date.now())
      setInterrupted(null)
      setStatus('running')
    } catch {
      setError('Screen and camera access are needed to record your session.')
      setStatus('idle')
    }
  }

  function handleResume() {
    if (!interrupted) return
    setName(interrupted.name === DEFAULT_SESSION_NAME ? '' : interrupted.name)
    void handleStart(interrupted.startedAt)
  }

  // Keeps the time up to the last heartbeat, without a clip.
  async function handleSaveInterrupted() {
    if (!interrupted) return
    const elapsedMs = interrupted.lastSeen - interrupted.startedAt
    try {
      await saveSession(
        { startedAt: interrupted.startedAt, task: interrupted.name, goalMs: 0, elapsedMs },
        null,
      )
    } catch {
      setError("This session couldn't be saved on this device.")
      return
    }
    clearActive()
    setInterrupted(null)
    setNotice(`Saved ${formatStudyTime(elapsedMs)}.`)
    onSessionSaved?.()
  }

  function handleDiscardInterrupted() {
    clearActive()
    setInterrupted(null)
  }

  async function handleStop() {
    if (stoppingRef.current || startedAt === null) return // ignore a double-fire
    stoppingRef.current = true
    const stopAt = Date.now()
    setStoppedAt(stopAt) // freezes the stopwatch on the final time
    setStatus('encoding')
    // Every step below is allowed to fail, but none may leave Stop hanging:
    // the study time is what matters most, the clip comes second.
    let { clip: recorded, problem } = await end().catch((e: unknown) => ({
      clip: null,
      problem: `Recording failed: ${describe(e)}`,
    }))
    const meta = { startedAt, task, goalMs: 0, elapsedMs: stopAt - startedAt }
    let saved = false
    try {
      await saveSession(meta, recorded && recorded.size > 0 ? recorded : null)
      saved = true
    } catch (e) {
      console.error('saving session with clip failed', e)
      if (recorded && recorded.size > 0) {
        problem = `The browser wouldn't store the video (${describe(e)}).`
        recorded = null
        try {
          await saveSession(meta, null)
          saved = true
        } catch (retryError) {
          console.error('saving session failed', retryError)
        }
      }
    }

    const validClip = saved && recorded && recorded.size > 0 ? recorded : null
    if (saved) {
      clearActive()
      onSessionSaved?.()
    }
    setClip(validClip)
    if (!saved) {
      setError("This session couldn't be saved on this device.")
    } else if (!validClip) {
      // The time still counts; say why there's no video rather than leave it out.
      setError(`Your session was saved without a timelapse. ${problem ?? ''}`.trim())
    }
    setStatus('done')
  }

  function handleNewSession() {
    setStartedAt(null)
    setStoppedAt(null)
    setClip(null)
    setError(null)
    setName('')
    stoppingRef.current = false
    setStatus('idle')
  }

  function handleDownload() {
    if (clip) downloadBlob(clip, timelapseName(clip, task))
  }

  return (
    // Switch to the focus layout only once the feed is live. Keying it to
    // inProgress would flip it during 'starting', while the permission
    // prompts are still up, sizing things for a camera that isn't there yet.
    <section className="session" data-focus={streaming}>
      {/* Camera-only preview. The screen is recorded but never shown — a live
          preview of your own screen reflects itself forever. Shown whenever
          the feeds are live (running + encoding). */}
      {streaming && (
        <div className="session-stage">
          <video
            ref={faceVideoRef}
            className="session-face"
            autoPlay
            playsInline
            muted
          />
        </div>
      )}

      <div className="session-clock">
        <input
          className="session-name"
          aria-label="Session name"
          placeholder={status === 'idle' ? 'Name this session' : DEFAULT_SESSION_NAME}
          maxLength={SESSION_NAME_MAX}
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          readOnly={status === 'encoding' || status === 'done'}
        />
        <Stopwatch startedAt={startedAt} stoppedAt={stoppedAt} />
      </div>

      <div className="session-actions">
        {status === 'idle' && (
          <button type="button" className="session-start" onClick={() => handleStart()}>
            Start
          </button>
        )}

        {status === 'starting' && (
          <button type="button" className="session-start" disabled>
            Starting…
          </button>
        )}

        {status === 'running' && (
          <button type="button" className="session-stop" onClick={handleStop}>
            Stop
          </button>
        )}

        {status === 'encoding' && (
          <button type="button" className="session-stop" disabled>
            Saving…
          </button>
        )}

        {status === 'done' && (
          <>
            {clip && clip.size > 0 && (
              <button
                type="button"
                className="session-start"
                onClick={handleDownload}
              >
                Download
              </button>
            )}
            <button
              type="button"
              className="session-stop"
              onClick={handleNewSession}
            >
              New session
            </button>
          </>
        )}
      </div>

      {status === 'idle' && interrupted && (
        <div className="session-recover" role="status">
          <p>
            “{interrupted.name}” was cut off after{' '}
            {formatStudyTime(interrupted.lastSeen - interrupted.startedAt)}. Its
            timelapse couldn't be kept.
          </p>
          <div className="session-recover-actions">
            {Date.now() - interrupted.lastSeen < RESUME_WINDOW_MS && (
              <button type="button" className="session-stop" onClick={handleResume}>
                Resume
              </button>
            )}
            <button type="button" className="session-stop" onClick={handleSaveInterrupted}>
              Save the time
            </button>
            <button type="button" className="session-link" onClick={handleDiscardInterrupted}>
              Discard
            </button>
          </div>
        </div>
      )}

      {notice && <p className="session-notice" role="status">{notice}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  )
}
