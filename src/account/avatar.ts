// Turns any picture into the small square the database accepts.

export const AVATAR_PX = 128

// Crops to the centre square, shrinks it, and returns a JPEG data URL of about
// 10 KB. Throws if the browser can't decode the file (a HEIC photo in Chrome).
export async function toAvatar(file: File): Promise<string> {
  let image: ImageBitmap
  try {
    image = await createImageBitmap(file)
  } catch {
    throw new Error("That file couldn't be read as a picture. Try a JPEG or PNG.")
  }
  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_PX
  canvas.height = AVATAR_PX
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error("This browser couldn't resize the picture.")

  // JPEG has no transparency: without a backdrop, see-through areas turn black.
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, AVATAR_PX, AVATAR_PX)
  const side = Math.min(image.width, image.height)
  ctx.drawImage(
    image,
    (image.width - side) / 2,
    (image.height - side) / 2,
    side,
    side,
    0,
    0,
    AVATAR_PX,
    AVATAR_PX,
  )
  image.close()
  return canvas.toDataURL('image/jpeg', 0.85)
}
