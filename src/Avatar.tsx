import './Avatar.css'

// A profile picture, or the person's initial when they haven't set one.
// Decorative: wherever it appears, the name is written beside it.
export default function Avatar({
  name,
  src,
  size = 28,
}: {
  name: string
  src: string | null
  size?: number
}) {
  const style = { width: size, height: size, fontSize: size * 0.45 }
  return src ? (
    <img className="avatar" src={src} alt="" style={style} />
  ) : (
    <span className="avatar" style={style} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  )
}
