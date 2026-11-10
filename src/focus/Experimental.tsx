import './Experimental.css'

// Marks numbers that come from the focus model. They are estimates that
// haven't been checked against anyone's own account of their session.
export default function Experimental() {
  return (
    <span className="experimental">
      <span aria-hidden="true">⚠</span> Experimental
    </span>
  )
}
