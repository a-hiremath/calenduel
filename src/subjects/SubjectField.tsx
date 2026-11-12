import { useRef, useState } from 'react'
import type { SessionMeta } from '../db'
import { applySubjectEdits, autoSortEnabled } from './sort'
import {
  SUBJECT_MAX,
  canonicalSubject,
  cleanSubject,
  isNamed,
  subjectOf,
} from './subjects'
import './Subjects.css'

// The datalist every SubjectField suggests from. Render it once per page.
export const SUBJECT_OPTIONS_ID = 'subject-options'

export function SubjectOptions({ subjects }: { subjects: string[] }) {
  const sorted = [...subjects].sort((a, b) => a.localeCompare(b))
  return (
    <datalist id={SUBJECT_OPTIONS_ID}>
      {sorted.map((s) => <option key={s} value={s} />)}
    </datalist>
  )
}

// A session's subject, editable in place like its name: type or pick one and
// it's yours from then on. Clearing it leaves the session unsorted on purpose.
// A background sort shows up as soon as you aren't typing in the field.
export default function SubjectField({ session, subjects }: {
  session: SessionMeta
  subjects: string[]
}) {
  const tag = subjectOf(session)
  const shown = tag?.name ?? ''
  const [value, setValue] = useState(shown)
  // What the field held when you clicked into it, or null when you aren't in it.
  const [editingFrom, setEditingFrom] = useState<string | null>(null)
  // The stored subject the field last showed. When it changes underneath
  // (a sort landed), show the new one, but never while you're typing.
  const [synced, setSynced] = useState(shown)
  if (editingFrom === null && synced !== shown) {
    setSynced(shown)
    setValue(shown)
  }
  // Escape blurs too; this keeps that blur from saving what was typed.
  const discard = useRef(false)

  // Reads the field itself: its value is current even if a re-render isn't.
  async function save(typedValue: string) {
    const from = editingFrom ?? shown
    setEditingFrom(null)
    if (discard.current) {
      discard.current = false
      setValue(shown)
      return
    }
    // Untouched, so a guess stays a guess (even one that landed meanwhile).
    if (cleanSubject(typedValue) === cleanSubject(from)) {
      setValue(shown)
      return
    }
    const typed = cleanSubject(typedValue)
    const name = typed ? canonicalSubject(typed, subjects) : null
    setValue(name ?? '')
    if ((name ?? '') === shown && tag?.by === 'you') return
    await applySubjectEdits([{ id: session.id, subject: { name, for: session.task, by: 'you' } }])
  }

  const waiting = !tag && isNamed(session.task) && autoSortEnabled()
  const placeholder = waiting ? 'Sorting…' : 'Add subject'
  // Monospace, so a width in ch follows the text, plus room for the caret.
  const width = `${(value || placeholder).length + 1}ch`
  return (
    <span className="subject-field">
      <input
        className="subject-input"
        aria-label="Subject"
        list={SUBJECT_OPTIONS_ID}
        maxLength={SUBJECT_MAX}
        autoComplete="off"
        placeholder={placeholder}
        style={{ width }}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setEditingFrom(value)}
        onBlur={(e) => void save(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            discard.current = true
            e.currentTarget.blur()
          }
        }}
      />
      {tag && tag.by !== 'you' && tag.name !== null && value === shown && (
        <span className="subject-auto" title="Picked automatically from the session name. Type to change it.">
          auto
        </span>
      )}
    </span>
  )
}
