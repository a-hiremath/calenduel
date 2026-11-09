const DB_NAME = 'calenduel'
const DB_VERSION = 1

export interface SessionMeta {
  id: string
  startedAt: number
  task: string
  goalMs: number
  elapsedMs: number
  hasClip: boolean
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

export async function deleteSession(id: string): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(['sessions', 'clips'], 'readwrite')
  tx.objectStore('sessions').delete(id)
  tx.objectStore('clips').delete(id)
  await awaitTransaction(tx)
}
