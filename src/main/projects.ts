import { app, clipboard, Menu, WebContentsView, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PROJECT_ID, type Project, type ProjectTab, type ViewBounds } from '@shared/types'
import { isPageUrl, pagePreferences, pageSession } from './pages'
import { webPreferences } from './web-apps'

/** Turns address-bar input into a URL: full URLs pass through, hostnames get a scheme, anything else is searched. */
export function toUrl(input: string): string {
  const text = input.trim()
  if (/^(https?:|about:)/i.test(text) || isPageUrl(text)) return text
  const isLocal = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i.test(text)
  if (isLocal) return `http://${text}`
  if (!/\s/.test(text) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`
}

const isWebUrl = (url: string): boolean => /^https?:/i.test(url)
/** What a tab can show: a website, or one of the project's pages. */
const isTabUrl = (url: string): boolean => isWebUrl(url) || isPageUrl(url)

const originOf = (url: string): string | undefined => {
  try {
    return isWebUrl(url) ? new URL(url).origin : undefined
  } catch {
    return undefined
  }
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const newId = (): string => randomUUID().slice(0, 8)

interface Tab {
  id: string
  /** Where the tab is, kept up to date as it navigates so it can be restored. */
  url: string
  title: string
  favicon?: string
  /** Created the first time the tab is shown with an address. */
  view?: WebContentsView
}

interface ProjectRecord {
  id: string
  name: string
  tabs: Tab[]
  activeTabId: string | null
}

/** projects.json */
interface Saved {
  projects: Array<{ id: string; name: string; activeTabId: string | null; tabs: Array<Omit<Tab, 'view'>> }>
  /** The project new-tab links go to. */
  lastUsedId?: string
  /** Origins whose WebMCP tools run without asking, in any project tab. */
  autoApproveOrigins?: string[]
}

interface Callbacks {
  window: () => BrowserWindow | null
  onChanged: (projects: Project[]) => void
  /** A link was opened in a project, which the UI should switch to. */
  onReveal: (projectId: string) => void
  /** Ctrl+Tab went to the project's Home, or from it to a tab. */
  onHome: (projectId: string, home: boolean) => void
  openExternal: (url: string) => void
}

/**
 * Projects are named sets of browser tabs. Like pinned sites, each tab is a native view laid over
 * the window: the renderer reserves a rectangle below the tab strip and reports it, and the shown
 * project's active tab fills it. Tabs keep running when you switch away. Tabs restored from last
 * time load only when first shown.
 */
export class ProjectManager {
  private projects: ProjectRecord[] = []
  private lastUsedId: string | undefined
  private autoApproveOrigins = new Set<string>()
  /** Closed tabs with an address, newest last, for Reopen Closed Tab. */
  private closed: Array<{ projectId: string; url: string; index: number }> = []
  private shownId: string | null = null
  /**
   * The project whose Home is on screen. The UI draws Home and hides the page for it, so shownId
   * is null then; this is how Ctrl+Tab knows which project it's in.
   */
  private homeShownId: string | null = null
  private bounds: ViewBounds | null = null
  private saveTimer?: NodeJS.Timeout

  constructor(private callbacks: Callbacks) {
    this.load()
    // Every chat needs a project, so there's always one to fall back to.
    if (!this.project(DEFAULT_PROJECT_ID)) {
      this.projects.unshift({ id: DEFAULT_PROJECT_ID, name: 'General', tabs: [], activeTabId: null })
    }
  }

  private get storePath(): string {
    return join(app.getPath('userData'), 'projects.json')
  }

  private load(): void {
    if (!existsSync(this.storePath)) return
    try {
      const saved = JSON.parse(readFileSync(this.storePath, 'utf8')) as Saved
      this.projects = (saved.projects ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        activeTabId: p.activeTabId,
        tabs: (p.tabs ?? []).map((t) => ({ id: t.id, url: isTabUrl(t.url) ? t.url : '', title: t.title ?? '', favicon: t.favicon }))
      }))
      this.lastUsedId = saved.lastUsedId
      this.autoApproveOrigins = new Set(saved.autoApproveOrigins ?? [])
    } catch {
      // Unreadable; start empty.
    }
  }

  /** Writes projects.json now, e.g. before quitting. */
  saveNow(): void {
    clearTimeout(this.saveTimer)
    const saved: Saved = {
      projects: this.projects.map((p) => ({
        id: p.id,
        name: p.name,
        activeTabId: p.activeTabId,
        tabs: p.tabs.map(({ id, url, title, favicon }) => ({ id, url, title, favicon }))
      })),
      lastUsedId: this.lastUsedId,
      autoApproveOrigins: [...this.autoApproveOrigins]
    }
    try {
      writeFileSync(this.storePath, JSON.stringify(saved, null, 2))
    } catch {
      // Best effort.
    }
  }

  /** Tells the UI and saves soon. Title and loading changes come often, so saving waits a beat. */
  private changed(): void {
    this.callbacks.onChanged(this.list())
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.saveNow(), 500)
  }

  list(): Project[] {
    return this.projects.map((p) => ({
      id: p.id,
      name: p.name,
      activeTabId: p.activeTabId,
      tabs: p.tabs.map((t) => this.tabState(t))
    }))
  }

  private tabState(tab: Tab): ProjectTab {
    const wc = tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents : undefined
    const origin = originOf(tab.url)
    return {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      favicon: tab.favicon,
      loaded: Boolean(wc),
      loading: wc?.isLoading() ?? false,
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      autoApproveTools: origin ? this.autoApproveOrigins.has(origin) : false
    }
  }

  private project(id: string): ProjectRecord | undefined {
    return this.projects.find((p) => p.id === id)
  }

  private activeTab(projectId: string): Tab | undefined {
    const p = this.project(projectId)
    return p?.tabs.find((t) => t.id === p.activeTabId)
  }

  // MARK: - Projects

  create(name: string): string {
    const project: ProjectRecord = { id: newId(), name: name.trim() || 'Project', tabs: [], activeTabId: null }
    this.projects.push(project)
    this.lastUsedId = project.id
    // It opens on its Home, whose box opens the first page.
    this.changed()
    return project.id
  }

  rename(id: string, name: string): void {
    const p = this.project(id)
    if (!p || !name.trim()) return
    p.name = name.trim()
    this.changed()
  }

  remove(id: string): void {
    const p = this.project(id)
    if (!p || id === DEFAULT_PROJECT_ID) return
    for (const tab of p.tabs) this.destroyView(tab)
    this.projects = this.projects.filter((q) => q !== p)
    if (this.shownId === id) this.shownId = null
    if (this.lastUsedId === id) this.lastUsedId = undefined
    this.changed()
  }

  /** Puts the projects in the given order; ids it doesn't mention keep their place at the end. */
  reorder(ids: string[]): void {
    this.projects = sortBy(this.projects, ids)
    this.changed()
  }

  // MARK: - Tabs

  /**
   * Returns the new tab's id. A tab the user opens goes first, just under the sidebar's New tab
   * (`first`); one a page opens goes after the active tab, as browsers do.
   */
  newTab(projectId: string, url?: string, opts: { activate?: boolean; first?: boolean } = {}): string | undefined {
    const p = this.project(projectId)
    if (!p) return undefined
    const tab: Tab = { id: newId(), url: url && isTabUrl(url) ? url : '', title: '' }
    const at = p.tabs.findIndex((t) => t.id === p.activeTabId)
    p.tabs.splice(opts.first ? 0 : at === -1 ? p.tabs.length : at + 1, 0, tab)
    if (opts.activate !== false || !p.activeTabId) p.activeTabId = tab.id
    // A background tab starts loading now; otherwise showing it loads it.
    if (tab.url && p.activeTabId !== tab.id) this.ensureView(tab, p)
    this.layout()
    this.changed()
    return tab.id
  }

  closeTab(projectId: string, tabId: string): void {
    const p = this.project(projectId)
    const i = p?.tabs.findIndex((t) => t.id === tabId) ?? -1
    if (!p || i === -1) return
    const [tab] = p.tabs.splice(i, 1)
    if (tab.url) this.closed = [...this.closed.slice(-(MAX_CLOSED - 1)), { projectId, url: tab.url, index: i }]
    this.destroyView(tab)
    if (p.activeTabId === tabId) p.activeTabId = (p.tabs[i] ?? p.tabs[i - 1])?.id ?? null
    this.layout()
    this.changed()
  }

  /**
   * Takes a tab out of its project without closing its page, for pinning: the page moves to the
   * pinned site as it is, scroll position, sign-in and all. Its view is the caller's now; it's
   * undefined if the tab was never loaded.
   */
  detachTab(projectId: string, tabId: string): { url: string; title: string; favicon?: string; view?: WebContentsView } | undefined {
    const p = this.project(projectId)
    const i = p?.tabs.findIndex((t) => t.id === tabId) ?? -1
    if (!p || i === -1) return undefined
    const [tab] = p.tabs.splice(i, 1)
    const view = tab.view && !tab.view.webContents.isDestroyed() ? tab.view : undefined
    // The tab's own handlers on the page stop acting once it isn't the tab's (see wire).
    tab.view = undefined
    if (p.activeTabId === tabId) p.activeTabId = (p.tabs[i] ?? p.tabs[i - 1])?.id ?? null
    this.layout()
    this.changed()
    return { url: tab.url, title: tab.title, favicon: tab.favicon, view }
  }

  /**
   * Moves a tab to another project (or Everyday), page and all: before `beforeTabId`, or first.
   * Returns true if it was the tab on screen, which the caller then follows to its new project.
   */
  moveTab(tabId: string, toProjectId: string, beforeTabId?: string): boolean {
    const from = this.projects.find((p) => p.tabs.some((t) => t.id === tabId))
    const to = this.project(toProjectId)
    if (!from || !to || from === to) return false
    const i = from.tabs.findIndex((t) => t.id === tabId)
    const [tab] = from.tabs.splice(i, 1)
    const wasShown = this.shownId === from.id && from.activeTabId === tabId
    if (from.activeTabId === tabId) from.activeTabId = (from.tabs[i] ?? from.tabs[i - 1])?.id ?? null
    const at = beforeTabId ? to.tabs.findIndex((t) => t.id === beforeTabId) : -1
    to.tabs.splice(at === -1 ? 0 : at, 0, tab)
    if (wasShown || !to.activeTabId) to.activeTabId = tab.id
    this.layout()
    this.changed()
    return wasShown
  }

  setHomeShown(projectId: string | null): void {
    this.homeShownId = projectId
  }

  /**
   * The next or previous tab in the project on screen, going round at the ends. A project's Home
   * (every project but the default one has one) comes first, before its tabs.
   */
  cycleTab(direction: 1 | -1): void {
    const id = this.homeShownId ?? this.shownId
    const p = id ? this.project(id) : undefined
    if (!p) return
    const hasHome = p.id !== DEFAULT_PROJECT_ID
    // Positions: Home (if any), then the tabs.
    const stops = p.tabs.length + (hasHome ? 1 : 0)
    if (stops < 2) return
    const onHome = hasHome && (this.homeShownId === p.id || !p.activeTabId)
    const i = onHome ? 0 : p.tabs.findIndex((t) => t.id === p.activeTabId) + (hasHome ? 1 : 0)
    const next = (i + direction + stops) % stops
    const toHome = hasHome && next === 0
    // Set now rather than when the UI catches up, so a held key keeps going round.
    this.homeShownId = toHome ? p.id : null
    if (!toHome) {
      p.activeTabId = p.tabs[next - (hasHome ? 1 : 0)].id
      this.shownId = p.id
    }
    if (hasHome) this.callbacks.onHome(p.id, toHome)
    this.layout()
    this.changed()
  }

  canReopen(): boolean {
    return this.closed.some((c) => this.project(c.projectId))
  }

  /** Brings back the tab closed last, where it was, and shows its project. */
  reopenClosedTab(): void {
    let entry = this.closed.pop()
    while (entry && !this.project(entry.projectId)) entry = this.closed.pop()
    const p = entry && this.project(entry.projectId)
    if (!entry || !p) return
    const tab: Tab = { id: newId(), url: entry.url, title: '' }
    p.tabs.splice(Math.min(entry.index, p.tabs.length), 0, tab)
    p.activeTabId = tab.id
    this.lastUsedId = p.id
    this.layout()
    this.changed()
    this.callbacks.onReveal(p.id)
  }

  activateTab(projectId: string, tabId: string): void {
    const p = this.project(projectId)
    if (!p?.tabs.some((t) => t.id === tabId)) return
    p.activeTabId = tabId
    this.layout()
    this.changed()
  }

  reorderTabs(projectId: string, tabIds: string[]): void {
    const p = this.project(projectId)
    if (!p) return
    p.tabs = sortBy(p.tabs, tabIds)
    this.changed()
  }

  navigate(projectId: string, input: string): void {
    const p = this.project(projectId)
    if (!p || !input.trim()) return
    const url = toUrl(input)
    const tab = this.activeTab(projectId)
    if (!tab) {
      this.newTab(projectId, url)
      return
    }
    tab.url = url
    if (!this.loadInView(tab, p)) this.layout() // creates and loads the view if the project is on screen
    this.changed()
  }

  back(projectId: string): void {
    const wc = this.activeTab(projectId)?.view?.webContents
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  }

  forward(projectId: string): void {
    const wc = this.activeTab(projectId)?.view?.webContents
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  }

  reload(projectId: string): void {
    this.activeTab(projectId)?.view?.webContents.reload()
  }

  stop(projectId: string): void {
    this.activeTab(projectId)?.view?.webContents.stop()
  }

  openInBrowser(projectId: string): void {
    const url = this.activeTab(projectId)?.url
    if (url) this.callbacks.openExternal(url)
  }

  /** A link from chat, an MCP App or a pinned site: a new tab in the project used last, made if need be. */
  openLink(url: string): void {
    const p = (this.lastUsedId && this.project(this.lastUsedId)) || this.projects[0]
    const projectId = p ? p.id : this.create('Browsing')
    this.newTab(projectId, url)
    this.lastUsedId = projectId
    this.callbacks.onReveal(projectId)
  }

  // MARK: - For Claude

  /** Brings a project on screen, as a link opened in it would. */
  reveal(projectId: string): void {
    if (!this.project(projectId)) return
    this.lastUsedId = projectId
    this.changed()
    this.callbacks.onReveal(projectId)
  }

  /** The project whose tab is showing `wc`. */
  projectIdFor(wc: Electron.WebContents): string | undefined {
    return this.projects.find((p) => p.tabs.some((t) => t.view?.webContents === wc))?.id
  }

  /**
   * Loads address-bar input (a URL or a search) in one of the project's tabs, or a new tab after
   * the active one, and brings the project on screen. Returns the tab's id.
   */
  openPage(projectId: string, input: string, tabId?: string): string | undefined {
    const p = this.project(projectId)
    if (!p) return undefined
    const url = toUrl(input)
    const tab = tabId ? p.tabs.find((t) => t.id === tabId) : undefined
    if (tabId && !tab) return undefined
    let id: string | undefined
    if (tab) {
      tab.url = url
      p.activeTabId = tab.id
      this.loadInView(tab, p)
      this.ensureView(tab, p)
      id = tab.id
      this.layout()
      this.changed()
    } else {
      id = this.newTab(projectId, url)
      // Shown or not, it starts loading now, so it can be read straight away.
      const created = p.tabs.find((t) => t.id === id)
      if (created) this.ensureView(created, p)
    }
    this.lastUsedId = projectId
    this.callbacks.onReveal(projectId)
    return id
  }

  /**
   * Shows one of the project's pages (main/pages.ts): in the tab showing it already, reloaded in
   * case it changed, or in a new one. Returns the tab's id.
   */
  showPage(projectId: string, url: string): string | undefined {
    const p = this.project(projectId)
    const tab = p?.tabs.find((t) => t.url === url)
    if (!p || !tab) return this.openPage(projectId, url)
    p.activeTabId = tab.id
    if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.reload()
    else this.ensureView(tab, p)
    this.lastUsedId = projectId
    this.layout()
    this.changed()
    this.callbacks.onReveal(projectId)
    return tab.id
  }

  /** Reloads the tabs showing a page, which was saved again. */
  reloadPage(url: string): void {
    for (const tab of this.projects.flatMap((p) => p.tabs)) {
      if (tab.url === url && tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.reload()
    }
  }

  /** Closes the tabs showing a page, which was deleted. */
  closePage(url: string): void {
    for (const p of this.projects) {
      for (const tab of p.tabs.filter((t) => t.url === url)) this.closeTab(p.id, tab.id)
    }
  }

  /**
   * The text of a tab's page, its title and address, and the links on it. The tab is loaded if it
   * hasn't been yet, and given a while to finish loading. The page's own scripts can't see or
   * change what's read: it runs in a separate JavaScript world.
   */
  async readTab(projectId: string, tabId?: string): Promise<PageText> {
    const { tabId: id, wc } = await this.tabContents(projectId, tabId)
    return { tabId: id, ...(await this.readContents(wc)) }
  }

  /** Reads any page the same way: a project tab's, or a pinned site's. */
  async readContents(wc: Electron.WebContents): Promise<Omit<PageText, 'tabId'>> {
    return (await wc.executeJavaScriptInIsolatedWorld(READ_WORLD_ID, [{ code: READ_PAGE_SCRIPT }])) as Omit<PageText, 'tabId'>
  }

  /** A tab's page (the active tab unless given one), loaded if it hasn't been and given a while to finish. */
  async tabContents(projectId: string, tabId?: string): Promise<{ tabId: string; wc: Electron.WebContents }> {
    const p = this.project(projectId)
    if (!p) throw new Error('No such project')
    const tab = p.tabs.find((t) => t.id === (tabId ?? p.activeTabId))
    if (!tab) throw new Error(tabId ? `No tab ${tabId} in ${p.name}` : `${p.name} has no tabs open`)
    if (!tab.url) throw new Error('That tab has no page yet')
    const view = this.ensureView(tab, p)
    if (!view) throw new Error('The app window is closed')
    const wc = view.webContents
    for (const start = Date.now(); Date.now() - start < READ_TIMEOUT_MS; ) {
      await new Promise((r) => setTimeout(r, 150))
      if (wc.isDestroyed()) throw new Error('The tab was closed')
      if (!wc.isLoading()) break
    }
    return { tabId: tab.id, wc }
  }

  /** A tab as a website Claude acts on, for approval: like sourceFor, without needing it loaded. */
  tabSource(projectId: string, tabId?: string): { id: string; name: string; autoApprove: boolean } | undefined {
    const p = this.project(projectId)
    const tab = p?.tabs.find((t) => t.id === (tabId ?? p.activeTabId))
    if (!tab?.url) return undefined
    const origin = originOf(tab.url)
    return { id: `tab:${tab.id}`, name: hostOf(tab.url), autoApprove: origin ? this.autoApproveOrigins.has(origin) : false }
  }

  // MARK: - WebMCP

  /** The project tab showing `wc`, as a WebMCP source: named after its host, approved per origin. */
  sourceFor(wc: Electron.WebContents): { id: string; name: string; autoApprove: boolean } | undefined {
    for (const p of this.projects) {
      const tab = p.tabs.find((t) => t.view?.webContents === wc)
      if (tab) {
        const origin = originOf(tab.url)
        return { id: `tab:${tab.id}`, name: hostOf(tab.url), autoApprove: origin ? this.autoApproveOrigins.has(origin) : false }
      }
    }
    return undefined
  }

  /** "Always allow" for a tab applies to its origin, in any project. */
  setAutoApprove(sourceId: string, on: boolean): void {
    const tabId = sourceId.replace(/^tab:/, '')
    const tab = this.projects.flatMap((p) => p.tabs).find((t) => t.id === tabId)
    const origin = tab && originOf(tab.url)
    if (!origin) return
    if (on) this.autoApproveOrigins.add(origin)
    else this.autoApproveOrigins.delete(origin)
    this.changed()
  }

  // MARK: - Views

  show(projectId: string, bounds: ViewBounds): void {
    if (!this.project(projectId)) return
    this.shownId = projectId
    this.bounds = bounds
    if (this.lastUsedId !== projectId) {
      this.lastUsedId = projectId
      this.changed()
    }
    this.layout()
  }

  /** The page on screen, if a project tab is showing one. */
  shownContents(): Electron.WebContents | undefined {
    const view = this.shownId ? this.activeTab(this.shownId)?.view : undefined
    return view?.getVisible() && !view.webContents.isDestroyed() ? view.webContents : undefined
  }

  setBounds(bounds: ViewBounds): void {
    if (!this.shownId) return
    this.bounds = bounds
    this.layout()
  }

  hide(): void {
    this.shownId = null
    this.layout()
  }

  /** The window went away (macOS keeps the app running); its views went with it. */
  reset(): void {
    for (const tab of this.projects.flatMap((p) => p.tabs)) tab.view = undefined
    this.shownId = null
  }

  /** Only the shown project's active tab is visible; it's created (and loaded) the first time it's needed. */
  private layout(): void {
    const shown = this.shownId ? this.activeTab(this.shownId) : undefined
    const project = this.shownId ? this.project(this.shownId) : undefined
    const want = shown && project && shown.url && this.bounds ? this.ensureView(shown, project) : undefined
    for (const tab of this.projects.flatMap((p) => p.tabs)) {
      if (tab.view && tab.view !== want) tab.view.setVisible(false)
    }
    if (want && this.bounds) {
      want.setBounds(roundBounds(this.bounds))
      want.setVisible(true)
    }
  }

  private ensureView(tab: Tab, project: ProjectRecord): WebContentsView | undefined {
    if (tab.view && !tab.view.webContents.isDestroyed()) return tab.view
    const win = this.callbacks.window()
    if (!win || !tab.url) return undefined
    const view = new WebContentsView({ webPreferences: isPageUrl(tab.url) ? pagePreferences() : webPreferences() })
    view.setBackgroundColor('#ffffff')
    tab.view = view
    this.wire(tab, project, win)
    win.contentView.addChildView(view)
    view.setVisible(false)
    void view.webContents.loadURL(tab.url).catch(() => {})
    return view
  }

  /**
   * Loads the tab's address in its view. A page and a website need different kinds of view (see
   * main/pages.ts), so going from one to the other drops the old view; showing the tab makes the new one.
   * True if it loaded in the view the tab has.
   */
  private loadInView(tab: Tab, project: ProjectRecord): boolean {
    const view = tab.view && !tab.view.webContents.isDestroyed() ? tab.view : undefined
    if (!view) return false
    if ((view.webContents.session === pageSession()) === isPageUrl(tab.url)) {
      void view.webContents.loadURL(tab.url).catch(() => {})
      return true
    }
    this.destroyView(tab)
    // A background tab keeps loading; the one on screen is made by layout().
    if (project.activeTabId !== tab.id) this.ensureView(tab, project)
    return false
  }

  private destroyView(tab: Tab): void {
    const view = tab.view
    tab.view = undefined
    if (!view) return
    this.callbacks.window()?.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  private wire(tab: Tab, project: ProjectRecord, win: BrowserWindow): void {
    const wc = tab.view!.webContents
    // The project the tab is in now: it can be moved to another (moveTab).
    const owner = (): string => this.projects.find((p) => p.tabs.includes(tab))?.id ?? project.id
    // Pinning takes the page away from the tab (detachTab); from then on it's the site's.
    const detached = (): boolean => tab.view?.webContents !== wc
    // One of the project's pages, which Claude wrote: it stays a page (see will-navigate).
    const onPage = wc.session === pageSession()
    const update = (): void => {
      if (wc.isDestroyed() || detached()) return
      const url = wc.getURL()
      if (onPage ? isPageUrl(url) : isWebUrl(url)) tab.url = url
      const title = wc.getTitle()
      if (title && title !== url) tab.title = title
      this.changed()
    }
    wc.on('did-start-loading', update)
    wc.on('did-stop-loading', update)
    wc.on('did-navigate', update)
    wc.on('did-navigate-in-page', update)
    wc.on('page-title-updated', update)
    wc.on('page-favicon-updated', (_e, favicons) => {
      if (detached()) return
      tab.favicon = favicons[0]
      this.changed()
    })

    // Popups with window features (OAuth "Sign in with…" windows) stay real popups so
    // window.opener keeps working; plain target=_blank links become tabs in this project.
    wc.setWindowOpenHandler(({ url, disposition }) => {
      // A page's links, to the web or to another page, all open as tabs; it gets no popups.
      if (onPage) {
        if (isTabUrl(url)) this.newTab(owner(), url, { activate: disposition !== 'background-tab' })
        return { action: 'deny' }
      }
      if (disposition === 'new-window') {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { parent: win, width: 520, height: 700, webPreferences: webPreferences() }
        }
      }
      if (isWebUrl(url)) this.newTab(owner(), url, { activate: disposition !== 'background-tab' })
      return { action: 'deny' }
    })

    wc.on('will-navigate', (event, url) => {
      // A page goes to its project's other pages in place. Anywhere on the web opens in a new tab,
      // so a page never turns into a website in the page session, or a website into a page.
      if (onPage) {
        if (isPageUrl(url)) return
        event.preventDefault()
        if (isWebUrl(url)) this.newTab(owner(), url)
        return
      }
      if (isWebUrl(url) || url.startsWith('about:')) return
      event.preventDefault()
      if (url.startsWith('mailto:')) this.callbacks.openExternal(url)
    })

    wc.on('context-menu', (_e, params) => {
      if (detached()) return
      const items: MenuItemConstructorOptions[] = []
      if (params.linkURL && isWebUrl(params.linkURL)) {
        items.push(
          { label: 'Open Link in New Tab', click: () => this.newTab(owner(), params.linkURL, { activate: false }) },
          { label: 'Open Link in Default Browser', click: () => this.callbacks.openExternal(params.linkURL) },
          { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
          { type: 'separator' }
        )
      }
      if (params.isEditable) {
        items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' })
      } else if (params.selectionText) {
        items.push({ role: 'copy' }, { type: 'separator' })
      }
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' },
        { label: 'Inspect Element', click: () => wc.inspectElement(params.x, params.y) }
      )
      Menu.buildFromTemplate(items).popup({ window: win })
    })
  }
}

/** What read_page returns. */
export interface PageText {
  tabId: string
  title: string
  url: string
  text: string
  links: Array<[label: string, href: string]>
}

const READ_TIMEOUT_MS = 15_000
const MAX_CLOSED = 25
/** An isolated world of our own, apart from the page's (0) and the WebMCP preload's. */
const READ_WORLD_ID = 1017
const READ_PAGE_SCRIPT = `(() => {
  const text = (document.body ? document.body.innerText : '')
    .replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim()
  const links = []
  const seen = new Set()
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href
    const label = (a.innerText || a.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ')
    if (!/^https?:/.test(href) || !label || seen.has(href)) continue
    seen.add(href)
    links.push([label.slice(0, 80), href])
    if (links.length >= 150) break
  }
  return { title: document.title, url: location.href, text, links }
})()`

function sortBy<T extends { id: string }>(items: T[], ids: string[]): T[] {
  const rank = (item: T): number => {
    const i = ids.indexOf(item.id)
    return i === -1 ? ids.length : i
  }
  return [...items].sort((a, b) => rank(a) - rank(b))
}

const roundBounds = (b: ViewBounds): Electron.Rectangle => ({
  x: Math.round(b.x),
  y: Math.round(b.y),
  width: Math.max(0, Math.round(b.width)),
  height: Math.max(0, Math.round(b.height))
})
