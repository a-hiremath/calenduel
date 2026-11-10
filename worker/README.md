# Experimental focus scoring

`calenduel-focus` runs on Cloudflare Workers with a native Workers AI binding to
`@cf/cloudflare/clef-flash`. No inference token is shipped in the browser.

The Sessions page offers manual, consented analysis of an existing named session.
It samples at 15-second intervals, capped at 240 frames for long sessions. The
browser masks the entire right camera strip before making JPEG requests: older
clips do not store camera aspect ratio, so guessing an inset height could leak
webcam pixels. This also hides some screen content. Clip time maps proportionally
to elapsed time; missed capture ticks and interrupted sessions reduce precision.

The score is the duration-weighted percentage of assessed intervals marked on
task. Unclear intervals are excluded and coverage is displayed. These are model
judgments of visible task relevance, not validated measurements of attention.
Users can correct individual intervals; original decisions are retained locally.
Renaming invalidates the score, and a concurrent rename/delete rejects a stale
analysis result. Scores and corrections live only in IndexedDB.

The endpoint verifies Neon JWT signatures, issuer, audience and expiry against
the configured JWKS. It requires the production origin, bounds request size,
and rate-limits each signed-in user. Cloudflare rate limits are per location,
not a hard global spending cap. No images, names or decisions are stored in the
Worker; Workers observability is disabled. Cloudflare documents zero data
retention for this model:
https://developers.cloudflare.com/workers-ai/models/clef-flash/

Deploy with `npm ci && npm run deploy` here, supplying Cloudflare deployment
credentials through the environment. `npm test` checks the authentication,
origin, rate and body-size boundaries. Root `npm test` covers score arithmetic.
The production client endpoint is in `src/focus/analyze.ts`.
