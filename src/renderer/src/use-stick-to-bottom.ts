import { useCallback, useEffect, useRef, useState } from 'react'

/** How close to the bottom (px) still counts as "at the bottom". */
const THRESHOLD = 48

/**
 * Chat-style scrolling: while the user is at the bottom, follow new content as it arrives;
 * once they scroll up, leave them where they are until they come back down.
 *
 * It watches the content's size rather than React state, so it follows everything that
 * grows the transcript: streamed text, thinking expanding, MCP Apps resizing themselves.
 */
export function useStickToBottom(): {
  scrollRef: (el: HTMLDivElement | null) => void
  contentRef: (el: HTMLDivElement | null) => void
  atBottom: boolean
  scrollToBottom: () => void
} {
  // Callback refs, because the elements can come later than this hook: the chat renders into
  // an overlay window once that's open.
  const [scrollEl, scrollRef] = useState<HTMLDivElement | null>(null)
  const [contentEl, contentRef] = useState<HTMLDivElement | null>(null)
  const scrollElRef = useRef<HTMLDivElement | null>(null)
  scrollElRef.current = scrollEl
  const stuck = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  const scrollToBottom = useCallback(() => {
    stuck.current = true
    setAtBottom(true)
    const el = scrollElRef.current
    // Instant, not smooth: a smooth scroll fires scroll events on the way down, which would
    // read as the user scrolling away and unstick us mid-animation.
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  useEffect(() => {
    const el = scrollEl
    const content = contentEl
    if (!el || !content) return
    let lastTop = el.scrollTop
    const onScroll = (): void => {
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < THRESHOLD
      // Only moving up lets go. Content can grow between our own jump to the bottom and the
      // scroll event it fires, which would otherwise read as the user scrolling away.
      const up = el.scrollTop < lastTop - 1
      lastTop = el.scrollTop
      if (bottom) stuck.current = true
      else if (up) stuck.current = false
      setAtBottom(bottom || stuck.current)
    }
    // Growth doesn't fire scroll events, so this only ever runs our own follow-along.
    // An observer only sees layout in its own window's document, so make it in the elements' window.
    const view = (el.ownerDocument.defaultView ?? window) as typeof window
    const observer = new view.ResizeObserver(() => {
      if (stuck.current) el.scrollTop = el.scrollHeight
    })
    el.addEventListener('scroll', onScroll, { passive: true })
    observer.observe(content)
    // The viewport changes size too: window resizes, the chat docking beside an app.
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [scrollEl, contentEl])

  return { scrollRef, contentRef, atBottom, scrollToBottom }
}
