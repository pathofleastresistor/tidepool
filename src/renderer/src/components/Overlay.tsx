import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ViewBounds } from '@shared/types'

/** Copies the app's stylesheets into the overlay's document, and keeps them in step (dev reloads CSS). */
function mirrorStyles(target: Document): () => void {
  const copy = (): void => {
    for (const el of target.head.querySelectorAll('[data-mirrored]')) el.remove()
    for (const el of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
      const clone = el.cloneNode(true) as HTMLElement
      // about:blank has no base to resolve a relative href against.
      if (el instanceof HTMLLinkElement) (clone as HTMLLinkElement).href = el.href
      clone.dataset.mirrored = ''
      target.head.append(clone)
    }
  }
  copy()
  const observer = new MutationObserver(copy)
  observer.observe(document.head, { childList: true, subtree: true, characterData: true })
  return () => observer.disconnect()
}

/**
 * The app listens on its own window, for keys (shortcuts, Escape out of a fullscreen app) and
 * for messages (MCP Apps' iframes talk to their parent over postMessage). In an overlay, both
 * arrive at the overlay's window instead, so they're passed on. `source` is kept, which is what
 * the app checks a message against.
 */
function relayToApp(from: Window): () => void {
  const onMessage = (e: MessageEvent): void => {
    window.dispatchEvent(new MessageEvent('message', { data: e.data, origin: e.origin, source: e.source, ports: [...e.ports] }))
  }
  const onKey = (e: KeyboardEvent): void => {
    // Handled where it was pressed (Enter in the message box, Escape stopping a reply): done.
    if (e.defaultPrevented) return
    const relayed = new KeyboardEvent('keydown', {
      key: e.key,
      code: e.code,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      repeat: e.repeat,
      isComposing: e.isComposing,
      cancelable: true
    })
    if (!window.dispatchEvent(relayed)) e.preventDefault()
  }
  from.addEventListener('message', onMessage)
  from.addEventListener('keydown', onKey)
  return () => {
    from.removeEventListener('message', onMessage)
    from.removeEventListener('keydown', onKey)
  }
}

/**
 * Renders its children above everything, websites included. Websites are native views that
 * cover the page, so this draws into a transparent native view of its own, kept on top by the
 * main process. It's a portal, so the children stay part of this React tree, with its state and
 * handlers. `bounds` is where the overlay goes, in window coordinates; only that box takes
 * clicks, so the page beside it keeps working. Null hides it.
 */
export function Overlay(props: {
  name: string
  bounds: ViewBounds | null
  className?: string
  /**
   * Reports the size of the first thing rendered, for an overlay sized to its content. It's
   * measured in the overlay's own document, where it's laid out.
   */
  onContentSize?: (size: { width: number; height: number }) => void
  children: React.ReactNode
}): React.JSX.Element | null {
  const { name, bounds } = props
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const onContentSizeRef = useRef(props.onContentSize)
  onContentSizeRef.current = props.onContentSize
  const measured = props.onContentSize !== undefined

  useEffect(() => {
    if (!root || !measured) return
    const view = root.ownerDocument.defaultView as typeof window
    let observed: Element | null = null
    const observer = new view.ResizeObserver(() => {
      if (!observed) return
      const r = observed.getBoundingClientRect()
      onContentSizeRef.current?.({ width: Math.ceil(r.width), height: Math.ceil(r.height) })
    })
    // The content can be replaced; keep watching whatever is first.
    const watchFirst = (): void => {
      const first = root.firstElementChild
      if (first === observed) return
      if (observed) observer.unobserve(observed)
      observed = first
      if (first) observer.observe(first)
    }
    watchFirst()
    const children = new view.MutationObserver(watchFirst)
    children.observe(root, { childList: true })
    return () => {
      observer.disconnect()
      children.disconnect()
    }
  }, [root, measured])

  useEffect(() => {
    const win = window.open('about:blank', `overlay:${name}`)
    if (!win) return
    const doc = win.document
    doc.title = name
    const meta = doc.createElement('meta')
    meta.name = 'color-scheme'
    meta.content = 'light dark'
    doc.head.append(meta)
    const stopMirroring = mirrorStyles(doc)
    doc.documentElement.classList.add('overlay-document')
    Object.assign(doc.documentElement.dataset, document.documentElement.dataset)
    const stopRelaying = relayToApp(win)
    const el = doc.createElement('div')
    el.className = 'overlay-root'
    doc.body.append(el)
    setRoot(el)
    return () => {
      stopMirroring()
      stopRelaying()
      setRoot(null)
      win.close()
    }
  }, [name])

  const key = bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : ''
  useEffect(() => {
    void window.api.overlay.setBounds(name, bounds)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `bounds`
  }, [name, key, root])
  useEffect(() => () => void window.api.overlay.setBounds(name, null), [name])

  if (!root) return null
  if (props.className !== undefined) root.className = `overlay-root ${props.className}`
  return createPortal(props.children, root)
}
