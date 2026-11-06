import { app, safeStorage } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens
} from '@modelcontextprotocol/client'

/** Where the authorization server sends the browser back to, unless a server's config picks another port. */
export const DEFAULT_REDIRECT_PORT = 33418
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

/** One server's OAuth state, kept in an encrypted file so tokens never sit on disk in plain text. */
interface AuthRecord {
  /** The server URL these credentials were issued for; a new URL starts over. */
  url?: string
  /** A pre-registered client's secret, entered in Settings rather than kept in mcp.json. */
  clientSecret?: string
  /** The pre-registered client ID the stamp below belongs to. */
  configuredClientId?: string
  configuredIssuer?: string
  /** A client registered dynamically (DCR). */
  client?: StoredOAuthClientInformation
  tokens?: StoredOAuthTokens
  codeVerifier?: string
  state?: string
  discovery?: OAuthDiscoveryState
}

function authDir(): string {
  const dir = join(app.getPath('userData'), 'mcp-auth')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Reads and writes one server's AuthRecord, caching it in memory. */
export class AuthStore {
  private cache?: AuthRecord

  constructor(private readonly key: string) {}

  private get path(): string {
    return join(authDir(), `${this.key}.bin`)
  }

  read(): AuthRecord {
    if (this.cache) return this.cache
    let record: AuthRecord = {}
    if (existsSync(this.path)) {
      try {
        const buf = readFileSync(this.path)
        const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8')
        record = JSON.parse(text) as AuthRecord
      } catch (err) {
        console.error(`Couldn't read the saved sign-in for ${this.key}`, err)
      }
    }
    this.cache = record
    return record
  }

  update(patch: Partial<AuthRecord>): void {
    const next: AuthRecord = { ...this.read(), ...patch }
    for (const k of Object.keys(next) as Array<keyof AuthRecord>) if (next[k] === undefined) delete next[k]
    this.cache = next
    const text = JSON.stringify(next)
    const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8')
    writeFileSync(this.path, buf, { mode: 0o600 })
  }

  /** Forgets everything but the client secret, which belongs to the user's client and not to a sign-in. */
  reset(): void {
    this.update({
      configuredIssuer: undefined,
      client: undefined,
      tokens: undefined,
      codeVerifier: undefined,
      state: undefined,
      discovery: undefined
    })
  }

  delete(): void {
    this.cache = undefined
    rmSync(this.path, { force: true })
  }
}

export interface OAuthOptions {
  url: string
  clientId?: string
  redirectPort?: number
}

/**
 * Hands the SDK what it needs to sign in to one server: storage, where to redirect, and who we are.
 * The SDK does discovery, registration, PKCE and refresh itself. It calls redirectToAuthorization
 * whenever it needs the user, including while connecting at startup, so that only records the URL;
 * the browser opens when the user clicks Sign in.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  constructor(
    readonly store: AuthStore,
    private readonly opts: OAuthOptions,
    private readonly onAuthorizationUrl: (url: URL) => void
  ) {
    const record = store.read()
    if (record.url !== opts.url) {
      store.reset()
      store.update({ url: opts.url })
    }
    if (record.configuredClientId !== opts.clientId) store.update({ configuredClientId: opts.clientId, configuredIssuer: undefined })
  }

  get port(): number {
    return this.opts.redirectPort ?? DEFAULT_REDIRECT_PORT
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}/callback`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Tidepool',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }
  }

  state(): string {
    const state = randomBytes(16).toString('base64url')
    this.store.update({ state })
    return state
  }

  expectedState(): string | undefined {
    return this.store.read().state
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    const record = this.store.read()
    if (this.opts.clientId) {
      return {
        client_id: this.opts.clientId,
        ...(record.clientSecret ? { client_secret: record.clientSecret } : {}),
        ...(record.configuredIssuer ? { issuer: record.configuredIssuer } : {})
      }
    }
    return record.client
  }

  saveClientInformation(info: StoredOAuthClientInformation): void {
    // A pre-registered client only needs the issuer the SDK stamped on it.
    if (this.opts.clientId) this.store.update({ configuredIssuer: info.issuer })
    else this.store.update({ client: info })
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.store.read().tokens
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.store.update({ tokens, codeVerifier: undefined, state: undefined })
  }

  redirectToAuthorization(url: URL): void {
    // Google only hands out a refresh token when asked for offline access, and only on consent.
    if (url.hostname === 'accounts.google.com') {
      url.searchParams.set('access_type', 'offline')
      url.searchParams.set('prompt', 'consent')
    }
    this.onAuthorizationUrl(url)
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.store.update({ codeVerifier })
  }

  codeVerifier(): string {
    const verifier = this.store.read().codeVerifier
    if (!verifier) throw new Error('No sign-in is under way for this server')
    return verifier
  }

  saveDiscoveryState(discovery: OAuthDiscoveryState): void {
    this.store.update({ discovery })
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.store.read().discovery
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    if (scope === 'all') return this.store.reset()
    if (scope === 'client') return this.store.update({ client: undefined, configuredIssuer: undefined })
    if (scope === 'tokens') return this.store.update({ tokens: undefined })
    if (scope === 'verifier') return this.store.update({ codeVerifier: undefined, state: undefined })
    this.store.update({ discovery: undefined })
  }

  /** Asks the authorization server to revoke the refresh token, if it has a revocation endpoint. */
  async revoke(): Promise<void> {
    const record = this.store.read()
    const endpoint = (record.discovery?.authorizationServerMetadata as { revocation_endpoint?: string } | undefined)
      ?.revocation_endpoint
    const token = record.tokens?.refresh_token ?? record.tokens?.access_token
    const client = this.clientInformation()
    if (!endpoint || !token || !client) return
    const body = new URLSearchParams({ token, client_id: client.client_id })
    if (client.client_secret) body.set('client_secret', client.client_secret)
    await fetch(endpoint, { method: 'POST', body, signal: AbortSignal.timeout(5000) }).catch(() => {})
  }
}

const page = (title: string, detail: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#333">` +
  `<div style="text-align:center"><h2 style="font-weight:600">${title}</h2><p>${detail}</p></div>`

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/**
 * Listens on 127.0.0.1 for the one redirect back from the authorization server and resolves with
 * its query parameters. Rejects on a state mismatch, an error from the server, a timeout, or abort.
 */
export function waitForCallback(
  port: number,
  expectedState: string | undefined,
  signal: AbortSignal
): { ready: Promise<void>; result: Promise<URLSearchParams> } {
  let markReady!: () => void
  let failReady!: (err: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve
    failReady = reject
  })
  const result = new Promise<URLSearchParams>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const params = url.searchParams
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      if (expectedState && params.get('state') !== expectedState) {
        res.end(page('Sign-in failed', 'This sign-in link is out of date. Go back to Tidepool and try again.'))
        return finish(new Error('The sign-in response did not match this request. Try again.'))
      }
      const error = params.get('error')
      if (error) {
        const description = params.get('error_description') ?? error
        res.end(page('Sign-in failed', escapeHtml(description)))
        return finish(new Error(`Sign-in failed: ${description}`))
      }
      if (!params.get('code')) {
        res.end(page('Sign-in failed', 'No authorization code came back.'))
        return finish(new Error('Sign-in failed: no authorization code came back'))
      }
      res.end(page('Signed in', 'You can close this tab and go back to Tidepool.'))
      finish(undefined, params)
    })

    const timer = setTimeout(() => finish(new Error('Sign-in timed out')), SIGN_IN_TIMEOUT_MS)
    const onAbort = (): void => finish(new Error('Sign-in cancelled'))
    signal.addEventListener('abort', onAbort)

    function finish(err: Error | undefined, params?: URLSearchParams): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      server.close()
      server.closeAllConnections()
      if (err) reject(err)
      else resolve(params!)
    }

    server.once('error', (err: NodeJS.ErrnoException) => {
      const e =
        err.code === 'EADDRINUSE'
          ? new Error(`Port ${port} is in use, so the sign-in can't come back to Tidepool. Set "oauth": { "redirectPort": … } for this server.`)
          : err
      failReady(e)
      finish(e)
    })
    server.listen(port, '127.0.0.1', markReady)
  })
  // The caller awaits `ready` first; a failure there is also reported through it.
  result.catch(() => {})
  return { ready, result }
}
