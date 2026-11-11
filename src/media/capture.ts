// Browser capture: camera (getUserMedia) and screen (getDisplayMedia).
//
// Video-only by design: the end product is a silent timelapse, so we never
// request the microphone — one less permission prompt, and no audio track to
// manage or merge later.

// Ask the browser for the webcam. Triggers the permission prompt on first use;
// resolves once the user grants access (or rejects with their denial reason).
export async function startCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera capture is not supported in this browser')
  }
  return navigator.mediaDevices.getUserMedia({ video: true, audio: false })
}

// Ask the browser to share a screen, window, or tab. Like the camera this
// prompts for permission, but it MUST be called straight from a user gesture —
// awaiting anything first spends the gesture and the call throws. Video only.
export async function startScreen(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('Screen capture is not supported in this browser')
  }
  return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
}

// A second, independent share for a single window — e.g. QuickTime mirroring an
// iPad. displaySurface is only a hint (the picker opens on its Windows tab);
// the user can still pick anything. Same user-gesture rule as startScreen.
export async function startWindow(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('Screen capture is not supported in this browser')
  }
  return navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: 'window' },
    audio: false,
  })
}

// Stop every track so the OS releases the camera and the indicator light turns
// off. A MediaStream stays "live" until each of its tracks is individually
// stopped — dropping the reference alone is not enough.
export function stopStream(stream: MediaStream): void {
  stream.getTracks().forEach((track) => track.stop())
}
