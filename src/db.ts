import type { FocusResult } from './focus/types'
import type { LayoutSpan } from './media/timelapse'
import type { SubjectTag, SubjectUpdate } from './subjects/subjects'

const DB_NAME = 'calenduel'
const DB_VERSION = 1

// What a session is called until someone names it.
export const DEFAULT_SESSION_NAME = 'Study session'
export const SESSION_NAME_MAX = 60

export interface SessionMeta {
  id: string
  startedAt: number
  task: string
  goalMs: number
  elapsedMs: number
  hasClip: boolean
  focus?: FocusResult
  // Where the laptop, iPad and webcam sit in the clip. Missing on older clips.
  layout?: LayoutSpan[]
  // What the session counts toward in the subject tally (see subjects/).
  subject?: SubjectTag
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function awaitTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    // The failing request carries the error; tx.error is still null while its
    // error event bubbles up.
    tx.onerror = (e) =>
      reject((e.target as IDBRequest | null)?.error ?? tx.error ?? new DOMException('Save failed'))
    // A transaction can abort without an error event (e.g. the browser refusing
    // to store a large file). Without this the promise never settles, and the
    // app sat on "Saving…" forever.
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'))
  })
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('sessions', { keyPath: 'id' })
      db.createObjectStore('clips')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

let persistRequested = false

async function requestPersistence() {
  if (persistRequested) return
  persistRequested = true
  try {
    await navigator.storage?.persist?.()
  } catch { /* best effort */ }
}

export async function saveSession(
  meta: Omit<SessionMeta, 'id' | 'hasClip'>,
  clip: Blob | null,
): Promise<string> {
  const db = await openDb()
  const id = crypto.randomUUID()
  const tx = db.transaction(['sessions', 'clips'], 'readwrite')
  tx.objectStore('sessions').put({ ...meta, id, hasClip: clip !== null && clip.size > 0 })
  if (clip && clip.size > 0) tx.objectStore('clips').put(clip, id)
  await awaitTransaction(tx)
  requestPersistence()
  return id
}

export async function listSessions(): Promise<SessionMeta[]> {
  const db = await openDb()
  const all = await promisify(
    db.transaction('sessions', 'readonly').objectStore('sessions').getAll(),
  ) as SessionMeta[]
  all.sort((a, b) => b.startedAt - a.startedAt)
  return all
}

export async function getClip(id: string): Promise<Blob | null> {
  const db = await openDb()
  const blob = await promisify(
    db.transaction('clips', 'readonly').objectStore('clips').get(id),
  )
  return blob instanceof Blob ? blob : null
}

// A local edit. (Names leave the device only for focus analysis or, if you
// turn it on, automatic subjects.) A guessed subject was made for the old
// name, so it lapses and the session is sorted again; one you set stays.
export async function renameSession(id: string, task: string): Promise<void> {
  const db = await openDb()
  const tx = db.transaction('sessions', 'readwrite')
  const store = tx.objectStore('sessions')
  // Written from inside the read's callback: an IndexedDB transaction closes
  // itself once it's left idle, which awaiting the read first would risk.
  const read = store.get(id)
  read.onsuccess = () => {
    if (read.result) store.put({ ...read.result, task, focus: undefined })
  }
  await awaitTransaction(tx)
}

export async function saveFocus(id: string, focus: FocusResult): Promise<void> {
  const db = await openDb()
  const tx = db.transaction('sessions', 'readwrite')
  const store = tx.objectStore('sessions')
  let stale = false
  const read = store.get(id)
  read.onsuccess = () => {
    if (!read.result || read.result.task !== focus.task) { stale = true; return }
    store.put({ ...read.result, focus })
  }
  await awaitTransaction(tx)
  if (stale) throw new Error('The session changed during analysis. Please analyze it again.')
}

// Write subject changes in one transaction and return how many were applied.
// A guess (match or model) is skipped if the session was renamed since it was
// made, or if you have set a subject yourself; your own changes always apply.
// `subject: undefined` clears a guess but never one of your choices.
export async function setSubjects(updates: SubjectUpdate[]): Promise<number> {
  if (updates.length === 0) return 0
  const db = await openDb()
  const tx = db.transaction('sessions', 'readwrite')
  const store = tx.objectStore('sessions')
  let applied = 0
  for (const { id, subject } of updates) {
    const read = store.get(id)
    read.onsuccess = () => {
      const current = read.result as SessionMeta | undefined
      if (!current) return
      const mine = current.subject?.by === 'you'
      if (subject === undefined) {
        if (!current.subject || mine) return
      } else if (subject.by !== 'you' && (mine || subject.for !== current.task)) {
        return
      }
      store.put({ ...current, subject })
      applied += 1
    }
  }
  await awaitTransaction(tx)
  return applied
}

export async function deleteSession(id: string): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(['sessions', 'clips'], 'readwrite')
  tx.objectStore('sessions').delete(id)
  tx.objectStore('clips').delete(id)
  await awaitTransaction(tx)
}
