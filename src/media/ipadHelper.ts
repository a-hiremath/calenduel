// Talks to the Calenduel iPad helper (ipad-helper/): a small Mac menu-bar app
// that reads a USB-connected iPad's screen the way QuickTime does and serves the
// newest frame on 127.0.0.1. With it, a session picks the iPad up on its own:
// no QuickTime window, no second screen-share picker.
//
// Opt-in per browser. The helper's first launch opens calenduel.com/?ipadHelper=1,
// which sets the flag below. Without the flag the page never contacts the helper,
// so people who don't run it never see Chrome's "access other apps and services
// on this device" prompt.

const HELPER = 'http://127.0.0.1:47615'
const FLAG = 'calenduel.ipadHelper'
const PARAM = 'ipadHelper'
// One frame a second, the timelapse's own rate. Faster polling starved it: a
// hidden tab gets a small budget for timer work, and at two polls a second the
// recorder's 1 s tick ran only every other second (29 frames a minute, not 58).
const POLL_MS = 1000
// Consecutive failed frame requests before the iPad counts as gone.
const MAX_MISSES = 3

export function helperEnabled(): boolean {
  try {
    return localStorage.getItem(FLAG) === '1'
  } catch {
    return false
  }
}

// Run once on load: ?ipadHelper=1 turns the helper on for this browser, =0 turns
// it off. The parameter is then removed so it doesn't linger in the address bar.
export function consumeHelperParam(): void {
  const url = new URL(window.location.href)
  const value = url.searchParams.get(PARAM)
  if (value === null) return
  try {
    if (value === '0') localStorage.removeItem(FLAG)
    else localStorage.setItem(FLAG, '1')
  } catch {
    // Storage blocked: the helper just stays off.
  }
  url.searchParams.delete(PARAM)
  window.history.replaceState(window.history.state, '', url)
}

// Is the helper running with an iPad plugged in? Any failure means no.
export async function helperHasIpad(): Promise<boolean> {
  try {
    const response = await fetch(`${HELPER}/status`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(1500),
    })
    if (!response.ok) return false
    const status = (await response.json()) as { app?: unknown; connected?: unknown }
    return status.app === 'calenduel-ipad' && status.connected === true
  } catch {
    return false
  }
}

export interface HelperFeed {
  // The iPad as a live video stream, so the recorder and the preview treat it
  // exactly like a shared window.
  stream: MediaStream
  // Resolves true once the first frame is drawn, false if the feed ends first.
  // The stream is 2×2 and blank until then, so don't show or record it before.
  ready: Promise<boolean>
  stop: () => void
}

// Poll the helper for frames and paint each onto a canvas whose captureStream()
// is the feed. onLost fires once if the iPad is unplugged or the helper quits.
export function openHelperFeed(onLost: () => void): HelperFeed {
  const canvas = document.createElement('canvas')
  canvas.width = 2
  canvas.height = 2
  const ctx = canvas.getContext('2d')!
  const stream = canvas.captureStream()
  let stopped = false
  let settle: (ok: boolean) => void = () => {}
  const ready = new Promise<boolean>((resolve) => {
    settle = resolve
  })

  function stop() {
    if (stopped) return
    stopped = true
    settle(false)
    for (const track of stream.getTracks()) track.stop()
  }

  async function poll() {
    let misses = 0
    while (!stopped) {
      const started = performance.now()
      try {
        const response = await fetch(`${HELPER}/frame`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(3000),
        })
        if (response.status === 200) {
          const bitmap = await createImageBitmap(await response.blob())
          if (stopped) {
            bitmap.close()
            return
          }
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width // rotating the iPad changes the shape
            canvas.height = bitmap.height
          }
          ctx.drawImage(bitmap, 0, 0)
          bitmap.close()
          settle(true)
          misses = 0
        } else if (response.status === 204) {
          misses = 0 // plugged in, no picture yet: keep waiting
        } else {
          misses++
        }
      } catch {
        misses++
      }
      if (misses >= MAX_MISSES) {
        if (!stopped) {
          stop()
          onLost()
        }
        return
      }
      const wait = POLL_MS - (performance.now() - started)
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }

  void poll()
  return { stream, ready, stop }
}
