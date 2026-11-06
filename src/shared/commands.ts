/**
 * Every keyboard shortcut in the app, in one list. The menu bar (src/main/menu.ts), the key
 * handler in the app's window (src/renderer/src/commands.ts), the shortcuts sheet, Settings and
 * the hints on buttons are all built from it.
 *
 * A binding is written like an Electron accelerator: "CmdOrCtrl+Shift+T". CmdOrCtrl is ⌘ on macOS
 * and Ctrl elsewhere. Keys are matched by their physical position (KeyboardEvent.code), so ⌘[
 * works the same on any keyboard layout and with Shift or Option held.
 */

/** What's on screen, which decides what a command can do right now. */
export interface CommandContext {
  view: 'home' | 'site' | 'project'
  /** A pinned site or project tab is showing (not hidden behind a dialog or a fullscreen app). */
  page: boolean
  /** A dialog is open. */
  modal: boolean
  chatOpen: boolean
  /** The chat on screen is answering. */
  busy: boolean
  /** The chat on screen has a reply to copy. */
  hasReply: boolean
  fullscreenApp: boolean
  /** Tabs in the project on screen. */
  tabCount: number
  /** The project on screen has a Home, which Ctrl+Tab goes round through with its tabs. */
  hasHome?: boolean
  /** The page on screen can be pinned to the sidebar (a project tab that isn't pinned yet). */
  canPin: boolean
  findOpen: boolean
  /** Voice input works here. */
  voice: boolean
  /** Names of the sidebar's sites and projects, in order, for ⌘1 to ⌘9. */
  sidebar: string[]
  /** A closed project tab can be brought back. Only the main process knows; the app assumes yes. */
  canReopen?: boolean
}

export const EMPTY_CONTEXT: CommandContext = {
  view: 'home',
  page: false,
  modal: false,
  chatOpen: false,
  busy: false,
  hasReply: false,
  fullscreenApp: false,
  tabCount: 0,
  canPin: false,
  findOpen: false,
  voice: false,
  sidebar: []
}

export type CommandGroup = 'App' | 'Chat' | 'Tabs' | 'Page' | 'Go' | 'Developer'

export interface Command {
  id: string
  label: string
  group: CommandGroup
  /** Bindings on macOS and elsewhere; the first is the one shown. Empty means no shortcut. */
  keys: { mac: string[]; other: string[] }
  /**
   * Yields to the page: while a website has the keyboard, it gets these keys (⌘K is search in
   * Slack and Linear, for instance). Everything else is the app's wherever you are, as a
   * browser's tab and window shortcuts are.
   */
  yieldsToPage?: boolean
  /** Run by the main process (it acts on the page on screen); the rest run in the app's window. */
  main?: boolean
  /** Whether it can run now. Always, when absent. */
  when?: (ctx: CommandContext) => boolean
}

const same = (...keys: string[]): Command['keys'] => ({ mac: keys, other: keys })

const onPage = (ctx: CommandContext): boolean => ctx.page

/** ⌘1 to ⌘8 go to that sidebar item and ⌘9 to the last, as ⌘1–9 pick tabs in a browser. */
const goToItem = (n: number): Command => ({
  id: n === 9 ? 'go.last' : `go.item${n}`,
  label: n === 9 ? 'Last Sidebar Item' : `Sidebar Item ${n}`,
  group: 'Go',
  keys: same(`CmdOrCtrl+${n}`),
  when: (ctx) => (n === 9 ? ctx.sidebar.length > 0 : ctx.sidebar.length >= n)
})

export const COMMANDS: Command[] = [
  // App
  { id: 'app.quickOpen', label: 'Quick Open…', group: 'App', keys: same('CmdOrCtrl+K'), yieldsToPage: true },
  { id: 'app.home', label: 'Home', group: 'App', keys: same('CmdOrCtrl+Shift+H') },
  {
    id: 'app.history',
    label: 'History',
    group: 'App',
    // Ctrl+Y is Redo on Windows and Linux, where browsers use Ctrl+H for history.
    keys: { mac: ['CmdOrCtrl+Y'], other: ['Ctrl+H'] }
  },
  { id: 'app.memory', label: 'Memory', group: 'App', keys: same('CmdOrCtrl+Shift+M') },
  { id: 'app.skills', label: 'Skills', group: 'App', keys: same() },
  { id: 'app.settings', label: 'Settings…', group: 'App', keys: same('CmdOrCtrl+,') },
  { id: 'app.shortcuts', label: 'Keyboard Shortcuts', group: 'App', keys: same('CmdOrCtrl+/'), yieldsToPage: true },

  // Chat
  { id: 'chat.new', label: 'New Chat', group: 'Chat', keys: same('CmdOrCtrl+N', 'CmdOrCtrl+Shift+O') },
  { id: 'chat.toggle', label: 'Show or Hide Chat', group: 'Chat', keys: same('CmdOrCtrl+J') },
  { id: 'chat.focus', label: 'Focus Message Box', group: 'Chat', keys: same('Shift+Escape'), yieldsToPage: true },
  { id: 'voice.toggle', label: 'Talk', group: 'Chat', keys: same('CmdOrCtrl+Shift+Space'), when: (ctx) => ctx.voice },
  { id: 'chat.stop', label: 'Stop Reply', group: 'Chat', keys: same('CmdOrCtrl+.'), when: (ctx) => ctx.busy },
  // Claude drafts a skill from the chat, and the user saves it (main/skills.ts).
  {
    id: 'chat.saveSkill',
    label: 'Save as Skill…',
    group: 'Chat',
    keys: same(),
    when: (ctx) => ctx.hasReply && !ctx.busy
  },
  {
    id: 'chat.copyReply',
    label: 'Copy Last Reply',
    group: 'Chat',
    keys: same('CmdOrCtrl+Shift+;'),
    yieldsToPage: true,
    when: (ctx) => ctx.hasReply
  },

  // Tabs
  { id: 'tab.new', label: 'New Tab', group: 'Tabs', keys: same('CmdOrCtrl+T') },
  {
    id: 'tab.close',
    label: 'Close Tab',
    group: 'Tabs',
    keys: same('CmdOrCtrl+W'),
    // Never the window: that's ⌘⇧W. On Home, with nothing to close, the key does nothing.
    when: (ctx) => ctx.modal || ctx.findOpen || ctx.fullscreenApp || ctx.view === 'site' || ctx.tabCount > 0
  },
  {
    id: 'tab.reopen',
    label: 'Reopen Closed Tab',
    group: 'Tabs',
    keys: same('CmdOrCtrl+Shift+T'),
    main: true,
    when: (ctx) => ctx.canReopen !== false
  },
  {
    id: 'tab.next',
    label: 'Next Tab',
    group: 'Tabs',
    keys: { mac: ['Ctrl+Tab', 'CmdOrCtrl+Alt+Right', 'CmdOrCtrl+Shift+]'], other: ['Ctrl+Tab', 'Ctrl+PageDown'] },
    // The main process has the tabs as they are this instant, which matters with the key held.
    main: true,
    when: (ctx) => ctx.view === 'project' && ctx.tabCount + (ctx.hasHome ? 1 : 0) > 1
  },
  {
    id: 'tab.previous',
    label: 'Previous Tab',
    group: 'Tabs',
    keys: { mac: ['Ctrl+Shift+Tab', 'CmdOrCtrl+Alt+Left', 'CmdOrCtrl+Shift+['], other: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'] },
    main: true,
    when: (ctx) => ctx.view === 'project' && ctx.tabCount + (ctx.hasHome ? 1 : 0) > 1
  },
  {
    id: 'tab.address',
    label: 'Open Location…',
    group: 'Tabs',
    keys: { mac: ['CmdOrCtrl+L'], other: ['CmdOrCtrl+L', 'F6', 'Alt+D'] }
  },

  // Page
  { id: 'page.reload', label: 'Reload Page', group: 'Page', keys: { mac: ['CmdOrCtrl+R'], other: ['CmdOrCtrl+R', 'F5'] }, main: true, when: onPage },
  {
    id: 'page.hardReload',
    label: 'Hard Reload Page',
    group: 'Page',
    keys: { mac: ['CmdOrCtrl+Shift+R'], other: ['CmdOrCtrl+Shift+R', 'Ctrl+F5'] },
    main: true,
    when: onPage
  },
  // ⌘← and ⌘→ are left alone: in a text field they move the cursor.
  { id: 'page.back', label: 'Back', group: 'Page', keys: { mac: ['CmdOrCtrl+['], other: ['Alt+Left', 'CmdOrCtrl+['] }, main: true, when: onPage },
  { id: 'page.forward', label: 'Forward', group: 'Page', keys: { mac: ['CmdOrCtrl+]'], other: ['Alt+Right', 'CmdOrCtrl+]'] }, main: true, when: onPage },
  { id: 'page.find', label: 'Find…', group: 'Page', keys: same('CmdOrCtrl+F'), when: (ctx) => ctx.page || ctx.chatOpen },
  { id: 'page.findNext', label: 'Find Next', group: 'Page', keys: { mac: ['CmdOrCtrl+G'], other: ['CmdOrCtrl+G', 'F3'] }, when: (ctx) => ctx.findOpen },
  {
    id: 'page.findPrevious',
    label: 'Find Previous',
    group: 'Page',
    keys: { mac: ['CmdOrCtrl+Shift+G'], other: ['CmdOrCtrl+Shift+G', 'Shift+F3'] },
    when: (ctx) => ctx.findOpen
  },
  { id: 'page.zoomIn', label: 'Zoom In', group: 'Page', keys: same('CmdOrCtrl+='), main: true, when: onPage },
  { id: 'page.zoomOut', label: 'Zoom Out', group: 'Page', keys: same('CmdOrCtrl+-'), main: true, when: onPage },
  { id: 'page.zoomReset', label: 'Actual Size', group: 'Page', keys: same('CmdOrCtrl+0'), main: true, when: onPage },
  { id: 'page.pin', label: 'Pin Page to Sidebar', group: 'Page', keys: same('CmdOrCtrl+D'), when: (ctx) => ctx.canPin },

  // Go
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(goToItem),

  // Developer
  {
    id: 'dev.tools',
    label: 'Developer Tools',
    group: 'Developer',
    keys: { mac: ['CmdOrCtrl+Alt+I'], other: ['Ctrl+Shift+I'] },
    main: true
  },
  { id: 'dev.reloadApp', label: 'Reload Tidepool', group: 'Developer', keys: same(), main: true }
]

const byId = new Map(COMMANDS.map((c) => [c.id, c]))
export const command = (id: string): Command | undefined => byId.get(id)

export const isEnabled = (cmd: Command, ctx: CommandContext): boolean => (cmd.when ? cmd.when(ctx) : true)

const isMac = (platform: string): boolean => platform === 'darwin'

/**
 * The command's bindings here, with the user's changes from Settings: a changed command has
 * just the one binding it was given, and an empty one has none.
 */
export function bindingsFor(cmd: Command, platform: string, overrides?: Record<string, string>): string[] {
  const custom = overrides?.[cmd.id]
  if (custom !== undefined) return custom ? [custom] : []
  return isMac(platform) ? cmd.keys.mac : cmd.keys.other
}

// MARK: - Parsing

interface Parsed {
  cmdOrCtrl: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** Only on macOS, where it's ⌘ written out; CmdOrCtrl is the usual way to say it. */
  cmd: boolean
  key: string
}

const MODIFIERS = new Set(['cmdorctrl', 'commandorcontrol', 'ctrl', 'control', 'alt', 'option', 'shift', 'cmd', 'command'])

function parse(binding: string): Parsed | undefined {
  // "CmdOrCtrl++" can't happen: the plus key is written "=" with Shift.
  const parts = binding.split('+')
  const key = parts.pop()
  if (!key) return undefined
  const mods = parts.map((p) => p.toLowerCase())
  if (mods.some((m) => !MODIFIERS.has(m))) return undefined
  return {
    cmdOrCtrl: mods.includes('cmdorctrl') || mods.includes('commandorcontrol'),
    ctrl: mods.includes('ctrl') || mods.includes('control'),
    alt: mods.includes('alt') || mods.includes('option'),
    shift: mods.includes('shift'),
    cmd: mods.includes('cmd') || mods.includes('command'),
    key: key.length === 1 ? key.toUpperCase() : key
  }
}

/** Binding key names and the KeyboardEvent.code for each. */
const CODES: Record<string, string> = {
  '[': 'BracketLeft',
  ']': 'BracketRight',
  '=': 'Equal',
  '-': 'Minus',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  ';': 'Semicolon',
  "'": 'Quote',
  '`': 'Backquote',
  '\\': 'Backslash',
  Space: 'Space',
  Escape: 'Escape',
  Tab: 'Tab',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Home: 'Home',
  End: 'End'
}
const KEYS_BY_CODE = new Map(Object.entries(CODES).map(([key, code]) => [code, key]))

function codeOf(key: string): string {
  if (/^[A-Z]$/.test(key)) return `Key${key}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  return CODES[key] ?? key // F1 to F12 are their own code
}

/** The binding's key for a KeyboardEvent.code, or undefined for keys bindings don't use. */
function keyOfCode(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-2])$/.test(code)) return code
  return KEYS_BY_CODE.get(code)
}

interface KeyEventLike {
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export function eventMatches(e: KeyEventLike, binding: string, platform: string): boolean {
  const b = parse(binding)
  if (!b || e.code !== codeOf(b.key)) return false
  const mac = isMac(platform)
  const wantMeta = b.cmd || (mac && b.cmdOrCtrl)
  const wantCtrl = b.ctrl || (!mac && b.cmdOrCtrl)
  return e.metaKey === wantMeta && e.ctrlKey === wantCtrl && e.altKey === b.alt && e.shiftKey === b.shift
}

/**
 * The binding a key press makes, for recording one in Settings. It needs ⌘, Ctrl or Option (or
 * is a function key), so it can't be mistaken for typing.
 */
export function bindingFromEvent(e: KeyEventLike, platform: string): string | undefined {
  const key = keyOfCode(e.code)
  if (!key) return undefined
  const mac = isMac(platform)
  const mods: string[] = []
  if (mac ? e.metaKey : e.ctrlKey) mods.push('CmdOrCtrl')
  if (mac && e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  const hasCommandKey = mods.some((m) => m !== 'Shift')
  if (!hasCommandKey && !/^F\d+$/.test(key)) return undefined
  return [...mods, key].join('+')
}

/** For Electron's menu and globalShortcut. */
export function toAccelerator(binding: string): string {
  const b = parse(binding)
  if (!b) return binding
  const mods = [
    b.cmdOrCtrl && 'CmdOrCtrl',
    b.cmd && 'Command',
    b.ctrl && 'Ctrl',
    b.alt && 'Alt',
    b.shift && 'Shift'
  ].filter(Boolean)
  return [...mods, b.key].join('+')
}

const MAC_KEY_LABELS: Record<string, string> = {
  // ⎋ is what macOS menus use, but few people recognize it.
  Escape: 'Esc',
  Space: 'Space',
  Tab: '⇥',
  Enter: '↩',
  Backspace: '⌫',
  Delete: '⌦',
  Left: '←',
  Right: '→',
  Up: '↑',
  Down: '↓',
  PageUp: 'Page Up',
  PageDown: 'Page Down'
}
const OTHER_KEY_LABELS: Record<string, string> = {
  Escape: 'Esc',
  Left: '←',
  Right: '→',
  Up: '↑',
  Down: '↓',
  PageUp: 'PgUp',
  PageDown: 'PgDn'
}

/** How a binding is shown: ⌘⇧T on macOS, Ctrl+Shift+T elsewhere. */
export function formatBinding(binding: string, platform: string): string {
  const b = parse(binding)
  if (!b) return binding
  if (isMac(platform)) {
    // macOS's order: Control, Option, Shift, Command.
    const mods = `${b.ctrl ? '⌃' : ''}${b.alt ? '⌥' : ''}${b.shift ? '⇧' : ''}${b.cmdOrCtrl || b.cmd ? '⌘' : ''}`
    return mods + (MAC_KEY_LABELS[b.key] ?? b.key)
  }
  const mods = [b.cmdOrCtrl || b.ctrl ? 'Ctrl' : '', b.alt ? 'Alt' : '', b.shift ? 'Shift' : ''].filter(Boolean)
  return [...mods, OTHER_KEY_LABELS[b.key] ?? b.key].join('+')
}

/** The command using `binding` here, other than `except`, to warn about a clash. */
export function commandUsing(
  binding: string,
  platform: string,
  overrides: Record<string, string> | undefined,
  except?: string
): Command | undefined {
  const target = parse(binding)
  if (!target) return undefined
  const same = (other: string): boolean => {
    const o = parse(other)
    if (!o) return false
    const mac = isMac(platform)
    const meta = (p: Parsed): boolean => p.cmd || (mac && p.cmdOrCtrl)
    const ctrl = (p: Parsed): boolean => p.ctrl || (!mac && p.cmdOrCtrl)
    return o.key === target.key && meta(o) === meta(target) && ctrl(o) === ctrl(target) && o.alt === target.alt && o.shift === target.shift
  }
  return COMMANDS.find((c) => c.id !== except && bindingsFor(c, platform, overrides).some(same))
}
