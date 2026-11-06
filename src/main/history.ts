import type { WebContents } from 'electron'
import type { Store } from './store'

/** Query parameters that hold what someone typed into a site's search box. */
const SEARCH_PARAMS = ['q', 'query', 'search_query', 'searchTerm', 'k', 'p', 'keywords', 'search', 'text']

/** A page's host without www., lowercase. */
export const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return undefined
  }
}

/** What was typed into a search box, if the address is a search. */
export function searchOf(url: string): string | undefined {
  return searchParamOf(url)?.[1]
}

/** The query parameter holding a search, and what was typed. */
export function searchParamOf(url: string): [name: string, value: string] | undefined {
  try {
    const params = new URL(url).searchParams
    for (const name of SEARCH_PARAMS) {
      const value = params.get(name)?.trim()
      if (value && value.length <= 120 && !/^https?:/i.test(value)) return [name, value]
    }
  } catch {
    // Not a URL.
  }
  return undefined
}

/** Whose page a visit was on: a project's tab, or a pinned site. */
export interface VisitOwner {
  projectId: string | null
  siteName?: string
}

/**
 * Records browsing history: every page a project tab or pinned site goes to, with its title and
 * when. Pages that belong to neither (sign-in popups, the app's own window) aren't recorded.
 */
export class HistoryRecorder {
  /** Each page's latest visit, so a title that arrives after the navigation lands on it. */
  private last = new WeakMap<WebContents, { id: number; url: string }>()

  constructor(
    private store: Store,
    /** Who `wc` belongs to, asked at navigation time since views are wired up after they're made. */
    private ownerOf: (wc: WebContents) => VisitOwner | undefined,
    /** Told after each recorded visit. */
    private visited: (owner: VisitOwner) => void = () => {}
  ) {}

  track(wc: WebContents): void {
    wc.on('did-navigate', (_e, url) => this.record(wc, url))
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) this.record(wc, url)
    })
    wc.on('page-title-updated', (_e, title) => {
      const last = this.last.get(wc)
      if (last && title && last.url === wc.getURL()) this.store.setVisitTitle(last.id, title)
    })
  }

  private record(wc: WebContents, url: string): void {
    if (!/^https?:/i.test(url)) return
    // A reload, or a page rewriting its own address to the same thing, isn't a new visit.
    if (this.last.get(wc)?.url === url) return
    const owner = this.ownerOf(wc)
    if (!owner) return
    const title = wc.getTitle()
    const id = this.store.addVisit({ url, title: title && title !== url ? title : '', ...owner })
    this.last.set(wc, { id, url })
    this.visited(owner)
  }
}
