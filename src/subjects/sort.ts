// Sorts unsorted sessions into subjects: locally where the answer is already
// clear, then (if you turned it on) with the subject sorter on the worker, a
// batch of names at a time. Results are written to this device only.

import { listSessions, setSubjects, type SessionMeta } from '../db'
import { FOCUS_ENDPOINT } from '../focus/endpoint'
import {
  ABOUT_MAX,
  BATCH_TITLES,
  MAX_SENT_SUBJECTS,
  canonicalSubject,
  cleanSubject,
  knownSubjects,
  localSubject,
  needsSorting,
  subjectExamples,
  subjectKey,
  type SubjectTag,
  type SubjectUpdate,
} from './subjects'

const SAVED = 'calenduel.subjects'
const AUTO = 'calenduel.autoSubjects'
// Fired on window whenever subjects change, so open pages can refresh.
export const SUBJECTS_CHANGED = 'calenduel:subjects'
// At most this many model calls per run (25 names each). Anything left waits
// for the next run: the next visit to Account or Sessions, or the next save.
const MAX_BATCHES = 8

// A subject you added or described yourself. `about` says what it covers
// ("linear algebra"): a course code alone tells the sorter nothing.
export interface SavedSubject {
  name: string
  about: string
}

// Subjects you added or described, kept even before any session uses them.
export function savedSubjects(): SavedSubject[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(SAVED) ?? '[]')
    if (!Array.isArray(list)) return []
    return list.flatMap((x): SavedSubject[] => {
      if (typeof x === 'string') return [{ name: x, about: '' }]
      if (x && typeof x.name === 'string') {
        return [{ name: x.name, about: typeof x.about === 'string' ? x.about : '' }]
      }
      return []
    })
  } catch {
    return []
  }
}

export function savedNames(): string[] {
  return savedSubjects().map((s) => s.name)
}

export function writeSavedSubjects(list: SavedSubject[]): void {
  try {
    localStorage.setItem(SAVED, JSON.stringify(list))
  } catch {
    // Storage blocked: the list just isn't remembered.
  }
}

// Whether you agreed to send session names to the sorter. Off by default.
export function autoSortEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO) === '1'
  } catch {
    return false
  }
}

export function setAutoSort(on: boolean): void {
  try {
    if (on) localStorage.setItem(AUTO, '1')
    else localStorage.removeItem(AUTO)
  } catch {
    // Storage blocked: stays off.
  }
}

export function notifySubjects(): void {
  window.dispatchEvent(new Event(SUBJECTS_CHANGED))
}

export interface SortReport {
  // Sorted on this device, from earlier sessions and your subjects' names.
  matched: number
  // Sorted by the model.
  sorted: number
  // Named sessions still without a subject.
  waiting: number
  // Why sorting stopped short, if it did.
  problem: 'off' | 'signed-out' | 'limited' | 'failed' | null
}

async function sortLocally(sessions: SessionMeta[], saved: string[]): Promise<number> {
  const subjects = knownSubjects(sessions, saved)
  const updates: SubjectUpdate[] = []
  for (const s of sessions) {
    if (!needsSorting(s)) continue
    // A name of only symbols has nothing to sort by.
    const name = subjectKey(s.task) ? localSubject(s.task, sessions, subjects) : null
    if (name === undefined) continue
    updates.push({ id: s.id, subject: { name, for: s.task, by: 'match' } })
  }
  return setSubjects(updates)
}

type Ask = {
  titles: string[]
  subjects: (string | { name: string; about: string })[]
  examples: { title: string; subject: string }[]
}

// The worker refuses bodies over 32 KB. Long descriptions, many subjects or
// non-Latin text could get near that, so drop examples first, then
// descriptions, then subjects, until the request fits.
const MAX_BODY_BYTES = 30_000
function fit(ask: Ask): Ask {
  const size = (a: Ask) => new TextEncoder().encode(JSON.stringify(a)).length
  const out = { ...ask, examples: [...ask.examples], subjects: [...ask.subjects] }
  while (size(out) > MAX_BODY_BYTES && out.examples.length > 0) out.examples.pop()
  if (size(out) > MAX_BODY_BYTES) out.subjects = out.subjects.map((s) => (typeof s === 'string' ? s : s.name))
  while (size(out) > MAX_BODY_BYTES && out.subjects.length > 0) out.subjects.pop()
  return out
}

// One pick per title: a subject, null for "no subject", or undefined when
// the model skipped that title (it stays unsorted and is asked again later).
type Picks = (string | null | undefined)[]

async function askModel(token: string, ask: Ask): Promise<Picks | SortReport['problem']> {
  let response: Response
  try {
    response = await fetch(`${FOCUS_ENDPOINT}/subjects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(fit(ask)),
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    return 'failed'
  }
  if (response.status === 401) return 'signed-out'
  if (response.status === 429) return 'limited'
  if (!response.ok) return 'failed'
  const body = (await response.json().catch(() => null)) as
    { subjects?: unknown; skipped?: unknown } | null
  const picks = body?.subjects
  if (!Array.isArray(picks) || picks.length !== ask.titles.length) return 'failed'
  const skipped = new Set(Array.isArray(body?.skipped) ? body.skipped : [])
  return picks.map((p, i) => {
    if (skipped.has(i)) return undefined
    return typeof p === 'string' && cleanSubject(p) ? cleanSubject(p) : null
  })
}

// Bumped by hand edits (rename, merge, remove). A model answer that was asked
// for before an edit is dropped: it could bring back a subject you just
// renamed or removed.
let editGeneration = 0
export function noteSubjectEdit(): void {
  editGeneration += 1
}

async function sortOnce(): Promise<SortReport> {
  let sessions = await listSessions()
  let matched = 0
  let sorted = 0
  let problem: SortReport['problem'] = null
  const report = (stop: SortReport['problem']): SortReport => ({
    matched, sorted, waiting: sessions.filter(needsSorting).length, problem: stop ?? problem,
  })
  // Titles this run already asked about without an answer (skipped, or in a
  // failed batch): left for the next run, so one bad title can't stall the rest.
  const unanswered = new Set<string>()

  let token: string | null | undefined
  for (let batch = 0; batch <= MAX_BATCHES; batch++) {
    // Read fresh every round: you may have edited subjects meanwhile.
    const described = savedSubjects()
    const saved = described.map((d) => d.name)
    const found = await sortLocally(sessions, saved)
    if (found > 0) {
      matched += found
      sessions = await listSessions()
      notifySubjects()
    }
    // Newest first: recent sessions matter most if the run stops early.
    const waiting = sessions.filter(needsSorting)
      .filter((s) => !unanswered.has(subjectKey(s.task)))
      .sort((a, b) => b.startedAt - a.startedAt)
    if (waiting.length === 0) return report(null)
    if (!autoSortEnabled()) return report('off')
    if (batch === MAX_BATCHES) return report(null)
    if (token === undefined) {
      try {
        const { focusToken } = await import('../compete/api')
        token = await focusToken()
      } catch {
        token = null
      }
    }
    if (!token) return report('signed-out')

    // One entry per distinct name: "chem hw" five times is one question.
    const titles: string[] = []
    const seen = new Set<string>()
    for (const s of waiting) {
      const key = subjectKey(s.task)
      if (seen.has(key)) continue
      seen.add(key)
      titles.push(s.task.trim())
      if (titles.length === BATCH_TITLES) break
    }
    const subjects = knownSubjects(sessions, saved)
    const generation = editGeneration
    const picks = await askModel(token, {
      titles,
      subjects: subjects.slice(0, MAX_SENT_SUBJECTS).map((name) => {
        const about = described.find((d) => subjectKey(d.name) === subjectKey(name))?.about.trim()
        return about ? { name, about: about.slice(0, ABOUT_MAX) } : name
      }),
      examples: subjectExamples(sessions),
    })
    if (picks === 'signed-out' || picks === 'limited') return report(picks)
    if (!Array.isArray(picks)) {
      // This batch failed; try the rest, and report it if nothing else does.
      problem = 'failed'
      for (const t of titles) unanswered.add(subjectKey(t))
      continue
    }
    if (generation !== editGeneration) {
      // You edited subjects while this batch was out: ask again with the new list.
      sessions = await listSessions()
      continue
    }

    const byKey = new Map(titles.map((t, i) => [subjectKey(t), picks[i]]))
    for (const t of titles) if (byKey.get(subjectKey(t)) === undefined) unanswered.add(subjectKey(t))
    const updates: SubjectUpdate[] = waiting.flatMap((s) => {
      const pick = byKey.get(subjectKey(s.task))
      if (pick === undefined) return []
      const tag: SubjectTag = {
        name: pick === null ? null : canonicalSubject(pick, subjects),
        for: s.task,
        by: 'model',
      }
      return [{ id: s.id, subject: tag }]
    })
    sorted += await setSubjects(updates)
    sessions = await listSessions()
    notifySubjects()
  }
  return report(null)
}

let running: Promise<SortReport> | null = null
let again = false

// Sort whatever needs sorting. Safe to call often: calls during a run share it,
// and the run goes round once more so nothing saved meanwhile is missed.
export function sortSessions(): Promise<SortReport> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    let result: SortReport
    do {
      again = false
      try {
        result = await sortOnce()
      } catch {
        result = { matched: 0, sorted: 0, waiting: 0, problem: 'failed' }
      }
    } while (again)
    // No await between the last check of `again` and this, so a call can't
    // slip in, see a run that is already over, and be dropped.
    running = null
    return result
  })()
  return running
}

// Apply subject edits made by hand (Account's subject list, Sessions' field).
export async function applySubjectEdits(updates: SubjectUpdate[]): Promise<void> {
  if ((await setSubjects(updates)) > 0) notifySubjects()
}
