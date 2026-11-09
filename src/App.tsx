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
          <button
            type="button"
            className={page === 'account' ? 'nav-link active' : 'nav-link'}
            onClick={() => setPage('account')}
          >
            Account
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
