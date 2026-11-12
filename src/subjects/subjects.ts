// Subjects: which part of your studying each session counts toward, so you can
// see where the time goes. Pure functions like the stats modules: no React, no
// storage, no network, which is what makes them testable.
//
// A session's subject comes from one of three places, in this order:
//   you    — set by hand on the Sessions page. Always wins, and survives renames.
//   match  — found locally: another session with the same name already has a
//            subject, or the name contains a subject's name ("cs10 lab" → CS 10).
//   model  — picked by the subject sorter on the worker, from the name alone.
// A guess (match or model) holds only for the name it was made for, so renaming
// a session sends it back to be sorted again.

import { addDays, localDay } from '../compete/stats'
import { DEFAULT_SESSION_NAME, type SessionMeta } from '../db'

export type SubjectSource = 'you' | 'match' | 'model'

export interface SubjectTag {
  // null: deliberately no subject (too vague to place, or you cleared it).
  name: string | null
  // The session name this was decided for.
  for: string
  by: SubjectSource
}

export const SUBJECT_MAX = 40
export const ABOUT_MAX = 80
// Matches the worker's limits (worker/src/subjects.js).
export const BATCH_TITLES = 25
export const MAX_SENT_SUBJECTS = 50
export const MAX_EXAMPLES = 60
const EXAMPLES_PER_SUBJECT = 3

// Case, spacing, punctuation, accents and letter-digit joins don't make two
// names different: "CS10", "cs 10" and "CS-10" are one subject. Letters and
// digits of any script count ("物理" is a name, not punctuation). Kept
// identical to subjectKey() in worker/src/subjects.js.
export function subjectKey(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/(\p{L})(\p{N})/gu, '$1 $2').replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

// For finding a subject's name inside a session name. Course codes stay
// whole: a word of letters joins the number after it ("cs 10" and "cs10" are
// both cs10), and letters already on a number stay on it (math2b). So subject
// "Math 2" doesn't match "math 2b hw", and subject "C" doesn't match
// "physics 4c".
function containKey(name: string): string {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    .replace(/(?<=(?:^| )\p{L}+) (?=\p{N})/gu, '')
}

// Tidy a typed subject name: single spaces, trimmed, capped. '' means none.
export function cleanSubject(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, SUBJECT_MAX).trim()
}

// Sessions left with the default name can't be sorted: there's nothing to read.
export function isNamed(task: string): boolean {
  return task.trim() !== '' && task !== DEFAULT_SESSION_NAME
}

// The subject in force for a session, or undefined if it still needs sorting.
export function subjectOf(session: SessionMeta): SubjectTag | undefined {
  const tag = session.subject
  if (!tag) return undefined
  if (tag.by === 'you' || tag.for === session.task) return tag
  return undefined
}

export function needsSorting(session: SessionMeta): boolean {
  return isNamed(session.task) && subjectOf(session) === undefined
}

// Every subject you have: the ones you added, then the ones in use, most
// recently used first. One spelling per subject (yours first).
export function knownSubjects(sessions: SessionMeta[], saved: string[]): string[] {
  const byKey = new Map<string, string>()
  for (const name of saved) {
    const key = subjectKey(name)
    if (key && !byKey.has(key)) byKey.set(key, name)
  }
  const recent = [...sessions].sort((a, b) => b.startedAt - a.startedAt)
  for (const s of recent) {
    const name = subjectOf(s)?.name
    if (!name) continue
    const key = subjectKey(name)
    if (key && !byKey.has(key)) byKey.set(key, name)
  }
  return [...byKey.values()]
}

// The existing spelling of `name` if you already have that subject.
export function canonicalSubject(name: string, subjects: string[]): string {
  const key = subjectKey(name)
  return subjects.find((s) => subjectKey(s) === key) ?? name
}

// Decide a session's subject without the model, if the answer is already
// clear. Returns a name, null (no subject), or undefined (ask the model).
export function localSubject(
  title: string,
  sessions: SessionMeta[],
  subjects: string[],
): string | null | undefined {
  const key = subjectKey(title)
  if (!key) return undefined

  // 1. Memory: the same name was sorted before. Your own choices win, then the
  // most recent guess. A choice is remembered for the name it was made for,
  // which for yours may be a name the session has since dropped.
  let remembered: SubjectTag | undefined
  let rememberedAt = -Infinity
  for (const s of sessions) {
    const tag = subjectOf(s)
    if (!tag || subjectKey(tag.for) !== key) continue
    const rank = (tag.by === 'you' ? 1e15 : 0) + s.startedAt
    if (rank > rememberedAt) {
      remembered = tag
      rememberedAt = rank
    }
  }
  if (remembered && (remembered.name !== null || remembered.by === 'you')) {
    return remembered.name === null ? null : canonicalSubject(remembered.name, subjects)
  }

  // 2. The name contains a subject's name as whole words. A match inside a
  // longer match gives way ("math 2b quiz" is MATH 2B, not Math), but a name
  // that mentions two separate subjects is left to the model.
  const padded = ` ${containKey(title)} `
  const found = new Map<string, string>()
  for (const subject of subjects) {
    const sk = containKey(subject)
    if (sk && padded.includes(` ${sk} `) && !found.has(sk)) found.set(sk, subject)
  }
  const outer = [...found.keys()].filter((sk) =>
    ![...found.keys()].some((other) => other !== sk && ` ${other} `.includes(` ${sk} `)))
  if (outer.length === 1) return found.get(outer[0])

  // 3. A guess of "no subject" for this name stands only when nothing above
  // places it, so adding a subject can still claim it.
  return remembered ? null : undefined
}

// A few of your own sorted sessions per subject, so the model learns your
// naming (course codes, chapter numbers, abbreviations). Your choices first.
export function subjectExamples(
  sessions: SessionMeta[],
  limit = MAX_EXAMPLES,
): { title: string; subject: string }[] {
  const ranked = sessions
    .map((s) => ({ s, tag: subjectOf(s) }))
    .filter((x): x is { s: SessionMeta; tag: SubjectTag } =>
      Boolean(x.tag?.name) && isNamed(x.tag!.for))
    .sort((a, b) =>
      Number(b.tag.by === 'you') - Number(a.tag.by === 'you') || b.s.startedAt - a.s.startedAt)
  const perSubject = new Map<string, number>()
  const seenTitles = new Set<string>()
  const out: { title: string; subject: string }[] = []
  for (const { tag } of ranked) {
    const subject = subjectKey(tag.name!)
    // The name the choice was made for (yours survive renames).
    const title = subjectKey(tag.for)
    if (!title || seenTitles.has(title) || (perSubject.get(subject) ?? 0) >= EXAMPLES_PER_SUBJECT) continue
    seenTitles.add(title)
    perSubject.set(subject, (perSubject.get(subject) ?? 0) + 1)
    out.push({ title: tag.for.trim(), subject: tag.name! })
    if (out.length >= limit) break
  }
  return out
}

export type Period = 'week' | 'month' | 'all'

export const PERIODS: { id: Period; label: string }[] = [
  { id: 'week', label: '7 days' },
  { id: 'month', label: '30 days' },
  { id: 'all', label: 'All time' },
]

// The first day counted, by the same day rule as Stats: a session counts
// toward the day it started, in your timezone.
export function periodStartDay(period: Period, today: string): string | null {
  if (period === 'week') return addDays(today, -6)
  if (period === 'month') return addDays(today, -29)
  return null
}

export interface SubjectTotal {
  // null: unsorted (no name, too vague, or not sorted yet).
  name: string | null
  ms: number
  sessions: number
}

// Time per subject since `fromDay` (inclusive), most first, unsorted last.
export function subjectTotals(sessions: SessionMeta[], fromDay: string | null): SubjectTotal[] {
  const totals = new Map<string | null, SubjectTotal>()
  for (const s of sessions) {
    if (fromDay !== null && localDay(s.startedAt) < fromDay) continue
    const name = subjectOf(s)?.name ?? null
    const key = name === null ? null : subjectKey(name)
    const total = totals.get(key) ?? { name, ms: 0, sessions: 0 }
    total.ms += s.elapsedMs
    total.sessions += 1
    totals.set(key, total)
  }
  return [...totals.values()]
    .filter((t) => t.ms > 0)
    .sort((a, b) => Number(a.name === null) - Number(b.name === null) || b.ms - a.ms)
}

export interface SubjectUpdate {
  id: string
  subject: SubjectTag | undefined
}

// Rename a subject everywhere it's in force. Renaming onto a subject you
// already have merges the two.
export function renameUpdates(sessions: SessionMeta[], from: string, to: string): SubjectUpdate[] {
  const key = subjectKey(from)
  return sessions.flatMap((s) => {
    const tag = subjectOf(s)
    return tag?.name && subjectKey(tag.name) === key
      ? [{ id: s.id, subject: { ...tag, name: to } }]
      : []
  })
}

// Remove a subject: its sessions become unsorted, by your choice, so the
// sorter doesn't put them straight back.
export function removeUpdates(sessions: SessionMeta[], name: string): SubjectUpdate[] {
  const key = subjectKey(name)
  return sessions.flatMap((s) => {
    const tag = subjectOf(s)
    return tag?.name && subjectKey(tag.name) === key
      ? [{ id: s.id, subject: { name: null, for: s.task, by: 'you' as const } }]
      : []
  })
}

// Forget guesses so the sorter starts over (your own choices stay). With the
// model off, only local matches are redone: model guesses couldn't come back.
export function resortUpdates(sessions: SessionMeta[], withModel: boolean): SubjectUpdate[] {
  return sessions.flatMap((s) =>
    s.subject && (s.subject.by === 'match' || (withModel && s.subject.by === 'model'))
      ? [{ id: s.id, subject: undefined }]
      : [])
}
