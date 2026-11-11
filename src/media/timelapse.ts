// Timelapse generation — browser-only via WebCodecs.
//
// A timelapse is just a video played back faster than it was recorded. We
// sample sparse frames during capture and encode each one the *instant* we grab
// it, assigning a virtual 30 fps timeline (frame i sits at i·33ms) so the
// finished clip is sped up:
//
//   speedup = PLAYBACK_FPS / SAMPLE_RATE
//
// At 1 sampled frame/sec stamped 33ms apart that's 30×. Because every frame is
// encoded live as it's sampled, Stop only has to flush the last few frames and
// finalize the container — near-instant, no matter how long the session ran.
//
// Each frame is a composite: the shared screen fills the frame, with the webcam
// face drawn small in the bottom-right (picture-in-picture), so a viewer can see
// both what you were working on and that you were there.

import { Muxer, ArrayBufferTarget } from 'mp4-muxer'

const SAMPLE_RATE = 1    // frames captured per second of real time
const PLAYBACK_FPS = 30  // frames shown per second on playback → 30× speedup
const FRAME_DURATION_US = Math.round(1_000_000 / PLAYBACK_FPS) // µs per frame
// One keyframe every ~2s of output, so scrubbing/seeking the clip works. Frame
// 0 lands on this too, satisfying the "first frame must be a keyframe" rule.
const KEYFRAME_INTERVAL = PLAYBACK_FPS * 2
// Screen capture is mostly text; a low bitrate smears it into mush, which defeats
// the "see what they were doing" point. Higher = more legible but bigger file.
const BITRATE = 4_000_000
// Cap the longer side. A Retina screen reports e.g. 3024×1964 — far more than a
// shared timelapse needs, and it would balloon the file. Capping also keeps us
// safely inside the codec level's max frame size (see CODEC).
const MAX_DIMENSION = 1920
// Tried in order; the first one this browser can actually encode wins. Browsers
// differ here (which H.264 profiles they ship an encoder for, whether they have
// one at all), and an unsupported config used to fail silently, saving the
// session with no clip. Every H.264 entry is level 5.1, which handles up to ~4K,
// so any screen scaled to MAX_DIMENSION fits regardless of aspect ratio.
const CODECS: { codec: string; muxer: 'avc' | 'vp9' }[] = [
  { codec: 'avc1.640033', muxer: 'avc' }, // H.264 High
  { codec: 'avc1.4d0033', muxer: 'avc' }, // H.264 Main
  { codec: 'avc1.420033', muxer: 'avc' }, // H.264 Baseline
  { codec: 'vp09.00.41.08', muxer: 'vp9' }, // VP9, for browsers without H.264
]

// Face inset (picture-in-picture): fraction of the screen width, pinned to the
// bottom-right with a margin and a dark frame so it reads against busy content.
const INSET_FRACTION = 0.25
const INSET_MARGIN = 16
const INSET_BORDER = 3
// Gap between the laptop screen and the iPad when both are in the frame.
const PANE_GAP = 16

export interface TimelapseResult {
  clip: Blob | null
  // Why there's no clip, in words the person recording can act on.
  problem: string | null
}

export interface TimelapseRecorder {
  // End sampling and finalize the live-encoded frames into one video.
  stop: () => Promise<TimelapseResult>
  // Abandon without finalizing — for teardown paths (e.g. the component
  // unmounting mid-recording) that don't need the clip. Safe to call after
  // stop(), and safe to call more than once.
  cancel: () => void
}

// A browser's encoder can stall without erroring, and Stop must always finish.
const FLUSH_TIMEOUT_MS = 15_000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// Scale (down only) so the longer side fits MAX_DIMENSION, keeping aspect ratio,
// and round to even — H.264 4:2:0 needs even dimensions, and an oversized frame
// blows past the codec level's max coded area (encode() then throws).
function fitDimensions(w: number, h: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_DIMENSION / Math.max(w, h))
  return {
    width: Math.round(w * scale) & ~1,
    height: Math.round(h * scale) & ~1,
  }
}

// Begin sampling composite frames from live <video> elements (the shared
// screen and the webcam face, plus an optional second window such as a mirrored
// iPad), encoding each one as it's captured. Returns a handle whose stop()
// flushes and produces the clip.
//
// getExtra is read every tick because the second window can be added or
// dropped mid-session; null means "screen only".
export function startTimelapse(
  face: HTMLVideoElement,
  screen: HTMLVideoElement,
  getExtra: () => HTMLVideoElement | null = () => null,
): TimelapseRecorder {
  // Encoder + muxer are built lazily on the first frame that actually has
  // pixels: configure() needs real dimensions, and the feed reports 0×0 until
  // it's playing. Both stay null until then.
  let muxer: Muxer<ArrayBufferTarget> | null = null
  let encoder: VideoEncoder | null = null
  let frameCount = 0
  // Choosing a codec is async, so frames are skipped until it settles.
  let settingUp = false
  // The first thing that went wrong. Reported instead of failing silently.
  let problem: string | null =
    typeof VideoEncoder === 'undefined'
      ? "This browser can't encode video, so no timelapse was recorded. Try Chrome or Edge."
      : null

  // Frames are composited through this canvas (sized to the capped, even output
  // dimensions) so the VideoFrame always matches the encoder's configured size.
  const scratch = document.createElement('canvas')
  const ctx = scratch.getContext('2d')!

  async function setup(width: number, height: number) {
    let chosen: (typeof CODECS)[number] | null = null
    for (const option of CODECS) {
      const config = { codec: option.codec, width, height, bitrate: BITRATE }
      try {
        if ((await VideoEncoder.isConfigSupported(config)).supported) {
          chosen = option
          break
        }
      } catch {
        // A config the browser can't even parse counts as unsupported.
      }
    }
    if (timer === null) return // stopped while we were checking
    if (!chosen) {
      problem = "This browser has no video encoder the timelapse can use. Try Chrome or Edge."
      stopSampling()
      return
    }

    scratch.width = width
    scratch.height = height
    const mux = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: chosen.muxer, width, height },
      fastStart: 'in-memory', // moov box up front → the Blob is seekable/playable
    })
    const enc = new VideoEncoder({
      // Forward meta untouched — it carries the codec description the muxer needs.
      output: (chunk, meta) => mux.addVideoChunk(chunk, meta),
      error: (e) => {
        console.error('timelapse encode error', e)
        problem ??= `The video encoder stopped: ${e.message}`
        stopSampling() // a fatal error closes the codec; stop feeding it
      },
    })
    enc.configure({ codec: chosen.codec, width, height, bitrate: BITRATE })
    muxer = mux
    encoder = enc
  }

  // The webcam, scaled down and dropped into the bottom-right over the screen.
  function drawFaceInset() {
    const insetW = Math.round(scratch.width * INSET_FRACTION)
    const insetH = Math.round(insetW * (face.videoHeight / face.videoWidth))
    const x = scratch.width - insetW - INSET_MARGIN
    const y = scratch.height - insetH - INSET_MARGIN
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
    ctx.fillRect(
      x - INSET_BORDER,
      y - INSET_BORDER,
      insetW + INSET_BORDER * 2,
      insetH + INSET_BORDER * 2,
    )
    ctx.drawImage(face, x, y, insetW, insetH)
  }

  // The canvas size is fixed at setup (from the laptop screen), but the second
  // window can show up later with any shape. So with both present, scale them to
  // one shared height and centre the pair inside the existing frame, letterboxed
  // in black, rather than resizing the video mid-stream.
  function drawSideBySide(extra: HTMLVideoElement) {
    const W = scratch.width
    const H = scratch.height
    const aw = screen.videoWidth
    const ah = screen.videoHeight
    const bw = extra.videoWidth
    const bh = extra.videoHeight
    // Pick the shared height h: each pane's width is h × its aspect ratio, and
    // together (plus the gap) they must fit W, while h itself must fit H.
    const h = Math.min(H, (W - PANE_GAP) / (aw / ah + bw / bh))
    const leftW = h * (aw / ah)
    const rightW = h * (bw / bh)
    const x = (W - (leftW + PANE_GAP + rightW)) / 2
    const y = (H - h) / 2
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)
    ctx.drawImage(screen, x, y, leftW, h)
    ctx.drawImage(extra, x + leftW + PANE_GAP, y, rightW, h)
  }

  let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (!screen.videoWidth) return // canvas size comes from the screen feed
    if (!encoder) {
      if (!settingUp) {
        settingUp = true
        const { width, height } = fitDimensions(screen.videoWidth, screen.videoHeight)
        void setup(width, height)
      }
      return
    }
    // A fatal encode error flips the codec to 'closed'; bail rather than throw
    // on every tick.
    if (encoder.state !== 'configured') {
      stopSampling()
      return
    }
    const extra = getExtra()
    if (extra?.videoWidth) drawSideBySide(extra) // has pixels yet?
    else ctx.drawImage(screen, 0, 0, scratch.width, scratch.height)
    if (face.videoWidth) drawFaceInset() // skip the inset until the camera has pixels
    const frame = new VideoFrame(scratch, {
      timestamp: frameCount * FRAME_DURATION_US,
      duration: FRAME_DURATION_US,
    })
    try {
      encoder.encode(frame, { keyFrame: frameCount % KEYFRAME_INTERVAL === 0 })
      frameCount++
    } catch (e) {
      console.error('timelapse encode error', e)
      problem ??= `Couldn't encode the recording: ${e instanceof Error ? e.message : e}`
      stopSampling()
    } finally {
      frame.close() // always release the GPU buffer, even if encode() throws
    }
  }, 1000 / SAMPLE_RATE)
  if (problem) stopSampling()

  // Clearing the sampling interval, idempotently — both stop() and cancel()
  // funnel through here, so calling them in any order is safe.
  function stopSampling() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    async stop() {
      // Clears the sampler synchronously (before the first await), so the caller
      // can safely release the streams the moment stop() returns.
      stopSampling()
      // Nothing usable: never sampled, or the codec died mid-session — you can't
      // flush a closed encoder, so report why rather than throw.
      if (problem) return { clip: null, problem }
      if (!encoder || !muxer || encoder.state !== 'configured' || frameCount === 0) {
        return {
          clip: null,
          problem: screen.videoWidth
            ? 'The session was too short to record any frames.'
            : 'The shared screen never showed up in the recording, so no timelapse was saved.',
        }
      }
      try {
        await withTimeout(
          encoder.flush(),
          FLUSH_TIMEOUT_MS,
          'The video encoder never finished.',
        )
        muxer.finalize()
      } catch (e) {
        console.error('timelapse finalize error', e)
        const detail = e instanceof Error ? ` ${e.message}` : ''
        return { clip: null, problem: `Couldn't finish the timelapse video.${detail}` }
      } finally {
        // An error during flush may already have closed it.
        if ((encoder.state as CodecState) !== 'closed') encoder.close()
      }
      return { clip: new Blob([muxer.target.buffer], { type: 'video/mp4' }), problem: null }
    },
    cancel() {
      stopSampling()
      // Tear down without finalizing. encoder may be null (no frame ever landed)
      // or already closed by a preceding stop()/error — guard both.
      if (encoder && encoder.state !== 'closed') encoder.close()
    },
  }
}
