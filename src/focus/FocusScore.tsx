import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { DEFAULT_SESSION_NAME, saveFocus, type SessionMeta } from '../db'
import { dismiss, getJob, startAnalysis, subscribe } from './jobs'
import {
  clockOf, firstPass, matchedAnchor, needsRecheck, smoothedChoices, summarizeFocus,
  type FocusChoice, type FocusResult,
} from './types'
import FramePreview from './FramePreview'
import './FocusScore.css'

const label = (choice: FocusChoice) => choice.replace('_', ' ')

// The card whose timeline was used last. Arrow keys step through its intervals
// only, so two open cards don't both move.
let activeCard: string | null = null

export default function FocusScore({ session, onChanged }: {
  session: SessionMeta; onChanged: () => void
}) {
  const [consent, setConsent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
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
  const counted = focus ? smoothedChoices(focus.samples) : []
  // Intervals the second pass matched to on-task work, and the estimate without them.
  const matched = focus ? focus.samples.filter(matchedAnchor).length : 0
  const withoutRecheck = focus && matched > 0 ? summarizeFocus(firstPass(focus.samples)).percent : null
  const unrechecked = focus ? focus.samples.some(needsRecheck) : false
  const sampleCount = focus?.samples.length ?? 0
  const named = session.task.trim() !== '' && session.task !== DEFAULT_SESSION_NAME
  const hasIpad = session.layout?.some(span => span.ipad !== null) ?? false

  // Left and right arrows step to the previous or next interval once one is
  // selected, unless you are typing somewhere.
  useEffect(() => {
    if (selected === null || sampleCount === 0) return
    const current = selected
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (activeCard !== session.id || !detailsRef.current?.open) return
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return
      const target = e.target as HTMLElement | null
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      const next = Math.min(sampleCount - 1, Math.max(0, current + (e.key === 'ArrowRight' ? 1 : -1)))
      e.preventDefault()
      if (next === current) return
      setSelected(next)
      const segment = timelineRef.current?.children[next]
      if (segment instanceof HTMLElement) segment.focus({ preventScroll: true })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, sampleCount, session.id])

  function analyze() {
    setError(null)
    dismiss(session.id)
    setConsent(false)
    startAnalysis(session.id, session.task, session.elapsedMs, session.layout)
  }

  async function override(choice: FocusChoice) {
    if (!focus || selected === null) return
    const next: FocusResult = { ...focus, samples: focus.samples.map((s, i) =>
      i === selected ? { ...s, choice, corrected: true } : s) }
    try { await saveFocus(session.id, next); onChanged() }
    catch { setError('The correction could not be saved. Please try again.') }
  }

  if (!session.hasClip) return null
  return (
    <div className="focus-score">
      <details ref={detailsRef}>
        <summary>
          <span aria-hidden="true">⚠</span>{' '}
          {summary?.percent !== null && summary?.percent !== undefined
            ? `${summary.percent}% focus` : focus ? 'Focus unclear' : 'Focus score'}
          <span className="focus-experimental">Experimental</span>
        </summary>
        <p>Estimates visible activity related to “{session.task}”. It can miss paper work or misread your screen{hasIpad ? 's' : ''}.</p>
        {focus && summary && <>
          <p>{summary.coverage}% of sampled time assessed · Clef-flash.
            {summary.smoothed > 0 && ` ${summary.smoothed} one-sample blip${summary.smoothed === 1 ? '' : 's'} smoothed (${summary.rawPercent}% without smoothing).`}
            {matched > 0 && ` ${matched} interval${matched === 1 ? '' : 's'} first called off task matched your on-task work in this session, so ${matched === 1 ? 'it counts' : 'they count'} as on task (${withoutRecheck}% without this recheck).`}
            {focus.anchors?.atMs.length === 0 && unrechecked && ' Off-task intervals were not rechecked: no interval was confidently on task to compare them with.'}
            {!focus.anchors && unrechecked && ' Analyzed before off-task intervals were rechecked against your on-task work; analyze again to recheck them.'}
            {' '}Tap an interval to see what it judged and correct it; arrow keys step between intervals.</p>
          <div className="focus-timeline" aria-label="Sampled focus timeline" ref={timelineRef}>
            {focus.samples.map((sample, i) => (
              <button key={sample.atMs} type="button"
                className={`focus-segment ${counted[i]}${counted[i] !== sample.choice ? ' smoothed' : ''}${matchedAnchor(sample) && counted[i] === 'on_task' ? ' matched' : ''}`}
                style={{ flexGrow: sample.durationMs }}
                aria-label={`${clockOf(sample.atMs)}: ${label(counted[i])}${counted[i] !== sample.choice ? ' (smoothed)' : ''}${matchedAnchor(sample) && sample.anchor ? ` (matched your work at ${clockOf(sample.anchor.atMs)})` : ''}`}
                aria-pressed={selected === i}
                onClick={() => { activeCard = session.id; setSelected(i) }} />
            ))}
          </div>
          <p className="focus-legend">Green: on task · muted: off task · amber: unclear · striped: a one-sample blip counted as its neighbours{matched > 0 && ' · dotted: first called off task, then matched your on-task work'}</p>
          {selected !== null && <div className="focus-correct">
            <span>{clockOf(focus.samples[selected].atMs)}</span>
            {(['on_task', 'off_task', 'unclear'] as const).map(choice =>
              <button type="button" key={choice} onClick={() => override(choice)}
                aria-pressed={counted[selected] === choice}>
                {label(choice)}
              </button>)}
          </div>}
          {selected !== null && <FramePreview session={session} sample={focus.samples[selected]}
            counted={counted[selected]} />}
        </>}
        {!named && <p>Name this session above so the checker knows what you were working on.</p>}
        {named && !progress && <>
          {!consent ? <button type="button" className="history-btn" onClick={() => setConsent(true)}>
            {focus ? 'Analyze again' : 'Analyze focus'}
          </button> : <div className="focus-consent">
            <p>This sends sampled screenshots{hasIpad ? ' of your laptop and iPad' : ''} and the session name to Cloudflare for analysis. Screenshots it calls off task are sent again beside one of your on-task ones for a second look. The webcam area is hidden. Cloudflare lists zero data retention for this model. Results stay on this device.</p>
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
