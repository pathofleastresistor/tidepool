import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import {
  bindingsFor,
  command,
  COMMANDS,
  EMPTY_CONTEXT,
  isEnabled,
  toAccelerator,
  type CommandContext
} from '@shared/commands'

/**
 * The menu bar, built from the command list (src/shared/commands.ts). Besides listing every
 * command with its shortcut, it's what makes shortcuts work while a website has the keyboard:
 * pages are separate web contents that the app's own key handler never hears from, but the
 * menu's shortcuts apply to the whole window.
 *
 * Shortcuts that yield to the page (⌘K and such) are shown here without being registered, so a
 * focused page keeps them; the app's window handles them itself when it has the keyboard.
 */
export class AppMenu {
  private ctx: CommandContext = EMPTY_CONTEXT
  private bindings: Record<string, string> = {}
  /** What the menu was last built from; enabled states change without a rebuild. */
  private builtFrom = ''

  constructor(
    /** `byKey` when a shortcut picked it rather than a click. */
    private run: (id: string, byKey: boolean) => void,
    /** Main-process state the app's context doesn't carry. */
    private extra: () => Partial<CommandContext>
  ) {}

  setContext(ctx: CommandContext): void {
    this.ctx = ctx
    this.update()
  }

  setBindings(bindings: Record<string, string>): void {
    this.bindings = bindings
    this.update()
  }

  /** Brings the menu up to date: rebuilt if labels or shortcuts changed, else just what's enabled. */
  update(): void {
    const ctx = this.context()
    const key = JSON.stringify([ctx.sidebar, ctx.chatOpen, this.bindings])
    if (key !== this.builtFrom) {
      this.builtFrom = key
      Menu.setApplicationMenu(Menu.buildFromTemplate(this.template(ctx)))
      return
    }
    const menu = Menu.getApplicationMenu()
    for (const cmd of COMMANDS) {
      const enabled = isEnabled(cmd, ctx)
      for (let i = 0; ; i++) {
        const item = menu?.getMenuItemById(i === 0 ? cmd.id : `${cmd.id}#${i}`)
        if (!item) break
        item.enabled = enabled
      }
    }
  }

  private context(): CommandContext {
    return { ...this.ctx, ...this.extra() }
  }

  /** The command as menu items: the item itself, then hidden ones for its other shortcuts. */
  private items(id: string, label?: string): MenuItemConstructorOptions[] {
    const cmd = command(id)
    if (!cmd) return []
    const ctx = this.context()
    const [first, ...others] = bindingsFor(cmd, process.platform, this.bindings)
    const enabled = isEnabled(cmd, ctx)
    const click: MenuItemConstructorOptions['click'] = (_item, _window, event) =>
      this.run(cmd.id, event?.triggeredByAccelerator === true)
    const item: MenuItemConstructorOptions = { id: cmd.id, label: label ?? cmd.label, enabled, click }
    if (first) {
      item.accelerator = toAccelerator(first)
      if (cmd.yieldsToPage) item.registerAccelerator = false
    }
    if (cmd.yieldsToPage) return [item]
    return [
      item,
      ...others.map((binding, i) => ({
        id: `${cmd.id}#${i + 1}`,
        label: item.label,
        accelerator: toAccelerator(binding),
        visible: false,
        acceleratorWorksWhenHidden: true,
        enabled,
        click
      }))
    ]
  }

  private template(ctx: CommandContext): MenuItemConstructorOptions[] {
    const mac = process.platform === 'darwin'
    const sep: MenuItemConstructorOptions = { type: 'separator' }
    const i = (id: string, label?: string): MenuItemConstructorOptions[] => this.items(id, label)
    // Named after what's there; numbers past the end of the sidebar stay out of sight.
    const goItems = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) =>
      i(`go.item${n}`, ctx.sidebar[n - 1]).map((item) => (n > ctx.sidebar.length && item.id === `go.item${n}` ? { ...item, visible: false } : item))
    )
    const last = ctx.sidebar[ctx.sidebar.length - 1]

    return [
      ...(mac
        ? [
            {
              label: app.name,
              submenu: [
                { role: 'about' },
                sep,
                ...i('app.settings'),
                sep,
                { role: 'services' },
                sep,
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                sep,
                { role: 'quit' }
              ] as MenuItemConstructorOptions[]
            }
          ]
        : []),
      {
        label: 'File',
        submenu: [
          ...i('chat.new'),
          ...i('tab.new'),
          ...i('tab.reopen'),
          sep,
          ...i('tab.address'),
          ...i('app.quickOpen'),
          sep,
          ...i('tab.close'),
          { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' },
          ...(mac ? [] : [sep, ...i('app.settings'), sep, { role: 'quit' } as MenuItemConstructorOptions])
        ]
      },
      {
        label: 'Edit',
        submenu: [
          // The text editing roles have to be in the menu, or ⌘C and ⌘V stop working on macOS.
          { role: 'undo' },
          { role: 'redo' },
          sep,
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          ...(mac ? [{ role: 'pasteAndMatchStyle' } as MenuItemConstructorOptions] : []),
          { role: 'delete' },
          { role: 'selectAll' },
          sep,
          ...i('page.find'),
          ...i('page.findNext'),
          ...i('page.findPrevious')
        ]
      },
      {
        label: 'View',
        submenu: [
          ...i('chat.toggle', ctx.chatOpen ? 'Hide Chat' : 'Show Chat'),
          sep,
          ...i('page.reload'),
          ...i('page.hardReload'),
          sep,
          ...i('page.zoomReset'),
          ...i('page.zoomIn'),
          ...i('page.zoomOut'),
          sep,
          { role: 'togglefullscreen' },
          sep,
          {
            label: 'Developer',
            submenu: [...i('dev.tools'), ...i('dev.reloadApp')]
          }
        ]
      },
      {
        label: 'Chat',
        submenu: [
          ...i('chat.focus'),
          ...i('voice.toggle'),
          ...i('chat.stop'),
          ...i('chat.copyReply'),
          ...i('chat.saveSkill'),
          sep,
          ...i('app.memory'),
          ...i('app.skills')
        ]
      },
      {
        label: 'Go',
        submenu: [
          ...i('page.back'),
          ...i('page.forward'),
          sep,
          ...i('app.home'),
          ...i('tab.next'),
          ...i('tab.previous'),
          sep,
          ...goItems,
          ...i('go.last', last ? `${last} (Last)` : undefined),
          sep,
          ...i('app.history'),
          ...i('page.pin')
        ]
      },
      {
        label: 'Window',
        submenu: mac
          ? [{ role: 'minimize' }, { role: 'zoom' }, sep, { role: 'front' }]
          : [{ role: 'minimize' }]
      },
      {
        role: 'help',
        submenu: [...i('app.shortcuts')]
      }
    ]
  }
}
