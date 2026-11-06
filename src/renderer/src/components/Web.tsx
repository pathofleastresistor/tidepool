import { useEffect, useRef, useState } from 'react'
import { PageToolsButton } from './PageTools'
import type { ViewBounds, WebApp, WebViewState } from '@shared/types'
import { googleSignInRejected } from '@shared/sign-in'
import { BackIcon, CloseIcon, ExternalIcon, ForwardIcon, MemoryIcon, ReloadIcon } from './Icons'
import { withShortcut } from '../commands'
import { Modal } from './Modals'

/** A steady hue per name, so sites without a favicon are told apart by colour as well as letter. */
function hueOf(name: string): number {
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

export function SiteIcon({ site }: { site: WebApp }): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  if (site.favicon && !broken) {
    return <img className="site-icon" src={site.favicon} alt="" onError={() => setBroken(true)} />
  }
  return (
    <span className="site-icon letter" aria-hidden="true" style={{ '--hue': hueOf(site.name) } as React.CSSProperties}>
      {site.name.charAt(0).toUpperCase()}
    </span>
  )
}

/**
 * Shown above a pinned site or project tab that Google has refused to sign in. There's no getting
 * past that page here, so this offers the default browser instead. It sits above the native
 * view's slot rather than over it, because the view would draw on top of it.
 */
export function SignInBlockedBanner({ url }: { url?: string }): React.JSX.Element | null {
  const target = url ? googleSignInRejected(url) : undefined
  if (!target) return null
  return (
    <div className="sign-in-blocked" role="status">
      <span>Google doesn't allow signing in inside this app.</span>
      <button className="primary" onClick={() => void window.api.openExternal(target)}>
        Open in your browser
      </button>
    </div>
  )
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * A pinned site fills the slot below the toolbar. The page itself is a native view laid over
 * that slot by the main process, so this reports where the slot is and keeps it up to date.
 */
export function WebPane(props: {
  site: WebApp
  state?: WebViewState
  /** False while something (a dialog, a fullscreen app) needs the space the view covers. */
  visible: boolean
  onClose: () => void
  /** Opens "Remember this page" for what the site is showing. */
  onRemember: (page: { title: string; url: string }) => void
  /** Tools the page on screen offers (WebMCP), and a look at them. */
  pageToolCount: number
  onOpenPageTools: () => void
}): React.JSX.Element {
  const { site, state, visible } = props
  const slotRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const slot = slotRef.current
    if (!slot || !visible) {
      void window.api.web.hide()
      return
    }
    const bounds = (): ViewBounds => {
      const r = slot.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    }
    void window.api.web.show(site.id, bounds())
    const update = (): void => void window.api.web.setBounds(bounds())
    const observer = new ResizeObserver(update)
    observer.observe(slot)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      void window.api.web.hide()
    }
  }, [site.id, visible])

  return (
    <section className="web-pane" aria-label={site.name}>
      <div className="web-toolbar">
        <button className="icon" onClick={() => window.api.web.back(site.id)} disabled={!state?.canGoBack} aria-label="Back" title={withShortcut('Back', 'page.back')}>
          <BackIcon />
        </button>
        <button
          className="icon"
          onClick={() => window.api.web.forward(site.id)}
          disabled={!state?.canGoForward}
          aria-label="Forward"
          title={withShortcut('Forward', 'page.forward')}
        >
          <ForwardIcon />
        </button>
        <button className="icon" onClick={() => window.api.web.reload(site.id)} aria-label="Reload" title={withShortcut('Reload', 'page.reload')}>
          <ReloadIcon />
        </button>
        <SiteIcon site={site} />
        <div className="web-address" title={state?.url ?? site.url}>
          <span className="web-title">{state?.title || site.name}</span>
          <span className="web-host">{hostOf(state?.url ?? site.url)}</span>
        </div>
        <PageToolsButton count={props.pageToolCount} onOpen={props.onOpenPageTools} />
        <button
          className="icon"
          onClick={() => props.onRemember({ title: state?.title || site.name, url: state?.url ?? site.url })}
          aria-label="Remember this page"
          title="Remember this page"
        >
          <MemoryIcon />
        </button>
        <button className="icon" onClick={() => window.api.web.openInBrowser(site.id)} aria-label="Open in browser" title="Open in your browser">
          <ExternalIcon />
        </button>
        <button className="icon" onClick={props.onClose} aria-label="Close website" title={withShortcut('Close tab', 'tab.close')}>
          <CloseIcon />
        </button>
      </div>
      <SignInBlockedBanner url={state?.url} />
      <div className="web-view-slot" ref={slotRef} />
    </section>
  )
}

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)

/** The connection picker's value for "a server on the site's own address, if there is one". */
const AUTOMATIC = '\u0000auto'

export function WebsiteModal(props: {
  site?: WebApp
  /** The MCP servers in Settings, any of which can be a site's connection. */
  servers: string[]
  /** Pinning a site passes its id, to open it; editing one doesn't. */
  onSaved: (apps: WebApp[], openId?: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { site } = props
  const [url, setUrl] = useState(site?.url ?? '')
  const [name, setName] = useState(site?.name ?? '')
  const [about, setAbout] = useState(site?.about ?? '')
  const [server, setServer] = useState(site?.server ?? AUTOMATIC)
  const [autoApprove, setAutoApprove] = useState(site?.autoApproveTools === true)
  const [error, setError] = useState<string>()

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError(undefined)
    const input = { url, name, about, server: server === AUTOMATIC ? undefined : server }
    try {
      if (site) {
        props.onSaved(await window.api.web.update(site.id, input))
        if (autoApprove !== (site.autoApproveTools === true)) await window.api.webmcp.setAutoApprove(site.id, autoApprove)
      } else {
        const apps = await window.api.web.add(input)
        props.onSaved(apps, apps[apps.length - 1]?.id)
      }
      props.onClose()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <Modal title={site ? `Edit ${site.name}` : 'Pin a site'} onClose={props.onClose}>
      <form className="server-form" onSubmit={save}>
        <label className="field">
          <span>Address</span>
          <input autoFocus value={url} placeholder="gmail.com" onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label className="field">
          <span>Name (optional)</span>
          <input value={name} placeholder="Gmail" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>What it's for (optional)</span>
          <input
            value={about}
            maxLength={300}
            placeholder="Home Assistant: lights, fans, thermostat and locks"
            onChange={(e) => setAbout(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Connection</span>
          <select value={server} onChange={(e) => setServer(e.target.value)}>
            <option value={AUTOMATIC}>Automatic: an MCP server on this site's address</option>
            <option value="">None: Claude uses the page</option>
            {props.servers.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {site && (
          <label className="check">
            <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} />
            <span>Let Claude act here without asking (it still asks right after reading another site)</span>
          </label>
        )}
        <p className="muted small">
          Claude knows your pinned sites in every chat, by the name and note above, and can use them for you. It
          goes through the site's connection when it has one, and asks before acting on the site unless you let
          it. Pinned sites and project tabs share one browser profile that's kept between launches, so you stay
          signed in, and one Google sign-in covers every Google site.
        </p>
        {error && <div className="server-error">{error}</div>}
        <div className="row end">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!url.trim()}>
            {site ? 'Save' : 'Pin site'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
