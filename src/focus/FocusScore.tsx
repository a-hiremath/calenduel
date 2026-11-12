import { useEffect, useRef, useState } from 'react'
import { DEFAULT_SESSION_NAME, getClip, saveFocus, type SessionMeta } from '../db'
import { analyzeFocus } from './analyze'
import { summarizeFocus, type FocusChoice, type FocusResult } from './types'
import './FocusScore.css'

export default function FocusScore({ session, onChanged }: {
  session: SessionMeta; onChanged: () => void
}) {
  const [consent, setConsent] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const focus = session.focus?.task === session.task ? session.focus : undefined
  const summary = focus ? summarizeFocus(focus.samples) : null
  const named = session.task.trim() !== '' && session.task !== DEFAULT_SESSION_NAME
  const hasIpad = session.layout?.some(span => span.ipad !== null) ?? false

  async function analyze() {
    setError(null)
    const abort = new AbortController()
    controller.current = abort
    setProgress('Reading recording…')
    try {
      const clip = await getClip(session.id)
      if (!clip) throw new Error('This session has no recording to analyze.')
      const result = await analyzeFocus(clip, session.task, session.elapsedMs,
        (done, total) => setProgress(`Analyzing ${done}/${total}…`), abort.signal,
        session.layout)
      abort.signal.throwIfAborted()
      await saveFocus(session.id, result)
      onChanged()
      setConsent(false)
    } catch (e) {
      if (!abort.signal.aborted) setError(e instanceof Error ? e.message : 'Analysis failed.')
    } finally {
      setProgress(null)
      controller.current = null
    }
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
        {progress && <p role="status">{progress}{' '}
          <button type="button" className="history-btn" onClick={() => controller.current?.abort()}>Cancel</button>
        </p>}
        {error && <p className="history-error" role="alert">{error}</p>}
      </details>
    </div>
  )
}
