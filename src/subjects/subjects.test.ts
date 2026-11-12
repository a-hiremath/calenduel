import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '../db'
import {
  canonicalSubject,
  cleanSubject,
  knownSubjects,
  localSubject,
  needsSorting,
  periodStartDay,
  removeUpdates,
  renameUpdates,
  resortUpdates,
  subjectExamples,
  subjectKey,
  subjectOf,
  subjectTotals,
  type SubjectTag,
} from './subjects'

const HOUR = 3_600_000
let nextId = 0
// Noon local time on `day`, so localDay() gives that day in any timezone.
function session(task: string, subject?: Partial<SubjectTag> | null, day = '2026-11-10', hours = 1): SessionMeta {
  return {
    id: `s${nextId++}`,
    startedAt: new Date(`${day}T12:00:00`).getTime() + nextId, // distinct, ordered
    task,
    goalMs: 0,
    elapsedMs: hours * HOUR,
    hasClip: false,
    subject: subject === undefined || subject === null ? undefined
      : { name: null, for: task, by: 'model', ...subject },
  }
}

describe('subjectKey', () => {
  it('ignores case, spacing, punctuation and letter-digit joins', () => {
    expect(subjectKey('CS10')).toBe('cs 10')
    expect(subjectKey(' MATH-2B ')).toBe('math 2 b')
    expect(subjectKey('Química')).toBe('quimica')
    expect(subjectKey('!!!')).toBe('')
  })
  it('keeps letters and digits of every script', () => {
    expect(subjectKey('物理')).toBe('物理')
    expect(subjectKey('Физика 2')).toBe('физика 2')
    expect(subjectKey('物理')).not.toBe(subjectKey('化学'))
  })
})

describe('cleanSubject and canonicalSubject', () => {
  it('tidies spacing and caps length', () => {
    expect(cleanSubject('  Organic   Chem ')).toBe('Organic Chem')
    expect(cleanSubject('x'.repeat(50))).toHaveLength(40)
  })
  it('takes the spelling you already have', () => {
    expect(canonicalSubject('cs10', ['CS 10', 'MATH 2B'])).toBe('CS 10')
    expect(canonicalSubject('Physics', ['CS 10'])).toBe('Physics')
  })
})

describe('subjectOf', () => {
  it('keeps a guess only for the name it was made for', () => {
    const s = session('chem hw', { name: 'CHEM 1A', by: 'model' })
    expect(subjectOf(s)?.name).toBe('CHEM 1A')
    expect(subjectOf({ ...s, task: 'chem lab' })).toBeUndefined()
    expect(needsSorting({ ...s, task: 'chem lab' })).toBe(true)
  })
  it('keeps your own choice through a rename', () => {
    const s = session('chem hw', { name: 'CHEM 1A', by: 'you' })
    expect(subjectOf({ ...s, task: 'anything' })?.name).toBe('CHEM 1A')
  })
  it('never sorts a session left with the default name', () => {
    expect(needsSorting(session('Study session'))).toBe(false)
    expect(needsSorting(session('  '))).toBe(false)
    expect(needsSorting(session('chem'))).toBe(true)
  })
})

describe('knownSubjects', () => {
  it('lists added subjects first, then subjects in use by recency, one spelling each', () => {
    const sessions = [
      session('a', { name: 'Physics' }, '2026-11-01'),
      session('b', { name: 'cs 10' }, '2026-11-05'),
      session('c', { name: 'CS10' }, '2026-11-02'),
      session('d', { name: null }),
    ]
    expect(knownSubjects(sessions, ['CHEM 1A', 'chem 1a'])).toEqual(['CHEM 1A', 'cs 10', 'Physics'])
  })
  it('ignores lapsed guesses', () => {
    const s = { ...session('old', { name: 'Gone' }), task: 'renamed' }
    expect(knownSubjects([s], [])).toEqual([])
  })
})

describe('localSubject', () => {
  const subjects = ['CS 10', 'MATH 2B', 'Math', 'CHEM 1A']

  it('remembers a name sorted before, preferring your choice', () => {
    const sessions = [
      session('lin alg', { name: 'Math', by: 'model' }, '2026-11-09'),
      session('Lin-Alg', { name: 'MATH 2B', by: 'you' }, '2026-11-01'),
    ]
    expect(localSubject('lin alg', sessions, subjects)).toBe('MATH 2B')
  })
  it('remembers "no subject" too', () => {
    expect(localSubject('study', [session('Study', { name: null, by: 'model' })], subjects)).toBeNull()
  })
  it('finds a subject named inside the title, longest match first', () => {
    expect(localSubject('cs10 unitary operators', [], subjects)).toBe('CS 10')
    expect(localSubject('math 2b quiz', [], subjects)).toBe('MATH 2B')
    expect(localSubject('math review', [], subjects)).toBe('Math')
  })
  it('matches whole words only', () => {
    expect(localSubject('chemistry lab', [], ['Chem'])).toBeUndefined()
    expect(localSubject('cs 100 project', [], ['CS 10'])).toBeUndefined()
  })
  it('keeps course codes whole', () => {
    expect(localSubject('physics 4c', [], ['C'])).toBeUndefined()
    expect(localSubject('math 2b hw', [], ['Math 2'])).toBeUndefined()
    expect(localSubject('cs10 lab', [], ['CS 10'])).toBe('CS 10')
    expect(localSubject('chem 1a lab report', [], ['CHEM 1A'])).toBe('CHEM 1A')
    expect(localSubject('math 2b 3.3 homework', [], ['MATH 2B'])).toBe('MATH 2B')
    expect(localSubject('CS-10 review', [], ['cs10'])).toBe('cs10')
  })
  it('finds non-Latin subjects', () => {
    expect(localSubject('物理 作业', [], ['物理', '化学'])).toBe('物理')
  })
  it('lets a subject claim a name the model called vague, but not one you did', () => {
    const guessed = [session('orgo ch5', { name: null, by: 'model' })]
    expect(localSubject('orgo ch5', guessed, ['Orgo'])).toBe('Orgo')
    expect(localSubject('orgo ch5', guessed, [])).toBeNull()
    const yours = [session('orgo ch5', { name: null, by: 'you' })]
    expect(localSubject('orgo ch5', yours, ['Orgo'])).toBeNull()
  })
  it('remembers your choice for the name you made it for, not a later rename', () => {
    const renamed = { ...session('chem hw', { name: 'CHEM 1A', by: 'you' }), task: 'physics hw' }
    expect(localSubject('physics hw', [renamed], ['CHEM 1A'])).toBeUndefined()
    expect(localSubject('chem hw', [renamed], ['CHEM 1A'])).toBe('CHEM 1A')
    expect(subjectExamples([renamed])).toEqual([{ title: 'chem hw', subject: 'CHEM 1A' }])
  })
  it('leaves a name that mentions two separate subjects to the model', () => {
    expect(localSubject('physics and chem', [], ['Physics', 'Chem'])).toBeUndefined()
    expect(localSubject('organic chemistry ch 5', [], ['Organic', 'Organic Chemistry'])).toBe('Organic Chemistry')
  })
  it('leaves everything else to the model', () => {
    expect(localSubject('eigenvalues', [], subjects)).toBeUndefined()
  })
})

describe('subjectExamples', () => {
  it('takes your choices first, a few per subject, one per distinct name', () => {
    const sessions = [
      ...['a', 'b', 'c', 'd'].map((t) => session(`cs ${t}`, { name: 'CS 10', by: 'model' })),
      session('quantum', { name: 'CS 10', by: 'you' }, '2026-10-01'),
      session('cs a', { name: 'CS 10', by: 'model' }),
      session('vague', { name: null, by: 'model' }),
      session('Study session', { name: 'CS 10', by: 'you' }),
    ]
    const examples = subjectExamples(sessions)
    expect(examples[0]).toEqual({ title: 'quantum', subject: 'CS 10' })
    expect(examples).toHaveLength(3)
    expect(new Set(examples.map((e) => e.title)).size).toBe(3)
  })
})

describe('subjectTotals', () => {
  it('adds time per subject in the period, most first, unsorted last', () => {
    const sessions = [
      session('a', { name: 'CS 10' }, '2026-11-10', 2),
      session('b', { name: 'cs10' }, '2026-11-09', 1),
      session('c', { name: 'CHEM 1A' }, '2026-11-08', 4),
      session('d', null, '2026-11-10', 5), // not sorted yet
      session('e', { name: 'CHEM 1A' }, '2026-10-01', 9), // before the window
    ]
    const totals = subjectTotals(sessions, periodStartDay('week', '2026-11-10'))
    expect(totals.map((t) => [t.name, t.ms / HOUR, t.sessions])).toEqual([
      ['CHEM 1A', 4, 1],
      ['CS 10', 3, 2],
      [null, 5, 1],
    ])
    expect(subjectTotals(sessions, null)[0]).toMatchObject({ name: 'CHEM 1A', ms: 13 * HOUR })
  })
  it('uses whole days, the same as Stats', () => {
    expect(periodStartDay('week', '2026-11-10')).toBe('2026-11-04')
    expect(periodStartDay('month', '2026-11-10')).toBe('2026-10-12')
    expect(periodStartDay('all', '2026-11-10')).toBeNull()
  })
})

describe('editing subjects', () => {
  const sessions = [
    session('a', { name: 'Chem', by: 'model' }),
    session('b', { name: 'chem', by: 'you' }),
    session('c', { name: 'CS 10', by: 'match' }),
    { ...session('d', { name: 'Chem', by: 'model' }), task: 'renamed' }, // lapsed
  ]
  it('renames every session in force, keeping who chose it', () => {
    const updates = renameUpdates(sessions, 'CHEM', 'CHEM 1A')
    expect(updates.map((u) => [u.id, u.subject?.name, u.subject?.by])).toEqual([
      [sessions[0].id, 'CHEM 1A', 'model'],
      [sessions[1].id, 'CHEM 1A', 'you'],
    ])
  })
  it('removes a subject by marking its sessions unsorted on purpose', () => {
    const updates = removeUpdates(sessions, 'chem')
    expect(updates).toHaveLength(2)
    expect(updates.every((u) => u.subject?.name === null && u.subject.by === 'you')).toBe(true)
  })
  it('sorting again forgets guesses but not your choices', () => {
    expect(resortUpdates(sessions, true).map((u) => u.id)).toEqual(
      [sessions[0].id, sessions[2].id, sessions[3].id])
  })
  it('with the model off, sorting again redoes only local matches', () => {
    expect(resortUpdates(sessions, false).map((u) => u.id)).toEqual([sessions[2].id])
  })
})
