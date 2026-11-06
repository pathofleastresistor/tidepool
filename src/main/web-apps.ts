import { app, session, webContents, WebContentsView, type BrowserWindow, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClearWebData, SiteData, ViewBounds, WebApp, WebAppInput, WebViewState } from '@shared/types'
import { belongsTo, groupSites, originsFor } from './site-data'

/**
 * One persistent browser profile for every website, like a Chrome profile: cookies and storage
 * survive restarts, and one Google sign-in covers Gmail and Chat. It is separate from the app's
 * own session, so sites never see the app and the app never sees their cookies.
 */
const PARTITION = 'persist:web'

/**
 * Identity providers' sign-in pages. A site that sends you to one in a new tab (Gmail's logged-out
 * page does) needs the sign-in to happen here, in this profile, or you end up signed in to your
 * regular browser instead. TIDEPOOL_SIGNIN_HOSTS adds hosts, for tests.
 */
const SIGN_IN_HOSTS = new Set([
  'accounts.google.com',
  'accounts.youtube.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  ...(process.env.TIDEPOOL_SIGNIN_HOSTS?.split(',').filter(Boolean) ?? [])
])

function isSignInPage(url: string): boolean {
  try {
    return SIGN_IN_HOSTS.has(new URL(url).host)
  } catch {
    return false
  }
}

/** How long Claude waits for a pinned site to load before reading or operating it anyway. */
const LOAD_TIMEOUT_MS = 15_000

/** What sites may ask for. Anything else (camera, microphone, location...) is refused. */
const ALLOWED_PERMISSIONS = new Set(['notifications', 'fullscreen', 'clipboard-sanitized-write'])

// MARK: - Site list (websites.json)

const storePath = (): string => join(app.getPath('userData'), 'websites.json')

export function loadWebApps(): WebApp[] {
  if (!existsSync(storePath())) return []
  try {
    const parsed = JSON.parse(readFileSync(storePath(), 'utf8')) as { websites?: WebApp[] }
    return Array.isArray(parsed.websites) ? parsed.websites : []
  } catch {
    return []
  }
}

function saveWebApps(apps: WebApp[]): WebApp[] {
  writeFileSync(storePath(), JSON.stringify({ websites: apps }, null, 2))
  return apps
}

/** Accepts "gmail.com" as well as full URLs; only http(s) is allowed. */
export function normalizeUrl(input: string): string {
  const raw = input.trim()
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http and https sites can be added.')
  return url.toString()
}

const defaultName = (url: string): string => new URL(url).hostname.replace(/^www\./, '')

/** The user's own words about what a site is for, kept short: Claude reads them in every chat. */
const MAX_ABOUT = 300

/** The fields the dialog edits, tidied: no blank notes, and '' (no connection) kept apart from unset (automatic). */
function details(input: WebAppInput): Pick<WebApp, 'about' | 'server'> {
  const about = input.about?.replace(/\s+/g, ' ').trim().slice(0, MAX_ABOUT)
  return { about: about || undefined, server: typeof input.server === 'string' ? input.server.trim() : undefined }
}

export function addWebApp(input: WebAppInput): WebApp[] {
  const url = normalizeUrl(input.url)
  const site: WebApp = { id: randomUUID().slice(0, 8), name: input.name?.trim() || defaultName(url), url, ...details(input) }
  return saveWebApps([...loadWebApps(), site])
}

export function updateWebApp(id: string, input: WebAppInput): WebApp[] {
  const url = normalizeUrl(input.url)
  return saveWebApps(
    loadWebApps().map((a) => (a.id === id ? { ...a, url, name: input.name?.trim() || defaultName(url), ...details(input) } : a))
  )
}

export function removeWebApp(id: string): WebApp[] {
  return saveWebApps(loadWebApps().filter((a) => a.id !== id))
}

/** Puts the sites in the given order (the sidebar's tabs); ids it doesn't mention keep their place at the end. */
export function reorderWebApps(ids: string[]): WebApp[] {
  const apps = loadWebApps()
  const rank = (a: WebApp): number => {
    const i = ids.indexOf(a.id)
    return i === -1 ? ids.length : i
  }
  return saveWebApps([...apps].sort((a, b) => rank(a) - rank(b)))
}

export function setAutoApproveTools(id: string, on: boolean): WebApp[] {
  return saveWebApps(loadWebApps().map((a) => (a.id === id ? { ...a, autoApproveTools: on || undefined } : a)))
}

export function setFavicon(id: string, favicon: string): WebApp[] | undefined {
  const apps = loadWebApps()
  const site = apps.find((a) => a.id === id)
  if (!site || site.favicon === favicon) return undefined
  site.favicon = favicon
  return saveWebApps(apps)
}

// MARK: - Views

let configured: Session | undefined
/** The shared profile for pinned sites and project tabs: one sign-in covers both. */
export function webSession(): Session {
  if (configured) return configured
  const ses = session.fromPartition(PARTITION)
  // Runs in every frame of the profile's pages (preload/web.ts).
  ses.registerPreloadScript({ type: 'frame', filePath: join(__dirname, '../preload/web.js') })
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission))
  configured = ses
  return ses
}

/**
 * For every pinned site, project tab and popup in that profile. nodeIntegrationInSubFrames only
 * lets the preload run in iframes too (Google's "Sign in with Google" buttons are iframes);
 * pages stay sandboxed and never get Node.
 */
export function webPreferences(): Electron.WebPreferences {
  return {
    session: webSession(),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: true
  }
}

interface Callbacks {
  window: () => BrowserWindow | null
  onState: (state: WebViewState) => void
  onAppsChanged: (apps: WebApp[]) => void
  /** A site's view was closed, so it's no longer loaded. */
  onClosed: (id: string) => void
  openExternal: (url: string) => void
  /** Where new-tab links go: a project tab or the default browser, per Settings. */
  openLink: (url: string) => void
}

/**
 * Websites are native views laid over the window, not DOM: the renderer reserves a rectangle
 * and reports it, and the view is positioned to fill it. Native views always draw above the
 * page, so the renderer hides the active one whenever a dialog or fullscreen app needs that
 * space. Opened sites keep running in the background, so switching between them is instant.
 */
export class WebViewManager {
  private views = new Map<string, WebContentsView>()
  private activeId: string | null = null

  constructor(private callbacks: Callbacks) {}

  private state(id: string): WebViewState | undefined {
    const wc = this.views.get(id)?.webContents
    if (!wc || wc.isDestroyed()) return undefined
    return {
      id,
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward()
    }
  }

  private report(id: string): void {
    const state = this.state(id)
    if (state) this.callbacks.onState(state)
  }

  private create(site: WebApp, win: BrowserWindow): WebContentsView {
    const view = new WebContentsView({ webPreferences: webPreferences() })
    this.wire(site, view, win)
    win.contentView.addChildView(view)
    view.setVisible(false)
    void view.webContents.loadURL(site.url).catch(() => {})
    return view
  }

  /**
   * Takes over a page that's already open, as a newly pinned site: a project tab's view, handed
   * over as it is (same profile, so nothing reloads). It's already in the window.
   */
  adopt(siteId: string, view: WebContentsView): void {
    const win = this.callbacks.window()
    const site = loadWebApps().find((a) => a.id === siteId)
    if (!win || !site || view.webContents.isDestroyed()) return
    this.close(siteId)
    this.wire(site, view, win)
    this.views.set(siteId, view)
    this.report(siteId)
  }

  private wire(site: WebApp, view: WebContentsView, win: BrowserWindow): void {
    const wc = view.webContents

    wc.setWindowOpenHandler(({ url, disposition }) => {
      // Sign-in and sharing popups (window.open with features) stay in the same profile so they
      // can finish and hand back to the site that opened them.
      if (disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { parent: win, width: 520, height: 700, webPreferences: webPreferences() }
        }
      }
      // A "sign in" link meant for a new tab: sign in here instead, so it's this profile that
      // ends up signed in.
      if (isSignInPage(url)) {
        void wc.loadURL(url)
        return { action: 'deny' }
      }
      // Any other new-tab link (a link in an email, a doc shared in chat) opens as a project tab
      // rather than replacing the site, or in the real browser if that's turned off.
      this.callbacks.openLink(url)
      return { action: 'deny' }
    })

    const report = (): void => this.report(site.id)
    wc.on('did-start-loading', report)
    wc.on('did-stop-loading', report)
    wc.on('did-navigate', report)
    wc.on('did-navigate-in-page', report)
    wc.on('page-title-updated', report)
    wc.on('page-favicon-updated', (_e, favicons) => {
      const apps = favicons[0] ? setFavicon(site.id, favicons[0]) : undefined
      if (apps) this.callbacks.onAppsChanged(apps)
    })
  }

  /** Callers hide project tabs first; only one native view is on screen at a time. */
  show(id: string, bounds: ViewBounds): void {
    const win = this.callbacks.window()
    const site = loadWebApps().find((a) => a.id === id)
    if (!win || !site) return
    let view = this.views.get(id)
    if (!view || view.webContents.isDestroyed()) {
      view = this.create(site, win)
      this.views.set(id, view)
    }
    for (const [otherId, other] of this.views) if (otherId !== id) other.setVisible(false)
    view.setBounds(roundBounds(bounds))
    view.setVisible(true)
    this.activeId = id
    this.report(id)
  }

  /**
   * A site's page for Claude to read or operate, loaded out of sight if it isn't yet and given a
   * while to finish. It's the same page the user sees, signed in as they are.
   */
  async contents(id: string): Promise<Electron.WebContents> {
    const win = this.callbacks.window()
    const site = loadWebApps().find((a) => a.id === id)
    if (!site) throw new Error('No pinned site with that id')
    if (!win) throw new Error('The app window is closed')
    let view = this.views.get(id)
    if (!view || view.webContents.isDestroyed()) {
      view = this.create(site, win)
      this.views.set(id, view)
    }
    const wc = view.webContents
    for (const start = Date.now(); Date.now() - start < LOAD_TIMEOUT_MS; ) {
      await new Promise((r) => setTimeout(r, 150))
      if (wc.isDestroyed()) throw new Error('The site was closed')
      if (!wc.isLoading()) break
    }
    return wc
  }

  /** The address a site is on now: where it was left if it's loaded, else where it opens. */
  currentUrl(id: string): string | undefined {
    const wc = this.views.get(id)?.webContents
    const url = wc && !wc.isDestroyed() ? wc.getURL() : ''
    return url || loadWebApps().find((a) => a.id === id)?.url
  }

  /** The website shown in `wc`, if it's one of ours. */
  siteFor(wc: Electron.WebContents): WebApp | undefined {
    for (const [id, view] of this.views) if (view.webContents === wc) return loadWebApps().find((a) => a.id === id)
    return undefined
  }

  /** The page on screen, if a pinned site is showing. */
  activeContents(): Electron.WebContents | undefined {
    const view = this.activeId ? this.views.get(this.activeId) : undefined
    return view?.getVisible() && !view.webContents.isDestroyed() ? view.webContents : undefined
  }

  setBounds(bounds: ViewBounds): void {
    if (this.activeId) this.views.get(this.activeId)?.setBounds(roundBounds(bounds))
  }

  hide(): void {
    for (const view of this.views.values()) view.setVisible(false)
    this.activeId = null
  }

  close(id: string): void {
    const view = this.views.get(id)
    if (!view) return
    this.views.delete(id)
    if (this.activeId === id) this.activeId = null
    this.callbacks.window()?.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
    this.callbacks.onClosed(id)
  }

  /** The window went away (macOS keeps the app running); its views went with it. */
  reset(): void {
    this.views.clear()
    this.activeId = null
  }

  back(id: string): void {
    this.views.get(id)?.webContents.navigationHistory.goBack()
  }

  forward(id: string): void {
    this.views.get(id)?.webContents.navigationHistory.goForward()
  }

  reload(id: string): void {
    this.views.get(id)?.webContents.reload()
  }

  openInBrowser(id: string): void {
    const url = this.views.get(id)?.webContents.getURL() ?? loadWebApps().find((a) => a.id === id)?.url
    if (url) this.callbacks.openExternal(url)
  }

  /** Write cookies to disk now rather than on Chromium's own schedule, so a fresh sign-in survives a quit. */
  async flush(): Promise<void> {
    await webSession().cookies.flushStore()
  }

  /** Clearing cookies and site data signs out of every site; clearing the cache alone keeps sign-ins. */
  async clearData(what: ClearWebData): Promise<void> {
    if (!what.cache && !what.cookies) return
    if (what.cookies) await webSession().clearStorageData()
    if (what.cache) await webSession().clearCache()
    for (const view of this.views.values()) view.webContents.reload()
  }
}

/** Every site in the websites' profile that has cookies, with how many. */
export async function listSites(): Promise<SiteData[]> {
  const cookies = await webSession().cookies.get({})
  return groupSites(cookies.map((c) => c.domain ?? '').filter(Boolean))
}

/**
 * Clear one site's cookies, cache and storage, signing out of it and nothing else. Storage is
 * kept per origin, so it's cleared for each origin the site is known by: its cookies' hosts, the
 * pages open on it, and knownUrls (from history). Its open pages reload to start afresh.
 */
export async function clearSite(site: string, knownUrls: string[]): Promise<void> {
  const ses = webSession()
  const open = webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.session === ses)
  const cookies = (await ses.cookies.get({})).filter((c) => c.domain && belongsTo(c.domain, site))
  await Promise.all(
    cookies.map((c) =>
      ses.cookies
        .remove(`${c.secure ? 'https' : 'http'}://${c.domain!.replace(/^\./, '')}${c.path ?? '/'}`, c.name)
        .catch(() => undefined)
    )
  )
  await ses.clearData({
    dataTypes: ['cache', 'cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'fileSystems', 'webSQL', 'backgroundFetch'],
    origins: originsFor(
      site,
      cookies.map((c) => c.domain!),
      [...knownUrls, ...open.map((wc) => wc.getURL())]
    )
  })
  await ses.cookies.flushStore()

  for (const wc of open) {
    try {
      if (belongsTo(new URL(wc.getURL()).hostname, site)) wc.reload()
    } catch {
      // not an address
    }
  }
}

const roundBounds = (b: ViewBounds): Electron.Rectangle => ({
  x: Math.round(b.x),
  y: Math.round(b.y),
  width: Math.max(0, Math.round(b.width)),
  height: Math.max(0, Math.round(b.height))
})
