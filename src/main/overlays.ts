import { WebContentsView, type BrowserWindow, type BrowserWindowConstructorOptions, type WebContents } from 'electron'
import type { ViewBounds } from '@shared/types'

/** window.open names the app uses for overlays; anything else is an ordinary link. */
export const OVERLAY_PREFIX = 'overlay:'

const roundBounds = (b: ViewBounds): Electron.Rectangle => ({
  x: Math.round(b.x),
  y: Math.round(b.y),
  width: Math.max(0, Math.round(b.width)),
  height: Math.max(0, Math.round(b.height))
})

/**
 * Websites are native views, drawn above the app's page, so nothing in the page can float over
 * them. An overlay is a second, transparent native view kept above the websites. The app opens
 * it as a same-origin about:blank window and renders into it with a React portal, so the UI in it
 * is still part of the one app: same state, same event handlers, same process. This view only
 * hosts that window's document and puts it where the app says.
 */
export class Overlays {
  private views = new Map<string, WebContentsView>()

  constructor(
    private window: () => BrowserWindow | null,
    /** Where a link that would navigate an overlay goes instead. */
    private openLink: (url: string) => void
  ) {}

  /**
   * For the main window's open handler (its `createWindow`): hosts the new window as the overlay
   * called `name`. Electron's options carry the window's already-created contents, which the view
   * adopts, so it stays in the app's process and the app can reach into its document.
   */
  create(name: string, options: BrowserWindowConstructorOptions): WebContents {
    this.views.get(name)?.webContents.close()
    const view = new WebContentsView(options)
    const webContents = view.webContents
    view.setBackgroundColor('#00000000')
    view.setVisible(false)
    this.views.set(name, view)
    this.window()?.contentView.addChildView(view)
    // An overlay is only ever the app's blank page; a link clicked in it opens like any other.
    webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      this.openLink(url)
    })
    webContents.once('destroyed', () => {
      if (this.views.get(name) !== view) return
      this.views.delete(name)
      this.window()?.contentView.removeChildView(view)
    })
    return webContents
  }

  /** Where the overlay goes, in window coordinates; null hides it. */
  setBounds(name: string, bounds: ViewBounds | null): void {
    const view = this.views.get(name)
    if (!view) return
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      // Keys would go on to a view nobody can see; hand them back to the app.
      if (view.webContents.isFocused()) this.window()?.webContents.focus()
      view.setVisible(false)
      return
    }
    view.setBounds(roundBounds(bounds))
    view.setVisible(true)
    this.raise()
  }

  /** The overlay's page, while it's on screen. */
  contents(name: string): WebContents | undefined {
    const view = this.views.get(name)
    return view?.getVisible() && !view.webContents.isDestroyed() ? view.webContents : undefined
  }

  /** Gives the overlay the keyboard, for the app to focus something in it. */
  focus(name: string): void {
    const view = this.views.get(name)
    if (view?.getVisible()) view.webContents.focus()
  }

  /**
   * Views stack in the order they were added, and websites are added as they're first opened.
   * Adding a view that's already there moves it to the top.
   */
  raise(): void {
    const win = this.window()
    if (!win) return
    for (const view of this.views.values()) win.contentView.addChildView(view)
  }

  reset(): void {
    for (const view of this.views.values()) if (!view.webContents.isDestroyed()) view.webContents.close()
    this.views.clear()
  }
}
