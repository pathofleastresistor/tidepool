import { app, type WebContents } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Chrome's zoom steps, as zoom factors. */
const STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]

const hostOf = (url: string): string | undefined => {
  try {
    const { protocol, host } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' ? host : undefined
  } catch {
    return undefined
  }
}

/**
 * Zoom is kept per site, as in Chrome: zooming Gmail zooms it in every tab, and it's still zoomed
 * next launch. Chromium already shares a zoom between pages of one host while the app runs; this
 * remembers it (zoom.json) and puts it back when a page of that host loads.
 */
export class PageZoom {
  private factors: Record<string, number> = {}

  constructor() {
    try {
      const saved = JSON.parse(readFileSync(this.path, 'utf8')) as unknown
      if (saved && typeof saved === 'object') this.factors = saved as Record<string, number>
    } catch {
      // None saved yet.
    }
  }

  private get path(): string {
    return join(app.getPath('userData'), 'zoom.json')
  }

  /** Puts a page's saved zoom back whenever it loads a site. */
  track(wc: WebContents): void {
    wc.on('did-navigate', (_e, url) => {
      const host = hostOf(url)
      if (host && !wc.isDestroyed()) wc.setZoomFactor(this.factors[host] ?? 1)
    })
  }

  /** One step in or out, or back to 100% for 0. */
  step(wc: WebContents, direction: 1 | -1 | 0): void {
    const current = wc.getZoomFactor()
    let next = 1
    if (direction === 1) next = STEPS.find((s) => s > current + 0.001) ?? STEPS[STEPS.length - 1]
    else if (direction === -1) next = [...STEPS].reverse().find((s) => s < current - 0.001) ?? STEPS[0]
    wc.setZoomFactor(next)
    const host = hostOf(wc.getURL())
    if (!host) return
    if (next === 1) delete this.factors[host]
    else this.factors[host] = next
    try {
      writeFileSync(this.path, JSON.stringify(this.factors, null, 2))
    } catch {
      // Best effort.
    }
  }
}
