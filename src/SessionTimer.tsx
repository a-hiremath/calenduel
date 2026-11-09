import { useEffect, useRef, useState } from 'react'
import Stopwatch from './Stopwatch'
import { useTimelapseRecorder } from './session/useTimelapseRecorder'
import { downloadBlob, timelapseName } from './media/share'
import { saveSession } from './db'
import './SessionTimer.css'

type Status = 'idle' | 'starting' | 'running' | 'encoding' | 'done'

// Pure stopwatch: no goal, so every session gets the same label.
const TASK = 'Study session'

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

  // One click does everything: screen picker, camera, recording, stopwatch.
  // (getDisplayMedia needs this click's user gesture — it can't run on load.)
  async function handleStart() {
    setError(null)
    setStatus('starting')
    try {
      await begin()
      setStartedAt(Date.now())
      setStatus('running')
    } catch {
      setError('Screen and camera access are needed to record your session.')
      setStatus('idle')
    }
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
    const meta = { startedAt, task: TASK, goalMs: 0, elapsedMs: stopAt - startedAt }
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
    if (saved) onSessionSaved?.()
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
    stoppingRef.current = false
    setStatus('idle')
  }

  function handleDownload() {
    if (clip) downloadBlob(clip, timelapseName(clip, TASK))
  }

  return (
    // Switch to the camera layout only once the feed is live. Keying it to
    // inProgress would flip it during 'starting', while the permission
    // prompts are still up, leaving the stopwatch stranded in the bar's left
    // slot with no camera above it.
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

      <Stopwatch startedAt={startedAt} stoppedAt={stoppedAt} />

      <div className="session-actions">
        {status === 'idle' && (
          <button type="button" className="session-start" onClick={handleStart}>
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

      {error && <p className="error">{error}</p>}
    </section>
  )
}
