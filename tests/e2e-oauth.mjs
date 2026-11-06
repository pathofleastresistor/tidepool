import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron } from 'playwright-core'

// OAuth sign-in to remote MCP servers, against a fake authorization server that also serves MCP.
// "open" registers Tidepool itself (DCR, like Linear or Notion); "closed" has no registration
// endpoint and wants a client ID and secret, like Google Workspace. The browser is stood in for by
// a fetch that follows the authorization server's redirect back to Tidepool.
// Run `npm run build` first.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-oauth-out-'))

// MARK: - Fake authorization server + MCP server

const issued = new Map() // access token → realm
const codes = new Map() // code → { realm, challenge, redirectUri, clientId }
const log = []
let revoked = []
let base = ''

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}
const readBody = (req) =>
  new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => resolve(body))
  })

/** Answers the few MCP requests Tidepool makes on connect, statelessly, with a JSON response. */
const mcp = (res, message, realm) => {
  if (!('id' in message)) {
    res.writeHead(202)
    return res.end()
  }
  const reply = (result) => json(res, 200, { jsonrpc: '2.0', id: message.id, result })
  if (message.method === 'initialize') {
    return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: `${realm}-server`, version: '1.0.0' } })
  }
  if (message.method === 'tools/list') {
    return reply({ tools: [{ name: `${realm}_whoami`, description: 'Says who you are', inputSchema: { type: 'object' } }] })
  }
  if (message.method === 'tools/call') return reply({ content: [{ type: 'text', text: `signed in to ${realm}` }] })
  json(res, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, base)
  const [, realm, ...rest] = url.pathname.split('/')
  const tail = '/' + rest.join('/')
  log.push(`${req.method} ${url.pathname}`)
  const issuer = `${base}/${realm}`

  // RFC 9728: protected resource metadata, at the path-inserted well-known URL.
  if (url.pathname.startsWith('/.well-known/oauth-protected-resource/')) {
    const r = url.pathname.split('/')[3]
    return json(res, 200, { resource: `${base}/${r}/mcp`, authorization_servers: [`${base}/${r}`], scopes_supported: ['read'] })
  }
  if (url.pathname.startsWith('/.well-known/oauth-authorization-server/')) {
    const r = url.pathname.split('/')[3]
    return json(res, 200, {
      issuer: `${base}/${r}`,
      authorization_endpoint: `${base}/${r}/authorize`,
      token_endpoint: `${base}/${r}/token`,
      revocation_endpoint: `${base}/${r}/revoke`,
      ...(r === 'open' ? { registration_endpoint: `${base}/${r}/register` } : {}),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic']
    })
  }
  if (url.pathname.startsWith('/.well-known/')) return json(res, 404, {})

  if (tail === '/register' && req.method === 'POST') {
    const meta = JSON.parse(await readBody(req))
    return json(res, 201, { ...meta, client_id: 'dcr-client' })
  }
  if (tail === '/authorize') {
    const p = url.searchParams
    const code = `code-${Math.random().toString(36).slice(2)}`
    codes.set(code, { realm, challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri'), clientId: p.get('client_id') })
    const back = new URL(p.get('redirect_uri'))
    back.searchParams.set('code', code)
    back.searchParams.set('state', p.get('state'))
    back.searchParams.set('iss', issuer)
    res.writeHead(302, { location: back.href })
    return res.end()
  }
  if (tail === '/token' && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req))
    let clientId = form.get('client_id')
    let secret = form.get('client_secret')
    const basic = req.headers.authorization?.match(/^Basic (.+)$/)
    if (basic) [clientId, secret] = Buffer.from(basic[1], 'base64').toString().split(':').map(decodeURIComponent)
    if (realm === 'closed' && (clientId !== 'my-client' || secret !== 'my-secret')) {
      return json(res, 401, { error: 'invalid_client', error_description: `bad client ${clientId}/${secret}` })
    }
    const grant = codes.get(form.get('code'))
    if (form.get('grant_type') !== 'authorization_code' || !grant || grant.realm !== realm || !form.get('code_verifier')) {
      return json(res, 400, { error: 'invalid_grant' })
    }
    codes.delete(form.get('code'))
    const token = `tok-${realm}-${Math.random().toString(36).slice(2)}`
    issued.set(token, realm)
    return json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 3600, refresh_token: `refresh-${token}` })
  }
  if (tail === '/revoke' && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req))
    revoked.push(form.get('token'))
    for (const [t] of issued) if (form.get('token') === `refresh-${t}`) issued.delete(t)
    res.writeHead(200)
    return res.end()
  }
  if (tail === '/mcp') {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]
    if (req.method !== 'POST') {
      res.writeHead(405)
      return res.end()
    }
    if (!token || issued.get(token) !== realm) {
      res.writeHead(401, {
        'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/${realm}/mcp"`
      })
      return res.end()
    }
    return mcp(res, JSON.parse(await readBody(req)), realm)
  }
  res.writeHead(404)
  res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
base = `http://127.0.0.1:${server.address().port}`

/** A free port for the sign-in to come back to, so the test doesn't depend on 33418 being free. */
const freePort = () =>
  new Promise((resolve) => {
    const s = http.createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
const redirectPort = await freePort()

// MARK: - App

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-oauth-'))
fs.writeFileSync(
  path.join(userDataDir, 'mcp.json'),
  JSON.stringify({
    mcpServers: {
      open: { url: `${base}/open/mcp`, oauth: { redirectPort } },
      closed: { url: `${base}/closed/mcp`, oauth: { redirectPort } }
    }
  })
)
const logs = []
const app = await _electron.launch({
  executablePath: electronPath,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `${REPO}/out/main/index.js`, `--user-data-dir=${userDataDir}`],
  env: { ...process.env, ANTHROPIC_API_KEY: 'test-key', TIDEPOOL_E2E: '1', ANTHROPIC_BASE_URL: `${base}/anthropic` }
})
app.process().stderr.on('data', (d) => logs.push(String(d)))
const win = await app.firstWindow()
win.on('pageerror', (e) => logs.push(`[renderer] ${e.message}\n`))

// Stand in for the browser: remember the URL, then follow its redirect back to Tidepool.
await app.evaluate(({ shell }) => {
  globalThis.__opened = []
  shell.openExternal = async (url) => {
    globalThis.__opened.push(url)
    await fetch(url)
  }
})
const opened = () => app.evaluate(() => globalThis.__opened)

let failed = false
const step = async (name, fn) => {
  try {
    await fn()
    console.log('PASS', name)
  } catch (e) {
    failed = true
    console.log('FAIL', name, '-', e.message.split('\n')[0])
    await win.screenshot({ path: `${OUT}/fail-${name.replace(/\W+/g, '_')}.png` }).catch(() => {})
  }
}
const assert = (cond, message) => {
  if (!cond) throw new Error(message)
}
const until = async (fn, label, ms = 8000) => {
  for (const start = Date.now(); Date.now() - start < ms; await win.waitForTimeout(100)) if (await fn()) return
  throw new Error(`timed out: ${label}`)
}
const status = async (name) => (await win.evaluate(() => window.api.mcp.getStatus())).find((s) => s.name === name)
const call = (server, tool) => win.evaluate(([s, t]) => window.api.mcp.callTool(s, t, {}), [server, tool])
const card = (name) => win.locator('.server-card', { has: win.locator('.server-card-title', { hasText: new RegExp(`^${name}\\b`) }) })

try {
  await step('servers that answer 401 wait for sign-in instead of failing', async () => {
    await until(async () => (await status('open'))?.status === 'needs-auth', 'open to need sign-in')
    await until(async () => (await status('closed'))?.status === 'needs-auth', 'closed to need sign-in')
    const open = await status('open')
    assert(!open.auth.signedIn && !open.auth.needsClient, JSON.stringify(open.auth))
    assert(open.auth.redirectUri === `http://127.0.0.1:${redirectPort}/callback`, open.auth.redirectUri)
    const closed = await status('closed')
    assert(closed.auth.needsClient, `closed should need a client: ${JSON.stringify(closed)}`)
    assert((await opened()).length === 0, 'a browser opened without the user asking')
  })

  await step('a tool call to a server that needs sign-in says so', async () => {
    const err = await call('open', 'open_whoami').then(() => null, (e) => e.message)
    assert(/needs you to sign in/.test(err ?? ''), `got ${err}`)
  })

  await step('Settings opens on MCP servers, with Sign in and Add client buttons', async () => {
    await win.locator('.nav-row[title^="Settings"]').click()
    await card('open').locator('button', { hasText: 'Sign in' }).waitFor({ timeout: 5000 })
    await card('closed').locator('button', { hasText: 'Add client' }).waitFor({ timeout: 5000 })
  })

  await step('Sign in registers Tidepool, opens the browser and connects', async () => {
    await card('open').locator('button', { hasText: 'Sign in' }).click()
    await until(async () => (await status('open'))?.status === 'connected', 'open to connect')
    const [url] = await opened()
    const auth = new URL(url)
    assert(auth.pathname === '/open/authorize', url)
    assert(auth.searchParams.get('client_id') === 'dcr-client', url)
    assert(auth.searchParams.get('code_challenge_method') === 'S256', url)
    assert(log.includes('POST /open/register'), 'no dynamic registration')
    assert((await status('open')).auth.signedIn, 'not marked signed in')
    const result = await call('open', 'open_whoami')
    assert(result.content[0].text === 'signed in to open', JSON.stringify(result))
    await card('open').locator('.dot.connected').waitFor({ timeout: 5000 })
  })

  await step('the tokens are stored encrypted, not in plain text', async () => {
    const dir = path.join(userDataDir, 'mcp-auth')
    const files = fs.readdirSync(dir)
    assert(files.length > 0, 'nothing saved')
    for (const f of files) assert(!fs.readFileSync(path.join(dir, f), 'utf8').includes('tok-open'), `${f} holds a token in plain text`)
  })

  await step('Add client takes a client ID and secret, and then Sign in works', async () => {
    await card('closed').locator('button', { hasText: 'Add client' }).click()
    const form = win.locator('.server-form')
    await form.locator('details.oauth-client[open]').waitFor({ timeout: 5000 })
    assert((await form.textContent()).includes(`127.0.0.1:${redirectPort}/callback`), 'redirect URI not shown')
    await form.getByLabel('Client ID').fill('my-client')
    await form.getByLabel('Client secret').fill('my-secret')
    await form.locator('button[type=submit]').click()
    await card('closed').locator('button', { hasText: 'Sign in' }).waitFor({ timeout: 8000 })
    const config = JSON.parse(fs.readFileSync(path.join(userDataDir, 'mcp.json'), 'utf8'))
    assert(config.mcpServers.closed.oauth.clientId === 'my-client', JSON.stringify(config.mcpServers.closed))
    assert(config.mcpServers.closed.oauth.redirectPort === redirectPort, 'redirectPort was dropped')
    assert(!JSON.stringify(config).includes('my-secret'), 'the secret was written to mcp.json')
    await card('closed').locator('button', { hasText: 'Sign in' }).click()
    await until(async () => (await status('closed'))?.status === 'connected', 'closed to connect')
    const result = await call('closed', 'closed_whoami')
    assert(result.content[0].text === 'signed in to closed', JSON.stringify(result))
  })

  await step('signing in again after a restart is not needed', async () => {
    const before = (await opened()).length
    await win.evaluate(() => window.api.mcp.reload())
    await until(async () => (await status('open'))?.status === 'connected' && (await status('closed'))?.status === 'connected', 'both to reconnect')
    assert((await opened()).length === before, 'asked to sign in again')
  })

  await step('a revoked token sends the server back to needing sign-in', async () => {
    for (const [t, realm] of issued) if (realm === 'closed') issued.delete(t)
    const err = await call('closed', 'closed_whoami').then(() => null, (e) => e.message)
    assert(/sign in/.test(err ?? ''), `got ${err}`)
    await until(async () => (await status('closed'))?.status === 'needs-auth', 'closed to need sign-in again')
  })

  await step('Sign out revokes the token and forgets it', async () => {
    revoked = []
    win.once('dialog', (d) => d.accept())
    await card('open').locator('.server-card-main').click()
    await card('open').locator('button', { hasText: 'Sign out' }).click()
    await until(async () => (await status('open'))?.status === 'needs-auth', 'open to be signed out')
    assert(revoked.some((t) => t.startsWith('refresh-tok-open')), `revoked ${revoked}`)
    assert(!(await status('open')).auth.signedIn, 'still signed in')
  })
} finally {
  await app.close().catch(() => {})
  server.close()
  if (failed) {
    console.log(`Screenshots in ${OUT}`)
    console.log(logs.join('').slice(-4000))
  }
  process.exit(failed ? 1 : 0)
}
