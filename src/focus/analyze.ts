import { sampleIntervals, type FocusChoice, type FocusResult } from './types'

// Public endpoint, never an API token. Inference runs behind signed-in auth.
export const FOCUS_ENDPOINT = 'https://calenduel-focus.calenduel-focus.workers.dev'

function waitFor(video: HTMLVideoElement, event: string, action: () => void) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      video.removeEventListener(event, done)
      video.removeEventListener('error', failed)
    }
    const done = () => { cleanup(); resolve() }
    const failed = () => { cleanup(); reject(new Error('The recording could not be read.')) }
    const timer = setTimeout(failed, 15_000)
    video.addEventListener(event, done, { once: true })
    video.addEventListener('error', failed, { once: true })
    action()
  })
}

export async function analyzeFocus(
  clip: Blob, task: string, elapsedMs: number,
  progress: (done: number, total: number) => void,
  signal: AbortSignal,
): Promise<FocusResult> {
  const { focusToken } = await import('../compete/api')
  let token = await focusToken()
  if (!token) throw new Error('Sign in from Compete before analyzing a session.')
  let tokenCheckedAt = Date.now()
  const url = URL.createObjectURL(clip)
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'auto'
  const canvas = document.createElement('canvas')
  try {
    await waitFor(video, 'loadeddata', () => { video.src = url; video.load() })
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error('The recording has no readable duration.')
    }
    const scale = Math.min(1, 1568 / video.videoWidth)
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    const ctx = canvas.getContext('2d')!
    const result: FocusResult = {
      task, analyzedAt: Date.now(), model: 'clef-flash', rubric: 'task-v2', samples: [],
    }
    const intervals = sampleIntervals(elapsedMs)
    progress(0, intervals.length)
    for (const interval of intervals) {
      signal.throwIfAborted()
      if (Date.now() - tokenCheckedAt > 60_000) {
        token = await focusToken()
        if (!token) throw new Error('Sign in again to finish analysis.')
        tokenCheckedAt = Date.now()
      }
      // The clip is compressed to 30x. Mapping by proportion also tolerates
      // missed capture ticks; this is a sampled estimate, not exact telemetry.
      const time = Math.min(video.duration - 0.001,
        video.duration * interval.atMs / elapsedMs)
      if (Math.abs(video.currentTime - time) > 0.0001) {
        await waitFor(video, 'seeked', () => { video.currentTime = time })
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      // The recorder uses a 25%-wide inset and a 16px margin in output pixels.
      // Mask it before serializing: no webcam pixels leave this browser.
      const margin = 16 * scale
      const width = canvas.width * 0.25
      // Camera aspect ratio is not saved in old clips. Mask the full strip
      // rather than guessing its height and leaking a tall webcam inset.
      ctx.fillStyle = 'black'
      ctx.fillRect(canvas.width - width - margin - 4, 0, width + margin + 4, canvas.height)
      const response = await fetch(`${FOCUS_ENDPOINT}/score`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ task, image: canvas.toDataURL('image/jpeg', 0.8) }),
      })
      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(detail?.error ?? 'Focus analysis failed. Please try again.')
      }
      const answer = await response.json() as { choice: FocusChoice }
      if (!['on_task', 'off_task', 'unclear'].includes(answer.choice)) {
        throw new Error('The model returned an unreadable result.')
      }
      result.samples.push({ ...interval, choice: answer.choice, originalChoice: answer.choice })
      progress(result.samples.length, intervals.length)
      // Pace post-session requests below the per-user endpoint limit.
      await new Promise<void>(resolve => setTimeout(resolve, 550))
    }
    return result
  } finally {
    video.removeAttribute('src')
    video.load()
    URL.revokeObjectURL(url)
    canvas.width = 0
    canvas.height = 0
  }
}
