import { session, type CustomScheme, type Session } from 'electron'
import { existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PageSummary } from '@shared/types'

/**
 * Pages are HTML files Claude makes for a project (a trip plan, a comparison, a checklist) and the
 * user opens in one of its tabs. Each project's are files in a folder of their own, served at
 * tidepool-page://<project id>/<name>.
 *
 * Claude writes them, sometimes from what websites said, so they're kept apart from both the app
 * and the web: their own session (no website cookies, no autofill or WebMCP preload, no
 * permissions), their own origin per project, and a policy that lets them load scripts and styles
 * from two public CDNs and nothing else. They can't fetch, post or load images from the web, so
 * what's in them stays in them. Links out open in a new tab (see ProjectManager.wire).
 */
export const PAGE_SCHEME = 'tidepool-page'

/** Registered with the other schemes before app 'ready' (see index.ts). */
export const PAGE_SCHEME_PRIVILEGES: CustomScheme = {
  scheme: PAGE_SCHEME,
  // standard: an origin per project, so their storage is apart. secure: localStorage and the like work.
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false }
}

/** Where scripts and styles may come from, besides the page itself. */
const CDNS = 'https://cdn.jsdelivr.net https://cdnjs.cloudflare.com'

const CSP = [
  "default-src 'none'",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${CDNS}`,
  `style-src 'self' 'unsafe-inline' ${CDNS} https://fonts.googleapis.com`,
  `font-src 'self' data: ${CDNS} https://fonts.gstatic.com`,
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'none'"
].join('; ')

/** Bigger than any page worth reading, small enough that one can't fill the disk. */
export const MAX_PAGE_BYTES = 2_000_000
const MAX_NAME = 60

/** A page's name as it's kept: lowercase words joined by dashes, like "trip-plan". */
export function pageSlug(name: string): string | undefined {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.html?$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME)
    .replace(/-+$/, '')
  return slug || undefined
}

const PROJECT_ID = /^[a-z0-9_-]{1,64}$/

export function pageUrl(projectId: string, name: string): string {
  return `${PAGE_SCHEME}://${projectId}/${name}`
}

export function isPageUrl(url: string): boolean {
  return url.startsWith(`${PAGE_SCHEME}://`)
}

/** The project and page an address is for, if it's a page's. */
export function parsePageUrl(url: string): { projectId: string; name: string } | undefined {
  if (!isPageUrl(url)) return undefined
  try {
    const u = new URL(url)
    const name = decodeURIComponent(u.pathname.replace(/^\/+/, ''))
    return PROJECT_ID.test(u.host) && pageSlug(name) === name ? { projectId: u.host, name } : undefined
  } catch {
    return undefined
  }
}

/** The page's <title>, as the tab would show it. */
export function titleOf(html: string): string {
  const raw = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? ''
  return raw
    .replace(/&(amp|lt|gt|quot|#39|apos);/g, (_m, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" })[e] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

let configured: Session | undefined

/** The session pages run in: nothing from the websites' profile, and no permissions. */
export function pageSession(): Session {
  if (configured) return configured
  const ses = session.fromPartition('persist:pages')
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  configured = ses
  return ses
}

export function pagePreferences(): Electron.WebPreferences {
  return { session: pageSession(), sandbox: true, contextIsolation: true, nodeIntegration: false }
}

export class Pages {
  constructor(
    private root: string,
    private onChanged: (projectId: string) => void
  ) {}

  /** Serves pages from disk; must run after app 'ready'. */
  serve(): void {
    pageSession().protocol.handle(PAGE_SCHEME, (request) => {
      const page = parsePageUrl(request.url)
      const file = page && this.file(page.projectId, page.name)
      if (!file || !existsSync(file)) {
        return new Response('<!doctype html><title>Page not found</title><p>This page was deleted.</p>', {
          status: 404,
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP }
        })
      }
      return new Response(readFileSync(file), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': CSP,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        }
      })
    })
  }

  /** The project's pages, newest first. */
  list(projectId: string): PageSummary[] {
    const dir = this.dir(projectId)
    if (!dir || !existsSync(dir)) return []
    const pages: PageSummary[] = []
    for (const entry of readdirSync(dir)) {
      const name = entry.replace(/\.html$/, '')
      if (!entry.endsWith('.html') || pageSlug(name) !== name) continue
      const file = join(dir, entry)
      try {
        const { mtimeMs } = statSync(file)
        pages.push({ name, title: titleOf(head(file)) || name, url: pageUrl(projectId, name), updatedAt: mtimeMs })
      } catch {
        // Gone since the listing.
      }
    }
    return pages.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(projectId: string, name: string): PageSummary | undefined {
    return this.list(projectId).find((p) => p.name === name)
  }

  source(projectId: string, name: string): string | undefined {
    const file = this.file(projectId, name)
    return file && existsSync(file) ? readFileSync(file, 'utf8') : undefined
  }

  /** Writes the page, replacing one of that name. Returns it as saved. */
  save(projectId: string, name: string, html: string): PageSummary {
    const slug = pageSlug(name)
    const dir = this.dir(projectId)
    if (!slug || !dir) throw new Error('Give the page a name, like "trip-plan".')
    if (Buffer.byteLength(html) > MAX_PAGE_BYTES) {
      throw new Error(`That page is too big; keep it under ${MAX_PAGE_BYTES / 1_000_000} MB.`)
    }
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${slug}.html`), html)
    this.onChanged(projectId)
    return { name: slug, title: titleOf(html) || slug, url: pageUrl(projectId, slug), updatedAt: Date.now() }
  }

  remove(projectId: string, name: string): void {
    const file = this.file(projectId, name)
    if (!file || !existsSync(file)) return
    rmSync(file)
    this.onChanged(projectId)
  }

  /** The project was deleted; its pages go with it. */
  removeProject(projectId: string): void {
    const dir = this.dir(projectId)
    if (dir) rmSync(dir, { recursive: true, force: true })
  }

  private dir(projectId: string): string | undefined {
    return PROJECT_ID.test(projectId) ? join(this.root, projectId) : undefined
  }

  private file(projectId: string, name: string): string | undefined {
    const dir = this.dir(projectId)
    return dir && pageSlug(name) === name ? join(dir, `${name}.html`) : undefined
  }
}

/** The start of a file, where its <title> is. */
function head(file: string): string {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(16_384)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.subarray(0, n).toString('utf8')
  } finally {
    closeSync(fd)
  }
}
