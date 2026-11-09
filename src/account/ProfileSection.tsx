import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import Avatar from '../Avatar'
import { ensureProfile, isSignedIn, setAvatar, type Profile } from '../compete/api'
import { toAvatar } from './avatar'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.'
}

// The signed-in half of the Account page. It imports the auth and database SDK,
// so Account loads it on demand, the same way App loads Compete.
export default function ProfileSection() {
  // null = still finding out.
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let closed = false
    async function load() {
      const active = await isSignedIn()
      if (closed) return
      setSignedIn(active)
      if (!active) return
      const mine = await ensureProfile()
      if (!closed) setProfile(mine)
    }
    load().catch((err) => {
      if (!closed) setError(errorText(err))
    })
    return () => {
      closed = true
    }
  }, [])

  async function save(avatar: string | null) {
    if (!profile) return
    setError(null)
    setSaving(true)
    try {
      await setAvatar(profile.id, avatar)
      setProfile({ ...profile, avatar })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    // Cleared so choosing the same file again still fires a change.
    event.target.value = ''
    if (!file) return
    try {
      await save(await toAvatar(file))
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <section className="account-section">
      <h2>Profile</h2>

      {signedIn === null && !error && <p className="account-note">Loading...</p>}

      {signedIn === false && (
        <p className="account-note">
          Sign in on the Compete tab to set a profile picture.
        </p>
      )}

      {profile && (
        <div className="profile">
          <Avatar name={profile.name} src={profile.avatar} size={64} />
          <div className="profile-info">
            <p className="profile-name">{profile.name}</p>
            <div className="profile-actions">
              {/* A real button, so the keyboard can reach it; the browser's own
                  file input is hidden and opened from here. */}
              <button
                type="button"
                className="account-btn"
                disabled={saving}
                onClick={() => fileInputRef.current?.click()}
              >
                {saving ? 'Saving...' : profile.avatar ? 'Change picture' : 'Add a picture'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={handleFile}
              />
              {profile.avatar && !saving && (
                <button type="button" className="account-link" onClick={() => save(null)}>
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {profile && (
        <p className="account-note">
          Your friends see your picture next to your name. Your name comes from
          your Google account.
        </p>
      )}

      {error && <p className="account-error" role="alert">{error}</p>}
    </section>
  )
}
