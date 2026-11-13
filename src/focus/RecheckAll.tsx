import { useState, useSyncExternalStore } from 'react'
import type { SessionMeta } from '../db'
import { dismissBulk, getBulk, startRecheckAll, subscribe } from './jobs'
import { needsRecheck, needsSecondPass } from './types'
import './FocusScore.css'

// One-time (2026-11-13): delete this file, its line in History.tsx, and
// startRecheckAll, needsSecondPass and recheckFocus once Adi and Zach have
// rechecked their sessions.
//
// Results saved before 2026-11-13 judged each screenshot alone, so program
// output, a debugger or notes often counted as off task. This runs the new
// second pass on all of them at once.
export default function RecheckAll({ sessions }: { sessions: SessionMeta[] }) {
  const [consent, setConsent] = useState(false)
  const bulk = useSyncExternalStore(subscribe, getBulk)
  const pending = sessions.filter(needsSecondPass)
  const intervals = pending.reduce((n, s) => n + (s.focus?.samples.filter(needsRecheck).length ?? 0), 0)
  // About a second per interval: the request plus the pause between requests.
  const minutes = Math.max(1, Math.round(intervals * 1.2 / 60))

  if (!bulk && pending.length === 0) return null
  return (
    <section className="recheck-all" aria-label="Recheck off-task intervals">
      {bulk?.status === 'running' ? <p role="status">
        Rechecking off-task intervals. {bulk.progress} Keep this tab open; you can switch pages.{' '}
        <button type="button" className="history-btn" onClick={bulk.cancel}>Cancel</button>
      </p> : bulk?.status === 'done' ? <p role="status">
        Rechecked {bulk.sessions} session{bulk.sessions === 1 ? '' : 's'}.{' '}
        <button type="button" className="history-btn" onClick={dismissBulk}>OK</button>
      </p> : <>
        {bulk?.status === 'failed' && <p className="history-error" role="alert">
          {bulk.error} {bulk.sessions > 0 && `${bulk.sessions} session${bulk.sessions === 1 ? ' was' : 's were'} rechecked before it stopped.`}
        </p>}
        <p>Focus results from before Nov 13 judged each screenshot alone, so code output, a debugger or notes
          often counted as off task. Recheck the {intervals} off-task interval{intervals === 1 ? '' : 's'} in{' '}
          {pending.length} session{pending.length === 1 ? '' : 's'} against your own on-task work from the same
          session (about {minutes} min). Your corrections stay as they are.</p>
        {!consent ? <button type="button" className="history-btn" onClick={() => setConsent(true)}>
          {bulk?.status === 'failed' ? 'Try again' : 'Recheck off-task intervals'}
        </button> : <div className="focus-consent">
          <p>This sends each off-task screenshot, beside one of your on-task ones from the same session, and the
            session name to Cloudflare. The webcam area is hidden. Results stay on this device.</p>
          <button type="button" className="history-btn"
            onClick={() => { setConsent(false); dismissBulk(); startRecheckAll(sessions) }}>Recheck</button>{' '}
          <button type="button" className="history-btn" onClick={() => setConsent(false)}>Cancel</button>
        </div>}
      </>}
    </section>
  )
}
