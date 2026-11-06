import { useCallback, useEffect, useRef } from 'react'
import {
  bindingsFor,
  command,
  COMMANDS,
  eventMatches,
  formatBinding,
  isEnabled,
  type CommandContext
} from '@shared/commands'

/**
 * Keyboard shortcuts in the app's window. While the app (or one of its overlays, whose keys are
 * relayed here) has the keyboard, keys are matched here. While a website has it, the menu bar
 * catches them instead and the main process sends the command over (src/main/menu.ts).
 */

let overrides: Record<string, string> = {}

/** The user's changes from Settings, for matching keys and showing them. */
export function setKeyBindings(bindings: Record<string, string> | undefined): void {
  overrides = bindings ?? {}
}

/** The command's shortcut as it's shown (⌘J, Ctrl+J), or "" if it has none. */
export function shortcutLabel(id: string): string {
  const cmd = command(id)
  const first = cmd && bindingsFor(cmd, window.api.platform, overrides)[0]
  return first ? formatBinding(first, window.api.platform) : ''
}

/** A button's tooltip with the shortcut after it: "History (⌘Y)". */
export function withShortcut(title: string, id: string): string {
  const keys = shortcutLabel(id)
  return keys ? `${title} (${keys})` : title
}

/** Parts of the UI that act on a command themselves, like the address bar or the find bar. */
const subscribers = new Map<string, Set<() => void>>()

export function useCommand(id: string, handler: () => void): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const fn = (): void => ref.current()
    let set = subscribers.get(id)
    if (!set) subscribers.set(id, (set = new Set()))
    set.add(fn)
    return () => void set.delete(fn)
  }, [id])
}

/** Runs what registered for `id` with useCommand, for an app handler that hands over to it. */
export function emitCommand(id: string): void {
  for (const fn of subscribers.get(id) ?? []) fn()
}

/** Commands that can sensibly repeat while the key is held. */
const REPEATS = new Set(['tab.next', 'tab.previous', 'page.zoomIn', 'page.zoomOut', 'page.findNext', 'page.findPrevious'])
/** The menu can see a key the window already handled; that copy is dropped. */
const DUPLICATE_MS = 250

/**
 * Handles shortcuts for the app. `handlers` has what the app itself does for each command; a
 * command without one goes to whatever registered with useCommand, and commands marked `main`
 * go to the main process. Returns `run`, for running a command from elsewhere (Quick Open).
 */
export function useCommands(ctx: CommandContext, handlers: Record<string, () => void>): (id: string) => void {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const handledAt = useRef(new Map<string, number>())

  const run = useCallback((id: string) => {
    const cmd = command(id)
    if (!cmd) return
    if (cmd.main) {
      void window.api.commands.run(id)
      return
    }
    const own = handlersRef.current[id]
    if (own) own()
    else emitCommand(id)
  }, [])

  useEffect(() => {
    const platform = window.api.platform
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing) return
      for (const cmd of COMMANDS) {
        if (!bindingsFor(cmd, platform, overrides).some((b) => eventMatches(e, b, platform))) continue
        // Not possible right now: let the key do whatever it would otherwise do.
        if (!isEnabled(cmd, ctxRef.current)) return
        e.preventDefault()
        if (e.repeat && !REPEATS.has(cmd.id)) return
        handledAt.current.set(cmd.id, Date.now())
        run(cmd.id)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    const off = window.api.commands.onCommand((id, byKey) => {
      if (byKey && Date.now() - (handledAt.current.get(id) ?? 0) < DUPLICATE_MS) return
      run(id)
    })
    return () => {
      window.removeEventListener('keydown', onKey)
      off()
    }
  }, [run])

  // The menu bar greys out what can't be done now.
  const sent = useRef('')
  useEffect(() => {
    const json = JSON.stringify(ctx)
    if (json === sent.current) return
    sent.current = json
    void window.api.commands.setContext(ctx)
  })

  return run
}

/**
 * Gives an overlay the keyboard and focuses something in it. An overlay that has just opened
 * may not be on screen yet, so this tries again for a little while.
 */
export function focusInOverlay(name: string, target: () => HTMLElement | null | undefined): void {
  let tries = 0
  const attempt = (): void => {
    const el = target()
    if (!el) {
      if (++tries < 20) setTimeout(attempt, 50)
      return
    }
    void window.api.overlay.focus(name).then(() => {
      el.focus()
      if (el.ownerDocument.activeElement !== el) {
        if (++tries < 20) setTimeout(attempt, 50)
        return
      }
      if (el instanceof el.ownerDocument.defaultView!.HTMLInputElement) el.select()
    })
  }
  setTimeout(attempt, 30)
}
