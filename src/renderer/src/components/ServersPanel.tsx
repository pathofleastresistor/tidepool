import { useEffect, useState } from 'react'
import type { McpConfigFile, McpServerConfig, ServerAuth, ServerStatus } from '@shared/types'

/** Matches DEFAULT_REDIRECT_PORT in the main process; shown before a server has connected once. */
const REDIRECT_URI = 'http://127.0.0.1:33418/callback'

const cleanError = (err: unknown): string =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)

type Kind = 'remote' | 'local'

interface FormState {
  name: string
  kind: Kind
  url: string
  transport: 'http' | 'sse'
  headers: string
  clientId: string
  /** Blank keeps the saved secret. */
  clientSecret: string
  command: string
  args: string
  env: string
  cwd: string
}

const EMPTY_FORM: FormState = {
  name: '',
  kind: 'remote',
  url: '',
  transport: 'http',
  headers: '',
  clientId: '',
  clientSecret: '',
  command: '',
  args: '',
  env: '',
  cwd: ''
}

/** Splits a command-line style string into args, honouring single and double quotes. */
function splitArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let inArg = false
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      inArg = true
    } else if (/\s/.test(ch)) {
      if (inArg) args.push(current)
      current = ''
      inArg = false
    } else {
      current += ch
      inArg = true
    }
  }
  if (inArg) args.push(current)
  return args
}

const joinArgs = (args: string[] = []): string =>
  args.map((a) => (a === '' || /[\s"']/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')

/** Parses "KEY<sep>value" lines into a record; blank lines and lines starting with # are ignored. */
function parsePairs(text: string, sep: ':' | '='): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf(sep)
    if (idx <= 0) throw new Error(`Couldn't parse "${line}" — expected KEY${sep === ':' ? ': ' : '='}value`)
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return Object.keys(out).length ? out : undefined
}

const formatPairs = (rec: Record<string, string> | undefined, sep: ': ' | '='): string =>
  Object.entries(rec ?? {})
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n')

function toForm(name: string, cfg: McpServerConfig): FormState {
  if ('url' in cfg) {
    return {
      ...EMPTY_FORM,
      name,
      kind: 'remote',
      url: cfg.url,
      transport: cfg.transport ?? 'http',
      headers: formatPairs(cfg.headers, ': '),
      clientId: (cfg.oauth && cfg.oauth.clientId) || ''
    }
  }
  return {
    ...EMPTY_FORM,
    name,
    kind: 'local',
    command: cfg.command,
    args: joinArgs(cfg.args),
    env: formatPairs(cfg.env, '='),
    cwd: cfg.cwd ?? ''
  }
}

function fromForm(form: FormState, previous: McpServerConfig | undefined): McpServerConfig {
  const base = previous?.disabled ? { disabled: true } : {}
  if (form.kind === 'remote') {
    let url: URL
    try {
      url = new URL(form.url.trim())
    } catch {
      throw new Error('Enter a full URL, e.g. https://example.com/mcp')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL must start with http:// or https://')
    const headers = parsePairs(form.headers, ':')
    // Keep settings only mcp.json can set (redirectPort, oauth: false) while editing the client ID.
    const prevOAuth = previous && 'url' in previous ? previous.oauth : undefined
    const clientId = form.clientId.trim()
    const oauth = prevOAuth === false ? false : { ...prevOAuth, clientId: clientId || undefined }
    const keepOAuth = oauth === false || oauth.clientId || oauth.redirectPort
    return {
      url: url.toString(),
      ...(form.transport === 'sse' ? { transport: 'sse' as const } : {}),
      ...(headers ? { headers } : {}),
      ...(keepOAuth ? { oauth } : {}),
      ...base
    }
  }
  const command = form.command.trim()
  if (!command) throw new Error('Enter the command that starts the server, e.g. npx or node')
  const args = splitArgs(form.args)
  const env = parsePairs(form.env, '=')
  return {
    command,
    ...(args.length ? { args } : {}),
    ...(env ? { env } : {}),
    ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
    ...base
  }
}

function describe(cfg: McpServerConfig): string {
  if ('url' in cfg) return `${cfg.transport === 'sse' ? 'SSE' : 'HTTP'} · ${cfg.url}`
  return ['stdio ·', cfg.command, ...(cfg.args ?? [])].join(' ')
}

function ServerForm(props: {
  initial: FormState
  auth?: ServerAuth
  isEdit: boolean
  existingNames: string[]
  onCancel: () => void
  onSubmit: (form: FormState) => Promise<void>
}): React.JSX.Element {
  const [form, setForm] = useState(props.initial)
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => setForm((f) => ({ ...f, [key]: value }))

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError(undefined)
    const name = form.name.trim()
    if (!name) return setError('Give the server a name')
    if (name !== props.initial.name && props.existingNames.includes(name)) {
      return setError(`A server named "${name}" already exists`)
    }
    setSaving(true)
    try {
      await props.onSubmit({ ...form, name })
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': /, '') : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="server-form" onSubmit={submit}>
      <label className="field">
        <span>Name</span>
        <input autoFocus value={form.name} placeholder="e.g. my-server" onChange={(e) => set('name', e.target.value)} />
      </label>

      <div className="segmented">
        <button type="button" className={form.kind === 'remote' ? 'active' : ''} onClick={() => set('kind', 'remote')}>
          Remote (URL)
        </button>
        <button type="button" className={form.kind === 'local' ? 'active' : ''} onClick={() => set('kind', 'local')}>
          Local (command)
        </button>
      </div>

      {form.kind === 'remote' ? (
        <>
          <div className="row gap">
            <label className="field grow">
              <span>Server URL</span>
              <input
                value={form.url}
                placeholder="https://example.com/mcp"
                onChange={(e) => set('url', e.target.value)}
              />
            </label>
            <label className="field">
              <span>Transport</span>
              <select value={form.transport} onChange={(e) => set('transport', e.target.value as 'http' | 'sse')}>
                <option value="http">Streamable HTTP</option>
                <option value="sse">SSE (legacy)</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>Headers (optional, one per line)</span>
            <textarea
              className="code"
              rows={3}
              spellCheck={false}
              value={form.headers}
              placeholder="Authorization: Bearer your-token"
              onChange={(e) => set('headers', e.target.value)}
            />
          </label>
          <details className="oauth-client" open={Boolean(form.clientId) || props.auth?.needsClient}>
            <summary className="small">OAuth client (only for servers that ask for one, like Google Workspace)</summary>
            <p className="muted small flush">
              Most servers sign in without this. For one that can&apos;t register Tidepool itself, create an OAuth
              client with its provider (for Google, a <b>Desktop app</b> client) and paste its ID and secret here. If
              the provider asks for a redirect URI, use <code>{props.auth?.redirectUri ?? REDIRECT_URI}</code>.
            </p>
            <div className="row gap">
              <label className="field grow">
                <span>Client ID</span>
                <input
                  value={form.clientId}
                  spellCheck={false}
                  placeholder="1234-abc.apps.googleusercontent.com"
                  onChange={(e) => set('clientId', e.target.value)}
                />
              </label>
              <label className="field grow">
                <span>Client secret</span>
                <input
                  type="password"
                  value={form.clientSecret}
                  placeholder={props.auth?.hasClientSecret ? 'Saved — type to replace' : 'Stored in the keychain'}
                  onChange={(e) => set('clientSecret', e.target.value)}
                />
              </label>
            </div>
          </details>
        </>
      ) : (
        <>
          <div className="row gap">
            <label className="field" style={{ width: 160 }}>
              <span>Command</span>
              <input value={form.command} placeholder="npx" onChange={(e) => set('command', e.target.value)} />
            </label>
            <label className="field grow">
              <span>Arguments</span>
              <input
                value={form.args}
                placeholder="-y @modelcontextprotocol/server-everything"
                onChange={(e) => set('args', e.target.value)}
              />
            </label>
          </div>
          <label className="field">
            <span>Environment variables (optional, one per line)</span>
            <textarea
              className="code"
              rows={3}
              spellCheck={false}
              value={form.env}
              placeholder="API_KEY=abc123"
              onChange={(e) => set('env', e.target.value)}
            />
          </label>
          <label className="field">
            <span>Working directory (optional)</span>
            <input value={form.cwd} placeholder="/Users/you/project" onChange={(e) => set('cwd', e.target.value)} />
          </label>
        </>
      )}

      {error && <div className="server-error">{error}</div>}
      <div className="row end">
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Connecting…' : props.isEdit ? 'Save & reconnect' : 'Add server'}
        </button>
      </div>
    </form>
  )
}

/** Tools, server info and stderr for one server, shown when its card is expanded. */
function ServerDetails({ status, onSignOut }: { status?: ServerStatus; onSignOut: () => void }): React.JSX.Element {
  if (!status) return <div className="muted small">Not connected yet.</div>
  return (
    <div className="server-details">
      {status.auth?.signedIn && (
        <div className="row between">
          <span className="muted small">Signed in</span>
          <button className="link" onClick={() => onSignOut()}>
            Sign out
          </button>
        </div>
      )}
      {status.serverInfo && (
        <div className="muted small">
          {status.serverInfo.name} {status.serverInfo.version}
        </div>
      )}
      {status.tools.length > 0 && (
        <div className="tool-grid">
          {status.tools.map((t) => (
            <div key={t.name} className="tool-row" title={t.description}>
              <span className="ellipsis">{t.title ?? t.name}</span>
              {t.uiResourceUri && <span className="badge">app</span>}
              {!t.visibility.includes('model') && <span className="badge muted">app-only</span>}
            </div>
          ))}
        </div>
      )}
      {status.stderr.length > 0 && (
        <details>
          <summary className="muted small">stderr ({status.stderr.length})</summary>
          <pre className="stderr">{status.stderr.join('\n')}</pre>
        </details>
      )}
    </div>
  )
}

/** The MCP servers section of Settings: add, edit, enable and remove servers, or edit mcp.json directly. */
export function ServersPanel(props: {
  configPath: string
  servers: ServerStatus[]
  onSaved: (status: ServerStatus[]) => void
}): React.JSX.Element {
  const [config, setConfig] = useState<McpConfigFile>()
  const [loadError, setLoadError] = useState<string>()
  const [view, setView] = useState<{ mode: 'list' } | { mode: 'form'; editing?: string } | { mode: 'json' }>({
    mode: 'list'
  })
  const [expanded, setExpanded] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string>()
  const [authErrors, setAuthErrors] = useState<Record<string, string>>({})

  const signIn = async (name: string): Promise<void> => {
    setAuthErrors(({ [name]: _, ...rest }) => rest)
    try {
      props.onSaved(await window.api.mcp.signIn(name))
    } catch (err) {
      const message = cleanError(err)
      if (message !== 'Sign-in cancelled') setAuthErrors((e) => ({ ...e, [name]: message }))
    }
  }

  const signOut = async (name: string): Promise<void> => {
    if (!window.confirm(`Sign out of "${name}"?`)) return
    props.onSaved(await window.api.mcp.signOut(name))
  }

  const load = async (): Promise<void> => {
    const text = await window.api.mcp.readConfig()
    setJsonText(text)
    try {
      const parsed = JSON.parse(text) as Partial<McpConfigFile>
      setConfig({ mcpServers: parsed.mcpServers ?? {} })
      setLoadError(undefined)
    } catch (err) {
      setLoadError(`mcp.json isn't valid JSON (${String(err)}). Fix it in the JSON tab.`)
      setView({ mode: 'json' })
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const save = async (next: McpConfigFile): Promise<void> => {
    const status = await window.api.mcp.writeConfig(JSON.stringify(next, null, 2))
    setConfig(next)
    setJsonText(JSON.stringify(next, null, 2))
    props.onSaved(status)
  }

  const upsert = async (form: FormState, previousName?: string): Promise<void> => {
    if (!config) return
    const previous = previousName ? config.mcpServers[previousName] : undefined
    const entry = fromForm(form, previous)
    // Before the config is written, so the reconnect that follows already has it.
    if (form.kind === 'remote' && form.clientSecret.trim()) await window.api.mcp.setClientSecret(form.name, form.clientSecret)
    // Rebuild to keep the server's position when renaming.
    const servers: Record<string, McpServerConfig> = {}
    let placed = false
    for (const [name, cfg] of Object.entries(config.mcpServers)) {
      if (name === previousName) {
        servers[form.name] = entry
        placed = true
      } else {
        servers[name] = cfg
      }
    }
    if (!placed) servers[form.name] = entry
    await save({ mcpServers: servers })
    setView({ mode: 'list' })
  }

  const toggle = (name: string): void => {
    if (!config) return
    const cfg = { ...config.mcpServers[name] }
    if (cfg.disabled) delete cfg.disabled
    else cfg.disabled = true
    void save({ mcpServers: { ...config.mcpServers, [name]: cfg } })
  }

  const remove = (name: string): void => {
    if (!config || !window.confirm(`Remove the MCP server "${name}"?`)) return
    const servers = { ...config.mcpServers }
    delete servers[name]
    void save({ mcpServers: servers })
  }

  const saveJson = async (): Promise<void> => {
    setJsonError(undefined)
    try {
      props.onSaved(await window.api.mcp.writeConfig(jsonText))
      await load()
      setView({ mode: 'list' })
    } catch (err) {
      setJsonError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': /, '') : String(err))
    }
  }

  const reconnectAll = async (): Promise<void> => {
    setReconnecting(true)
    try {
      props.onSaved(await window.api.mcp.reload())
    } finally {
      setReconnecting(false)
    }
  }

  const statusOf = (name: string): ServerStatus | undefined => props.servers.find((s) => s.name === name)
  const names = Object.keys(config?.mcpServers ?? {})

  return (
    <div className="settings-section">
      {loadError && <div className="server-error">{loadError}</div>}

      {view.mode === 'list' && config && (
        <>
          <div className="row between">
            <p className="muted small flush">
              Tidepool can use the tools of every connected server. Servers with apps can show them in the chat.
            </p>
            <span className="row nowrap">
              <button onClick={reconnectAll} disabled={reconnecting || names.length === 0}>
                {reconnecting ? 'Reconnecting…' : 'Reconnect all'}
              </button>
              <button className="primary" onClick={() => setView({ mode: 'form' })}>
                + Add server
              </button>
            </span>
          </div>
          {names.length === 0 && (
            <div className="empty-card muted">No servers yet. Add a remote URL or a local command.</div>
          )}
          <div className="server-list">
            {names.map((name) => {
              const cfg = config.mcpServers[name]
              const status = statusOf(name)
              const state = cfg.disabled ? 'disabled' : (status?.status ?? 'connecting')
              const appCount = status?.tools.filter((t) => t.uiResourceUri).length ?? 0
              const open = expanded === name
              return (
                <div key={name} className={`server-card ${open ? 'open' : ''}`}>
                  <div className="server-card-row">
                    <button
                      className="server-card-main"
                      onClick={() => setExpanded(open ? null : name)}
                      aria-expanded={open}
                    >
                      <span className={`dot ${state}`} title={state} />
                      <span className="server-card-text">
                        <span className="server-card-title">
                          {name}
                          {state === 'connected' && status && (
                            <span className="muted small">
                              {' '}
                              · {status.tools.length} tools{appCount > 0 && ` · ${appCount} app${appCount === 1 ? '' : 's'}`}
                            </span>
                          )}
                          {cfg.disabled && <span className="muted small"> · disabled</span>}
                          {state === 'needs-auth' && <span className="muted small"> · sign-in needed</span>}
                        </span>
                        <span className="muted small ellipsis" title={describe(cfg)}>
                          {describe(cfg)}
                        </span>
                      </span>
                      <span className={`chevron ${open ? 'open' : ''}`} aria-hidden="true">
                        ›
                      </span>
                    </button>
                    <div className="server-card-actions">
                      {state === 'needs-auth' &&
                        (status?.auth?.signingIn ? (
                          <>
                            <span className="muted small nowrap">Waiting for browser…</span>
                            <button onClick={() => window.api.mcp.cancelSignIn(name)}>Cancel</button>
                          </>
                        ) : status?.auth?.needsClient ? (
                          <button className="primary" onClick={() => setView({ mode: 'form', editing: name })}>
                            Add client
                          </button>
                        ) : (
                          <button className="primary" onClick={() => void signIn(name)}>
                            Sign in
                          </button>
                        ))}
                      <label className="switch" title={cfg.disabled ? 'Enable' : 'Disable'}>
                        <input type="checkbox" checked={!cfg.disabled} onChange={() => toggle(name)} />
                        <span />
                      </label>
                      <button onClick={() => setView({ mode: 'form', editing: name })}>Edit</button>
                      <button className="danger" onClick={() => remove(name)}>
                        Remove
                      </button>
                    </div>
                  </div>
                  {(state === 'error' || state === 'needs-auth') && status?.error && (
                    <div className="server-error small">{status.error}</div>
                  )}
                  {authErrors[name] && <div className="server-error small">{authErrors[name]}</div>}
                  {open && <ServerDetails status={status} onSignOut={() => void signOut(name)} />}
                </div>
              )
            })}
          </div>
          <div className="row between">
            <span className="muted small ellipsis" title={props.configPath}>
              Saved to {props.configPath}
            </span>
            <button className="link" onClick={() => setView({ mode: 'json' })}>
              Edit JSON
            </button>
          </div>
        </>
      )}

      {view.mode === 'form' && config && (
        <ServerForm
          key={view.editing ?? '__new__'}
          initial={view.editing ? toForm(view.editing, config.mcpServers[view.editing]) : EMPTY_FORM}
          auth={view.editing ? statusOf(view.editing)?.auth : undefined}
          isEdit={Boolean(view.editing)}
          existingNames={names}
          onCancel={() => setView({ mode: 'list' })}
          onSubmit={(form) => upsert(form, view.editing)}
        />
      )}

      {view.mode === 'json' && (
        <>
          <p className="muted flush">
            Same <code>mcpServers</code> format most MCP clients use, so you can paste entries from their config
            files. Remote servers use <code>url</code> (plus optional <code>&quot;transport&quot;: &quot;sse&quot;</code>{' '}
            , <code>headers</code> and <code>oauth</code>: <code>{'{ "clientId": …, "redirectPort": … }'}</code> or{' '}
            <code>false</code>); local servers use <code>command</code>/<code>args</code>/<code>env</code>.
          </p>
          <textarea
            className="code"
            rows={18}
            spellCheck={false}
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
          />
          {jsonError && <div className="server-error">{jsonError}</div>}
          <div className="row between">
            <span className="row">
              {config && <button onClick={() => setView({ mode: 'list' })}>Back</button>}
              <button className="link" onClick={() => window.api.mcp.openConfigFile()}>
                Open in external editor
              </button>
            </span>
            <button className="primary" onClick={saveJson}>
              Save & reconnect
            </button>
          </div>
        </>
      )}
    </div>
  )
}
