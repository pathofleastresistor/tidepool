import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeTheme, shell, type WebContents } from 'electron'
import { join } from 'node:path'
import { bindingsFor, command, eventMatches, toAccelerator, type CommandContext } from '@shared/commands'
import { addressLabel } from '@shared/address'
import {
  DEFAULT_PROJECT_ID,
  type AppModelContext,
  type ClearWebData,
  type FindTarget,
  type ImportKinds,
  type Settings,
  type SkillDraft,
  type ToolApprovalAnswer,
  type ViewBounds,
  type WebAppInput
} from '@shared/types'
import { detectBrowsers, importFromBrowser } from './browser-import'
import { ChatManager } from './chats'
import { HistoryRecorder } from './history'
import { Passwords } from './passwords'
import { Cards } from './cards'
import { confirmOwner } from './touch-id'
import { LocalTools } from './local-tools'
import { memoryPath, ProjectMemory } from './memory'
import { appendLine, MemorySuggester } from './memory-suggestions'
import { McpManager } from './mcp-manager'
import { AppMenu } from './menu'
import { PageZoom } from './page-zoom'
import { OVERLAY_PREFIX, Overlays } from './overlays'
import { isPageUrl, PAGE_SCHEME_PRIVILEGES, Pages } from './pages'
import { PinnedSites } from './pinned-sites'
import { ProjectManager } from './projects'
import { handleSandboxProtocol, registerSandboxScheme } from './sandbox'
import { SpeechService } from './speech'
import { Store } from './store'
import { SuggestionService } from './suggestions'
import {
  addWebApp,
  loadWebApps,
  removeWebApp,
  reorderWebApps,
  setAutoApproveTools,
  setFavicon,
  updateWebApp,
  webSession,
  WebViewManager,
  listSites,
  clearSite
} from './web-apps'
import { parseSite } from './site-data'
import { WebMcpRegistry } from './webmcp'
import { JevBrowser } from './jev'
import { PageFacts } from './page-facts'
import { ShoppingIdeas } from './shopping-ideas'
import { Skills } from './skills'
import {
  loadSettings,
  mcpConfigPath,
  getJevAccess,
  publicSettings,
  readMcpConfig,
  readMcpConfigText,
  saveSettings,
  setApiKey,
  setJevKey,
  writeMcpConfigText
} from './settings'
import { loadShellPath } from './shell-path'

app.setName('Tidepool')
// Pin the userData folder so dev, preview, and packaged builds share one (and mcp.json). It keeps
// the app's old name so existing chats and settings survive the rename; --user-data-dir still wins.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', join(app.getPath('appData'), 'MCP Client'))
}
registerSandboxScheme([PAGE_SCHEME_PRIVILEGES])
// Chromium's WebMCP (document.modelContext), so pinned sites and project tabs can offer tools.
app.commandLine.appendSwitch('enable-blink-features', 'WebMCP')

const mcp = new McpManager()
/** The login shell's PATH, loaded at startup; local servers need it. */
let shellPathLoaded!: () => void
const shellPath = new Promise<void>((resolve) => (shellPathLoaded = resolve))
let mainWindow: BrowserWindow | null = null
const overlays = new Overlays(() => mainWindow, (url) => openLink(url))

const send = (channel: string, payload: unknown): void => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

mcp.on('status', (status) => send('mcp:status', status))
const speech = new SpeechService((event) => send('speech:event', event))
const web = new WebViewManager({
  window: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  onState: (state) => send('web:state', state),
  onAppsChanged: (apps) => send('web:apps', apps),
  onClosed: (id) => send('web:closed', id),
  openExternal: (url) => openExternalSafely(url),
  // New-tab links from a pinned site (a link in an email, a doc shared in chat) open as a tab in
  // a project, or in the default browser if that's turned off.
  openLink: (url) => openLink(url)
})
const projects = new ProjectManager({
  window: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  onChanged: (list) => {
    send('projects:changed', list)
    // Closing a tab makes Reopen Closed Tab possible.
    if (app.isReady()) menu.update()
  },
  onReveal: (id) => send('projects:reveal', id),
  onHome: (id, home) => send('projects:home', [id, home]),
  openExternal: (url) => openExternalSafely(url)
})

const webmcp = new WebMcpRegistry(
  (wc) => {
    const site = web.siteFor(wc)
    return site ? { id: site.id, name: site.name, autoApprove: site.autoApproveTools === true } : projects.sourceFor(wc)
  },
  (sources) => {
    send('webmcp:sources', sources)
    suggestions.refresh()
  }
)
const suggestions = new SuggestionService(
  webmcp,
  (next) => send('webmcp:suggestions', next),
  (line) => console.warn(line)
)
const store = new Store(join(app.getPath('userData'), 'app.db'))
const passwords = new Passwords(store)
const cards = new Cards(store)
const memorySuggester = new MemorySuggester(
  store,
  (id) => projects.list().find((p) => p.id === id)?.name,
  () => send('memory:suggestionsChanged', null),
  (line) => console.warn(line)
)
const history = new HistoryRecorder(
  store,
  (wc) => {
    const site = web.siteFor(wc)
    if (site) return { projectId: null, siteName: site.name }
    const projectId = projects.projectIdFor(wc)
    return projectId ? { projectId } : undefined
  },
  (owner) => memorySuggester.noteVisit(owner.projectId)
)
const jev = new JevBrowser(getJevAccess)
const pageFacts = new PageFacts(store, jev, (projectId, host) => shoppingIdeas.forHost(projectId, host), (line) => console.warn(line))
const shoppingIdeas = new ShoppingIdeas(store, jev, (projectId) => send('ideas:changed', projectId), (line) => console.warn(line))

const skills = new Skills(
  store,
  (proposal) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false
    send('skills:proposal', proposal)
    return true
  },
  (requestId) => send('skills:proposalClosed', requestId),
  (list) => send('skills:changed', list)
)

const pages = new Pages(join(app.getPath('userData'), 'pages'), (projectId) => send('pages:changed', projectId))

const pinnedSites = new PinnedSites(web, () => readMcpConfig().mcpServers, (id) => send('web:reveal', id))

const chats = new ChatManager(
  store,
  mcp,
  webmcp,
  {
    local: new LocalTools(projects, store, jev, skills, pinnedSites, pages),
    memory: new ProjectMemory(store),
    skills,
    sites: pinnedSites,
    projectName: (id) => projects.list().find((p) => p.id === id)?.name
  },
  (event) => send('chat:event', event),
  (projectId) => send('chat:listChanged', projectId),
  (line) => console.warn(line)
)

function openExternalSafely(url: string): void {
  try {
    const { protocol } = new URL(url)
    if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') void shell.openExternal(url)
  } catch {
    // ignore malformed URLs
  }
}

/** Web links open as a tab in the last-used project (unless turned off in Settings); anything else goes to the OS. */
function openLink(url: string): void {
  if (/^https?:/i.test(url) && loadSettings().linksInBuiltInBrowser) projects.openLink(url)
  else openExternalSafely(url)
}

// MARK: - Commands (keyboard shortcuts and the menu bar)

const zoom = new PageZoom()

/** The pinned site or project tab on screen, if any. */
const activePage = (): WebContents | undefined => web.activeContents() ?? projects.shownContents()

/**
 * A key press in the app's window is handled there, and doesn't reach the menu. Should both see
 * the same one anyway (platforms differ), the menu's copy is dropped.
 */
const DUPLICATE_MS = 250
const lastRun = new Map<string, number>()

/** `from`: the app's window, a click in the menu, or a shortcut the menu caught. */
function runCommand(id: string, from: 'app' | 'menu' | 'key'): void {
  const cmd = command(id)
  if (!cmd) return
  const now = Date.now()
  if (from === 'key' && now - (lastRun.get(id) ?? 0) < DUPLICATE_MS) return
  if (from === 'app') lastRun.set(id, now)
  if (!cmd.main) {
    send('commands:run', { id, byKey: from === 'key' })
    return
  }
  const page = activePage()
  switch (id) {
    case 'page.reload':
      page?.reload()
      break
    case 'page.hardReload':
      page?.reloadIgnoringCache()
      break
    case 'page.back':
      if (page?.navigationHistory.canGoBack()) page.navigationHistory.goBack()
      break
    case 'page.forward':
      if (page?.navigationHistory.canGoForward()) page.navigationHistory.goForward()
      break
    case 'page.zoomIn':
      if (page) zoom.step(page, 1)
      break
    case 'page.zoomOut':
      if (page) zoom.step(page, -1)
      break
    case 'page.zoomReset':
      if (page) zoom.step(page, 0)
      break
    case 'tab.reopen':
      projects.reopenClosedTab()
      break
    case 'tab.next':
      projects.cycleTab(1)
      break
    case 'tab.previous':
      projects.cycleTab(-1)
      break
    // The page's tools when one is on screen, the app's otherwise.
    case 'dev.tools':
      ;(page ?? mainWindow?.webContents)?.toggleDevTools()
      break
    case 'dev.reloadApp':
      mainWindow?.webContents.reload()
      break
  }
  menu.update()
}

const menu = new AppMenu(
  (id, byKey) => runCommand(id, byKey ? 'key' : 'menu'),
  () => ({ canReopen: projects.canReopen() })
)

/** Where find in page looks: the page on screen, or the chat's overlay. */
const findTarget = (target: FindTarget): WebContents | undefined =>
  target === 'page' ? activePage() : overlays.contents(`${OVERLAY_PREFIX}chat`)
const findWired = new WeakSet<WebContents>()

/** The system-wide talk shortcut from Settings: brings the app forward and starts listening. */
let talkShortcut = ''
function registerTalkShortcut(binding: string): void {
  if (binding === talkShortcut) return
  if (talkShortcut) globalShortcut.unregister(toAccelerator(talkShortcut))
  talkShortcut = ''
  if (!binding) return
  const ok = globalShortcut.register(toAccelerator(binding), () => {
    if (!mainWindow) createWindow()
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.show()
    mainWindow?.focus()
    send('commands:run', { id: 'voice.toggle', byKey: false })
  })
  if (ok) talkShortcut = binding
  else console.warn(`couldn't register the talk shortcut ${binding}; another app may be using it`)
}

/** The user's shortcut changes from Settings. */
let keyBindings: Record<string, string> = {}

/**
 * Talk is caught here, before the page or overlay with the keyboard sees it. It has to work
 * from anywhere in the window, and the menu's copy of the shortcut doesn't reliably reach the
 * app while a website has the keyboard.
 */
function catchTalkKey(contents: WebContents): void {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const cmd = command('voice.toggle')
    if (!cmd || !speech.available()) return
    const key = { code: input.code, metaKey: input.meta, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift }
    if (!bindingsFor(cmd, process.platform, keyBindings).some((b) => eventMatches(key, b, process.platform))) return
    event.preventDefault()
    if (!input.isAutoRepeat) runCommand(cmd.id, 'app')
  })
}

function applyShortcutSettings(): void {
  const settings = loadSettings()
  keyBindings = settings.keyBindings ?? {}
  menu.setBindings(keyBindings)
  registerTalkShortcut(settings.talkShortcut ?? '')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 500,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // The app's background, so the window doesn't flash the other color before the page draws.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a1a' : '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // The e2e test drives the page directly and doesn't need focus. Taking it would send whatever
  // the person at the machine is typing into the test window.
  mainWindow.on('ready-to-show', () =>
    process.env.TIDEPOOL_E2E ? mainWindow?.showInactive() : mainWindow?.show()
  )
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Links clicked in the chat (target=_blank) open in a project tab or the system browser.
  // ...except the app's own overlays: blank windows it renders floating UI into (see overlays.ts).
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url === 'about:blank' && frameName.startsWith(OVERLAY_PREFIX)) {
      return {
        action: 'allow',
        createWindow: (options) => overlays.create(frameName, options)
      }
    }
    openLink(url)
    return { action: 'deny' }
  })

  // The top-level renderer never navigates away from the app.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) {
      event.preventDefault()
      openLink(url)
    }
  })

  // Site views are native and draw over the page. If the app's own page reloads, the UI that
  // positioned them is gone, so hide them until the new page asks again.
  mainWindow.webContents.on('did-start-loading', () => {
    web.hide()
    projects.hide()
    overlays.reset()
  })
  mainWindow.on('closed', () => {
    web.reset()
    projects.reset()
    overlays.reset()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** The host of a frame asking to fill a form, for the Touch ID prompt ("…on shop.example"). */
function frameHost(url: string | undefined): string {
  try {
    return new URL(url ?? '').host || 'this page'
  } catch {
    return 'this page'
  }
}

/** Whether a frame is somewhere cards may fill: https, or this machine (local development). */
function isSecureFrame(url: string | undefined): boolean {
  try {
    const u = new URL(url ?? '')
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
  } catch {
    return false
  }
}

function registerIpc(): void {
  ipcMain.handle('settings:get', () => publicSettings())
  ipcMain.handle('settings:update', (_e, patch: Partial<Settings>) => {
    saveSettings(patch)
    if ('pageSuggestions' in patch) suggestions.refresh()
    if ('keyBindings' in patch || 'talkShortcut' in patch) applyShortcutSettings()
    return publicSettings()
  })
  ipcMain.handle('settings:setApiKey', (_e, key: string) => {
    setApiKey(key)
    return publicSettings()
  })
  ipcMain.handle('settings:setJevKey', (_e, key: string) => {
    setJevKey(String(key ?? ''))
    return publicSettings()
  })

  ipcMain.handle('mcp:getStatus', () => mcp.getStatus())
  ipcMain.handle('mcp:reload', async () => {
    await shellPath
    await mcp.loadFromConfig()
    return mcp.getStatus()
  })
  ipcMain.handle('mcp:readConfig', () => readMcpConfigText())
  ipcMain.handle('mcp:writeConfig', async (_e, text: string) => {
    writeMcpConfigText(text)
    // Local servers are started with the login shell's PATH, which may still be loading.
    await shellPath
    await mcp.loadFromConfig()
    return mcp.getStatus()
  })
  ipcMain.handle('mcp:openConfigFile', async () => {
    readMcpConfigText() // ensure it exists
    await shell.openPath(mcpConfigPath())
  })
  // Calls from the renderer originate from MCP Apps (AppBridge oncalltool), so enforce app visibility.
  ipcMain.handle('mcp:callTool', (_e, server: string, name: string, args: Record<string, unknown>) =>
    mcp.callTool(server, name, args ?? {}, { fromApp: true })
  )
  ipcMain.handle('mcp:readUiResource', (_e, server: string, uri: string) => mcp.readUiResource(server, uri))
  ipcMain.handle('mcp:readResource', (_e, server: string, uri: string) => mcp.readResource(server, uri))
  ipcMain.handle('mcp:listResources', (_e, server: string) => mcp.listResources(server))
  ipcMain.handle('mcp:signIn', async (_e, server: string) => {
    await mcp.signIn(server)
    return mcp.getStatus()
  })
  ipcMain.handle('mcp:cancelSignIn', (_e, server: string) => mcp.cancelSignIn(server))
  ipcMain.handle('mcp:signOut', async (_e, server: string) => {
    await mcp.signOut(server)
    return mcp.getStatus()
  })
  ipcMain.handle('mcp:setClientSecret', (_e, server: string, secret: string) =>
    mcp.setClientSecret(String(server), String(secret ?? ''))
  )

  ipcMain.handle('chat:list', (_e, projectId: string) => chats.list(String(projectId)))
  ipcMain.handle('chat:create', (_e, projectId: string) => {
    if (!projects.list().some((p) => p.id === projectId)) throw new Error('That project no longer exists')
    return chats.create(projectId)
  })
  ipcMain.handle('chat:open', (_e, id: string) => chats.open(String(id)))
  ipcMain.handle('chat:send', (_e, id: string, text: string, fromApp?: boolean) =>
    chats.send(String(id), String(text ?? ''), fromApp === true)
  )
  ipcMain.handle('chat:stop', (_e, id: string) => chats.stop(String(id)))
  ipcMain.handle('chat:remove', (_e, id: string) => chats.remove(String(id)))
  ipcMain.handle('chat:setAppContext', (_e, id: string, ctx: AppModelContext | null, appId: string) =>
    chats.setAppContext(String(id), appId, ctx)
  )
  ipcMain.handle('chat:answerApproval', (_e, callId: string, answer: ToolApprovalAnswer) =>
    chats.answerApproval(callId, answer)
  )

  ipcMain.handle('speech:available', () => speech.available())
  ipcMain.handle('speech:start', () => speech.start())
  ipcMain.handle('speech:stop', () => speech.stop())
  ipcMain.handle('speech:cancel', () => speech.cancel())
  ipcMain.handle('speech:openPrivacySettings', (_e, pane: 'microphone' | 'speech') =>
    speech.openPrivacySettings(pane === 'speech' ? 'speech' : 'microphone')
  )

  ipcMain.handle('web:list', () => loadWebApps())
  ipcMain.handle('web:add', (_e, input: WebAppInput) => addWebApp(input))
  ipcMain.handle('web:update', (_e, id: string, input: WebAppInput) => {
    const apps = updateWebApp(id, input)
    web.close(id) // reopens at the new address next time it's shown
    return apps
  })
  ipcMain.handle('web:remove', (_e, id: string) => {
    web.close(id)
    return removeWebApp(id)
  })
  ipcMain.handle('web:reorder', (_e, ids: string[]) => reorderWebApps(ids))
  ipcMain.handle('web:close', (_e, id: string) => web.close(id))
  ipcMain.handle('web:show', (_e, id: string, bounds) => {
    projects.hide()
    web.show(id, bounds)
    overlays.raise()
  })
  ipcMain.handle('web:setBounds', (_e, bounds) => web.setBounds(bounds))
  ipcMain.handle('web:hide', () => web.hide())
  ipcMain.handle('web:back', (_e, id: string) => web.back(id))
  ipcMain.handle('web:forward', (_e, id: string) => web.forward(id))
  ipcMain.handle('web:reload', (_e, id: string) => web.reload(id))
  ipcMain.handle('web:openInBrowser', (_e, id: string) => web.openInBrowser(id))
  ipcMain.handle('web:clearData', (_e, what: ClearWebData) =>
    web.clearData({ cache: what?.cache === true, cookies: what?.cookies === true })
  )
  ipcMain.handle('web:listSites', () => listSites())
  ipcMain.handle('web:clearSite', async (_e, typed: string) => {
    const site = typeof typed === 'string' ? parseSite(typed) : undefined
    if (!site) return null
    await clearSite(site, store.urlsMentioning(site))
    return site
  })

  ipcMain.handle('projects:list', () => projects.list())
  ipcMain.handle('projects:create', (_e, name: string) => projects.create(String(name ?? '')))
  ipcMain.handle('projects:rename', (_e, id: string, name: string) => projects.rename(id, String(name ?? '')))
  ipcMain.handle('projects:remove', (_e, id: string) => {
    if (id === DEFAULT_PROJECT_ID) return
    projects.remove(id)
    chats.removeProject(id)
    store.deleteProjectMemory(id)
    store.forgetProjectVisits(id)
    pages.removeProject(id)
    send('memory:suggestionsChanged', null)
  })

  ipcMain.handle('history:search', (_e, opts: { query?: string; projectId?: string; limit?: number; before?: number }) =>
    store.searchHistory({
      query: typeof opts?.query === 'string' ? opts.query : undefined,
      projectId: typeof opts?.projectId === 'string' ? opts.projectId : undefined,
      before: typeof opts?.before === 'number' ? opts.before : undefined,
      limit: Math.min(Math.max(Number(opts?.limit) || 100, 1), 500)
    })
  )
  ipcMain.handle('history:complete', (_e, typed: string, projectId?: string) =>
    typeof typed === 'string' && typed.length <= 2048 ? store.completeAddress(typed, typeof projectId === 'string' ? projectId : undefined) : undefined
  )
  ipcMain.handle('history:remove', (_e, id: number) => store.deleteVisit(Number(id)))
  ipcMain.handle('history:clear', () => store.clearHistory())

  // MARK: - Import from another browser, saved logins and autofill

  ipcMain.handle('browserImport:detect', () => detectBrowsers())
  ipcMain.handle('browserImport:run', async (_e, browserId: string, profile: string, kinds: ImportKinds) => {
    const imported = await importFromBrowser(
      String(browserId),
      String(profile),
      {
        cookies: Boolean(kinds?.cookies),
        passwords: Boolean(kinds?.passwords),
        addresses: Boolean(kinds?.addresses),
        cards: Boolean(kinds?.cards)
      },
      webSession()
    )
    const { result } = imported
    if (imported.credentials.length) result.passwords = passwords.save(imported.credentials)
    if (imported.addresses.length) result.addresses = store.upsertAddresses(imported.addresses)
    if (imported.cards.length) result.cards = cards.save(imported.cards)
    return result
  })

  ipcMain.handle('addresses:list', () => store.listAddresses())
  ipcMain.handle('addresses:remove', (_e, id: number) => store.deleteAddress(Number(id)))
  ipcMain.handle('addresses:clear', () => store.clearAddresses())
  ipcMain.handle('cards:list', () => cards.list())
  ipcMain.handle('cards:remove', (_e, id: number) => cards.remove(Number(id)))
  ipcMain.handle('cards:clear', () => cards.clear())

  ipcMain.handle('passwords:list', () => passwords.list())
  ipcMain.handle('passwords:remove', (_e, id: number) => passwords.remove(Number(id)))
  ipcMain.handle('passwords:clear', () => passwords.clear())
  // Raw channels for the web preload's autofill (preload/web.ts): usernames to offer, then the
  // password for the chosen one, once the OS biometric prompt is cleared. Off unless enabled.
  ipcMain.handle('passwords:match', (_e, pageUrl: string) =>
    loadSettings().autofill ? passwords.matches(String(pageUrl)) : []
  )
  ipcMain.handle('passwords:fill', (_e, id: number, host: string) => {
    if (!loadSettings().autofill) throw new Error('Autofill is turned off.')
    return passwords.reveal(Number(id), `fill your saved login for ${String(host)}`)
  })
  // Addresses for the web preload: short labels to offer, then one address's fields once the user
  // picks it and clears Touch ID.
  ipcMain.handle('addresses:offer', () =>
    loadSettings().autofill ? store.listAddresses().map((a) => ({ id: a.id, label: addressLabel(a) })) : []
  )
  ipcMain.handle('addresses:fill', async (e, id: number) => {
    if (!loadSettings().autofill) throw new Error('Autofill is turned off.')
    const address = store.getAddress(Number(id))
    if (!address) throw new Error('That saved address no longer exists.')
    await confirmOwner(`fill your saved address on ${frameHost(e.senderFrame?.url)}`)
    return address
  })
  // Cards for the web preload, only in secure pages (as browsers do): "Visa •••• 4242" to offer,
  // then the number, expiry and code once the user picks one and clears Touch ID. The host in the
  // prompt comes from the frame that asked, not from anything the page says.
  ipcMain.handle('cards:offer', (e) =>
    loadSettings().autofill && isSecureFrame(e.senderFrame?.url) ? cards.offers() : []
  )
  ipcMain.handle('cards:fill', (e, id: number) => {
    if (!loadSettings().autofill) throw new Error('Autofill is turned off.')
    if (!isSecureFrame(e.senderFrame?.url)) throw new Error('Cards only fill on secure (https) pages.')
    return cards.reveal(Number(id), frameHost(e.senderFrame?.url))
  })

  ipcMain.handle('memory:list', (_e, projectId: string) => store.memoryFiles(String(projectId)))
  ipcMain.handle('memory:write', (_e, projectId: string, path: string, content: string) => {
    const file = memoryPath(path)
    if (file === '/memories') throw new Error('Give the file a name, like /memories/notes.md')
    store.writeMemory(String(projectId), file, String(content ?? ''))
    return store.memoryFiles(String(projectId))
  })
  ipcMain.handle('memory:remove', (_e, projectId: string, path: string) => {
    store.deleteMemory(String(projectId), memoryPath(path))
    return store.memoryFiles(String(projectId))
  })
  ipcMain.handle('memory:append', (_e, projectId: string, path: string, line: string) => {
    appendLine(store, String(projectId), String(path), String(line ?? ''))
    return store.memoryFiles(String(projectId))
  })
  ipcMain.handle('memory:suggestions', () => store.pendingSuggestions())
  ipcMain.handle('memory:suggest', async (_e, projectId: string) => {
    await memorySuggester.suggestNow(String(projectId))
    return store.pendingSuggestions()
  })
  ipcMain.handle('memory:accept', (_e, id: number, text: string) => memorySuggester.accept(Number(id), String(text ?? '')))
  ipcMain.handle('memory:dismiss', (_e, id: number) => memorySuggester.dismiss(Number(id)))
  ipcMain.handle('skills:list', () => skills.list())
  ipcMain.handle('skills:save', (_e, draft: SkillDraft, id?: string) => {
    skills.save(draft ?? {}, typeof id === 'string' ? id : undefined)
    return skills.list()
  })
  ipcMain.handle('skills:remove', (_e, id: string) => {
    skills.remove(String(id))
    return skills.list()
  })
  ipcMain.handle('skills:answerProposal', (_e, requestId: string, draft: SkillDraft | null) =>
    skills.answer(String(requestId), draft ?? null)
  )
  ipcMain.handle('projects:reorder', (_e, ids: string[]) => projects.reorder(ids))
  // null when Jev isn't set up or couldn't answer, so the UI falls back to offering the basics.
  ipcMain.handle('projects:insights', async (_e, id: string, tabId: string) => {
    const wc = await projects.tabContents(String(id), String(tabId)).then(
      (t) => t.wc,
      () => undefined
    )
    return wc ? pageFacts.insights(wc, String(id), id === DEFAULT_PROJECT_ID) : null
  })
  ipcMain.handle('pages:list', (_e, projectId: string) => pages.list(String(projectId)))
  ipcMain.handle('pages:open', (_e, projectId: string, name: string) => {
    const page = pages.get(String(projectId), String(name))
    if (page) projects.showPage(String(projectId), page.url)
  })
  ipcMain.handle('pages:remove', (_e, projectId: string, name: string) => {
    const page = pages.get(String(projectId), String(name))
    if (!page) return
    pages.remove(String(projectId), page.name)
    projects.closePage(page.url)
  })
  ipcMain.handle('ideas:list', (_e, projectId: string) => shoppingIdeas.list(String(projectId)))
  ipcMain.handle('ideas:dismiss', (_e, id: number) => shoppingIdeas.dismiss(Number(id)))
  // In a new tab: the search as the user's earlier ones on that store looked, or else the store,
  // searched once it loads.
  ipcMain.handle('ideas:open', async (_e, id: number) => {
    const idea = store.shoppingIdea(Number(id))
    if (!idea) return
    const unfiled = idea.projectId === DEFAULT_PROJECT_ID
    const known = pageFacts.searchUrlFor(idea.projectId, idea.host, unfiled, idea.term)
    const tabId = projects.newTab(idea.projectId, known ?? `https://${idea.host}/`)
    send('projects:reveal', idea.projectId)
    if (known || !tabId) return
    try {
      const { wc } = await projects.tabContents(idea.projectId, tabId)
      await pageFacts.searchHere(wc, idea.projectId, unfiled, idea.term)
    } catch (err) {
      console.warn(`shopping idea search failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  ipcMain.handle('projects:searchHere', async (_e, id: string, tabId: string, term: string) => {
    try {
      const { wc } = await projects.tabContents(String(id), String(tabId))
      return await pageFacts.searchHere(wc, String(id), id === DEFAULT_PROJECT_ID, String(term ?? ''))
    } catch (err) {
      console.warn(`search here failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  })
  // From the app: New tab, ⌘T, Home's search, History. Links from pages go after the active tab instead.
  ipcMain.handle('projects:newTab', (_e, id: string, url?: string) => projects.newTab(id, url, { first: true }))
  ipcMain.handle('projects:closeTab', (_e, id: string, tabId: string) => projects.closeTab(id, tabId))
  ipcMain.handle('projects:activateTab', (_e, id: string, tabId: string) => projects.activateTab(id, tabId))
  ipcMain.handle('projects:setHomeShown', (_e, id: string | null) => projects.setHomeShown(typeof id === 'string' ? id : null))
  ipcMain.handle('projects:reorderTabs', (_e, id: string, tabIds: string[]) => projects.reorderTabs(id, tabIds))
  ipcMain.handle('projects:moveTab', (_e, tabId: string, toId: string, beforeTabId?: string) =>
    projects.moveTab(String(tabId), String(toId), typeof beforeTabId === 'string' ? beforeTabId : undefined)
  )
  // A tab's menu in a project's tab strip. It's native because the page, a native view, would cover
  // one drawn in the app's window. A tab on screen that moves is followed to its new project.
  ipcMain.handle('projects:tabMenu', (_e, id: string, tabId: string) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const others = projects.list().filter((p) => p.id !== id)
    Menu.buildFromTemplate([
      ...others.map((p) => ({
        label: `Move to ${p.id === DEFAULT_PROJECT_ID ? 'Everyday' : p.name}`,
        click: () => {
          if (projects.moveTab(String(tabId), p.id)) projects.reveal(p.id)
        }
      })),
      ...(others.length ? [{ type: 'separator' as const }] : []),
      { label: 'Close Tab', click: () => projects.closeTab(String(id), String(tabId)) }
    ]).popup({ window: mainWindow })
  })
  // The tab becomes the pinned site, page and all, rather than a copy of it opening alongside.
  ipcMain.handle('projects:pinTab', (_e, id: string, tabId: string) => {
    // A project's own page stays in it.
    if (isPageUrl(projects.list().find((p) => p.id === id)?.tabs.find((t) => t.id === tabId)?.url ?? '')) return undefined
    const tab = projects.detachTab(id, tabId)
    if (!tab?.url) return undefined
    let apps = addWebApp({ url: tab.url })
    const site = apps[apps.length - 1]
    if (tab.favicon) apps = setFavicon(site.id, tab.favicon) ?? apps
    send('web:apps', apps)
    if (tab.view) {
      web.adopt(site.id, tab.view)
      webmcp.refresh()
    }
    return site.id
  })
  ipcMain.handle('projects:navigate', (_e, id: string, input: string) => projects.navigate(id, String(input ?? '')))
  ipcMain.handle('projects:back', (_e, id: string) => projects.back(id))
  ipcMain.handle('projects:forward', (_e, id: string) => projects.forward(id))
  ipcMain.handle('projects:reload', (_e, id: string) => projects.reload(id))
  ipcMain.handle('projects:stop', (_e, id: string) => projects.stop(id))
  ipcMain.handle('projects:openInBrowser', (_e, id: string) => projects.openInBrowser(id))
  ipcMain.handle('projects:show', (_e, id: string, bounds: ViewBounds) => {
    // One native view on screen at a time: a project tab replaces any pinned site.
    web.hide()
    projects.show(id, bounds)
    overlays.raise()
  })
  ipcMain.handle('overlay:setBounds', (_e, name: string, bounds: ViewBounds | null) =>
    overlays.setBounds(`${OVERLAY_PREFIX}${name}`, bounds)
  )
  ipcMain.handle('overlay:focus', (_e, name: string) => overlays.focus(`${OVERLAY_PREFIX}${name}`))
  ipcMain.handle('projects:setBounds', (_e, bounds: ViewBounds) => projects.setBounds(bounds))
  ipcMain.handle('projects:hide', () => projects.hide())

  // Only pages in the websites' profile report tools (preload/web.ts), never the app's own window.
  ipcMain.on('webmcp:tools', (e, tools: unknown) => {
    if (e.sender.session === webSession()) webmcp.update(e.sender, tools)
  })
  ipcMain.handle('webmcp:getSources', () => webmcp.sources())
  ipcMain.on('webmcp:result', (e, result: unknown) => webmcp.settle(e.sender, result))
  ipcMain.handle('webmcp:setCurrentSite', (_e, siteId: string | null) => {
    webmcp.setCurrentSite(siteId)
    suggestions.refresh()
  })
  ipcMain.handle('webmcp:getSuggestions', () => suggestions.get())
  // A pinned site keeps the choice itself; a project tab's is kept for its origin.
  ipcMain.handle('webmcp:setAutoApprove', (_e, siteId: string, on: boolean) => {
    if (siteId.startsWith('tab:')) projects.setAutoApprove(siteId, on === true)
    else send('web:apps', setAutoApproveTools(siteId, on === true))
    send('webmcp:sources', webmcp.sources())
  })

  ipcMain.handle('commands:setContext', (_e, ctx: CommandContext) => menu.setContext(ctx))
  ipcMain.handle('commands:run', (_e, id: string) => runCommand(String(id), 'app'))
  ipcMain.handle('app:focus', () => mainWindow?.webContents.focus())
  ipcMain.handle('clipboard:writeText', (_e, text: string) => clipboard.writeText(String(text ?? '')))
  ipcMain.handle('find:start', (_e, target: FindTarget, text: string, opts: { forward?: boolean; newSearch?: boolean }) => {
    const wc = findTarget(target)
    if (!wc) return
    if (!findWired.has(wc)) {
      findWired.add(wc)
      wc.on('found-in-page', (_event, result) =>
        send('find:result', { active: result.activeMatchOrdinal ?? 0, matches: result.matches ?? 0 })
      )
    }
    if (!text) {
      wc.stopFindInPage('clearSelection')
      send('find:result', { active: 0, matches: 0 })
      return
    }
    wc.findInPage(String(text), { forward: opts?.forward !== false, findNext: opts?.newSearch === true })
  })
  ipcMain.handle('find:stop', (_e, target: FindTarget) => findTarget(target)?.stopFindInPage('clearSelection'))

  // Links from MCP Apps (ui/open-link) and the chat UI.
  ipcMain.handle('openLink', (_e, url: string) => openLink(url))
  ipcMain.handle('openExternal', (_e, url: string) => openExternalSafely(url))
}

app.whenReady().then(async () => {
  // Packaged builds get the icon from electron-builder; in dev the Dock would show Electron's.
  // Tests start out/main/index.js directly, where the app path has no build/; the window matters more.
  if (!app.isPackaged && process.platform === 'darwin') {
    try {
      app.dock?.setIcon(join(app.getAppPath(), 'build/icon.png'))
    } catch {
      // Electron's icon, then.
    }
  }
  handleSandboxProtocol()
  pages.serve()
  registerIpc()
  applyShortcutSettings()

  // Default for every web contents: popups go through openLink instead of spawning windows.
  // Project tabs and pinned sites replace this with their own handler right after creation.
  app.on('web-contents-created', (_e, contents) => {
    // Pages in project tabs and pinned sites go in browsing history; the rest are skipped there.
    history.track(contents)
    catchTalkKey(contents)
    // Sites keep their zoom, as in Chrome.
    if (contents.session === webSession()) zoom.track(contents)
    contents.setWindowOpenHandler(({ url }) => {
      openLink(url)
      return { action: 'deny' }
    })
  })

  createWindow()
  await loadShellPath().finally(shellPathLoaded)
  // Servers added in Settings while the PATH loaded are already connected; reconnecting them
  // now would restart them under whatever is using them.
  await mcp.loadIfNeeded()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  // Give stdio servers a chance to exit cleanly.
  quitting = true
  event.preventDefault()
  speech.discard()
  chats.stopAll()
  projects.saveNow()
  void Promise.allSettled([web.flush(), mcp.closeAll()]).finally(() => {
    store.close()
    app.quit()
  })
})

