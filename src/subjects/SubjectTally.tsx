import { useCallback, useEffect, useState } from 'react'
import { listSessions, type SessionMeta } from '../db'
import { formatStudyTime, localDay } from '../compete/stats'
import {
  SUBJECTS_CHANGED,
  applySubjectEdits,
  autoSortEnabled,
  noteSubjectEdit,
  notifySubjects,
  savedSubjects,
  setAutoSort,
  sortSessions,
  writeSavedSubjects,
  type SavedSubject,
  type SortReport,
} from './sort'
import {
  ABOUT_MAX,
  PERIODS,
  SUBJECT_MAX,
  canonicalSubject,
  cleanSubject,
  knownSubjects,
  periodStartDay,
  removeUpdates,
  renameUpdates,
  resortUpdates,
  subjectKey,
  subjectTotals,
  type Period,
} from './subjects'
import './Subjects.css'

const PERIOD_KEY = 'calenduel.subjectPeriod'

function readPeriod(): Period {
  try {
    const p = localStorage.getItem(PERIOD_KEY)
    if (p === 'week' || p === 'month' || p === 'all') return p
  } catch { /* storage blocked */ }
  return 'month'
}

function Status({ report, auto, onTurnOn, onTurnOff }: {
  report: SortReport | null
  auto: boolean
  onTurnOn: () => void
  onTurnOff: () => void
}) {
  const [asking, setAsking] = useState(false)
  if (!auto) {
    return asking ? (
      <div className="subject-consent">
        <p>
          This sends your session names to Cloudflare, signed in as you, along
          with your subjects, what you said they cover, and a few sessions you
          already sorted as examples. Gemma picks a subject for each session.
          No screenshots or times are sent, and nothing is stored there. The
          subjects stay on this device.
        </p>
        <button type="button" className="history-btn" onClick={onTurnOn}>Turn on</button>{' '}
        <button type="button" className="history-btn" onClick={() => setAsking(false)}>Cancel</button>
      </div>
    ) : (
      <p className="account-note">
        {report && report.waiting > 0
          ? `${report.waiting} session${report.waiting === 1 ? '' : 's'} not sorted yet. `
          : ''}
        Set a subject on any session, or{' '}
        <button type="button" className="subject-link" onClick={() => setAsking(true)}>
          sort sessions automatically
        </button>
        .
      </p>
    )
  }
  let line = 'Sorted automatically from session names. Change any one on Sessions.'
  if (report?.problem === 'signed-out') line = 'Sign in on Compete to sort sessions automatically.'
  else if (report?.problem === 'limited') line = 'Sorting paused for a minute. It picks up again next visit.'
  else if (report?.problem === 'failed') line = "Couldn't sort some sessions just now. It tries again next visit."
  else if (report === null) line = 'Sorting…'
  return (
    <p className="account-note">
      {line}{' '}
      <button type="button" className="subject-link" onClick={onTurnOff}>Turn off</button>
    </p>
  )
}

function EditSubjects({ subjects, saved, auto, onSorted }: {
  subjects: string[]
  saved: SavedSubject[]
  auto: boolean
  onSorted: () => void
}) {
  const [adding, setAdding] = useState('')
  const [addingAbout, setAddingAbout] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const aboutOf = (name: string) =>
    saved.find((s) => subjectKey(s.name) === subjectKey(name))?.about ?? ''

  async function rename(from: string, typed: string) {
    const clean = cleanSubject(typed)
    if (!clean || clean === from) return
    const others = subjects.filter((s) => s !== from)
    const to = canonicalSubject(clean, others)
    const merging = others.some((s) => subjectKey(s) === subjectKey(to))
    // The merged subject keeps its own description, or takes this one's.
    const about = (merging && aboutOf(to)) || aboutOf(from)
    writeSavedSubjects(dedupe([
      ...savedSubjects().filter((s) => ![from, to].some((n) => subjectKey(n) === subjectKey(s.name))),
      { name: to, about },
    ]))
    noteSubjectEdit()
    // Fresh, not the page's copy: a sort may have filed more sessions since.
    await applySubjectEdits(renameUpdates(await listSessions(), from, to))
    notifySubjects()
    setNote(merging ? `Merged “${from}” into “${to}”.` : null)
  }

  function describe(name: string, typed: string) {
    const about = typed.replace(/\s+/g, ' ').trim().slice(0, ABOUT_MAX)
    if (about === aboutOf(name)) return
    const list = savedSubjects()
    const i = list.findIndex((s) => subjectKey(s.name) === subjectKey(name))
    if (i >= 0) list[i] = { ...list[i], about }
    else list.push({ name, about })
    writeSavedSubjects(list)
    notifySubjects()
    setNote('Saved. New sessions use it; Sort again to re-sort past ones.')
  }

  async function remove(name: string) {
    writeSavedSubjects(savedSubjects().filter((s) => subjectKey(s.name) !== subjectKey(name)))
    noteSubjectEdit()
    await applySubjectEdits(removeUpdates(await listSessions(), name))
    notifySubjects()
    setNote(`Removed “${name}”. Its sessions are unsorted.`)
  }

  function add() {
    const clean = cleanSubject(adding)
    if (!clean) return
    const name = canonicalSubject(clean, subjects)
    if (subjects.includes(name)) {
      setNote(`You already have “${name}”.`)
    } else {
      const about = addingAbout.replace(/\s+/g, ' ').trim().slice(0, ABOUT_MAX)
      writeSavedSubjects(dedupe([...savedSubjects(), { name, about }]))
      setNote(null)
      notifySubjects()
      onSorted()
    }
    setAdding('')
    setAddingAbout('')
  }

  async function resort() {
    await applySubjectEdits(resortUpdates(await listSessions(), auto))
    setNote(auto
      ? 'Sorting again. Subjects you set yourself stay.'
      : 'Matched again on this device. Automatic picks stay until you turn sorting on.')
    onSorted()
  }

  return (
    <details className="subject-edit">
      <summary>Edit subjects</summary>
      <p className="account-note">
        Say what each course covers, so the sorter can tell your courses apart
        (a code like “MATH 1D” means nothing to it). Rename one onto another to
        merge them.
      </p>
      <ul className="subject-edit-list">
        {subjects.map((s) => (
          <li key={`${s}:${aboutOf(s)}`}>
            <input
              className="subject-input subject-name-input"
              aria-label={`Rename ${s}`}
              defaultValue={s}
              maxLength={SUBJECT_MAX}
              onBlur={(e) => {
                void rename(s, e.target.value)
                e.target.value = s
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
            <input
              className="subject-input subject-about-input"
              aria-label={`What ${s} covers`}
              placeholder="What it covers"
              defaultValue={aboutOf(s)}
              maxLength={ABOUT_MAX}
              onBlur={(e) => describe(s, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
            />
            <button type="button" className="history-btn danger" onClick={() => void remove(s)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <form
        className="subject-add"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <input
          className="subject-input subject-name-input"
          aria-label="New subject"
          placeholder="New subject"
          maxLength={SUBJECT_MAX}
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
        />
        <input
          className="subject-input subject-about-input"
          aria-label="What the new subject covers"
          placeholder="What it covers"
          maxLength={ABOUT_MAX}
          value={addingAbout}
          onChange={(e) => setAddingAbout(e.target.value)}
        />
        <button type="submit" className="history-btn">Add</button>
      </form>
      <p className="subject-resort">
        <button type="button" className="history-btn" onClick={() => void resort()}>
          Sort again
        </button>{' '}
        <span className="account-note">
          {auto
            ? "Re-sorts every session you haven't set yourself."
            : 'Re-matches sessions by name on this device.'}
        </span>
      </p>
      {note && <p className="account-note" role="status">{note}</p>}
    </details>
  )
}

function dedupe(list: SavedSubject[]): SavedSubject[] {
  const seen = new Set<string>()
  return list.filter((s) => {
    const key = subjectKey(s.name)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Where your study time goes, by subject, over a period you pick.
export default function SubjectTally() {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  const [period, setPeriod] = useState<Period>(readPeriod)
  const [auto, setAuto] = useState(autoSortEnabled)
  const [report, setReport] = useState<SortReport | null>(null)
  const [saved, setSaved] = useState(savedSubjects)
  // Fixed for the visit, like Stats.
  const [today] = useState(() => localDay(Date.now()))

  const sort = useCallback(() => {
    setReport(null)
    void sortSessions().then(setReport)
  }, [])

  useEffect(() => {
    let closed = false
    const refresh = () => {
      setSaved(savedSubjects())
      void listSessions().then((list) => {
        if (!closed) setSessions(list)
      })
    }
    refresh()
    window.addEventListener(SUBJECTS_CHANGED, refresh)
    return () => {
      closed = true
      window.removeEventListener(SUBJECTS_CHANGED, refresh)
    }
  }, [])

  // Sort on arrival. sortSessions only does work when something needs it.
  useEffect(() => {
    let closed = false
    void sortSessions().then((r) => {
      if (!closed) setReport(r)
    })
    return () => {
      closed = true
    }
  }, [])

  if (!sessions) return <p className="account-note">Loading...</p>

  const subjects = knownSubjects(sessions, saved.map((s) => s.name))
  const totals = subjectTotals(sessions, periodStartDay(period, today))
  const sum = totals.reduce((n, t) => n + t.ms, 0)
  const max = Math.max(0, ...totals.map((t) => t.ms))

  return (
    <>
      <div className="subject-periods" role="group" aria-label="Period">
        {PERIODS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={period === p.id}
            onClick={() => {
              setPeriod(p.id)
              try { localStorage.setItem(PERIOD_KEY, p.id) } catch { /* storage blocked */ }
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {totals.length === 0 ? (
        <p className="account-note">No study time in this period.</p>
      ) : (
        <ul className="subject-bars">
          {totals.map((t) => (
            <li key={t.name ?? ''} className={t.name === null ? 'unsorted' : undefined}>
              <div className="subject-row">
                <span className="subject-name">{t.name ?? 'Unsorted'}</span>
                <span className="subject-time">
                  {formatStudyTime(t.ms)}
                  <span className="subject-share">{Math.round((t.ms / sum) * 100)}%</span>
                </span>
              </div>
              <div
                className="subject-bar"
                role="img"
                aria-label={`${t.name ?? 'Unsorted'}: ${formatStudyTime(t.ms)} over ${t.sessions} session${t.sessions === 1 ? '' : 's'}`}
              >
                <span style={{ width: `${(t.ms / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <Status
        report={report}
        auto={auto}
        onTurnOn={() => {
          setAutoSort(true)
          setAuto(true)
          sort()
        }}
        onTurnOff={() => {
          setAutoSort(false)
          setAuto(false)
          sort()
        }}
      />

      <EditSubjects subjects={subjects} saved={saved} auto={auto} onSorted={sort} />
    </>
  )
}
