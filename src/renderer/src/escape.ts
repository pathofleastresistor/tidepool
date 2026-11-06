import { useEffect, useRef } from 'react'

/**
 * Escape closes one thing at a time, the one on top: a menu before the dialog it's in, a dialog
 * before the fullscreen app under it. Each of them registers here while it's open, and the last
 * one registered is on top.
 *
 * It listens on the app's window, where keys from the overlays are relayed too (Overlay.tsx). A
 * key something else already handled (the address bar putting its text back, say) is left alone.
 */
const stack: Array<{ current: () => void }> = []

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
  const top = stack[stack.length - 1]
  if (!top) return
  e.preventDefault()
  top.current()
}

/** Calls `onEscape` when Escape is pressed while this is the top thing open (and `active`). */
export function useEscape(onEscape: () => void, active = true): void {
  const ref = useRef(onEscape)
  ref.current = onEscape
  useEffect(() => {
    if (!active) return
    const entry = { current: () => ref.current() }
    if (stack.length === 0) window.addEventListener('keydown', onKey)
    stack.push(entry)
    return () => {
      const i = stack.indexOf(entry)
      if (i !== -1) stack.splice(i, 1)
      if (stack.length === 0) window.removeEventListener('keydown', onKey)
    }
  }, [active])
}
