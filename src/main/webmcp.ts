import type { WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import type { WebMcpSource, WebMcpTool } from '@shared/types'

const MAX_TOOLS = 200
const MAX_TEXT = 4000
const MAX_RESULT = 100_000
const CALL_TIMEOUT_MS = 60_000
/** After a tool that may change the page, how long to wait for its tools to follow (see settle). */
const SETTLE_MAX_MS = 3000
const SETTLE_QUIET_MS = 400

/** What a page tool call came back with: the tool's own (string) result, or why there isn't one. */
export type WebMcpCallResult = { ok: true; text: string } | { ok: false; error: string }

/** Whose page a webContents is: a pinned site, or a project tab ("tab:<id>"). */
export interface PageSource {
  id: string
  name: string
  autoApprove: boolean
}

interface PendingCall {
  wc: WebContents
  finish: (result: WebMcpCallResult) => void
}

/**
 * The WebMCP tools each open page has registered, as reported by the websites' preload
 * (preload/web.ts) whenever a page's tools change. Pinned sites and project tabs count; popups
 * report too, and are ignored. A page's entry goes when it reports none, navigates away (its
 * preload reports none on pagehide), or closes.
 */
export class WebMcpRegistry {
  private pages = new Map<number, { wc: WebContents; tools: WebMcpTool[] }>()
  private calls = new Map<string, PendingCall>()
  /** Called whenever a page's tools change, keyed by webContents id; see waitForTools(). */
  private toolWatchers = new Map<number, Set<() => void>>()
  /** The page the user has open; only its tools are offered to Claude. */
  private currentSiteId: string | null = null

  constructor(
    private sourceFor: (wc: WebContents) => PageSource | undefined,
    private onChange: (sources: WebMcpSource[]) => void
  ) {}

  /** A page's latest getTools() snapshot. The sender's renderer runs untrusted pages, so check the shape. */
  update(wc: WebContents, raw: unknown): void {
    if (!this.sourceFor(wc)) return
    const tools = Array.isArray(raw) ? raw.slice(0, MAX_TOOLS).flatMap(toTool) : []
    const known = this.pages.get(wc.id)
    if (tools.length === 0) {
      if (!known) return
      this.pages.delete(wc.id)
    } else {
      if (!known) {
        const forget = (): void => {
          if (this.pages.delete(wc.id)) this.emit()
        }
        wc.once('destroyed', forget)
        wc.once('render-process-gone', forget)
      }
      this.pages.set(wc.id, { wc, tools })
    }
    this.emit()
    for (const watcher of this.toolWatchers.get(wc.id) ?? []) watcher()
  }

  sources(): WebMcpSource[] {
    const sources: WebMcpSource[] = []
    for (const [id, { wc, tools }] of this.pages) {
      const source = wc.isDestroyed() ? undefined : this.sourceFor(wc)
      if (source)
        sources.push({
          webContentsId: id,
          siteId: source.id,
          name: source.name,
          url: wc.getURL(),
          tools,
          autoApprove: source.autoApprove
        })
    }
    return sources
  }

  /** Sends the sources again, after a page changed hands (a tab pinned as a site). */
  refresh(): void {
    this.emit()
  }

  setCurrentSite(siteId: string | null): void {
    this.currentSiteId = siteId
  }

  /** The title of the page a source is showing. */
  title(webContentsId: number): string {
    const wc = this.pages.get(webContentsId)?.wc
    return wc && !wc.isDestroyed() ? wc.getTitle() : ''
  }

  /** The open page's tools, as they are right now (they change as the page does). */
  current(): WebMcpSource | undefined {
    return this.currentSiteId ? this.sources().find((s) => s.siteId === this.currentSiteId) : undefined
  }

  /**
   * Runs a tool in the page (preload/web.ts calls document.modelContext.executeTool). Settles
   * when the page answers, or when it can't: the page navigated away mid-call (some tools do
   * exactly that), closed, took too long, or the user pressed Stop.
   */
  execute(webContentsId: number, name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<WebMcpCallResult> {
    const wc = this.pages.get(webContentsId)?.wc
    if (!wc || wc.isDestroyed()) return Promise.resolve({ ok: false, error: 'The page with this tool is gone.' })
    const callId = randomUUID()
    return new Promise((resolve) => {
      const onNavigate = (_e: unknown, url: string): void =>
        finish({ ok: true, text: `The page navigated to ${url} before the tool returned a result.` })
      const onGone = (): void => finish({ ok: false, error: 'The page closed before the tool returned a result.' })
      const onAbort = (): void => {
        if (!wc.isDestroyed()) wc.send('webmcp:cancel', callId)
        finish({ ok: false, error: 'Cancelled by the user.' })
      }
      const timer = setTimeout(
        () => finish({ ok: false, error: `The page didn't answer within ${CALL_TIMEOUT_MS / 1000}s.` }),
        CALL_TIMEOUT_MS
      )
      const finish = (result: WebMcpCallResult): void => {
        if (!this.calls.delete(callId)) return
        clearTimeout(timer)
        wc.off('did-navigate', onNavigate)
        wc.off('destroyed', onGone)
        wc.off('render-process-gone', onGone)
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      }
      this.calls.set(callId, { wc, finish })
      wc.on('did-navigate', onNavigate)
      wc.once('destroyed', onGone)
      wc.once('render-process-gone', onGone)
      signal.addEventListener('abort', onAbort)
      if (signal.aborted) return onAbort()
      wc.send('webmcp:execute', { callId, name, input: JSON.stringify(input) })
    })
  }

  /** One of a page tool's WebMCP annotations (readOnlyHint, untrustedContentHint...). */
  annotation(webContentsId: number, name: string, key: string): unknown {
    return this.pages.get(webContentsId)?.tools.find((t) => t.name === name)?.annotations?.[key]
  }

  /**
   * Runs a tool, then gives the page a moment to settle if the tool might have changed it. A
   * tool that navigates (Target's search_products) answers first and registers the next page's
   * tools (filter_products) a little later; without the wait, Claude's next round would still
   * see the old ones. Waits until the tools have been quiet for a beat, up to a cap. Tools that
   * say they're read-only don't wait.
   */
  async executeAndSettle(
    webContentsId: number,
    name: string,
    input: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<WebMcpCallResult> {
    const readOnly = this.annotation(webContentsId, name, 'readOnlyHint')
    // Watch from before the call: some pages swap their tools before the call even returns.
    const settled = readOnly === true ? undefined : this.waitForTools(webContentsId, signal)
    const result = await this.execute(webContentsId, name, input, signal)
    if (result.ok) await settled?.promise
    settled?.cancel()
    return result
  }

  private waitForTools(webContentsId: number, signal: AbortSignal): { promise: Promise<void>; cancel: () => void } {
    let cancel = (): void => {}
    const promise = new Promise<void>((resolve) => {
      let quiet: NodeJS.Timeout | undefined
      const cap = setTimeout(() => done(), SETTLE_MAX_MS)
      const changed = (): void => {
        clearTimeout(quiet)
        quiet = setTimeout(() => done(), SETTLE_QUIET_MS)
      }
      const done = (): void => {
        clearTimeout(cap)
        clearTimeout(quiet)
        this.toolWatchers.get(webContentsId)?.delete(changed)
        signal.removeEventListener('abort', done)
        resolve()
      }
      cancel = done
      const watchers = this.toolWatchers.get(webContentsId) ?? new Set()
      watchers.add(changed)
      this.toolWatchers.set(webContentsId, watchers)
      signal.addEventListener('abort', done)
    })
    return { promise, cancel }
  }

  /** The page's answer to execute(). Only the page the call went to can settle it. */
  settle(wc: WebContents, raw: unknown): void {
    const { callId, ok, result, error } = (raw ?? {}) as Record<string, unknown>
    const call = typeof callId === 'string' ? this.calls.get(callId) : undefined
    if (!call || call.wc !== wc) return
    call.finish(
      ok === true
        ? { ok: true, text: typeof result === 'string' ? result.slice(0, MAX_RESULT) : '(no result)' }
        : { ok: false, error: typeof error === 'string' ? error.slice(0, MAX_TEXT) : 'The tool failed.' }
    )
  }

  private emit(): void {
    this.onChange(this.sources())
  }
}

function toTool(raw: unknown): WebMcpTool[] {
  if (!raw || typeof raw !== 'object') return []
  const t = raw as Record<string, unknown>
  if (typeof t.name !== 'string' || !t.name) return []
  const text = (v: unknown): string | undefined => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : undefined)
  return [
    {
      name: t.name.slice(0, 128),
      title: text(t.title),
      description: text(t.description) ?? '',
      inputSchema: t.inputSchema,
      annotations:
        t.annotations && typeof t.annotations === 'object' ? (t.annotations as Record<string, unknown>) : undefined,
      origin: text(t.origin) ?? ''
    }
  ]
}
