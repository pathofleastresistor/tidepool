import type { WebContents } from 'electron'
import type { PageDriver, Snapshot } from './driver'
import { ACT_SCRIPT, FINGERPRINT_SCRIPT, SNAPSHOT_SCRIPT } from './scripts'

/** An isolated world of our own, apart from the page's (0), the preload's and read_page's (1017). */
const WORLD_ID = 1018

/**
 * Drives an Electron tab. Everything runs in an isolated world, so the page's own scripts can't
 * see the element list or tamper with it. Actions are DOM events, which work in tabs that aren't
 * on screen; a few sites ignore anything but real input.
 */
export class ElectronDriver implements PageDriver {
  constructor(private wc: WebContents) {}

  snapshot(): Promise<Snapshot> {
    return this.inPage<Snapshot>(SNAPSHOT_SCRIPT)
  }

  act(op: 'click' | 'type' | 'select', index: number, arg?: string): Promise<string> {
    return this.inPage<string>(`(${ACT_SCRIPT})(${JSON.stringify(op)}, ${index}, ${JSON.stringify(arg ?? '')})`)
  }

  async scroll(direction: 'up' | 'down'): Promise<void> {
    await this.inPage(`window.scrollBy(0, ${direction === 'down' ? 1 : -1} * innerHeight * 0.8)`)
  }

  canGoBack(): boolean {
    return this.wc.navigationHistory.canGoBack()
  }

  goBack(): void {
    this.wc.navigationHistory.goBack()
  }

  /** Waits for a navigation to load, then for the page to stop re-rendering (capped). */
  async settle(signal?: AbortSignal): Promise<void> {
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    await wait(250)
    for (const end = Date.now() + 10_000; Date.now() < end && !this.wc.isDestroyed() && this.wc.isLoading() && !signal?.aborted; ) await wait(150)
    let prev = ''
    for (const end = Date.now() + 1500; Date.now() < end && !this.wc.isDestroyed() && !signal?.aborted; await wait(250)) {
      const now = await this.inPage<string>(FINGERPRINT_SCRIPT).catch(() => '')
      if (now && now === prev) return
      prev = now
    }
  }

  isClosed(): boolean {
    return this.wc.isDestroyed()
  }

  private async inPage<T = unknown>(code: string): Promise<T> {
    return (await this.wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }])) as T
  }
}
