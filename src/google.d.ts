/// <reference types="vite/client" />

// The Vite env var holding our OAuth Client ID.
interface ImportMetaEnv {
  readonly VITE_GOOGLE_CLIENT_ID: string
  readonly VITE_NEON_AUTH_URL: string
  readonly VITE_NEON_DATA_API_URL: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}

// Minimal typing for the Google Identity Services (GIS) token flow.
// The full SDK has more surface; we only declare what we use.
interface GoogleTokenResponse {
  access_token: string
  expires_in: number
  scope: string
  token_type: string
  error?: string
}

interface GoogleTokenClient {
  requestAccessToken: (overrideConfig?: { prompt?: string }) => void
}

interface Window {
  google?: {
    accounts: {
      oauth2: {
        initTokenClient: (config: {
          client_id: string
          scope: string
          callback: (response: GoogleTokenResponse) => void
          error_callback?: (error: { type?: string; message?: string }) => void
        }) => GoogleTokenClient
      }
    }
  }
}
