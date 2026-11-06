import { useEffect, useState } from 'react'
import { addressLabel } from '@shared/address'
import type {
  ClearWebData,
  DetectedBrowser,
  Effort,
  PublicSettings,
  SavedAddress,
  SavedCard,
  SavedLogin,
  ServerStatus,
  SiteData
} from '@shared/types'
import { useEscape } from '../escape'
import { CloseIcon, ImportIcon, KeyboardIcon, LogIcon, ServerIcon, SlidersIcon } from './Icons'
import { KeyboardSettings } from './Shortcuts'
import { ServersPanel } from './ServersPanel'

export function Modal(props: {
  title: string
  onClose: () => void
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  useEscape(props.onClose)
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div className={`modal ${props.className ?? ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{props.title}</h2>
          <button className="icon modal-close" onClick={props.onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  )
}

const MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' }
]
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export type SettingsSection = 'general' | 'import' | 'servers' | 'keyboard' | 'log'

const SECTIONS: { id: SettingsSection; label: string; icon: () => React.JSX.Element }[] = [
  { id: 'general', label: 'General', icon: SlidersIcon },
  { id: 'import', label: 'Import & autofill', icon: ImportIcon },
  { id: 'servers', label: 'MCP servers', icon: ServerIcon },
  { id: 'keyboard', label: 'Keyboard', icon: KeyboardIcon },
  { id: 'log', label: 'App log', icon: LogIcon }
]

export function SettingsModal(props: {
  settings: PublicSettings
  onChange: (s: PublicSettings) => void
  servers: ServerStatus[]
  onServersChange: (s: ServerStatus[]) => void
  initialSection?: SettingsSection
  /** What the app has logged this session, for the App log section. */
  logLines: string[]
  onClose: () => void
}): React.JSX.Element {
  const [section, setSection] = useState<SettingsSection>(props.initialSection ?? 'general')
  const serverProblems = props.servers.filter((s) => s.status === 'error' || s.status === 'needs-auth').length
  return (
    <Modal title="Settings" onClose={props.onClose} className="settings-modal">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-row ${section === id ? 'active' : ''}`}
              onClick={() => setSection(id)}
              aria-current={section === id ? 'page' : undefined}
            >
              <Icon />
              <span>{label}</span>
              {id === 'servers' && serverProblems > 0 && (
                <span className="attention-dot" title={`${serverProblems} server(s) failed to connect`} />
              )}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {section === 'general' ? (
            <GeneralSettings settings={props.settings} onChange={props.onChange} />
          ) : section === 'import' ? (
            <ImportSettings settings={props.settings} onChange={props.onChange} />
          ) : section === 'keyboard' ? (
            <KeyboardSettings settings={props.settings} onChange={props.onChange} />
          ) : section === 'log' ? (
            <div className="settings-section">
              <p className="muted">MCP App lifecycle and bridge traffic (tool calls, messages, context updates), and page tools as they change.</p>
              <pre className="log">{props.logLines.length ? props.logLines.join('\n') : 'Nothing yet.'}</pre>
            </div>
          ) : (
            <ServersPanel
              configPath={props.settings.mcpConfigPath}
              servers={props.servers}
              onSaved={props.onServersChange}
            />
          )}
        </div>
      </div>
    </Modal>
  )
}

function GeneralSettings(props: {
  settings: PublicSettings
  onChange: (s: PublicSettings) => void
}): React.JSX.Element {
  const { settings } = props
  const [apiKey, setApiKey] = useState('')
  const [jevKey, setJevKey] = useState('')
  const [systemPrompt, setSystemPrompt] = useState(settings.systemPrompt)
  const [excluded, setExcluded] = useState(settings.memoryExcludedSites.join('\n'))
  const [clearWhat, setClearWhat] = useState<ClearWebData>({ cache: true, cookies: false })
  const [cleared, setCleared] = useState<string | null>(null)
  const knownModel = MODELS.some((m) => m.id === settings.model)

  const update = async (patch: Partial<PublicSettings>): Promise<void> => {
    props.onChange(await window.api.settings.update(patch))
  }

  return (
    <div className="settings-section">
      <label className="field">
        <span>Anthropic API key</span>
        <div className="row">
          <input
            type="password"
            placeholder={
              settings.hasApiKey
                ? settings.apiKeyFromEnv
                  ? 'Using ANTHROPIC_API_KEY from environment'
                  : '•••••••• (saved in macOS Keychain-encrypted storage)'
                : 'sk-ant-…'
            }
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button
            className="primary"
            disabled={!apiKey.trim()}
            onClick={async () => {
              props.onChange(await window.api.settings.setApiKey(apiKey))
              setApiKey('')
            }}
          >
            Save
          </button>
        </div>
      </label>

      <label className="field">
        <span>Jev API key</span>
        <div className="row">
          <input
            type="password"
            placeholder={
              settings.jevProvider
                ? `${settings.jevProvider === 'openrouter' ? 'OpenRouter' : 'TypeSafe'} key ${
                    settings.jevKeyFromEnv ? 'from environment' : '•••••••• (saved in macOS Keychain-encrypted storage)'
                  }`
                : 'Optional: a TypeSafe key, or an OpenRouter key (sk-or-…)'
            }
            value={jevKey}
            onChange={(e) => setJevKey(e.target.value)}
          />
          <button
            className="primary"
            disabled={!jevKey.trim()}
            onClick={async () => {
              props.onChange(await window.api.settings.setJevKey(jevKey))
              setJevKey('')
            }}
          >
            Save
          </button>
        </div>
        <span className="hint">
          Lets Claude operate pages that have no tools of their own, using TypeSafe's Jev to pick each click. Works
          with a key from TypeSafe or OpenRouter.
        </span>
      </label>

      <div className="row gap">
        <label className="field grow">
          <span>Model</span>
          <select value={settings.model} onChange={(e) => update({ model: e.target.value })}>
            {!knownModel && <option value={settings.model}>{settings.model}</option>}
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Effort</span>
          <select value={settings.effort} onChange={(e) => update({ effort: e.target.value as Effort })}>
            {EFFORTS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span>Custom model ID (optional)</span>
        <input
          placeholder="e.g. claude-opus-4-8"
          defaultValue={knownModel ? '' : settings.model}
          onBlur={(e) => e.target.value.trim() && update({ model: e.target.value.trim() })}
        />
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={settings.showThinking}
          onChange={(e) => update({ showThinking: e.target.checked })}
        />
        Show thinking summaries
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.refusalFallbacks}
          onChange={(e) => update({ refusalFallbacks: e.target.checked })}
        />
        Server-side refusal fallbacks (Opus 5 / 5.5 and Fable models)
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.skipApprovals}
          onChange={(e) => update({ skipApprovals: e.target.checked })}
        />
        Skip approvals: Tidepool uses your sites and tools without asking first
      </label>
      {settings.skipApprovals && (
        <p className="muted small indent">
          Nothing stops a website Tidepool reads from steering what it does next, like sending your
          information somewhere or buying something. Use it on tasks you're watching.
        </p>
      )}

      <label className="check">
        <input
          type="checkbox"
          checked={settings.linksInBuiltInBrowser}
          onChange={(e) => update({ linksInBuiltInBrowser: e.target.checked })}
        />
        Open links from chat, MCP Apps and pinned sites as tabs in your last-used project
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={settings.pageSuggestions}
          onChange={(e) => update({ pageSuggestions: e.target.checked })}
        />
        Suggest things to ask for on pages that offer tools (uses Haiku)
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.webSearch} onChange={(e) => update({ webSearch: e.target.checked })} />
        Let Tidepool search the web (Anthropic bills each search)
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.memory} onChange={(e) => update({ memory: e.target.checked })} />
        Let Tidepool keep notes in each project's memory and use them in later chats
      </label>
      <label className="check indent">
        <input
          type="checkbox"
          disabled={!settings.memory}
          checked={settings.memory && settings.browsingMemory}
          onChange={(e) => update({ browsingMemory: e.target.checked })}
        />
        Suggest notes from my browsing for me to review (uses Haiku; sends site names, visit counts, searches and page
        titles, never page text)
      </label>
      {settings.memory && settings.browsingMemory && (
        <label className="field indent">
          <span>Never use these sites for suggestions</span>
          <textarea
            rows={3}
            placeholder={'mybank.com\nhealthportal.org'}
            value={excluded}
            onChange={(e) => setExcluded(e.target.value)}
            onBlur={() => {
              const sites = excluded.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
              if (sites.join('\n') !== settings.memoryExcludedSites.join('\n')) update({ memoryExcludedSites: sites })
            }}
          />
          <span className="muted small">One per line. Includes their subdomains.</span>
        </label>
      )}

      <label className="field">
        <span>System prompt</span>
        <textarea rows={6} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
      </label>
      <div className="row end">
        <button disabled={systemPrompt === settings.systemPrompt} onClick={() => update({ systemPrompt })}>
          Save system prompt
        </button>
      </div>

      <div className="field">
        <span>Clear browsing data</span>
        <label className="check">
          <input
            type="checkbox"
            checked={clearWhat.cache}
            onChange={(e) => {
              setClearWhat({ ...clearWhat, cache: e.target.checked })
              setCleared(null)
            }}
          />
          Cached images and files
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={clearWhat.cookies}
            onChange={(e) => {
              setClearWhat({ ...clearWhat, cookies: e.target.checked })
              setCleared(null)
            }}
          />
          Cookies and site data (signs you out of every website)
        </label>
        <div className="row between">
          <span className="muted small">{cleared ?? 'Browsing history is cleared from the History page.'}</span>
          <button
            className={clearWhat.cookies ? 'danger' : undefined}
            disabled={!clearWhat.cache && !clearWhat.cookies}
            onClick={async () => {
              if (
                clearWhat.cookies &&
                !window.confirm('Clear cookies and site data? This signs you out of every website.')
              )
                return
              await window.api.web.clearData(clearWhat)
              setCleared(
                clearWhat.cache && clearWhat.cookies
                  ? 'Cleared the cache, cookies and site data.'
                  : clearWhat.cookies
                    ? 'Cleared cookies and site data.'
                    : 'Cleared the cache.'
              )
            }}
          >
            Clear data
          </button>
        </div>
      </div>

      <SiteDataList />
    </div>
  )
}

/** One site's cookies, cache and storage, cleared without signing out of any other site. */
function SiteDataList(): React.JSX.Element {
  const [sites, setSites] = useState<SiteData[] | null>(null)
  const [filter, setFilter] = useState('')
  const [status, setStatus] = useState<string | null>(null)

  const refresh = async (): Promise<void> => setSites(await window.api.web.listSites())
  useEffect(() => {
    void refresh()
  }, [])

  const clear = async (site: string): Promise<void> => {
    if (!window.confirm(`Clear cookies, cache and site data for ${site}? This signs you out of it.`)) return
    const cleared = await window.api.web.clearSite(site)
    setStatus(cleared ? `Cleared ${cleared}.` : `"${site}" isn't a website address.`)
    if (cleared) setFilter('')
    await refresh()
  }

  const query = filter.trim().toLowerCase()
  const shown = (sites ?? []).filter((s) => !query || s.site.includes(query))
  // A site with storage but no cookies isn't listed, so one can be typed in and cleared anyway.
  const typedSite = query.includes('.') && !shown.some((s) => s.site === query) ? query : null

  return (
    <div className="field">
      <span>Clear one site</span>
      <input
        type="search"
        placeholder="Find or type a site, e.g. example.com"
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value)
          setStatus(null)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          const site = shown.length === 1 ? shown[0].site : typedSite
          if (site) void clear(site)
        }}
      />
      <span className="muted small">
        {status ?? 'Clears its cookies, cache and storage, and signs you out of it. Other sites stay signed in.'}
      </span>
      {sites === null ? null : sites.length === 0 && !typedSite ? (
        <span className="muted small">No sites have stored cookies.</span>
      ) : (
        <ul className="login-list site-data-list">
          {typedSite && (
            <li className="login-row">
              <span className="login-host login-user">{typedSite}</span>
              <button className="danger" onClick={() => clear(typedSite)}>
                Clear
              </button>
            </li>
          )}
          {shown.map((s) => (
            <li key={s.site} className="login-row">
              <span className="login-host">{s.site}</span>
              <span className="login-user muted small">
                {s.cookies} cookie{s.cookies === 1 ? '' : 's'}
              </span>
              <button onClick={() => clear(s.site)}>Clear</button>
            </li>
          ))}
          {query && shown.length === 0 && !typedSite && <span className="muted small">No sites match.</span>}
        </ul>
      )}
    </div>
  )
}

function ImportSettings(props: {
  settings: PublicSettings
  onChange: (s: PublicSettings) => void
}): React.JSX.Element {
  const { settings } = props
  const [browsers, setBrowsers] = useState<DetectedBrowser[] | null>(null)
  const [logins, setLogins] = useState<SavedLogin[]>([])
  const [addresses, setAddresses] = useState<SavedAddress[]>([])
  const [cards, setCards] = useState<SavedCard[]>([])
  const [kinds, setKinds] = useState({ cookies: true, passwords: true, addresses: true, cards: true })
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refreshSaved = async (): Promise<void> => {
    const [l, a, c] = await Promise.all([
      window.api.passwords.list(),
      window.api.addresses.list(),
      window.api.cards.list()
    ])
    setLogins(l)
    setAddresses(a)
    setCards(c)
  }
  useEffect(() => {
    void window.api.browserImport.detect().then(setBrowsers)
    void refreshSaved()
  }, [])

  const update = async (patch: Partial<PublicSettings>): Promise<void> => {
    props.onChange(await window.api.settings.update(patch))
  }

  const rowKey = (b: DetectedBrowser): string => `${b.id}/${b.profile}`
  // A browser with more than one profile lists each by name; one with a single profile needs none.
  const rowName = (b: DetectedBrowser): string =>
    (browsers ?? []).filter((x) => x.id === b.id).length > 1 ? `${b.name} — ${b.profileName ?? b.profile}` : b.name

  const runImport = async (b: DetectedBrowser): Promise<void> => {
    setBusy(rowKey(b))
    setStatus(null)
    setError(null)
    try {
      const result = await window.api.browserImport.run(b.id, b.profile, {
        cookies: kinds.cookies && b.hasCookies,
        passwords: kinds.passwords && b.passwordCount > 0,
        addresses: kinds.addresses && b.addressCount > 0,
        cards: kinds.cards && b.cardCount > 0
      })
      const parts: string[] = []
      if (kinds.cookies) parts.push(plural(result.cookies, 'cookie'))
      if (kinds.passwords) parts.push(plural(result.passwords, 'saved login'))
      if (kinds.addresses) parts.push(plural(result.addresses, 'address', 'addresses'))
      if (kinds.cards) parts.push(plural(result.cards, 'card'))
      let skipped = ''
      if (result.passwordsSkipped)
        skipped += ` Skipped ${plural(result.passwordsSkipped, 'login')} for apps, or that couldn't be decrypted.`
      if (result.cardsSkipped)
        skipped += ` Skipped ${plural(result.cardsSkipped, 'card')} kept in Google Pay, whose full numbers aren't on this Mac.`
      setStatus(`Imported ${parts.join(', ')} from ${rowName(b)}.${skipped}`)
      await refreshSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="settings-section">
      <p className="muted">
        Bring your cookies, saved logins and addresses over from the browser you use now, the way a new browser imports
        from your old one. Signing in to a site once here then works the same. Some sign-ins Google protects with
        device-bound keys can&apos;t be copied — for those, just sign in again in Tidepool.
      </p>

      {window.api.platform !== 'darwin' ? (
        <p className="muted small">Importing from another browser is only supported on macOS right now.</p>
      ) : (
        <>
          <div className="row">
            <label className="check">
              <input
                type="checkbox"
                checked={kinds.cookies}
                onChange={(e) => setKinds((k) => ({ ...k, cookies: e.target.checked }))}
              />
              Cookies
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={kinds.passwords}
                onChange={(e) => setKinds((k) => ({ ...k, passwords: e.target.checked }))}
              />
              Saved passwords
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={kinds.addresses}
                onChange={(e) => setKinds((k) => ({ ...k, addresses: e.target.checked }))}
              />
              Addresses
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={kinds.cards}
                onChange={(e) => setKinds((k) => ({ ...k, cards: e.target.checked }))}
              />
              Payment cards
            </label>
          </div>

          {browsers === null ? (
            <p className="muted small">Looking for browsers…</p>
          ) : browsers.length === 0 ? (
            <p className="muted small">No supported browsers found to import from.</p>
          ) : (
            <ul className="import-list">
              {browsers.map((b) => (
                <li key={rowKey(b)} className="import-row">
                  <span className="import-name">
                    {rowName(b)}
                    {b.isDefault && <span className="badge">Default</span>}
                    <span className="muted small">
                      {' '}
                      {plural(b.passwordCount, 'password')}, {plural(b.addressCount, 'address', 'addresses')},{' '}
                      {plural(b.cardCount, 'card')}
                    </span>
                  </span>
                  <button
                    className="primary"
                    disabled={busy !== null || !Object.values(kinds).some(Boolean)}
                    onClick={() => runImport(b)}
                  >
                    {busy === rowKey(b) ? 'Importing…' : 'Import'}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">macOS asks permission to read the other browser&apos;s data the first time.</p>
          {status && <p className="import-status">{status}</p>}
          {error && <p className="import-error">{error}</p>}
        </>
      )}

      <label className="check">
        <input type="checkbox" checked={settings.autofill} onChange={(e) => update({ autofill: e.target.checked })} />
        Offer to fill saved logins, cards and addresses on forms (asks for Touch ID before each fill)
      </label>

      <div className="field">
        <div className="row between">
          <span>Saved logins {logins.length > 0 && <span className="muted">({logins.length})</span>}</span>
          {logins.length > 0 && (
            <button
              className="danger"
              onClick={async () => {
                if (!window.confirm('Delete every saved login? This cannot be undone.')) return
                await window.api.passwords.clear()
                await refreshSaved()
              }}
            >
              Delete all
            </button>
          )}
        </div>
        {logins.length === 0 ? (
          <span className="muted small">No saved logins yet. Import them from a browser above.</span>
        ) : (
          <ul className="login-list">
            {logins.map((l) => (
              <li key={l.id} className="login-row">
                <span className="login-host">{l.host}</span>
                <span className="login-user muted">{l.username || '(no username)'}</span>
                <button
                  className="icon"
                  aria-label={`Delete saved login for ${l.host}`}
                  onClick={async () => {
                    await window.api.passwords.remove(l.id)
                    await refreshSaved()
                  }}
                >
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="field">
        <div className="row between">
          <span>Saved cards {cards.length > 0 && <span className="muted">({cards.length})</span>}</span>
          {cards.length > 0 && (
            <button
              className="danger"
              onClick={async () => {
                if (!window.confirm('Delete every saved card? This cannot be undone.')) return
                await window.api.cards.clear()
                await refreshSaved()
              }}
            >
              Delete all
            </button>
          )}
        </div>
        {cards.length === 0 ? (
          <span className="muted small">No saved cards yet. Import them from a browser above.</span>
        ) : (
          <ul className="login-list">
            {cards.map((c) => (
              <li key={c.id} className="login-row">
                <span className="login-host">
                  {c.nickname || c.network} •••• {c.lastFour}
                </span>
                <span className="login-user muted">
                  {[c.nameOnCard, c.expMonth && c.expYear ? `expires ${String(c.expMonth).padStart(2, '0')}/${c.expYear}` : '']
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <button
                  className="icon"
                  aria-label={`Delete saved card ending ${c.lastFour}`}
                  onClick={async () => {
                    await window.api.cards.remove(c.id)
                    await refreshSaved()
                  }}
                >
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="field">
        <div className="row between">
          <span>Saved addresses {addresses.length > 0 && <span className="muted">({addresses.length})</span>}</span>
          {addresses.length > 0 && (
            <button
              className="danger"
              onClick={async () => {
                if (!window.confirm('Delete every saved address? This cannot be undone.')) return
                await window.api.addresses.clear()
                await refreshSaved()
              }}
            >
              Delete all
            </button>
          )}
        </div>
        {addresses.length === 0 ? (
          <span className="muted small">No saved addresses yet. Import them from a browser above.</span>
        ) : (
          <ul className="login-list">
            {addresses.map((a) => (
              <li key={a.id} className="login-row">
                <span className="login-host">{a.name || a.organization || a.email || 'Address'}</span>
                <span className="login-user muted">
                  {[a.line1, a.city, a.state, a.postalCode].filter(Boolean).join(', ') || a.email || a.phone}
                </span>
                <button
                  className="icon"
                  aria-label={`Delete saved address ${addressLabel(a)}`}
                  onClick={async () => {
                    await window.api.addresses.remove(a.id)
                    await refreshSaved()
                  }}
                >
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** "1 cookie", "1,203 cookies". */
const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString()} ${n === 1 ? one : many}`
