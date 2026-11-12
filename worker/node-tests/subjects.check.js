import test from 'node:test'
import assert from 'node:assert/strict'
import worker from '../src/index.js'
import {
  SUBJECT_MODEL, readSubjects, subjectKey, subjectsRequest, validSubjectsInput,
} from '../src/subjects.js'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { createServer } from 'node:http'

const reply = results => ({ response: { results } })

test('subject names are compared without case, spacing or punctuation', () => {
  assert.equal(subjectKey('CS10'), subjectKey('cs 10'))
  assert.equal(subjectKey('Math 2B'), subjectKey('MATH-2b'))
  assert.equal(subjectKey('Química'), 'quimica')
  assert.notEqual(subjectKey('Math 2B'), subjectKey('Math 2C'))
})

test('answers take the existing spelling, and new names merge within a batch', () => {
  const input = { titles: ['a', 'b', 'c', 'd', 'e'], subjects: ['CS 10', 'Other'] }
  const out = readSubjects(reply([
    { i: 0, subject: 'cs10' },
    { i: 1, subject: 'organic chemistry' },
    { i: 2, subject: 'Organic  Chemistry ' },
    { i: 3, subject: 'other' }, // a real subject of theirs, so kept
    { i: 4, subject: '' },
  ]), input)
  assert.deepEqual(out.subjects, ['CS 10', 'organic chemistry', 'organic chemistry', 'Other', null])
  assert.deepEqual(out.skipped, [])
})

test('placeholders are no subject; skipped and unusable answers are retried', () => {
  const input = { titles: ['a', 'b', 'c', 'd'], subjects: [] }
  assert.deepEqual(readSubjects(reply([
    { i: 0, subject: 'None' }, { i: 1, subject: 'x'.repeat(41) }, { i: 2, subject: 'Misc' },
    { i: 7, subject: 'Physics' }, { i: 0, subject: 'Physics' },
  ]), input), { subjects: [null, null, null, null], skipped: [1, 3] })
})

test('non-Latin subjects stay distinct', () => {
  const input = { titles: ['a', 'b'], subjects: ['物理'] }
  assert.deepEqual(readSubjects(reply([{ i: 0, subject: '物理' }, { i: 1, subject: '化学' }]), input).subjects,
    ['物理', '化学'])
  assert.equal(subjectKey('Физика'), 'физика')
})

test('the reply may be a JSON string, fenced, or in the chat-completions shape', () => {
  const input = { titles: ['kinematics'], subjects: ['Physics'] }
  const results = [{ i: 0, subject: 'physics' }]
  const want = { subjects: ['Physics'], skipped: [] }
  assert.deepEqual(readSubjects({ response: JSON.stringify({ results }) }, input), want)
  assert.deepEqual(readSubjects({ response: '```json\n' + JSON.stringify({ results }) + '\n```' }, input), want)
  assert.deepEqual(readSubjects({ choices: [{ message: { content: JSON.stringify({ results }) } }] }, input), want)
  assert.equal(readSubjects({ response: 'not json' }, input), null)
  assert.equal(readSubjects({}, input), null)
})

test('a reply covering under half the sessions is unusable', () => {
  const input = { titles: ['a', 'b', 'c', 'd'], subjects: [] }
  assert.equal(readSubjects(reply([{ i: 0, subject: 'Physics' }]), input), null)
  assert.ok(readSubjects(reply([{ i: 0, subject: 'Physics' }, { i: 1, subject: '' }]), input))
})

test('input bounds', () => {
  const ok = { titles: ['chem hw'], subjects: ['CS 10'], examples: [{ title: 'p6', subject: 'CS 3A' }] }
  assert.ok(validSubjectsInput(ok))
  assert.ok(validSubjectsInput({ titles: ['chem hw'], subjects: [] }))
  for (const bad of [
    null, {}, { ...ok, titles: [] }, { ...ok, titles: Array(26).fill('x') },
    { ...ok, titles: ['x'.repeat(61)] }, { ...ok, titles: ['  '] }, { ...ok, titles: [3] },
    { ...ok, subjects: ['x'.repeat(41)] }, { ...ok, subjects: Array(51).fill('s') },
    { ...ok, examples: [{ title: 'p6' }] }, { ...ok, examples: Array(81).fill(ok.examples[0]) },
  ]) assert.equal(validSubjectsInput(bad), false, JSON.stringify(bad)?.slice(0, 80))
})

test('a subject may say what it covers', () => {
  const input = { titles: ['triple integrals', 'chem'], subjects: [{ name: 'MATH 1D', about: 'multivariable calculus' }, 'CHEM 1A', { name: 'CS 3A', about: '' }] }
  assert.ok(validSubjectsInput(input))
  assert.equal(validSubjectsInput({ ...input, subjects: [{ name: 'X', about: 'y'.repeat(81) }] }), false)
  assert.equal(validSubjectsInput({ ...input, subjects: [{ about: 'no name' }] }), false)
  const sent = JSON.parse(subjectsRequest(input).messages[1].content.split('\n\n')[0])
  assert.deepEqual(sent.existing_subjects, [{ name: 'MATH 1D', covers: 'multivariable calculus' }, 'CHEM 1A', 'CS 3A'])
  assert.deepEqual(readSubjects(reply([{ i: 0, subject: 'math 1d' }, { i: 1, subject: 'chem 1a' }]), input).subjects, ['MATH 1D', 'CHEM 1A'])
})

test('the request turns reasoning off and constrains the output to the schema', () => {
  const request = subjectsRequest({ titles: ['a', 'b'], subjects: ['S'], examples: [{ title: 't', subject: 'S' }] })
  assert.deepEqual(request.chat_template_kwargs, { enable_thinking: false })
  assert.equal(request.response_format.type, 'json_schema')
  assert.equal(request.temperature, 0)
  const sent = JSON.parse(request.messages[1].content.split('\n\n')[0])
  assert.deepEqual(sent.sessions, [{ i: 0, name: 'a' }, { i: 1, name: 'b' }])
  assert.deepEqual(sent.examples, [{ session: 't', subject: 'S' }])
})

test('signed /subjects requests are bounded, separately limited, and return only subjects', async () => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA')
  const jwk = { ...await exportJWK(publicKey), kid: 'test', alg: 'EdDSA' }
  const server = createServer((_, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ keys: [jwk] }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const issuer = 'https://auth.example'
    const token = await new SignJWT({}).setProtectedHeader({ alg: 'EdDSA', kid: 'test' })
      .setSubject('user').setIssuer(issuer).setAudience(issuer)
      .setExpirationTime('5m').sign(privateKey)
    const models = []
    const limitKeys = []
    const env = {
      ALLOWED_ORIGIN: 'https://calenduel.com', AUTH_ISSUER: issuer,
      JWKS_URL: `http://127.0.0.1:${server.address().port}/jwks`,
      LIMITER: { async limit({ key }) { limitKeys.push(key); return { success: true } } },
      AI: { async run(model, input) {
        models.push(model)
        const { sessions } = JSON.parse(input.messages[1].content.split('\n\n')[0])
        return reply(sessions.map(s => ({ i: s.i, subject: /chem/.test(s.name) ? 'chem 1a' : '' })))
      } },
    }
    const request = (body, auth = `Bearer ${token}`) => new Request('https://worker/subjects', {
      method: 'POST', headers: { Origin: 'https://calenduel.com', Authorization: auth },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    let response = await worker.fetch(request({ titles: ['x'], subjects: [] }, ''), env)
    assert.equal(response.status, 401)
    assert.equal(models.length, 0)

    response = await worker.fetch(request({ titles: [' chem lab ', 'study'], subjects: ['CHEM 1A'] }), env)
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.deepEqual(result.subjects, ['CHEM 1A', null])
    assert.deepEqual(result.skipped, [])
    assert.deepEqual(Object.keys(result).sort(), ['rubric', 'skipped', 'subjects'])
    assert.deepEqual(models, [SUBJECT_MODEL])
    assert.deepEqual(limitKeys, ['subjects:user'])

    response = await worker.fetch(request({ titles: [], subjects: [] }), env)
    assert.equal(response.status, 400)
    response = await worker.fetch(request('x'.repeat(40_000)), env)
    assert.equal(response.status, 413)
    assert.equal(models.length, 1)

    env.AI.run = async () => ({ response: 'garbage' })
    response = await worker.fetch(request({ titles: ['chem'], subjects: [] }), env)
    assert.equal(response.status, 502)
    env.LIMITER.limit = async () => ({ success: false })
    response = await worker.fetch(request({ titles: ['chem'], subjects: [] }), env)
    assert.equal(response.status, 429)
  } finally { server.close() }
})
