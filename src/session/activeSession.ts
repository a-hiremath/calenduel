// A session in progress lives only in the page's memory, so a refresh or a
// closed tab used to lose it without a trace. This keeps a small record of the
// running session in localStorage, so the next load can offer to resume it or
// save the time studied. The clip can't be rescued: its frames were in memory.

const KEY = 'calenduel.activeSession'
const TAB_KEY = 'calenduel.tabId'
export const HEARTBEAT_MS = 15_000

export interface ActiveSession {
  startedAt: number
  name: string
  lastSeen: number // the last moment the session was known to be running
  tabId: string
}

// sessionStorage survives a reload but isn't shared between tabs, which is
// what tells "this tab was refreshed" apart from "another tab is recording".
export function tabId(): string {
  try {
    let id = sessionStorage.getItem(TAB_KEY)
    if (!id) {
      id = crypto.randomUUID()
      sessionStorage.setItem(TAB_KEY, id)
    }
    return id
  } catch {
    return 'unknown'
  }
}

export function readActive(): ActiveSession | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as ActiveSession) : null
  } catch {
    return null
  }
}

export function writeActive(session: ActiveSession): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(session))
  } catch { /* storage blocked: the session still runs, it just can't be rescued */ }
}

export function clearActive(): void {
  try {
    localStorage.removeItem(KEY)
  } catch { /* nothing to clear */ }
}

// A record left by a session that is no longer running anywhere. One written
// recently by a different tab is probably that tab still recording.
export function interruptedSession(now: number): ActiveSession | null {
  const record = readActive()
  if (!record) return null
  const live = record.tabId !== tabId() && now - record.lastSeen < 2 * HEARTBEAT_MS
  return live ? null : record
}
