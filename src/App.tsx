import { lazy, Suspense, useState } from 'react'
import SessionTimer from './SessionTimer'
import History from './History'
import Account from './account/Account'
import './App.css'

// The auth and database SDK is big and only competition features use it, so
// it loads on demand rather than slowing down the timer.
const Compete = lazy(() => import('./compete/Compete'))

type Page = 'timer' | 'history' | 'compete' | 'account'

// Invite links and the return trip from Google sign-in land on Compete.
function initialPage(): Page {
  const params = new URLSearchParams(window.location.search)
  return params.has('invite') || params.get('tab') === 'compete' ? 'compete' : 'timer'
}

// The Lucide "settings" icon (ISC licence), drawn in the current text colour.
function GearIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function App() {
  // While a session is in progress, hide the nav so the screen is just the
  // session — no distractions. SessionTimer reports its in-progress state up
  // via onActiveChange.
  const [sessionActive, setSessionActive] = useState(false)
  const [page, setPage] = useState<Page>(initialPage)
  const [historyKey, setHistoryKey] = useState(0)

  return (
    <>
      {!sessionActive && (
        <nav className="nav">
          <button
            type="button"
            className={page === 'timer' ? 'nav-link active' : 'nav-link'}
            onClick={() => setPage('timer')}
          >
            Timer
          </button>
          <button
            type="button"
            className={page === 'history' ? 'nav-link active' : 'nav-link'}
            onClick={() => setPage('history')}
          >
            Sessions
          </button>
          <button
            type="button"
            className={page === 'compete' ? 'nav-link active' : 'nav-link'}
            onClick={() => setPage('compete')}
          >
            Compete
          </button>
          {/* Settings-type page, so it sits apart from the tabs as an icon. */}
          <button
            type="button"
            className={page === 'account' ? 'nav-gear active' : 'nav-gear'}
            aria-label="Account"
            aria-current={page === 'account' ? 'page' : undefined}
            title="Account"
            onClick={() => setPage('account')}
          >
            <GearIcon />
          </button>
        </nav>
      )}

      {page === 'timer' && (
        <SessionTimer
          onActiveChange={setSessionActive}
          onSessionSaved={() => {
            setHistoryKey((k) => k + 1)
            // Best effort: the session is safe locally, and opening Compete
            // retries anything that didn't make it up.
            import('./compete/api')
              .then(({ syncSessions }) => syncSessions())
              .catch(console.error)
          }}
        />
      )}

      {page === 'history' && <History key={historyKey} />}

      {page === 'compete' && (
        <Suspense fallback={null}>
          <Compete />
        </Suspense>
      )}

      {page === 'account' && <Account />}
    </>
  )
}

export default App
