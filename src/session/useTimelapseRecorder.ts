import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { startCamera, startScreen, stopStream } from '../media/capture'
import {
  startTimelapse,
  type TimelapseRecorder,
  type TimelapseResult,
} from '../media/timelapse'

// Encapsulates the camera + screen + timelapse lifecycle for a study session.
// Both streams live in STATE so that setting them mounts the face <video>;
// the effect then attaches the streams and starts frame sampling only once
// that element is actually in the DOM. (Attaching in the click handler would
// race a not-yet-mounted ref.)
//
// The screen feed is never shown on the page: a live preview of the screen
// you're capturing captures itself, an infinite hall of mirrors that also
// lands in the timelapse. It plays in a detached <video> the sampler reads.

interface Streams {
  face: MediaStream
  screen: MediaStream
}

export interface RecorderHandle {
  faceVideoRef: RefObject<HTMLVideoElement | null>
  // True once both feeds are live — gate the preview on this.
  streaming: boolean
  // Acquire screen + camera and start recording. Rejects if either is denied,
  // which the caller uses to block the session from starting.
  begin: () => Promise<void>
  // Stop recording, release both streams, and resolve with the timelapse clip
  // or the reason there isn't one.
  end: () => Promise<TimelapseResult>
}

// onInterrupted fires when the user ends the screen share from the browser's own
// "Stop sharing" UI mid-session — the caller should treat it like pressing Stop.
export function useTimelapseRecorder(onInterrupted: () => void): RecorderHandle {
  const faceVideoRef = useRef<HTMLVideoElement>(null)
  const timelapseRef = useRef<TimelapseRecorder | null>(null)
  const [streams, setStreams] = useState<Streams | null>(null)

  // Keep the latest callback in a ref so the track listener (attached once per
  // session) always calls the current handler without re-running the effect.
  const interruptedRef = useRef(onInterrupted)
  useEffect(() => {
    interruptedRef.current = onInterrupted
  }, [onInterrupted])

  // Attach + sample once the face <video> has mounted (effects run post-commit,
  // so the ref is guaranteed here). Cleanup covers normal stop and unmount, so
  // neither the camera light nor the screen share ever lingers.
  useEffect(() => {
    const face = faceVideoRef.current
    if (!streams || !face) return
    face.srcObject = streams.face
    // Safari doesn't always honour autoPlay when srcObject is set after mount,
    // which left the camera preview blank.
    void face.play().catch(() => {})
    // In the page but invisible, so it can't appear in its own capture. Some
    // browsers never deliver frames from a <video> that isn't in the document,
    // which left the timelapse empty. An explicit play() (not the autoplay
    // attribute) keeps the browser from pausing it as "not visible".
    const screen = document.createElement('video')
    screen.muted = true
    screen.playsInline = true
    screen.setAttribute('aria-hidden', 'true')
    Object.assign(screen.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '1px',
      height: '1px',
      opacity: '0',
      pointerEvents: 'none',
    })
    document.body.appendChild(screen)
    screen.srcObject = streams.screen
    void screen.play()
    const timelapse = startTimelapse(face, screen)
    timelapseRef.current = timelapse

    // The screen track ends if the user clicks the browser's "Stop sharing".
    const screenTrack = streams.screen.getVideoTracks()[0]
    const handleEnded = () => interruptedRef.current()
    screenTrack.addEventListener('ended', handleEnded)

    return () => {
      screenTrack.removeEventListener('ended', handleEnded)
      timelapse.cancel()
      timelapseRef.current = null
      screen.srcObject = null
      screen.remove()
      stopStream(streams.face)
      stopStream(streams.screen)
    }
  }, [streams])

  const begin = useCallback(async () => {
    // Screen first: getDisplayMedia needs the click's transient activation, and
    // awaiting the camera first would spend it. If the user cancels the screen
    // picker this throws and we never touch the camera.
    const screen = await startScreen()
    let face: MediaStream
    try {
      face = await startCamera()
    } catch (err) {
      stopStream(screen) // don't leave the screen share running on camera denial
      throw err
    }
    setStreams({ face, screen })
  }, [])

  const end = useCallback(async () => {
    // stop() clears the sampling timer synchronously, so releasing the streams
    // right after is safe — the lights go off while the final flush runs.
    const encoding =
      timelapseRef.current?.stop() ??
      Promise.resolve<TimelapseResult>({
        clip: null,
        problem: 'The recording never started, so no timelapse was saved.',
      })
    if (streams) {
      stopStream(streams.face)
      stopStream(streams.screen)
    }
    const result = await encoding
    setStreams(null) // unmounts the previews and fires the effect cleanup
    return result
  }, [streams])

  return {
    faceVideoRef,
    streaming: streams !== null,
    begin,
    end,
  }
}
