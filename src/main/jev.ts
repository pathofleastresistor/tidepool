import type { WebContents } from 'electron'
import { choice, noul, TypeSafeClient } from '@typesafe-ai/sdk'
import { runBrowse, type BrowseOptions, type BrowseResult } from './browse/core'
import { ElectronDriver } from './browse/electron-driver'
import type { JevAccess } from './settings'

/**
 * TypeSafe's Jev, for Tidepool: it operates pages for the browse tool (browse/core.ts) and labels
 * them, choosing among options of ours so nothing a page says comes back as text.
 */

/** A page is offered "Summarize" and "Key points" when Jev thinks it's this likely to be reading. */
const SUMMARIZABLE_P = 0.5
/** Less text than this has nothing to summarize. */
const MIN_SUMMARY_CHARS = 400
/** A search from another store is offered when Jev thinks this one is this likely to sell it. */
const FITS_P = 0.6
/** A site counts as a store when Jev thinks it's this likely to be one. */
const STORE_P = 0.6

/** What Jev can say about a page. Every value is one of ours; none is page text. */
export interface PageLabels {
  kind: PageKind
  topic: PageTopic
  store: boolean
  summarizable: boolean
}

export const PAGE_KINDS = {
  article: 'An article, post, document or thread to read',
  product: 'One product or item for sale, with its price and details',
  results: 'Search results, or a category or listing of many products or items',
  front: "A site's homepage or an index of headlines and links",
  app: 'An app or tool: email, a dashboard, an editor, maps, a chat',
  form: 'A sign-in, sign-up, checkout, cart or other form',
  media: 'Mostly a video, images or audio',
  other: 'None of these'
} as const
export type PageKind = keyof typeof PAGE_KINDS

/**
 * Topics for noticing interests. There are deliberately none for sensitive subjects: those pages
 * are labeled "sensitive" and left out of anything built from browsing.
 */
export const PAGE_TOPICS = {
  news: 'News and current events',
  sports: 'Sports',
  weather: 'Weather',
  technology: 'Technology and gadgets news or reviews',
  software: 'Programming and software development',
  science: 'Science',
  business: 'Business and companies',
  travel: 'Travel, trips, flights and hotels',
  cooking: 'Food, recipes and cooking',
  groceries: 'Groceries',
  household: 'Household supplies: cleaning, paper goods, toiletries',
  home: 'Furniture, home decor and kitchenware',
  garden: 'Home improvement, tools and gardening',
  clothing: 'Clothing, shoes and accessories',
  beauty: 'Beauty and personal care',
  electronics: 'Electronics, computers and appliances to buy',
  books: 'Books and reading',
  music: 'Music',
  video: 'Movies, TV and video',
  games: 'Video games and board games',
  kids: 'Toys, baby and kids',
  pets: 'Pets',
  cars: 'Cars and vehicles',
  outdoors: 'Outdoors, fitness and sporting goods',
  crafts: 'Arts, crafts and hobbies',
  learning: 'Education and learning',
  sensitive:
    'Health or medical, mental health, money trouble or debt, banking or taxes, politics, religion, legal matters, immigration, dating or sex, or job hunting',
  other: 'Something else'
} as const
export type PageTopic = keyof typeof PAGE_TOPICS

/** OpenRouter serves TypeSafe's System One API under its own root, with Jev under TypeSafe's name. */
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api'
const OPENROUTER_MODEL = '~typesafe/jev-latest'

export class JevBrowser {
  constructor(private access: () => JevAccess | undefined) {}

  get available(): boolean {
    return this.access() !== undefined
  }

  /**
   * A client for whoever serves Jev. For TypeSafe, the SDK reads TYPESAFE_BASE_URL itself, so a
   * local System One server (Kev, Laya) works too. TYPESAFE_DEFAULT_MODEL picks another model
   * either way.
   */
  private client(): TypeSafeClient {
    const access = this.access()
    if (!access) throw new Error('Add a Jev key (TypeSafe or OpenRouter) in Settings to use browse.')
    const common = { apiKey: access.key, logLevel: 'off' as const, timeout: 15_000, retry: { maxRetries: 1 } }
    if (access.provider === 'typesafe') return new TypeSafeClient(common)
    return new TypeSafeClient({
      ...common,
      baseURL: process.env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL,
      defaultModel: process.env.TYPESAFE_DEFAULT_MODEL || OPENROUTER_MODEL,
      // OpenRouter's app attribution.
      defaultHeaders: { 'HTTP-Referer': 'https://github.com/pathofleastresistor/tidepool', 'X-Title': 'Tidepool' }
    })
  }

  /**
   * Labels a page from lists of our own: what kind of page it is, what it's about, whether the
   * site is a store, and whether it has reading worth summarizing. Jev only picks among these, so
   * nothing the page says can come back as text; the worst a page can do is get a wrong label.
   * That's why labels only ever change what's offered, never what's allowed.
   * Throws if Jev isn't set up or can't be reached.
   */
  async classify(page: { url: string; title: string; text: string }): Promise<PageLabels> {
    const text = page.text.replace(/\s+/g, ' ').trim()
    const reply = await this.client().systemOne({
      state: { page: { url: page.url, title: page.title, text: text.slice(0, 3000), length: text.length } },
      questions: {
        kind: choice('What kind of page is this?', PAGE_KINDS),
        topic: choice('What is this page mostly about?', PAGE_TOPICS),
        store: noul('This website is a store or marketplace: it sells products, groceries or goods to buy online', {
          true: 'A shop, supermarket, marketplace or brand store with a cart or checkout',
          false: 'A site that writes about, reviews or links to products without selling them, or has nothing for sale'
        }),
        worth_summarizing: noul('This page is mostly text to read, which a summary or its key points would help with', {
          true:
            'A news article or live news updates, a blog post, an essay, documentation, a report, a paper, a long post or discussion ' +
            'thread, or a product or recipe page with substantial text: the page itself carries the paragraphs to read',
          false:
            'Mostly an app, a form, a sign-in, search results, a homepage or index of headlines that link to the stories elsewhere, ' +
            'a store listing grid, a dashboard, or video or images with little text'
        })
      }
    })
    const { kind, topic, store, worth_summarizing } = reply.answers
    return {
      kind: (kind.choice in PAGE_KINDS ? kind.choice : 'other') as PageKind,
      topic: (topic.choice in PAGE_TOPICS ? topic.choice : 'other') as PageTopic,
      store: store.noul >= STORE_P,
      summarizable: text.length >= MIN_SUMMARY_CHARS && worth_summarizing.noul >= SUMMARIZABLE_P
    }
  }

  /**
   * Which of these searches, made at other stores, are for things this store sells. The searches
   * go in as data, with our own questions about them, and each answer is a yes or no.
   */
  async fits(site: { url: string; title: string }, terms: string[]): Promise<boolean[]> {
    if (!terms.length) return []
    const reply = await this.client().systemOne({
      state: { store: { url: site.url, title: site.title }, searches: Object.fromEntries(terms.map((t, i) => [`s${i}`, t])) },
      questions: Object.fromEntries(
        terms.map((_, i) => [
          `fits_s${i}`,
          noul(`What search s${i} looks for is something this store sells`, {
            true: 'This store would likely have it for sale',
            false: "This store doesn't sell that kind of thing"
          })
        ])
      )
    })
    return terms.map((_, i) => (reply.answers[`fits_s${i}`]?.noul ?? 0) >= FITS_P)
  }

  /** Operates the tab's page toward a task; see browse/core.ts. */
  run(wc: WebContents, opts: BrowseOptions): Promise<BrowseResult> {
    return runBrowse(new ElectronDriver(wc), this.client(), opts)
  }
}
