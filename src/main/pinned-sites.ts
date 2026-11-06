import type { McpServerConfig, WebApp } from '@shared/types'
import { loadWebApps, type WebViewManager } from './web-apps'

/** A pinned site as Claude knows it: what it's called and for, and how to reach it. */
export interface PinnedSite {
  id: string
  name: string
  url: string
  host: string
  about?: string
  /** The MCP server that reaches it, if one is set or one lives on its host. */
  server?: string
  /** The user chose "Always allow" for it. */
  autoApprove: boolean
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * The sites the user pinned, which Claude may use in any chat: they're the ones the user reaches
 * for most. Everything Claude is told about them (name, note, connection) is the user's own
 * choice; nothing comes from the pages. A site's connection is the MCP server the user picked for
 * it, or else a remote server on the same host (Home Assistant serves its MCP at /api/mcp).
 */
export class PinnedSites {
  constructor(
    private web: WebViewManager,
    private servers: () => Record<string, McpServerConfig>,
    private onReveal: (id: string) => void
  ) {}

  list(): PinnedSite[] {
    let servers: Record<string, McpServerConfig> = {}
    try {
      servers = this.servers()
    } catch {
      // A config that doesn't parse links nothing.
    }
    return loadWebApps().map((site) => this.describe(site, servers))
  }

  get(id: string): PinnedSite | undefined {
    return this.list().find((s) => s.id === id)
  }

  /** The pinned site an MCP server reaches, whose approval its calls share. */
  forServer(server: string): PinnedSite | undefined {
    return this.list().find((s) => s.server === server)
  }

  contents(id: string): Promise<Electron.WebContents> {
    return this.web.contents(id)
  }

  /** The host the site is on now, which can differ from where it opens (after a sign-in, say). */
  currentHost(id: string): string {
    return hostOf(this.web.currentUrl(id) ?? '')
  }

  /** Puts the site on screen, so the user sees Claude working in it. */
  reveal(id: string): void {
    this.onReveal(id)
  }

  private describe(site: WebApp, servers: Record<string, McpServerConfig>): PinnedSite {
    const host = hostOf(site.url)
    const enabled = (name: string): boolean => !!servers[name] && !servers[name].disabled
    const server =
      site.server === ''
        ? undefined
        : site.server !== undefined
          ? enabled(site.server) ? site.server : undefined
          : Object.keys(servers).find((name) => {
              const cfg = servers[name]
              return enabled(name) && 'url' in cfg && host !== '' && hostOf(cfg.url) === host
            })
    return {
      id: site.id,
      name: site.name,
      url: site.url,
      host,
      about: site.about,
      server,
      autoApprove: site.autoApproveTools === true
    }
  }
}
