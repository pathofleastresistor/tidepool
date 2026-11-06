/** A control on the page, as the snapshot script reports it. */
export interface PageElement {
  i: number
  kind: 'click' | 'type' | 'select'
  role: string
  label: string
  value?: string
  /** A field whose value isn't sent anywhere (card numbers, codes, contact details): only whether it's filled. */
  sensitive?: boolean
  filled?: boolean
  checked?: boolean
  href?: string
  /** A link whose address sounds like it commits something (/order/confirm, ?action=delete). */
  commitLink?: boolean
  options?: string[]
  inView: boolean
  button: boolean
}

export interface Snapshot {
  url: string
  title: string
  text: string
  atTop: boolean
  atBottom: boolean
  fingerprint: string
  elements: PageElement[]
}

/**
 * What a run needs from a page. The Electron driver runs the scripts in scripts.ts in a tab; other
 * drivers (Playwright, a browser extension) can run the same scripts.
 */
export interface PageDriver {
  /** Reads the page's controls, and keeps them for act() to find by number. */
  snapshot(): Promise<Snapshot>
  /** One action on a control from the last snapshot: 'ok', or 'gone' if the page changed under it. */
  act(op: 'click' | 'type' | 'select', index: number, arg?: string): Promise<string>
  scroll(direction: 'up' | 'down'): Promise<void>
  canGoBack(): boolean
  goBack(): void
  /** Waits for a navigation to load, then for the page to stop re-rendering (capped). */
  settle(signal?: AbortSignal): Promise<void>
  /** The page is gone, like a closed tab. */
  isClosed(): boolean
}
