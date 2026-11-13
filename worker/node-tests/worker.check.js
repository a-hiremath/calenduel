import test from 'node:test'
import assert from 'node:assert/strict'
import worker from '../src/index.js'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { createServer } from 'node:http'

test('unauthenticated or foreign-origin calls never invoke inference', async () => {
  let inferenceCalls = 0
  const env = { ALLOWED_ORIGIN: 'https://calenduel.com', AI: { run() { inferenceCalls++ } } }
  for (const [origin, auth, status] of [
    ['https://evil.example', '', 403],
    ['https://calenduel.com', '', 401],
    ['https://calenduel.com', 'Bearer invalid', 401],
  ]) {
    const response = await worker.fetch(new Request('https://worker/score', {
      method: 'POST', headers: { Origin: origin, Authorization: auth }, body: '{}',
    }), env)
    assert.equal(response.status, status)
    assert.equal(response.headers.get('Cache-Control'), 'no-store')
  }
  assert.equal(inferenceCalls, 0)
})

test('preflight permits only the app origin', async () => {
  const response = await worker.fetch(new Request('https://worker/score', {
    method: 'OPTIONS', headers: { Origin: 'https://calenduel.com' },
  }), { ALLOWED_ORIGIN: 'https://calenduel.com' })
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://calenduel.com')
})

test('valid signed requests are bounded, rate limited, and return only decisions', async () => {
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
    let calls = 0
    let lastInput = null
    const env = {
      ALLOWED_ORIGIN: 'https://calenduel.com', AUTH_ISSUER: issuer,
      JWKS_URL: `http://127.0.0.1:${server.address().port}/jwks`,
      LIMITER: { async limit() { return { success: true } } },
      AI: { async run(_, input) { calls++; lastInput = input; return { answers: { focus: {
        choice: 'on_task', probabilities: { on_task: .9, off_task: .05, unclear: .05 },
      } } } } },
    }
    const request = body => new Request('https://worker/score', {
      method: 'POST', headers: { Origin: 'https://calenduel.com', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    const body = { task: 'chem homework', image: 'data:image/jpeg;base64,/9j/2Q==' }
    let response = await worker.fetch(request(body), env)
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.choice, 'on_task')
    assert.equal(result.image, undefined)
    assert.equal(result.task, undefined)
    assert.equal(calls, 1)
    assert.equal(result.rubric, 'task-v2')
    assert.deepEqual(lastInput.images, [body.image])
    assert.match(lastInput.state, /Image 1 is the current computer screen/)
    assert.doesNotMatch(lastInput.state, /iPad/)
    // Laptop + iPad, iPad changed: the iPad alone decides.
    const ipad = 'data:image/jpeg;base64,/9j/4A=='
    response = await worker.fetch(request({ ...body, ipad, ipadChanged: true }), env)
    assert.equal(response.status, 200)
    const scored = await response.json()
    assert.equal(scored.rubric, 'task-v3')
    assert.equal(scored.source, 'ipad')
    assert.deepEqual(lastInput.images, [ipad])
    assert.match(lastInput.state, /iPad screen.*changed since the previous sample/)
    // First iPad sample (nothing to compare): the laptop decides, as in task-v2.
    response = await worker.fetch(request({ ...body, ipad, ipadChanged: null }), env)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).source, 'laptop')
    assert.deepEqual(lastInput.images, [body.image])
    assert.doesNotMatch(lastInput.state, /iPad/)
    assert.equal(calls, 3)
    for (const bad of [
      { ...body, ipad: 'data:image/png;base64,AAAA', ipadChanged: true },
      { ...body, ipad, ipadChanged: 'yes' },
      { ...body, ipad },
    ]) {
      response = await worker.fetch(request(bad), env)
      assert.equal(response.status, 400)
    }
    assert.equal(calls, 3)
    response = await worker.fetch(request({ ...body, task: 'x'.repeat(61) }), env)
    assert.equal(response.status, 400)
    response = await worker.fetch(request({ ...body, image: 'x'.repeat(500_000) }), env)
    assert.equal(response.status, 400) // one image over 400k characters
    response = await worker.fetch(request({ ...body, image: 'x'.repeat(900_000) }), env)
    assert.equal(response.status, 413)
    assert.equal((await response.json()).error, 'Frame too large')
    env.LIMITER.limit = async () => ({ success: false })
    response = await worker.fetch(request(body), env)
    assert.equal(response.status, 429)
    assert.equal((await response.json()).error, 'Too many frames. Please try again in a minute.')
    assert.equal(calls, 3)
  } finally { server.close() }
})

test('an unclear changed iPad falls back to the laptop; an unchanged one is ignored', async () => {
  const { scoreFrame } = await import('../src/index.js')
  const seen = []
  const answers = { ipad: 'unclear', laptop: 'off_task' }
  const ai = { async run(_, input) {
    const which = /iPad/.test(input.state) ? 'ipad' : 'laptop'
    seen.push(which)
    return { answers: { focus: { choice: answers[which],
      probabilities: { on_task: .1, off_task: .1, unclear: .1 } } } }
  } }
  const base = { task: 'chem', image: 'data:image/jpeg;base64,AA==', ipad: 'data:image/jpeg;base64,BB==' }
  let result = await scoreFrame(ai, 'chem', { ...base, ipadChanged: true })
  assert.deepEqual(seen, ['ipad', 'laptop'])
  assert.equal(result.choice, 'off_task')
  assert.equal(result.source, 'laptop')
  seen.length = 0
  answers.ipad = 'on_task'
  result = await scoreFrame(ai, 'chem', { ...base, ipadChanged: false })
  assert.deepEqual(seen, ['laptop']) // an old notes page never excuses the laptop
  assert.equal(result.choice, 'off_task')
  seen.length = 0
  result = await scoreFrame(ai, 'chem', { ...base, ipadChanged: true })
  assert.deepEqual(seen, ['ipad'])
  assert.equal(result.choice, 'on_task')
  // A malformed iPad answer falls back to the laptop; a malformed laptop answer is no answer.
  seen.length = 0
  const flaky = { async run(_, input) {
    const which = /iPad/.test(input.state) ? 'ipad' : 'laptop'
    seen.push(which)
    return which === 'ipad' ? { answers: {} } : { answers: { focus: { choice: 'on_task',
      probabilities: { on_task: .8, off_task: .1, unclear: .1 } } } }
  } }
  result = await scoreFrame(flaky, 'chem', { ...base, ipadChanged: true })
  assert.deepEqual(seen, ['ipad', 'laptop'])
  assert.equal(result.source, 'laptop')
  result = await scoreFrame({ async run() { return { answers: {} } } }, 'chem', base)
  assert.equal(result, null)
})

test('the second pass compares two frames with the tested anchor prompt and returns only a decision', async () => {
  const { compareFrame, anchorState, validCompareInput, RUBRIC_ANCHOR } = await import('../src/index.js')
  let input = null
  const ai = { async run(model, i) { input = i; return { answers: { focus: { choice: 'same_work',
    probabilities: { same_work: .8, different: .15, unclear: .05 } } } } } }
  const body = { task: 'cs3a p8', anchor: 'data:image/jpeg;base64,AA==', image: 'data:image/jpeg;base64,BB==' }
  const result = await compareFrame(ai, 'cs3a p8', body)
  assert.equal(result.choice, 'same_work')
  assert.equal(result.rubric, RUBRIC_ANCHOR)
  // The anchor goes first: the prompt calls it image 1.
  assert.deepEqual(input.images, [body.anchor, body.image])
  assert.equal(input.state, anchorState('cs3a p8'))
  assert.match(input.state, /^Declared session: cs3a p8\nImage 1 is the person's screen earlier/)
  assert.deepEqual(Object.keys(input.questions.focus.criteria), ['same_work', 'different', 'unclear'])
  // A first-pass answer shape is not a usable comparison.
  const wrong = { async run() { return { answers: { focus: { choice: 'on_task',
    probabilities: { on_task: .8, off_task: .1, unclear: .1 } } } } } }
  assert.equal(await compareFrame(wrong, 'cs3a p8', body), null)
  assert.ok(validCompareInput(body))
  for (const bad of [{ ...body, anchor: undefined }, { ...body, anchor: 'data:image/png;base64,AA==' },
    { ...body, task: '' }, { ...body, task: 'x'.repeat(61) }, { ...body, image: 'x'.repeat(400_001) }]) {
    assert.ok(!validCompareInput(bad))
  }
})

test('/compare is authenticated, shares the focus budget and returns only decisions', async () => {
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
    let calls = 0
    const keys = []
    const env = {
      ALLOWED_ORIGIN: 'https://calenduel.com', AUTH_ISSUER: issuer,
      JWKS_URL: `http://127.0.0.1:${server.address().port}/jwks`,
      LIMITER: { async limit({ key }) { keys.push(key); return { success: true } } },
      AI: { async run() { calls++; return { answers: { focus: { choice: 'different',
        probabilities: { same_work: .1, different: .85, unclear: .05 } } } } } },
    }
    const request = (body, auth = `Bearer ${token}`) => new Request('https://worker/compare', {
      method: 'POST', headers: { Origin: 'https://calenduel.com', Authorization: auth },
      body: JSON.stringify(body),
    })
    const body = { task: 'cs3a p8', anchor: 'data:image/jpeg;base64,/9j/2Q==', image: 'data:image/jpeg;base64,/9j/4A==' }
    let response = await worker.fetch(request(body, ''), env)
    assert.equal(response.status, 401)
    assert.equal(calls, 0)
    response = await worker.fetch(request(body), env)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { choice: 'different',
      probabilities: { same_work: .1, different: .85, unclear: .05 }, model: 'clef-flash', rubric: 'anchor-v1' })
    assert.deepEqual(keys, ['focus:user'])
    response = await worker.fetch(request({ task: 'cs3a p8', image: body.image }), env)
    assert.equal(response.status, 400)
    response = await worker.fetch(request({ ...body, anchor: 'x'.repeat(900_000) }), env)
    assert.equal(response.status, 413)
    assert.equal(calls, 1)
    response = await worker.fetch(new Request('https://worker/health'), env)
    assert.equal((await response.json()).anchorRubric, 'anchor-v1')
  } finally { server.close() }
})
