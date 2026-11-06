// Types shared between the main process, preload bridge, and renderer.
import type { ChatState } from './chat-state'
import type { CommandContext } from './commands'

/** One MCP server entry, in the same shape Claude Desktop uses in claude_desktop_config.json. */
export type McpServerConfig =
  | {
      command: string
      args?: string[]
      env?: Record<string, string>
      cwd?: string
      disabled?: boolean
    }
  | {
      url: string
      /** "http" (Streamable HTTP, default) or "sse" (legacy). */
      transport?: 'http' | 'sse'
      headers?: Record<string, string>
      /**
       * OAuth sign-in, on by default: it only starts when the server answers 401. Set clientId for
       * servers without dynamic client registration (Google Workspace); the secret is entered in
       * Settings and kept in the keychain. false turns sign-in off.
       */
      oauth?: { clientId?: string; redirectPort?: number } | false
      disabled?: boolean
    }

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface Settings {
  model: string
  effort: Effort
  systemPrompt: string
  /** Show summarized thinking in the transcript. */
  showThinking: boolean
  /** Opt into server-side refusal fallbacks (only sent for models that support it). */
  refusalFallbacks: boolean
  /** Open web links from chat, MCP Apps and pinned sites as tabs in a project instead of the default browser. */
  linksInBuiltInBrowser: boolean
  /** Suggest things to ask for, based on the tools the open page offers. */
  pageSuggestions: boolean
  /** Let Claude search the web (Anthropic's server-side web search; searches are billed per use). */
  webSearch: boolean
  /** Let Claude keep notes in each project's memory and read them in later chats. */
  memory: boolean
  /** Have Claude Haiku look at browsing now and then and suggest memory notes, which the user reviews. */
  browsingMemory: boolean
  /** Sites (hosts, like "mybank.com") whose visits are never used for memory suggestions. */
  memoryExcludedSites: string[]
  /** Shortcuts changed in Settings, by command id (src/shared/commands.ts); "" turns one off. */
  keyBindings: Record<string, string>
  /** A shortcut that works from any app: it brings Tidepool forward and starts talking. "" is off. */
  talkShortcut: string
  /** Offer to fill saved logins on sign-in forms in built-in websites and tabs. */
  autofill: boolean
  /**
   * Run every tool call without asking, even on the user's signed-in sites and after Claude read
   * what websites wrote. Off unless the user turns it on.
   */
  skipApprovals: boolean
}

/** A browser found installed that logins and cookies can be imported from (main/browser-import.ts). */
export interface DetectedBrowser {
  id: string
  name: string
  /** The profile folder inside the browser's data folder ("Default", "Profile 4"). */
  profile: string
  /** The profile's name as the browser shows it, when it has one. */
  profileName?: string
  /** The OS default browser, so the UI can lead with it. */
  isDefault: boolean
  hasCookies: boolean
  /** Saved logins in the profile, both on-device and saved to the browser's account. */
  passwordCount: number
  /** Saved addresses (name, street, email, phone) in the profile. */
  addressCount: number
  /** Payment cards saved on this device (Google Pay cards live on Google's servers and can't be copied). */
  cardCount: number
}

/** What to bring over in an import. */
export interface ImportKinds {
  cookies: boolean
  passwords: boolean
  addresses: boolean
  cards: boolean
}

/** How an import went. */
export interface ImportResult {
  browserId: string
  profile: string
  cookies: number
  passwords: number
  /** Saved logins left behind: app-only logins, or ones whose password wouldn't decrypt. */
  passwordsSkipped: number
  addresses: number
  cards: number
  /** Cards left behind: Google Pay cards (only the last four digits are on disk), or undecryptable. */
  cardsSkipped: number
}

/** A saved login shown in settings; never carries the password. */
export interface SavedLogin {
  id: number
  origin: string
  host: string
  username: string
  source?: string
  importedAt: number
}

/** A saved login offered for a form: enough to pick between accounts, no password. */
export interface AutofillMatch {
  id: number
  host: string
  username: string
}

/** The parts of an address a form can ask for; any may be empty. */
export interface AddressFields {
  name: string
  givenName: string
  familyName: string
  organization: string
  street: string
  line1: string
  line2: string
  city: string
  state: string
  postalCode: string
  country: string
  email: string
  phone: string
}

/** A saved address, for the settings list and for filling a form. */
export interface SavedAddress extends AddressFields {
  id: number
  source?: string
  importedAt: number
}

/** A saved payment card as the settings list shows it: never the number or security code. */
export interface SavedCard {
  id: number
  nameOnCard: string
  nickname: string
  /** Visa, Mastercard, Amex, Discover, or Card. */
  network: string
  lastFour: string
  expMonth: number
  expYear: number
  hasCvc: boolean
  source?: string
  importedAt: number
}

/** A saved card offered for a form: enough to pick between cards. */
export interface CardOffer {
  id: number
  label: string
}

/** What a card fill hands the page, after Touch ID. */
export interface CardFill {
  number: string
  nameOnCard: string
  expMonth: number
  expYear: number
  cvc: string
}

/** Who serves Jev: TypeSafe itself, or OpenRouter. */
export type JevProvider = 'typesafe' | 'openrouter'

export interface PublicSettings extends Settings {
  hasApiKey: boolean
  /** True when the key came from ANTHROPIC_API_KEY rather than the settings UI. */
  apiKeyFromEnv: boolean
  /** Where the browse tool (main/jev.ts) reaches Jev, going by the key given; null without one. */
  jevProvider: JevProvider | null
  /** True when the Jev key came from the environment rather than the settings UI. */
  jevKeyFromEnv: boolean
  mcpConfigPath: string
}

export interface ToolSummary {
  name: string
  title?: string
  description?: string
  /** ui:// resource for MCP Apps tools. */
  uiResourceUri?: string
  /** Tool visibility per the MCP Apps spec; defaults to ["model", "app"]. */
  visibility: Array<'model' | 'app'>
}

export interface ServerStatus {
  name: string
  /** Hostname-safe key used for the per-server sandbox origin. */
  key: string
  status: 'connecting' | 'connected' | 'needs-auth' | 'error' | 'disabled'
  error?: string
  /** OAuth state for remote servers that use sign-in. */
  auth?: ServerAuth
  serverInfo?: { name: string; version: string }
  instructions?: string
  tools: ToolSummary[]
  resourceCount: number
  stderr: string[]
}

export interface ServerAuth {
  signedIn: boolean
  /** A sign-in is waiting on the browser. */
  signingIn: boolean
  /** The server can't register Tidepool by itself; the user has to supply a client ID. */
  needsClient: boolean
  hasClientSecret: boolean
  /** The redirect URI to register with a pre-registered client. */
  redirectUri: string
}

/** A UI resource fetched for an MCP App, ready to hand to the sandbox. */
export interface UiResource {
  html: string
  csp?: {
    connectDomains?: string[]
    resourceDomains?: string[]
    frameDomains?: string[]
    baseUriDomains?: string[]
  }
  permissions?: Record<string, unknown>
  prefersBorder?: boolean
}

/** MCP CallToolResult, loosely typed for IPC. */
export interface ToolResult {
  content: Array<Record<string, unknown> & { type: string }>
  structuredContent?: unknown
  isError?: boolean
  _meta?: Record<string, unknown>
}

/** Streaming events sent from the main process agent loop to the renderer. */
export type ChatEvent =
  | { type: 'turn-start'; turnId: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | {
      type: 'tool-start'
      callId: string
      server: string
      serverKey: string
      tool: string
      input: Record<string, unknown>
      uiResourceUri?: string
      /** A call waiting for the user's OK; answer with chat.answerApproval(). */
      approval?: ToolApproval
    }
  /**
   * Claude is still writing a tool call's input (a page's HTML can take a while): how much so far.
   * tool-start for the same callId follows once it's written.
   */
  | { type: 'tool-drafting'; callId: string; server: string; tool: string; chars: number }
  | { type: 'tool-result'; callId: string; result: ToolResult }
  | { type: 'fallback'; from: string; to: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens: number }
  | { type: 'turn-end'; stopReason: string | null }
  | { type: 'error'; message: string }

/** A chat event, tagged with the conversation it belongs to. */
export interface ConversationEvent {
  conversationId: string
  event: ChatEvent
}

/** A saved chat, as the sidebar lists it. */
export interface ConversationSummary {
  id: string
  projectId: string
  /** Empty until the first message; then a short name for what it's about. */
  title: string
  createdAt: number
  updatedAt: number
  /** Claude is answering in it right now. */
  busy: boolean
}

/** A page visited in a project tab or a pinned site. */
export interface HistoryEntry {
  id: number
  url: string
  title: string
  visitedAt: number
  /** The project whose tab it was in; null for a pinned site, or a project since deleted. */
  projectId: string | null
  /** The pinned site it was in. */
  siteName: string | null
}

/** A chat that matched a search, with the words around its best match. */
export interface ChatSearchHit {
  conversationId: string
  title: string
  projectId: string
  snippet: string
  at: number
}

/** A note suggested from browsing, waiting for the user to add it to memory or dismiss it. */
export interface MemorySuggestion {
  id: number
  projectId: string
  /** The memory file it would be added to, under /memories. */
  path: string
  text: string
  /** What in the browsing it's based on, e.g. "9 visits to ikea.com this week". */
  reason: string
  createdAt: number
}

/** A file in a project's memory, which Claude keeps under /memories. */
export interface MemoryFile {
  path: string
  content: string
  updatedAt: number
}

/** Context an MCP App pushed via ui/update-model-context; attached to the next user turn. */
export interface AppModelContext {
  appId: string
  server: string
  tool: string
  content?: Array<{ type: string; text?: string }>
  structuredContent?: Record<string, unknown>
}

/** A site pinned to the sidebar: one page of its own, like a pinned tab. */
export interface WebApp {
  id: string
  name: string
  url: string
  /** Last favicon the site reported. */
  favicon?: string
  /** Let Claude act on the site without asking first: its WebMCP tools, browse, its connection (the user chose "Always allow"). */
  autoApproveTools?: boolean
  /** What the site is for, in the user's words; Claude sees it with the name, to know what the site can do. */
  about?: string
  /**
   * The MCP server that reaches this site (Home Assistant's own, for a Home Assistant dashboard), which
   * Claude uses ahead of operating the page. Unset: a server whose address is on the site's host, if any.
   * '' means none.
   */
  server?: string
}

/** What the pinned-site dialog saves. */
export interface WebAppInput {
  name?: string
  url: string
  about?: string
  server?: string
}

/** Where a website's view is and what it's showing; pushed whenever that changes. */
/** What to clear from the websites' shared session. */
export interface ClearWebData {
  /** Cached images and files. Sign-ins are kept. */
  cache: boolean
  /** Cookies and site storage. Signs out of every site. */
  cookies: boolean
}

/** A site in the websites' profile that has something stored. */
export interface SiteData {
  /** The registrable domain, e.g. "google.com" for accounts.google.com too. */
  site: string
  cookies: number
}

export interface WebViewState {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/** Screen area (CSS px, relative to the window content) the active website should fill. */
export interface ViewBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Events from the on-device speech helper (see native/speech-helper/main.swift). */
export type SpeechEvent =
  | { type: 'listening' }
  | { type: 'level'; value: number }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'cancelled' }
  | { type: 'error'; code: string; message: string }
  /** The helper process is gone, whatever the reason. Always the last event of a session. */
  | { type: 'ended' }

/** A tab in a project. */
export interface ProjectTab {
  id: string
  /** Empty for a new tab that hasn't been given an address yet. */
  url: string
  title: string
  favicon?: string
  /** Its page is loaded. Tabs restored from last time wait until they're first shown. */
  loaded: boolean
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** Its site's WebMCP tools run without asking (the user chose "Always allow" for this origin). */
  autoApproveTools: boolean
}

/** The project every chat falls back to. It always exists and can't be deleted. */
export const DEFAULT_PROJECT_ID = 'general'

/** A page Claude made for a project (main/pages.ts). */
export interface PageSummary {
  /** Its file name, like "trip-plan"; saving another page with it replaces this one. */
  name: string
  title: string
  /** tidepool-page://<project id>/<name>, which opens in a project tab. */
  url: string
  updatedAt: number
}

/** A named set of browser tabs, shown as a horizontal tab strip, with its own chats. */
export interface Project {
  id: string
  name: string
  tabs: ProjectTab[]
  activeTabId: string | null
}

/** Something the user could ask for on the open page, written as they'd type it. */
export interface PageSuggestion {
  label: string
  /** The page tool it would use. */
  tool: string
}

/** A search made on a site before, to run again. */
export interface RepeatSearch {
  /** As typed, from the search's address. */
  term: string
  url: string
  /** On how many separate days it was searched. */
  times: number
}

/** What Tidepool offers on the page on screen, from what Jev made of it (main/page-facts.ts). */
export interface PageInsights {
  /** Mostly reading, so Summarize and Key points fit. */
  summarizable: boolean
  /** The site sells things. */
  store: boolean
  /** On a store, searches made there before: most repeated first. */
  searches: RepeatSearch[]
  /** On a store, searches made at other stores lately that Jev thinks this one sells. */
  elsewhere: SearchElsewhere[]
}

/** A search made at another store, or suggested by an interest, to run on this one. */
export interface SearchElsewhere {
  term: string
  /** The store it was searched at. */
  from?: string
  /** The interest from memory it's for (a shopping idea). */
  interest?: string
}

/** An interest from memory paired with a store good for it (main/shopping-ideas.ts). */
export interface ShoppingIdea {
  id: number
  /** Like "mid-century lighting". */
  interest: string
  /** What to search the store for. */
  term: string
  host: string
  /** A store the user hasn't been to. */
  isNew: boolean
}

/** What a skill says: something the user taught Tidepool to repeat (main/skills.ts). */
export interface SkillDraft {
  /** Short, like "Check the sprint board". */
  name: string
  /** When Claude should use it, like "when I ask what's left in the sprint". */
  whenToUse: string
  /** Where it starts; empty for a skill that doesn't start on a page. */
  startUrl: string
  /** What to do, as instructions to Claude. */
  steps: string
}

/** A saved skill. Every one was saved or approved by the user, so its steps are the user's words. */
export interface Skill extends SkillDraft {
  id: string
  createdAt: number
  updatedAt: number
  lastRunAt: number | null
}

/** A skill Claude drafted, waiting for the user to save it (edited, if they like) or not. */
export interface SkillProposal {
  requestId: string
  draft: SkillDraft
  /** The skill with the same name it would replace. */
  replaces?: string
}

/** Suggestions for one open page (a WebMcpSource siteId). */
export interface PageSuggestions {
  siteId: string | null
  suggestions: PageSuggestion[]
}

/**
 * What a call waiting for the user's OK is: a website's tool, or Claude opening a page after it
 * read content from websites in the same turn.
 */
export type ToolApproval =
  | {
      kind: 'site'
      siteId: string
      site: string
      /**
       * Asked because this turn already read another site (named here), even though this one may be
       * always allowed: what that site wrote could be steering the call. "Always" isn't offered.
       */
      afterReading?: string
    }
  | { kind: 'navigate'; siteId: string; url: string }

/** Allow this call, refuse it, or allow it and every later call on that site. */
export type ToolApprovalAnswer = 'allow' | 'deny' | 'always'

/** A tool a page registered with WebMCP (document.modelContext.registerTool). */
export interface WebMcpTool {
  name: string
  title?: string
  description: string
  /** Parsed JSON Schema, or the raw string if the page's schema wasn't valid JSON. */
  inputSchema?: unknown
  annotations?: Record<string, unknown>
  /** Origin of the frame that registered it; differs from the page's when an iframe did. */
  origin: string
}

/** An open page and the WebMCP tools it currently has registered. */
export interface WebMcpSource {
  webContentsId: number
  /** A pinned site's id, or "tab:<id>" for a project tab. */
  siteId: string
  /** The pinned site's name, or a project tab's host. */
  name: string
  url: string
  tools: WebMcpTool[]
  /** Its tools run without asking (WebApp.autoApproveTools, or the tab's origin was allowed). */
  autoApprove: boolean
}

export type FindTarget = 'page' | 'chat'

export interface FindResult {
  /** Which match is selected, from 1; 0 when there are none. */
  active: number
  matches: number
}

export interface ElectronApi {
  settings: {
    get(): Promise<PublicSettings>
    update(patch: Partial<Settings>): Promise<PublicSettings>
    setApiKey(key: string): Promise<PublicSettings>
    setJevKey(key: string): Promise<PublicSettings>
  }
  mcp: {
    getStatus(): Promise<ServerStatus[]>
    reload(): Promise<ServerStatus[]>
    readConfig(): Promise<string>
    writeConfig(json: string): Promise<ServerStatus[]>
    openConfigFile(): Promise<void>
    callTool(server: string, name: string, args: Record<string, unknown>): Promise<ToolResult>
    readUiResource(server: string, uri: string): Promise<UiResource>
    readResource(server: string, uri: string): Promise<unknown>
    listResources(server: string): Promise<unknown>
    /** Opens the browser to sign in and resolves once the server has reconnected. */
    signIn(server: string): Promise<ServerStatus[]>
    cancelSignIn(server: string): Promise<void>
    signOut(server: string): Promise<ServerStatus[]>
    /** Stores a pre-registered OAuth client's secret; an empty string removes it. */
    setClientSecret(server: string, secret: string): Promise<void>
    onStatus(cb: (status: ServerStatus[]) => void): () => void
  }
  chat: {
    /** The project's chats, most recently used first. */
    list(projectId: string): Promise<ConversationSummary[]>
    create(projectId: string): Promise<ConversationSummary>
    /** The conversation as it stands, including a turn still streaming. */
    open(conversationId: string): Promise<ChatState>
    /** Resolves when Claude's turn ends. */
    send(conversationId: string, text: string, fromApp?: boolean): Promise<void>
    stop(conversationId: string): Promise<void>
    remove(conversationId: string): Promise<void>
    setAppContext(conversationId: string, ctx: AppModelContext | null, appId: string): Promise<void>
    /** The user's answer to a website tool call waiting for approval. */
    answerApproval(callId: string, answer: ToolApprovalAnswer): Promise<void>
    onEvent(cb: (event: ConversationEvent) => void): () => void
    /** A project's chat list changed (a new chat, a title, one started or stopped answering). */
    onListChanged(cb: (projectId: string) => void): () => void
  }
  speech: {
    /** Whether voice input can work here (macOS with the helper built). */
    available(): Promise<boolean>
    start(): Promise<void>
    /** Finish now with whatever has been heard. */
    stop(): Promise<void>
    /** Discard the utterance. */
    cancel(): Promise<void>
    openPrivacySettings(pane: 'microphone' | 'speech'): Promise<void>
    onEvent(cb: (event: SpeechEvent) => void): () => void
  }
  web: {
    list(): Promise<WebApp[]>
    add(input: WebAppInput): Promise<WebApp[]>
    update(id: string, input: WebAppInput): Promise<WebApp[]>
    remove(id: string): Promise<WebApp[]>
    /** Save the sites in this order. */
    reorder(ids: string[]): Promise<WebApp[]>
    /** Unload a site's page, like closing its tab; it stays in the list. */
    close(id: string): Promise<void>
    /** Show a website filling `bounds`, loading it the first time. Others are hidden. */
    show(id: string, bounds: ViewBounds): Promise<void>
    setBounds(bounds: ViewBounds): Promise<void>
    /** Hide whichever website is showing (it keeps running). */
    hide(): Promise<void>
    back(id: string): Promise<void>
    forward(id: string): Promise<void>
    reload(id: string): Promise<void>
    openInBrowser(id: string): Promise<void>
    /** Clear the websites' cache, or their cookies and site storage (which signs out of them), or both. */
    clearData(what: ClearWebData): Promise<void>
    /** Sites with cookies, the most first. */
    listSites(): Promise<SiteData[]>
    /** Clear one site's cookies, cache and storage (signs out of it only). Resolves to the site cleared, or null if what was given isn't one. */
    clearSite(site: string): Promise<string | null>
    onState(cb: (state: WebViewState) => void): () => void
    onAppsChanged(cb: (apps: WebApp[]) => void): () => void
    onClosed(cb: (id: string) => void): () => void
    /** Claude is working in a pinned site: show it. */
    onReveal(cb: (id: string) => void): () => void
  }
  /** NodeJS.Platform of the host, e.g. "darwin". */
  platform: string
  /** Floating UI drawn above websites (see src/main/overlays.ts). Null bounds hide it. */
  overlay: {
    setBounds(name: string, bounds: ViewBounds | null): Promise<void>
    /** Gives the overlay the keyboard, so something in it can be focused. */
    focus(name: string): Promise<void>
  }
  projects: {
    list(): Promise<Project[]>
    /** Makes a project with one new tab, and returns its id. */
    create(name: string): Promise<string>
    rename(id: string, name: string): Promise<void>
    /** Closes all of the project's tabs and forgets it. */
    remove(id: string): Promise<void>
    reorder(ids: string[]): Promise<void>
    /** Opens a tab after the active one and switches to it; with no url, an empty tab waiting for an address. */
    newTab(projectId: string, url?: string): Promise<void>
    closeTab(projectId: string, tabId: string): Promise<void>
    activateTab(projectId: string, tabId: string): Promise<void>
    /** The project whose Home is on screen (null for none), so Ctrl+Tab can go round through it. */
    setHomeShown(projectId: string | null): Promise<void>
    reorderTabs(projectId: string, tabIds: string[]): Promise<void>
    /** Moves the tab, page and all, to a new pinned site; returns the site's id. */
    pinTab(projectId: string, tabId: string): Promise<string | undefined>
    /**
     * Moves a tab, page and all, to another project (or the default one): before another tab, or
     * first. Resolves true if it was the tab on screen.
     */
    moveTab(tabId: string, toProjectId: string, beforeTabId?: string): Promise<boolean>
    /** A tab's menu (move to another project, close), as a native menu so pages can't cover it. */
    tabMenu(id: string, tabId: string): Promise<void>
    /** What Jev makes of the tab's page, for what to offer there; null without a Jev key or when it can't tell. */
    insights(projectId: string, tabId: string): Promise<PageInsights | null>
    /** Searches the store in the tab for this; false if it couldn't find a way to. */
    searchHere(projectId: string, tabId: string, term: string): Promise<boolean>
    /** Loads address-bar input (a URL, a hostname or a search) in the project's active tab. */
    navigate(projectId: string, input: string): Promise<void>
    back(projectId: string): Promise<void>
    forward(projectId: string): Promise<void>
    reload(projectId: string): Promise<void>
    stop(projectId: string): Promise<void>
    openInBrowser(projectId: string): Promise<void>
    /** Show the project's active tab filling `bounds`, loading it if needed. Hides pinned sites' views too. */
    show(projectId: string, bounds: ViewBounds): Promise<void>
    setBounds(bounds: ViewBounds): Promise<void>
    /** Hide whichever project tab is showing (every tab keeps running). */
    hide(): Promise<void>
    onChanged(cb: (projects: Project[]) => void): () => void
    /** A link was opened in this project; the UI should switch to it. */
    onReveal(cb: (projectId: string) => void): () => void
    /** Ctrl+Tab went to the project's Home (true) or from it to a tab (false). */
    onHome(cb: (projectId: string, home: boolean) => void): () => void
  }
  webmcp: {
    /** Every open website that has registered WebMCP tools. */
    getSources(): Promise<WebMcpSource[]>
    onSources(cb: (sources: WebMcpSource[]) => void): () => void
    /** The page the user has open (a WebMcpSource siteId), whose tools Claude is offered; null for none. */
    setCurrentSite(siteId: string | null): Promise<void>
    /** Whether that page's tools run without asking: saved on the pinned site, or for a tab's origin. */
    setAutoApprove(siteId: string, on: boolean): Promise<void>
    /** Suggestions for the open page, as they are now; updates arrive through onSuggestions. */
    getSuggestions(): Promise<PageSuggestions>
    onSuggestions(cb: (suggestions: PageSuggestions) => void): () => void
  }
  /** Pages Claude made for a project (main/pages.ts). */
  pages: {
    /** Newest first. */
    list(projectId: string): Promise<PageSummary[]>
    /** Shows the page in one of the project's tabs: the one it's in already, or a new one. */
    open(projectId: string, name: string): Promise<void>
    /** Deletes the page and closes the tabs showing it. */
    remove(projectId: string, name: string): Promise<void>
    /** A project's pages changed. */
    onChanged(cb: (projectId: string) => void): () => void
  }
  /** Interests from memory paired with stores good for them (main/shopping-ideas.ts). */
  ideas: {
    /** The project's ideas; looks again in the background if it's time, then onChanged fires. */
    list(projectId: string): Promise<ShoppingIdea[]>
    /** Opens the idea's search in a new tab in its project. */
    open(id: number): Promise<void>
    dismiss(id: number): Promise<void>
    /** A project's ideas changed. */
    onChanged(cb: (projectId: string) => void): () => void
  }
  history: {
    /** Newest first; with a query, visits whose title or address has every word. */
    search(opts: { query?: string; projectId?: string; limit?: number; before?: number }): Promise<HistoryEntry[]>
    /** What to fill in after an address being typed, from history: all of it, typed part included. */
    complete(typed: string, projectId?: string): Promise<string | undefined>
    remove(id: number): Promise<void>
    clear(): Promise<void>
  }
  /** Import cookies and saved logins from the user's other browser (macOS; main/browser-import.ts). */
  browserImport: {
    /** Browsers found installed that can be imported from, default first. */
    detect(): Promise<DetectedBrowser[]>
    /** Bring the chosen kinds over; reading the source browser's key prompts for Keychain access. */
    run(browserId: string, profile: string, kinds: ImportKinds): Promise<ImportResult>
  }
  /** Saved addresses for form autofill, imported from another browser. */
  addresses: {
    list(): Promise<SavedAddress[]>
    remove(id: number): Promise<void>
    clear(): Promise<void>
  }
  /** Saved payment cards (main/cards.ts). Numbers and security codes never cross this boundary. */
  cards: {
    list(): Promise<SavedCard[]>
    remove(id: number): Promise<void>
    clear(): Promise<void>
  }
  /** Saved logins and autofill (main/passwords.ts). Passwords never cross this boundary. */
  passwords: {
    list(): Promise<SavedLogin[]>
    remove(id: number): Promise<void>
    clear(): Promise<void>
  }
  memory: {
    list(projectId: string): Promise<MemoryFile[]>
    write(projectId: string, path: string, content: string): Promise<MemoryFile[]>
    remove(projectId: string, path: string): Promise<MemoryFile[]>
    /** Adds a line to a memory file, making the file if it's new. */
    append(projectId: string, path: string, line: string): Promise<MemoryFile[]>
    /** Suggestions from browsing still waiting for review, in every project. */
    suggestions(): Promise<MemorySuggestion[]>
    /** Looks at a project's browsing now; resolves with every project's pending suggestions. */
    suggest(projectId: string): Promise<MemorySuggestion[]>
    /** Adds a suggestion (as edited) to its memory file. */
    accept(id: number, text: string): Promise<void>
    dismiss(id: number): Promise<void>
    onSuggestionsChanged(cb: () => void): () => void
  }
  /** Routines the user taught Tidepool, which Claude repeats when asked (main/skills.ts). */
  skills: {
    list(): Promise<Skill[]>
    /** Saves a new skill, or changes the one with `id`. Rejects a draft that's missing something. */
    save(draft: SkillDraft, id?: string): Promise<Skill[]>
    remove(id: string): Promise<Skill[]>
    onChanged(cb: (skills: Skill[]) => void): () => void
    /** Claude drafted a skill (save_skill); the user saves it or not with answerProposal. */
    onProposal(cb: (proposal: SkillProposal) => void): () => void
    /** A proposal is no longer waiting (the chat was stopped). */
    onProposalClosed(cb: (requestId: string) => void): () => void
    /** The draft as the user saved it, or null for no. Rejects a draft that's missing something. */
    answerProposal(requestId: string, draft: SkillDraft | null): Promise<void>
  }
  /** Keyboard shortcuts and the menu bar (src/shared/commands.ts). */
  commands: {
    /** What's on screen, so the menu bar can turn off what can't be done now. */
    setContext(ctx: CommandContext): Promise<void>
    /** Runs one of the commands the main process handles (those marked `main`). */
    run(id: string): Promise<void>
    /**
     * A command picked from the menu bar for the app to run. `byKey` when its shortcut picked it
     * (pressed on a page, usually) rather than a click.
     */
    onCommand(cb: (id: string, byKey: boolean) => void): () => void
  }
  /** Find in page, for the page on screen or the chat. */
  find: {
    /** `newSearch` starts over with new text; otherwise it moves to the next or previous match. */
    start(target: FindTarget, text: string, opts: { forward: boolean; newSearch: boolean }): Promise<void>
    stop(target: FindTarget): Promise<void>
    onResult(cb: (result: FindResult) => void): () => void
  }
  /** Gives the app's own page the keyboard, from a website or an overlay that had it. */
  focusApp(): Promise<void>
  copyText(text: string): Promise<void>
  /** Opens a link the way the user prefers: a tab in the last-used project, or the system browser. */
  openLink(url: string): Promise<void>
  openExternal(url: string): Promise<void>
}
