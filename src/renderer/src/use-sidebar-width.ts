import { useCallback, useState } from 'react'

const KEY = 'sidebarWidth'
export const SIDEBAR_DEFAULT = 248
export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 420

const clamp = (width: number): number => Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, width)))

function read(): number {
  try {
    const saved = Number(localStorage.getItem(KEY))
    return saved ? clamp(saved) : SIDEBAR_DEFAULT
  } catch {
    return SIDEBAR_DEFAULT
  }
}

/**
 * The sidebar's width, which its handle drags, remembered for next time. `resizing` is true
 * during a drag: pages are native views that would take the pointer away from the handle as it
 * crosses them, so they step aside until the drag ends.
 */
export function useSidebarWidth(): {
  width: number
  setWidth: (width: number) => void
  resizing: boolean
  setResizing: (resizing: boolean) => void
} {
  const [width, setState] = useState(read)
  const [resizing, setResizing] = useState(false)
  const setWidth = useCallback((next: number) => {
    const w = clamp(next)
    setState(w)
    try {
      localStorage.setItem(KEY, String(w))
    } catch {
      // Remembering it is a convenience; it's fine if storage is unavailable.
    }
  }, [])
  return { width, setWidth, resizing, setResizing }
}
