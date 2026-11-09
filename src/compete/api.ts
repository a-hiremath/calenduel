// Every network call the competition makes. The browser talks straight to
// Postgres through Neon's Data API: the SDK attaches the signed-in user's JWT,
// and the policies in db/migrations decide what that user may do.

import { createClient } from '@neondatabase/neon-js'
import { listSessions } from '../db'
import { localDay, type DailyTotal } from './stats'

const neon = createClient({
  auth: { url: import.meta.env.VITE_NEON_AUTH_URL },
  dataApi: { url: import.meta.env.VITE_NEON_DATA_API_URL },
})

// The database refuses longer sessions, so don't keep offering them.
const MAX_SESSION_MS = 24 * 60 * 60 * 1000
const UNIQUE_VIOLATION = '23505'

export interface Profile {
  id: string
  name: string
  inviteCode: string
  avatar: string | null // a small JPEG data URL
}

export interface Friend {
  id: string
  name: string
  avatar: string | null
  since: string // YYYY-MM-DD: the head-to-head record starts here
}

export interface FriendSession {
  id: string
  startedAt: string
  elapsedMs: number
}

// PostgREST and auth errors are plain objects, not Error instances.
function fail(error: { message?: string }): never {
  throw new Error(error.message ?? 'Something went wrong. Please try again.')
}

export async function isSignedIn(): Promise<boolean> {
  const { data, error } = await neon.auth.getSession()
  if (error) fail(error)
  return Boolean(data?.session)
}

// Leaves the page for Google, then returns to the Compete tab. Anything already
// in the URL, like an invite code, survives the round trip.
export async function signIn(): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  params.set('tab', 'compete')
  const { error } = await neon.auth.signIn.social({
    provider: 'google',
    callbackURL: `${window.location.origin}/?${params}`,
  })
  if (error) fail(error)
}

export async function signOut(): Promise<void> {
  const { error } = await neon.auth.signOut()
  if (error) fail(error)
}

export async function ensureProfile(): Promise<Profile> {
  const { data, error } = await neon.rpc('ensure_profile').single()
  if (error) fail(error)
  const row = data as {
    user_id: string
    display_name: string
    invite_code: string
    avatar: string | null
  }
  return {
    id: row.user_id,
    name: row.display_name,
    inviteCode: row.invite_code,
    avatar: row.avatar,
  }
}

// Sets or, with null, removes the caller's picture. The policy in
// db/migrations only lets this reach the caller's own row, whatever id is sent.
export async function setAvatar(userId: string, avatar: string | null): Promise<void> {
  const { error } = await neon.from('profiles').update({ avatar }).eq('user_id', userId)
  if (error) fail(error)
}

export async function listFriends(): Promise<Friend[]> {
  const { data: links, error } = await neon
    .from('friendships')
    .select('friend_id, since')
  if (error) fail(error)
  const rows = links as { friend_id: string; since: string }[]
  if (rows.length === 0) return []

  const { data: profiles, error: profileError } = await neon
    .from('profiles')
    .select('user_id, display_name, avatar')
    .in('user_id', rows.map((r) => r.friend_id))
  if (profileError) fail(profileError)

  const byId = new Map(
    (
      profiles as { user_id: string; display_name: string; avatar: string | null }[]
    ).map((p) => [p.user_id, p]),
  )
  return rows.map((r) => ({
    id: r.friend_id,
    name: byId.get(r.friend_id)?.display_name ?? 'Unknown',
    avatar: byId.get(r.friend_id)?.avatar ?? null,
    since: r.since,
  }))
}

export async function addFriend(code: string): Promise<string> {
  const { data, error } = await neon.rpc('add_friend', { code })
  if (error) fail(error)
  return data as string
}

export async function removeFriend(friendId: string): Promise<void> {
  const { error } = await neon.rpc('remove_friend', { friend: friendId })
  if (error) fail(error)
}

export async function fetchDailyTotals(): Promise<DailyTotal[]> {
  const { data, error } = await neon.rpc('daily_totals')
  if (error) fail(error)
  return (data as { user_id: string; day: string; total_ms: number }[]).map(
    (r) => ({ userId: r.user_id, day: r.day, totalMs: r.total_ms }),
  )
}

// The server returns at most this many, newest first.
export const FRIEND_SESSION_LIMIT = 50

export async function fetchFriendSessions(friendId: string): Promise<FriendSession[]> {
  const { data, error } = await neon.rpc('friend_sessions', { friend: friendId })
  if (error) fail(error)
  return (data as { id: string; started_at: string; elapsed_ms: number }[]).map(
    (r) => ({ id: r.id, startedAt: r.started_at, elapsedMs: r.elapsed_ms }),
  )
}

// Uploads local sessions the server doesn't have yet and returns how many it
// couldn't upload. Anything missed is retried next time, so a session recorded
// offline or before signing in still counts. Only times are sent, never clips.
export async function syncSessions(): Promise<number> {
  if (!(await isSignedIn())) return 0

  const { data, error } = await neon.from('study_sessions').select('id')
  if (error) fail(error)
  const uploaded = new Set((data as { id: string }[]).map((r) => r.id))

  const pending = (await listSessions()).filter(
    (s) => !uploaded.has(s.id) && s.elapsedMs <= MAX_SESSION_MS,
  )

  // One at a time, because a batch insert would let a single rejected session
  // stop all the others from counting.
  const results = await Promise.all(
    pending.map((s) =>
      neon.from('study_sessions').insert({
        id: s.id,
        day: localDay(s.startedAt),
        started_at: new Date(s.startedAt).toISOString(),
        elapsed_ms: Math.round(s.elapsedMs),
      }),
    ),
  )
  // A duplicate means another tab beat this one to it, which is still a success.
  return results.filter((r) => r.error && r.error.code !== UNIQUE_VIOLATION).length
}

// Takes a deleted session out of the competition. Throws on failure so the
// caller can keep the local copy rather than leave a phantom score behind.
export async function deleteUploadedSession(id: string): Promise<void> {
  if (!(await isSignedIn())) return
  const { error } = await neon.from('study_sessions').delete().eq('id', id)
  if (error) fail(error)
}
