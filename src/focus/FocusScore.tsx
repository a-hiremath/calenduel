import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { DEFAULT_SESSION_NAME, saveFocus, type SessionMeta } from '../db'
import { dismiss, getJob, startAnalysis, subscribe } from './jobs'
import { summarizeFocus, type FocusChoice, type FocusResult } from './types'
import './FocusScore.css'

export default function FocusScore({ session, onChanged }: {
  session: SessionMeta; onChanged: () => void
}) {
  const [consent, setConsent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  // The job lives in jobs.ts, so it keeps going while this card is unmounted.
  const job = useSyncExternalStore(subscribe, () => getJob(session.id))
  const progress = job?.status === 'running' ? job.progress : null
  const shownError = error ?? (job?.status === 'failed' ? job.error : null)
  // A finished job clears itself; reload so the saved result shows up.
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !job) onChanged()
    wasRunning.current = job?.status === 'running'
  }, [job, onChanged])
  const focus = session.focus?.task === session.task ? session.focus : undefined
  const summary = focus ? summarizeFocus(focus.samples) : null
  const named = session.task.trim() !== '' && session.task !== DEFAULT_SESSION_NAME
  const hasIpad = session.layout?.some(span => span.ipad !== null) ?? false

  function analyze() {
    setError(null)
    dismiss(session.id)
    setConsent(false)
    startAnalysis(session.id, session.task, session.elapsedMs, session.layout)
  }

  async function override(choice: FocusChoice) {
    if (!focus || selected === null) return
    const next: FocusResult = { ...focus, samples: focus.samples.map((s, i) =>
      i === selected ? { ...s, choice } : s) }
    try { await saveFocus(session.id, next); onChanged() }
    catch { setError('The correction could not be saved. Please try again.') }
  }

  if (!session.hasClip) return null
  return (
    <div className="focus-score">
      <details>
        <summary>
          <span aria-hidden="true">⚠</span>{' '}
          {summary?.percent !== null && summary?.percent !== undefined
            ? `${summary.percent}% focus` : focus ? 'Focus unclear' : 'Focus score'}
          <span className="focus-experimental">Experimental</span>
        </summary>
        <p>Estimates visible activity related to “{session.task}”. It can miss paper work or misread your screen{hasIpad ? 's' : ''}.</p>
        {focus && summary && <>
          <p>{summary.coverage}% of sampled time assessed · Clef-flash. Tap an interval to correct it.</p>
          <div className="focus-timeline" aria-label="Sampled focus timeline">
            {focus.samples.map((sample, i) => (
              <button key={sample.atMs} type="button"
                className={`focus-segment ${sample.choice}`}
                style={{ flexGrow: sample.durationMs }}
                aria-label={`${Math.floor(sample.atMs / 60_000)}:${String(Math.floor(sample.atMs / 1000) % 60).padStart(2, '0')}: ${sample.choice.replace('_', ' ')}`}
                aria-pressed={selected === i}
                onClick={() => setSelected(i)} />
            ))}
          </div>
          <p className="focus-legend">Green: on task · muted: off task · amber: unclear</p>
          {selected !== null && <div className="focus-correct">
            <span>{Math.floor(focus.samples[selected].atMs / 60_000)}:{String(Math.floor(focus.samples[selected].atMs / 1000) % 60).padStart(2, '0')}</span>
            {(['on_task', 'off_task', 'unclear'] as const).map(choice =>
              <button type="button" key={choice} onClick={() => override(choice)}
                aria-pressed={focus.samples[selected].choice === choice}>
                {choice.replace('_', ' ')}
              </button>)}
          </div>}
        </>}
        {!named && <p>Name this session above so the checker knows what you were working on.</p>}
        {named && !progress && <>
          {!consent ? <button type="button" className="history-btn" onClick={() => setConsent(true)}>
            {focus ? 'Analyze again' : 'Analyze focus'}
          </button> : <div className="focus-consent">
            <p>This sends sampled screenshots{hasIpad ? ' of your laptop and iPad' : ''} and the session name to Cloudflare for analysis. The webcam area is hidden. Cloudflare lists zero data retention for this model. Results stay on this device.</p>
            <button type="button" className="history-btn" onClick={analyze}>Analyze</button>{' '}
            <button type="button" className="history-btn" onClick={() => setConsent(false)}>Cancel</button>
          </div>}
        </>}
        {progress && <p role="status">{progress} You can switch pages, just keep this tab open.{' '}
          <button type="button" className="history-btn"
            onClick={() => job?.status === 'running' && job.cancel()}>Cancel</button>
        </p>}
        {shownError && <p className="history-error" role="alert">{shownError}</p>}
      </details>
    </div>
  )
}
