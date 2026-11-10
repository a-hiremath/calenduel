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
    const env = {
      ALLOWED_ORIGIN: 'https://calenduel.com', AUTH_ISSUER: issuer,
      JWKS_URL: `http://127.0.0.1:${server.address().port}/jwks`,
      LIMITER: { async limit() { return { success: true } } },
      AI: { async run() { calls++; return { answers: { focus: {
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
    response = await worker.fetch(request({ ...body, task: 'x'.repeat(61) }), env)
    assert.equal(response.status, 400)
    response = await worker.fetch(request({ ...body, image: 'x'.repeat(500_000) }), env)
    assert.equal(response.status, 413)
    env.LIMITER.limit = async () => ({ success: false })
    response = await worker.fetch(request(body), env)
    assert.equal(response.status, 429)
    assert.equal(calls, 1)
  } finally { server.close() }
})
