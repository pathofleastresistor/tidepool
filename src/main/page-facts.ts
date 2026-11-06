import type { WebContents } from 'electron'
import type { PageInsights, RepeatSearch, SearchElsewhere, ShoppingIdea } from '@shared/types'
import { hostOf, searchOf, searchParamOf } from './history'
import type { JevBrowser } from './jev'
import { isExcluded } from './memory-suggestions'
import { loadSettings } from './settings'
import type { PageFactsRow, Store } from './store'

/** A page's labels are asked for again after this long. */
const STALE_MS = 14 * 86_400_000
/** Searches older than this aren't offered again. */
const SEARCH_WINDOW_MS = 90 * 86_400_000
/** Searches at other stores are offered elsewhere for this long. */
const ELSEWHERE_WINDOW_MS = 30 * 86_400_000
const MAX_SITE_VISITS = 500
const MAX_PROJECT_VISITS = 1000
const MAX_REPEAT_SEARCHES = 3
/** How many searches from other stores Jev is asked about, and how many are offered. */
const MAX_CANDIDATES = 6
const MAX_ELSEWHERE = 2
const MAX_FITS_CACHED = 500
/** The read world (main/projects.ts); these scripts only read, like read_page's. */
const READ_WORLD_ID = 1017

/**
 * What Tidepool knows about the page on screen, for what to offer there: whether it's worth
 * summarizing, whether the site is a store, searches made on it before, and searches made at
 * other stores that it probably sells.
 *
 * Jev labels each page once (main/jev.ts), and the labels are kept in page_facts along with a
 * product's price, currency, stock and rating from the page's structured data, checked to be
 * numbers and codes. Nothing kept is the page's own text, so what's built from it later (memory
 * suggestions, for one) can't pick up instructions a page planted. Excluded sites are never read,
 * and searches on pages labeled sensitive are never offered.
 */
export class PageFacts {
  /** Jev's answer to whether a store (host) sells what a search (term) is for. */
  private fitsCache = new Map<string, boolean>()

  constructor(
    private store: Store,
    private jev: JevBrowser,
    /** Shopping ideas for a store (main/shopping-ideas.ts). */
    private ideasFor: (projectId: string, host: string) => ShoppingIdea[],
    private log: (line: string) => void
  ) {}

  /** null when Jev isn't set up, the site is excluded, or the page couldn't be read. */
  async insights(wc: WebContents, projectId: string, includeUnfiled: boolean): Promise<PageInsights | null> {
    if (!this.jev.available) return null
    try {
      const url = wc.getURL()
      const host = hostOf(url)
      if (!host || isExcluded(host, loadSettings().memoryExcludedSites)) return null
      let facts = this.store.pageFacts(url)
      if (!facts || Date.now() - facts.classifiedAt > STALE_MS) facts = await this.learn(wc, host)
      const store = facts.store || this.store.isStore(host)
      if (!store) return { summarizable: facts.summarizable, store, searches: [], elsewhere: [] }

      const here = this.searchVisits(
        this.store.siteVisits(projectId, host, { since: Date.now() - SEARCH_WINDOW_MS, limit: MAX_SITE_VISITS, includeUnfiled })
      ).filter((v) => hostOf(v.url) === host)
      const current = searchOf(facts.url)
      const searches = rankSearches(here, new Set(current ? [current] : []), MAX_REPEAT_SEARCHES)
      // Anything already searched for here is offered as itself, not as from elsewhere.
      const skip = new Set(here.map((v) => searchOf(v.url)!))
      if (current) skip.add(current)
      const elsewhere = await this.fromOtherStores(host, { url, title: wc.getTitle() }, projectId, includeUnfiled, skip).catch(
        (err) => {
          this.log(`searches from other stores failed: ${err instanceof Error ? err.message : String(err)}`)
          return []
        }
      )
      // Ideas from what the user likes come first; they're rarer than searches.
      const skipped = new Set([...skip].map((t) => t.toLowerCase()))
      const ideas = this.ideasFor(projectId, host)
        .filter((i) => !skipped.has(i.term.toLowerCase()))
        .map((i) => ({ term: i.term, interest: i.interest }))
      return { summarizable: facts.summarizable, store, searches, elsewhere: [...ideas, ...elsewhere].slice(0, MAX_ELSEWHERE) }
    } catch (err) {
      this.log(`page facts failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /**
   * Searches this store in the tab for something searched for elsewhere: the way the site's own
   * searches looked before, else its search form, else Jev types it into the search box. The
   * address is always on this site, so nothing typed goes anywhere else.
   */
  async searchHere(wc: WebContents, projectId: string, includeUnfiled: boolean, rawTerm: string): Promise<boolean> {
    const term = rawTerm.replace(/\s+/g, ' ').trim().slice(0, 120)
    const page = wc.getURL()
    const host = hostOf(page)
    if (!term || !host) return false
    const target = this.searchUrlFor(projectId, host, includeUnfiled, term) ?? formSearchUrl(
      (await wc.executeJavaScriptInIsolatedWorld(READ_WORLD_ID, [{ code: SEARCH_FORM_SCRIPT }])) as SearchForm | null,
      page,
      term
    )
    if (target) {
      await wc.loadURL(target).catch(() => {})
      return true
    }
    if (!this.jev.available) return false
    const result = await this.jev.run(wc, { task: `Search this site for "${term}"`, texts: [term], maxSteps: 3 })
    return result.steps.length > 0
  }

  private async learn(wc: WebContents, host: string): Promise<PageFactsRow> {
    const page = (await wc.executeJavaScriptInIsolatedWorld(READ_WORLD_ID, [{ code: FACTS_SCRIPT }])) as RawPage
    const labels = await this.jev.classify(page)
    const product = checkProduct(page.product)
    const facts: PageFactsRow = { url: page.url, host, ...labels, ...product, classifiedAt: Date.now() }
    this.store.setPageFacts(facts)
    return facts
  }

  /** Visits that are searches, minus those on pages labeled sensitive. */
  private searchVisits<T extends { url: string }>(visits: T[]): T[] {
    const searches = visits.filter((v) => searchOf(v.url))
    const facts = this.store.pageFactsFor(searches.map((v) => v.url))
    return searches.filter((v) => facts.get(v.url)?.topic !== 'sensitive')
  }

  /** Searches at other stores lately that Jev thinks this store sells. */
  private async fromOtherStores(
    host: string,
    page: { url: string; title: string },
    projectId: string,
    includeUnfiled: boolean,
    skip: Set<string>
  ): Promise<SearchElsewhere[]> {
    const excluded = loadSettings().memoryExcludedSites
    const stores = new Map<string, boolean>()
    const isStore = (h: string): boolean => stores.get(h) ?? (stores.set(h, this.store.isStore(h)), stores.get(h)!)
    const visits = this.store
      .projectVisits(projectId, { afterId: 0, since: Date.now() - ELSEWHERE_WINDOW_MS, limit: MAX_PROJECT_VISITS, includeUnfiled })
      .filter((v) => {
        const h = hostOf(v.url)
        return h !== undefined && h !== host && !isExcluded(h, excluded) && isStore(h)
      })
    const candidates = rankSearches(this.searchVisits(visits), skip, MAX_CANDIDATES)
    const key = (term: string): string => `${host}\u0000${term.toLowerCase()}`
    const unknown = candidates.filter((c) => !this.fitsCache.has(key(c.term)))
    if (unknown.length) {
      const answers = await this.jev.fits(page, unknown.map((c) => c.term))
      unknown.forEach((c, i) => {
        if (this.fitsCache.size >= MAX_FITS_CACHED) this.fitsCache.delete(this.fitsCache.keys().next().value!)
        this.fitsCache.set(key(c.term), answers[i])
      })
    }
    return candidates
      .filter((c) => this.fitsCache.get(key(c.term)))
      .slice(0, MAX_ELSEWHERE)
      .map((c) => ({ term: c.term, from: hostOf(c.url)! }))
  }

  /** A search on this site as the user's earlier ones there looked, with the term swapped in. */
  searchUrlFor(projectId: string, host: string, includeUnfiled: boolean, term: string): string | undefined {
    const visits = this.searchVisits(this.store.siteVisits(projectId, host, { since: 0, limit: MAX_SITE_VISITS, includeUnfiled }))
    for (const v of visits) {
      const param = searchParamOf(v.url)
      if (!param || hostOf(v.url) !== host) continue
      // Only the search itself: filters and paging from that search don't carry over.
      const url = new URL(v.url)
      url.search = ''
      url.hash = ''
      url.searchParams.set(param[0], term)
      return url.href
    }
    return undefined
  }
}

/**
 * Searches from these visits, most worth offering first: the ones made on the most separate
 * days, then the most recent. `skip` is compared without case.
 */
export function rankSearches(visits: Array<{ url: string; visitedAt: number }>, skip: Set<string>, limit: number): RepeatSearch[] {
  const skipped = new Set([...skip].map((t) => t.replace(/\s+/g, ' ').toLowerCase()))
  const byTerm = new Map<string, { term: string; url: string; last: number; days: Set<string> }>()
  for (const v of visits) {
    const term = searchOf(v.url)?.replace(/\s+/g, ' ')
    if (!term) continue
    const key = term.toLowerCase()
    if (skipped.has(key)) continue
    const entry = byTerm.get(key) ?? { term, url: v.url, last: v.visitedAt, days: new Set() }
    if (v.visitedAt > entry.last) Object.assign(entry, { term, url: v.url, last: v.visitedAt })
    entry.days.add(new Date(v.visitedAt).toDateString())
    byTerm.set(key, entry)
  }
  return [...byTerm.values()]
    .sort((a, b) => b.days.size - a.days.size || b.last - a.last)
    .slice(0, limit)
    .map(({ term, url, days }) => ({ term, url, times: days.size }))
}

interface SearchForm {
  action: string
  name: string
  hidden: Array<[string, string]>
}

/** A search address from the page's own search form, if it's a plain GET form on this site. */
export function formSearchUrl(form: SearchForm | null, page: string, term: string): string | undefined {
  if (!form || typeof form.action !== 'string' || typeof form.name !== 'string' || !form.name) return undefined
  let url: URL
  try {
    url = new URL(form.action, page)
  } catch {
    return undefined
  }
  // A form that sends the search to another site doesn't get it.
  if (!/^https?:$/.test(url.protocol) || hostOf(url.href) !== hostOf(page)) return undefined
  url.search = ''
  url.hash = ''
  for (const [name, value] of (Array.isArray(form.hidden) ? form.hidden : []).slice(0, 10)) {
    if (typeof name === 'string' && typeof value === 'string' && name !== form.name) url.searchParams.set(name.slice(0, 60), value.slice(0, 200))
  }
  url.searchParams.set(form.name, term)
  return url.href
}

/** The page's search form, if it has a GET one: where it goes, the search field's name, and its hidden fields. */
const SEARCH_FORM_SCRIPT = `(() => {
  const FIELD = 'input[type=search], input[role=searchbox], input[name=q], input[name=k], input[name=query], input[name=search], ' +
    'input[name=keywords], input[name=searchTerm], input[aria-label*=earch i], input[placeholder*=earch i]'
  for (const form of document.querySelectorAll('form')) {
    if ((form.getAttribute('method') || 'get').toLowerCase() !== 'get') continue
    const field = form.querySelector(FIELD)
    if (!field || !field.name) continue
    const hidden = Array.from(form.querySelectorAll('input[type=hidden]')).filter((h) => h.name).map((h) => [h.name, h.value])
    return { action: form.action, name: field.name, hidden }
  }
  return null
})()`

interface RawPage {
  url: string
  title: string
  text: string
  product: { price?: unknown; currency?: unknown; availability?: unknown; rating?: unknown; bestRating?: unknown } | null
}

/** Only numbers in range and codes of the right shape get through; anything else is dropped. */
export function checkProduct(raw: RawPage['product']): Pick<PageFactsRow, 'price' | 'currency' | 'inStock' | 'rating'> {
  const num = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN
    return Number.isFinite(n) ? n : null
  }
  const price = num(raw?.price)
  const currency = typeof raw?.currency === 'string' && /^[A-Z]{3}$/.test(raw.currency.trim()) ? raw.currency.trim() : null
  const availability = typeof raw?.availability === 'string' ? raw.availability : ''
  const inStock = /(InStock|LimitedAvailability|OnlineOnly|InStoreOnly)$/.test(availability)
    ? true
    : /(OutOfStock|SoldOut|Discontinued)$/.test(availability)
      ? false
      : null
  const best = num(raw?.bestRating) ?? 5
  const rating = num(raw?.rating)
  return {
    price: price !== null && price > 0 && price < 10_000_000 ? Math.round(price * 100) / 100 : null,
    currency: price !== null ? currency : null,
    inStock,
    rating: rating !== null && best > 0 && rating >= 0 && rating <= best ? Math.round((rating / best) * 50) / 10 : null
  }
}

/**
 * The page's text for Jev, and the one product its schema.org data describes, if exactly one.
 * Runs in the read world, so the page's scripts can't see or change it.
 */
const FACTS_SCRIPT = `(() => {
  const products = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(visit)
    const type = [].concat(node['@type'] || [])
    if (type.includes('Product')) products.push(node)
    visit(node['@graph'])
  }
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(s.textContent)) } catch {}
  }
  let product = null
  if (products.length === 1) {
    const p = products[0]
    const offer = [].concat(p.offers || [])[0] || {}
    const rating = p.aggregateRating || {}
    product = {
      price: offer.price ?? offer.lowPrice,
      currency: offer.priceCurrency,
      availability: offer.availability,
      rating: rating.ratingValue,
      bestRating: rating.bestRating
    }
  }
  return {
    url: location.href,
    title: document.title,
    text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 5000),
    product
  }
})()`
