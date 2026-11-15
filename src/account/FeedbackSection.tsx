import { useEffect, useState, type FormEvent } from 'react'
import { isSignedIn, MAX_FEEDBACK_LENGTH, sendFeedback } from '../compete/api'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.'
}

// A plain box at the bottom of Account for ideas and complaints. It imports the
// auth and database SDK, so Account loads it on demand, like ProfileSection.
export default function FeedbackSection() {
  // null = still finding out.
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let closed = false
    isSignedIn()
      .then((active) => {
        if (!closed) setSignedIn(active)
      })
      .catch((err) => {
        if (!closed) setError(errorText(err))
      })
    return () => {
      closed = true
    }
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!message.trim() || sending) return
    setError(null)
    setSending(true)
    try {
      await sendFeedback(message)
      setMessage('')
      setSent(true)
    } catch (err) {
      // The text stays in the box, so nothing is lost on a failure.
      setError(errorText(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="account-section">
      <h2>Feedback</h2>

      {signedIn === false && (
        <p className="account-note">Sign in on the Compete tab to send feedback.</p>
      )}

      {signedIn && (
        <form className="feedback" onSubmit={submit}>
          <textarea
            className="feedback-input"
            aria-label="Feedback"
            placeholder="An idea, a bug, anything that bugs you"
            rows={3}
            maxLength={MAX_FEEDBACK_LENGTH}
            value={message}
            onChange={(e) => {
              setMessage(e.target.value)
              setSent(false)
            }}
          />
          <div className="feedback-actions">
            <button
              type="submit"
              className="account-btn"
              disabled={sending || !message.trim()}
            >
              {sending ? 'Sending...' : 'Send'}
            </button>
            {sent && (
              <span className="account-note feedback-sent" role="status">
                Sent. Thanks!
              </span>
            )}
          </div>
          <p className="account-note">
            Goes to the people who build Calenduel, with your name. Nobody else
            sees it.
          </p>
        </form>
      )}

      {error && <p className="account-error" role="alert">{error}</p>}
    </section>
  )
}
