import { useEffect, useState } from 'react'
import { getClip, type SessionMeta } from '../db'
import { drawSample } from './frames'
import { clockOf, type FocusChoice, type FocusSample } from './types'

type Drawn =
  | { key: string; screen: string; ipad: string | null }
  | { key: string; error: string }

const label = (choice: string) => choice.replace('_', ' ')

// Wait this long after a selection before drawing, so holding an arrow key
// doesn't open the recording for every interval it passes.
const SETTLE_MS = 120

// What the model judged for one sample: the same images it was sent, drawn
// again from the recording on this device, and what it said about them.
// `counted` is the label the score uses, after smoothing.
export default function FramePreview({ session, sample, counted }: {
  session: SessionMeta; sample: FocusSample; counted: FocusChoice
}) {
  const key = `${session.id}@${sample.atMs}`
  const [drawn, setDrawn] = useState<Drawn | null>(null)
  const [large, setLarge] = useState(false)

  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      getClip(session.id)
        .then((clip) => {
          if (!clip) throw new Error('This session has no recording to show.')
          if (!live) return null
          return drawSample(clip, session.layout ?? [], session.elapsedMs, sample.atMs)
        })
        .then(
          (images) => { if (live && images) setDrawn({ key, ...images }) },
          (e) => { if (live) setDrawn({ key, error: e instanceof Error ? e.message : 'This frame could not be drawn.' }) },
        )
    }, SETTLE_MS)
    return () => { live = false; clearTimeout(timer) }
  }, [key, session.id, session.layout, session.elapsedMs, sample.atMs])

  // Taps on other intervals keep showing the last frame until the new one is drawn.
  const current = drawn?.key === key ? drawn : null
  const sure = sample.probabilities?.[sample.originalChoice]
  const decidedBy = sample.ipad ? sample.source : 'laptop'

  return (
    <figure className="focus-frame">
      <figcaption>
        At {clockOf(sample.atMs)}, Clef said <strong>{label(sample.originalChoice)}</strong>
        {sure !== undefined && ` (${Math.round(sure * 100)}% sure)`}.
        {sample.choice !== sample.originalChoice && ` You changed it to ${label(sample.choice)}.`}
        {counted !== sample.choice && ` It counts as ${label(counted)}: a single sample between longer stretches of ${label(counted)} is treated as a blip. Pick ${label(sample.choice)} below to keep it.`}
        {sample.ipad && (sample.source === 'ipad' ? ' The iPad decided.'
          : sample.source === 'laptop' ? ' The laptop decided: the iPad only decides when it changed since the last sample and shows something readable.'
            : ' This result is older than the record of which screen decided.')}
      </figcaption>
      {!current && <p role="status">Drawing the frame…</p>}
      {current && 'error' in current && <p className="history-error" role="alert">{current.error}</p>}
      {current && 'screen' in current && (
        <button type="button" className="focus-frame-images" aria-pressed={large}
          aria-label={large ? 'Show the frame smaller' : 'Show the frame larger'}
          onClick={() => setLarge((l) => !l)}>
          <span className={`focus-frame-pane${decidedBy === 'laptop' && current.ipad ? ' decided' : ''}`}>
            <img src={current.screen} alt={`Computer screen at ${clockOf(sample.atMs)}, as sent to the focus checker`} />
            {current.ipad && <span className="focus-frame-label">Laptop{decidedBy === 'laptop' ? ' · decided' : ''}</span>}
          </span>
          {current.ipad && (
            <span className={`focus-frame-pane${decidedBy === 'ipad' ? ' decided' : ''}`}>
              <img src={current.ipad} alt={`iPad screen at ${clockOf(sample.atMs)}, as sent to the focus checker`} />
              <span className="focus-frame-label">iPad{decidedBy === 'ipad' ? ' · decided' : ''}</span>
            </span>
          )}
        </button>
      )}
      <p className="focus-frame-note">Black areas hide your webcam. Tap the frame to {large ? 'shrink' : 'enlarge'} it.</p>
    </figure>
  )
}
