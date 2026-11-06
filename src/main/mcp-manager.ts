import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type Resource,
  type Tool,
  type Transport
} from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'
import { shell } from 'electron'
import type { McpServerConfig, ServerAuth, ServerStatus, ToolSummary, UiResource } from '@shared/types'
import { AuthStore, McpOAuthProvider, waitForCallback } from './mcp-auth'
import { readMcpConfig } from './settings'

const CLIENT_INFO = { name: 'tidepool', version: '0.1.0' }
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app'
const MAX_STDERR_LINES = 200

/** Reads the MCP Apps UI resource URI from a tool, supporting both the current and legacy _meta keys. */
function uiResourceUriOf(tool: Tool): string | undefined {
  const meta = tool._meta as Record<string, unknown> | undefined
  const ui = meta?.ui as { resourceUri?: unknown } | undefined
  const uri = ui?.resourceUri ?? meta?.['ui/resourceUri']
  return typeof uri === 'string' && uri.startsWith('ui://') ? uri : undefined
}

function visibilityOf(tool: Tool): Array<'model' | 'app'> {
  const ui = (tool._meta as Record<string, unknown> | undefined)?.ui as
    | { visibility?: unknown }
    | undefined
  const v = ui?.visibility
  return Array.isArray(v) && v.length > 0 ? (v as Array<'model' | 'app'>) : ['model', 'app']
}

/** Hostname-safe, stable key per server name; each server's apps get their own sandbox origin. */
export function serverKey(name: string): string {
  return 's' + createHash('sha256').update(name).digest('hex').slice(0, 16)
}

interface Connection {
  name: string
  key: string
  config: McpServerConfig
  client?: Client
  status: ServerStatus['status']
  error?: string
  tools: Tool[]
  resources: Resource[]
  stderr: string[]
  oauth?: {
    provider: McpOAuthProvider
    /** Where to send the browser to sign in, recorded when the server last asked for it. */
    authorizationUrl?: URL
    needsClient: boolean
    signIn?: AbortController
  }
}

/** Remote servers sign in with OAuth unless their config says "oauth": false. */
function oauthFor(conn: Connection, onUrl: (url: URL) => void): Connection['oauth'] {
  const cfg = conn.config
  if (!('url' in cfg) || cfg.oauth === false) return undefined
  const provider = new McpOAuthProvider(
    new AuthStore(conn.key),
    { url: cfg.url, clientId: cfg.oauth?.clientId, redirectPort: cfg.oauth?.redirectPort },
    onUrl
  )
  return { provider, needsClient: false }
}

const NO_DCR = /does not support dynamic client registration/i

function authSummary(oauth: NonNullable<Connection['oauth']>): ServerAuth {
  const record = oauth.provider.store.read()
  return {
    signedIn: Boolean(record.tokens),
    signingIn: Boolean(oauth.signIn),
    needsClient: oauth.needsClient,
    hasClientSecret: Boolean(record.clientSecret),
    redirectUri: oauth.provider.redirectUrl
  }
}

export class McpManager extends EventEmitter {
  private connections = new Map<string, Connection>()
  /** The (re)connect under way, if any. */
  private loading: Promise<void> | null = null
  private loaded = false
  private firstLoadDone!: () => void
  /** Settles when the servers have been connected once, at startup. */
  private firstLoad = new Promise<void>((resolve) => (this.firstLoadDone = resolve))

  /**
   * Resolves once no (re)connect is under way. Calls wait for it rather than failing: a saved
   * chat's apps can load before the servers have connected at startup, and changing the config
   * reconnects every server while an app may be using one.
   */
  private async settled(): Promise<void> {
    await this.firstLoad
    while (this.loading) await this.loading
  }

  /** Connects the servers at startup, unless editing them in Settings already has. */
  async loadIfNeeded(): Promise<void> {
    if (!this.loaded) await this.loadFromConfig()
  }

  /** (Re)connects every server in mcp.json. Existing connections are closed first. */
  async loadFromConfig(): Promise<void> {
    this.loaded = true
    const run = this.reconnectAll()
    this.loading = run
    try {
      await run
    } finally {
      if (this.loading === run) this.loading = null
      this.firstLoadDone()
    }
  }

  private async reconnectAll(): Promise<void> {
    await this.closeAll()
    let servers: Record<string, McpServerConfig>
    try {
      servers = readMcpConfig().mcpServers
    } catch (err) {
      console.error('Failed to read mcp.json', err)
      servers = {}
    }
    for (const [name, config] of Object.entries(servers)) this.connections.set(name, this.newConnection(name, config))
    this.emitStatus()
    await Promise.all(
      [...this.connections.values()].filter((c) => c.status === 'connecting').map((c) => this.connect(c))
    )
  }

  private newConnection(name: string, config: McpServerConfig): Connection {
    const conn: Connection = {
      name,
      key: serverKey(name),
      config,
      status: config.disabled ? 'disabled' : 'connecting',
      tools: [],
      resources: [],
      stderr: []
    }
    conn.oauth = oauthFor(conn, (url) => {
      if (conn.oauth) conn.oauth.authorizationUrl = url
    })
    return conn
  }

  /** Closes one server and connects it again from mcp.json, leaving the others alone. */
  async reconnect(name: string): Promise<void> {
    await this.settled()
    const old = this.connections.get(name)
    const config = readMcpConfig().mcpServers[name]
    if (!old || !config) return
    old.oauth?.signIn?.abort()
    const conn = this.newConnection(name, config)
    this.connections.set(name, conn)
    this.emitStatus()
    await old.client?.close().catch(() => {})
    if (conn.status === 'connecting') await this.connect(conn)
  }

  private async connect(conn: Connection): Promise<void> {
    const client = new Client(CLIENT_INFO, {
      capabilities: {
        // Advertise MCP Apps support so servers expose their UI tools/resources.
        extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [MCP_APP_MIME_TYPE] } }
      } as Record<string, unknown>,
      listChanged: {
        tools: {
          onChanged: (err, tools) => {
            if (!err && tools) {
              conn.tools = tools
              this.emitStatus()
            }
          }
        }
      }
    })
    try {
      await client.connect(this.createTransport(conn))
      conn.client = client
      conn.tools = (await client.listTools()).tools
      if (client.getServerCapabilities()?.resources) {
        conn.resources = (await client.listResources()).resources
      }
      conn.status = 'connected'
      conn.error = undefined
      client.onclose = () => {
        if (conn.client === client) {
          conn.status = 'error'
          conn.error = 'Connection closed'
          conn.client = undefined
          this.emitStatus()
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (conn.oauth && UnauthorizedError.isInstance(err)) {
        conn.status = 'needs-auth'
        conn.error = undefined
      } else if (conn.oauth && NO_DCR.test(message)) {
        conn.status = 'needs-auth'
        conn.oauth.needsClient = true
        conn.error =
          "This server can't register Tidepool by itself. Create an OAuth client with its provider, then click Add client and paste its ID and secret."
      } else {
        conn.status = 'error'
        conn.error = message
      }
      await client.close().catch(() => {})
    }
    this.emitStatus()
  }

  /**
   * Opens the browser at the server's sign-in page, waits for it to redirect back to 127.0.0.1,
   * trades the code for tokens and reconnects. Only one sign-in runs at a time: they share a port.
   */
  async signIn(name: string): Promise<void> {
    await this.settled()
    for (const c of this.connections.values()) c.oauth?.signIn?.abort()
    let conn = this.connections.get(name)
    if (!conn?.oauth) throw new Error(`"${name}" doesn't use sign-in`)
    if (!conn.oauth.authorizationUrl) {
      // Signed out, or the URL went stale; connecting again makes the SDK produce a fresh one.
      await this.reconnect(name)
      conn = this.connections.get(name)
      if (conn?.status === 'connected') return
      if (!conn?.oauth?.authorizationUrl) throw new Error(conn?.error ?? `"${name}" didn't ask for a sign-in`)
    }
    const oauth = conn.oauth!
    const abort = new AbortController()
    oauth.signIn = abort
    this.emitStatus()
    try {
      const { ready, result } = waitForCallback(oauth.provider.port, oauth.provider.expectedState(), abort.signal)
      await ready
      await shell.openExternal(oauth.authorizationUrl!.href)
      const params = await result
      const cfg = conn.config as Extract<McpServerConfig, { url: string }>
      await this.transportFor(cfg, oauth.provider).finishAuth(params)
    } finally {
      if (oauth.signIn === abort) oauth.signIn = undefined
      this.emitStatus()
    }
    await this.reconnect(name)
  }

  cancelSignIn(name: string): void {
    this.connections.get(name)?.oauth?.signIn?.abort()
  }

  /** Forgets the server's tokens (revoking them where the server allows) and reconnects, signed out. */
  async signOut(name: string): Promise<void> {
    const oauth = this.connections.get(name)?.oauth
    if (!oauth) return
    await oauth.provider.revoke()
    oauth.provider.store.reset()
    await this.reconnect(name)
  }

  /** Saves (or with "", removes) a pre-registered client's secret. */
  setClientSecret(name: string, secret: string): void {
    const store = this.connections.get(name)?.oauth?.provider.store ?? new AuthStore(serverKey(name))
    store.update({ clientSecret: secret.trim() || undefined })
  }

  private transportFor(
    cfg: Extract<McpServerConfig, { url: string }>,
    authProvider?: McpOAuthProvider
  ): SSEClientTransport | StreamableHTTPClientTransport {
    const url = new URL(cfg.url)
    const requestInit = cfg.headers ? { headers: cfg.headers } : undefined
    return cfg.transport === 'sse'
      ? new SSEClientTransport(url, { requestInit, authProvider })
      : new StreamableHTTPClientTransport(url, { requestInit, authProvider })
  }

  private createTransport(conn: Connection): Transport {
    const cfg = conn.config
    if ('url' in cfg) return this.transportFor(cfg, conn.oauth?.provider)
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      cwd: cfg.cwd,
      env: { ...getDefaultEnvironment(), PATH: process.env.PATH ?? '', ...cfg.env },
      stderr: 'pipe'
    })
    transport.stderr?.on('data', (chunk: Buffer) => {
      conn.stderr.push(...chunk.toString('utf8').split('\n').filter(Boolean))
      if (conn.stderr.length > MAX_STDERR_LINES) conn.stderr.splice(0, conn.stderr.length - MAX_STDERR_LINES)
    })
    return transport
  }

  async closeAll(): Promise<void> {
    const conns = [...this.connections.values()]
    this.connections.clear()
    await Promise.all(conns.map((c) => c.client?.close().catch(() => {})))
  }

  getStatus(): ServerStatus[] {
    return [...this.connections.values()].map((c) => ({
      name: c.name,
      key: c.key,
      status: c.status,
      error: c.error,
      serverInfo: c.client?.getServerVersion(),
      instructions: c.client?.getInstructions(),
      tools: c.tools.map(
        (t): ToolSummary => ({
          name: t.name,
          title: t.title,
          description: t.description,
          uiResourceUri: uiResourceUriOf(t),
          visibility: visibilityOf(t)
        })
      ),
      resourceCount: c.resources.length,
      auth: c.oauth && authSummary(c.oauth),
      stderr: c.stderr.slice(-50)
    }))
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus())
  }

  /** Every connected tool the model is allowed to see (MCP Apps "app"-only tools are hidden). */
  modelTools(): Array<{ server: string; key: string; tool: Tool; uiResourceUri?: string }> {
    const out: Array<{ server: string; key: string; tool: Tool; uiResourceUri?: string }> = []
    for (const c of this.connections.values()) {
      if (c.status !== 'connected') continue
      for (const tool of c.tools) {
        if (!visibilityOf(tool).includes('model')) continue
        out.push({ server: c.name, key: c.key, tool, uiResourceUri: uiResourceUriOf(tool) })
      }
    }
    return out
  }

  serverInstructions(): Array<{ server: string; instructions: string }> {
    const out: Array<{ server: string; instructions: string }> = []
    for (const c of this.connections.values()) {
      const instructions = c.client?.getInstructions()
      if (instructions) out.push({ server: c.name, instructions })
    }
    return out
  }

  private async requireClient(server: string): Promise<{ conn: Connection; client: Client }> {
    await this.settled()
    const conn = this.connections.get(server)
    if (conn?.status === 'needs-auth') {
      throw new Error(`MCP server "${server}" needs you to sign in. Open Settings → MCP servers and click Sign in.`)
    }
    if (!conn?.client) throw new Error(`MCP server "${server}" is not connected`)
    return { conn, client: conn.client }
  }

  /** A call that finds the sign-in gone (refresh refused, access revoked) sends the server back to needs-auth. */
  private async guard<T>(conn: Connection, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (err) {
      if (conn.oauth && UnauthorizedError.isInstance(err) && this.connections.get(conn.name) === conn) {
        conn.status = 'needs-auth'
        const client = conn.client
        conn.client = undefined
        this.emitStatus()
        await client?.close().catch(() => {})
        throw new Error(`MCP server "${conn.name}" needs you to sign in again. Open Settings → MCP servers and click Sign in.`)
      }
      throw err
    }
  }

  async callTool(
    server: string,
    name: string,
    args: Record<string, unknown>,
    opts: { fromApp?: boolean; signal?: AbortSignal } = {}
  ): Promise<CallToolResult> {
    const { conn, client } = await this.requireClient(server)
    if (opts.fromApp) {
      // Spec: hosts MUST reject app-initiated calls to tools whose visibility excludes "app".
      const tool = conn.tools.find((t) => t.name === name)
      if (tool && !visibilityOf(tool).includes('app')) {
        throw new Error(`Tool "${name}" is not callable from apps`)
      }
    }
    return this.guard(conn, async () => (await client.callTool({ name, arguments: args }, { signal: opts.signal })) as CallToolResult)
  }

  async readResource(server: string, uri: string): Promise<unknown> {
    const { conn, client } = await this.requireClient(server)
    return this.guard(conn, () => client.readResource({ uri }))
  }

  async listResources(server: string): Promise<unknown> {
    const { conn, client } = await this.requireClient(server)
    return this.guard(conn, () => client.listResources())
  }

  /** Fetches an MCP App's HTML plus its CSP/permission metadata (content-level wins over listing-level). */
  async readUiResource(server: string, uri: string): Promise<UiResource> {
    const { conn, client } = await this.requireClient(server)
    const result = await this.guard(conn, () => client.readResource({ uri }))
    const content = result.contents[0] as
      | { mimeType?: string; text?: string; blob?: string; _meta?: Record<string, unknown> }
      | undefined
    if (!content) throw new Error(`UI resource ${uri} returned no contents`)
    if (content.mimeType && content.mimeType !== MCP_APP_MIME_TYPE) {
      throw new Error(`Unsupported UI resource MIME type: ${content.mimeType}`)
    }
    const html =
      typeof content.text === 'string'
        ? content.text
        : Buffer.from(content.blob ?? '', 'base64').toString('utf8')
    const listingMeta = conn.resources.find((r) => r.uri === uri)?._meta as
      | Record<string, unknown>
      | undefined
    const ui = (content._meta?.ui ?? listingMeta?.ui) as
      | { csp?: UiResource['csp']; permissions?: Record<string, unknown>; prefersBorder?: boolean }
      | undefined
    return { html, csp: ui?.csp, permissions: ui?.permissions, prefersBorder: ui?.prefersBorder }
  }
}
