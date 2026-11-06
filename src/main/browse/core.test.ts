import { describe, expect, it } from 'vitest'
import { runBrowse, type BrowseOptions, type BrowseTraceStep, type JevClient } from './core'
import type { PageDriver, PageElement, Snapshot } from './driver'

// The browse loop against a scripted site and a scripted Jev: no browser, no network. The page
// scripts themselves (what a snapshot reports, how a click lands) are covered by tests/e2e-browse.mjs.

// MARK: - A fake site

/** A control on a fake page; clicking one with goto navigates there. */
type FakeElement = Partial<PageElement> & { label: string; goto?: string }
interface FakePage {
  title: string
  text?: string
  elements: FakeElement[]
}

const button = (label: string, extra: Partial<FakeElement> = {}): FakeElement => ({ kind: 'click', role: 'button', label, button: true, ...extra })
const link = (label: string, goto: string, extra: Partial<FakeElement> = {}): FakeElement => ({ kind: 'click', role: 'link', label, goto, ...extra })
const field = (label: string, extra: Partial<FakeElement> = {}): FakeElement => ({ kind: 'type', role: 'text field', label, ...extra })

class FakeDriver implements PageDriver {
  acts: string[] = []
  private history: string[] = []

  constructor(
    private site: Record<string, FakePage>,
    public url: string
  ) {}

  async snapshot(): Promise<Snapshot> {
    const page = this.site[this.url]
    const elements = page.elements.map(
      (e, i): PageElement => ({ kind: 'click', role: 'button', inView: true, button: false, ...e, i })
    )
    return {
      url: this.url,
      title: page.title,
      text: page.text ?? page.title,
      atTop: true,
      atBottom: true,
      fingerprint: `${this.url}:${JSON.stringify(elements.map((e) => e.value ?? e.filled))}`,
      elements
    }
  }

  async act(op: 'click' | 'type' | 'select', index: number, arg?: string): Promise<string> {
    const el = this.site[this.url].elements[index]
    this.acts.push(`${op} ${el.label}${arg ? ` = ${arg}` : ''}`)
    if (op === 'type') {
      if (el.sensitive) el.filled = true
      else el.value = arg
    }
    if (op === 'select') el.value = arg
    if (el.goto) {
      this.history.push(this.url)
      this.url = el.goto
    }
    return 'ok'
  }

  async scroll(): Promise<void> {}
  canGoBack(): boolean {
    return this.history.length > 0
  }
  goBack(): void {
    this.url = this.history.pop()!
  }
  async settle(): Promise<void> {}
  isClosed(): boolean {
    return false
  }
}

// MARK: - A scripted Jev

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JevRequest = { state: any; questions: Record<string, { criteria?: Record<string, string> }> }
type Answers = Record<string, unknown>

/** p on the action whose description matches, and `rest` on each of the others. */
function pick(request: JevRequest, match: RegExp, p = 0.9, rest = 0.01): Answers {
  const criteria = request.questions.action.criteria!
  const labels = Object.keys(criteria)
  const chosen = labels.find((l) => match.test(criteria[l]))
  if (!chosen) throw new Error(`no action matches ${match}: ${Object.values(criteria).join(' | ')}`)
  const probabilities = Object.fromEntries(labels.map((l) => [l, l === chosen ? p : rest]))
  return { type: 'choice', choice: chosen, confidence: p, probabilities }
}
const yes = (p: number): Answers => ({ type: 'noul', noul: p })
const choose = (label: string): Answers => ({ type: 'choice', choice: label, confidence: 0.9, probabilities: { [label]: 0.9 } })

/**
 * A Jev that answers each step with the action `act` picks (and not done, not stuck unless the
 * overrides say so), picks the first text or option, and calls every click it's asked about
 * irreversible unless `risky` says otherwise.
 */
function fakeJev(
  act: (request: JevRequest) => Answers,
  overrides: { done?: (r: JevRequest) => number; stuck?: number; risky?: (aboutToClick: string) => number; answers?: (r: JevRequest) => Answers | undefined } = {}
): JevClient & { requests: JevRequest[] } {
  const requests: JevRequest[] = []
  return {
    requests,
    async systemOne(request) {
      const r = request as unknown as JevRequest
      requests.push(r)
      const custom = overrides.answers?.(r)
      const answers: Answers = custom ?? {}
      if (!custom) {
        if (r.questions.action) {
          const done = overrides.done?.(r) ?? 0.05
          // Once it's done, the action doesn't matter.
          answers.action = done >= 0.85 ? choose('go_back') : act(r)
          answers.goal_done = yes(done)
          answers.stuck = yes(overrides.stuck ?? 0.05)
        }
        if (r.questions.text) answers.text = choose('t0')
        if (r.questions.option) answers.option = choose('o0')
        if (r.questions.irreversible) answers.irreversible = yes(overrides.risky?.(r.state.about_to_click) ?? 0.9)
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { model: 'fake-jev', answers, usage: { input_tokens: 10, output_tokens: 0 } } as any
    }
  }
}

const run = (driver: FakeDriver, jev: JevClient, opts: Partial<BrowseOptions> = {}): ReturnType<typeof runBrowse> =>
  runBrowse(driver, jev, { task: 'Do the thing', texts: [], ...opts })

// MARK: - Tests

describe('typing', () => {
  it('hands back when it needs text it was not given', async () => {
    const driver = new FakeDriver({ 'https://shop.test/': { title: 'Shop', elements: [field('Search products', { role: 'search box' })] } }, 'https://shop.test/')
    const result = await run(driver, fakeJev((r) => pick(r, /Type into search box/)))
    expect(result.status).toBe('needs_text')
    expect(driver.acts).toEqual([])
  })

  it('types the text Jev picks, then stops when Jev judges the task done', async () => {
    const site = {
      'https://shop.test/': { title: 'Shop', elements: [field('Search products', { role: 'search box', goto: 'https://shop.test/results' })] },
      'https://shop.test/results': { title: 'Results', text: 'Results for paper towels', elements: [link('About', 'https://shop.test/about')] }
    }
    const driver = new FakeDriver(site, 'https://shop.test/')
    const jev = fakeJev((r) => pick(r, /Type into search box|Click link/), { done: (r) => (r.state.page.url.endsWith('/results') ? 0.95 : 0.05) })
    const result = await run(driver, jev, { texts: ['paper towels'] })
    expect(result.status).toBe('done')
    expect(result.steps).toEqual(['Typed "paper towels" into search box "Search products" and pressed Enter'])
    expect(driver.acts).toEqual(['type Search products = paper towels'])
  })

  it('ends the run when Jev picks a text it was not offered', async () => {
    const driver = new FakeDriver({ 'https://shop.test/': { title: 'Shop', elements: [field('Name')] } }, 'https://shop.test/')
    const jev = fakeJev((r) => pick(r, /Type into/), { answers: (r) => (r.questions.text ? { text: choose('t7') } : undefined) })
    const result = await run(driver, jev, { texts: ['Ada'] })
    expect(result.status).toBe('error')
    expect(result.detail).toMatch(/didn't pick any of the texts/)
    expect(driver.acts).toEqual([])
  })

  it("shows Jev only whether a sensitive field is filled, never its value", async () => {
    const card = field('Card number', { sensitive: true, filled: true })
    const driver = new FakeDriver({ 'https://shop.test/pay': { title: 'Pay', elements: [card, button('Place order')] } }, 'https://shop.test/pay')
    const jev = fakeJev((r) => pick(r, /Click button "Place order"/))
    await run(driver, jev)
    const offered = Object.values(jev.requests[0].questions.action.criteria!)
    expect(offered).toContain('Type into text field "Card number" (filled)')
  })
})

describe('the irreversible check', () => {
  const cart = (): Record<string, FakePage> => ({
    'https://shop.test/cart': { title: 'Cart', elements: [button('Buy now', { goto: 'https://shop.test/bought' })] },
    'https://shop.test/bought': { title: 'Order placed', elements: [button('Confirm donation', { goto: 'https://shop.test/donated' })] },
    'https://shop.test/donated': { title: 'Thanks', elements: [] }
  })

  it('stops before a click Jev thinks commits something', async () => {
    const driver = new FakeDriver(cart(), 'https://shop.test/cart')
    const jev = fakeJev((r) => pick(r, /Click button/))
    const result = await run(driver, jev)
    expect(result.status).toBe('irreversible')
    expect(driver.acts).toEqual([])
    expect(jev.requests.at(-1)!.state.about_to_click).toBe('button "Buy now"')
  })

  it('clicks a button Jev thinks is harmless', async () => {
    const driver = new FakeDriver(cart(), 'https://shop.test/cart')
    const result = await run(driver, fakeJev((r) => pick(r, /Click button/), { risky: () => 0.1 }), { maxSteps: 1 })
    expect(result.status).toBe('out_of_steps')
    expect(driver.acts).toEqual(['click Buy now'])
  })

  it('counts a missing answer as irreversible', async () => {
    const driver = new FakeDriver(cart(), 'https://shop.test/cart')
    const jev = fakeJev((r) => pick(r, /Click button/), { answers: (r) => (r.questions.irreversible ? {} : undefined) })
    expect((await run(driver, jev)).status).toBe('irreversible')
    expect(driver.acts).toEqual([])
  })

  it('with the go-ahead, makes one commit and stops before the next', async () => {
    const driver = new FakeDriver(cart(), 'https://shop.test/cart')
    const result = await run(driver, fakeJev((r) => pick(r, /Click button/)), { allowIrreversible: true })
    expect(result.status).toBe('irreversible')
    expect(result.steps).toEqual(['Clicked button "Buy now" (with the go-ahead)'])
    expect(result.detail).toMatch(/Confirm donation/)
    expect(driver.url).toBe('https://shop.test/bought')
  })

  it('checks links whose address or label sounds like a commit, and no others', async () => {
    const site = {
      'https://shop.test/review': {
        title: 'Review',
        elements: [link('Continue', 'https://shop.test/order/confirm', { commitLink: true }), link('Help', 'https://shop.test/help')]
      },
      'https://shop.test/help': { title: 'Help', elements: [] },
      'https://shop.test/order/confirm': { title: 'Confirmed', elements: [] }
    }
    const toContinue = fakeJev((r) => pick(r, /Click link "Continue"/))
    expect((await run(new FakeDriver(site, 'https://shop.test/review'), toContinue)).status).toBe('irreversible')

    const toHelp = fakeJev((r) => pick(r, /Click link "Help"/), { done: (r) => (r.state.page.url.endsWith('/help') ? 0.95 : 0) })
    expect((await run(new FakeDriver(site, 'https://shop.test/review'), toHelp)).status).toBe('done')
    expect(toHelp.requests.some((r) => r.questions.irreversible)).toBe(false)
  })
})

describe('staying on the site', () => {
  it('stops when a step leads to another site, without acting there', async () => {
    const site = {
      'https://shop.test/partner': { title: 'Partner', elements: [link('Visit our partner', 'https://other.test/')] },
      'https://other.test/': { title: 'Other', elements: [button('Sign up')] }
    }
    const driver = new FakeDriver(site, 'https://shop.test/partner')
    const jev = fakeJev((r) => pick(r, /Click/))
    const result = await run(driver, jev)
    expect(result.status).toBe('left_site')
    expect(result.detail).toMatch(/other\.test/)
    expect(result.url).toBe('https://other.test/')
    expect(jev.requests.every((r) => !r.state.page?.url?.startsWith('https://other.test'))).toBe(true)
  })

  it('stops when going back leads to another site', async () => {
    const site = {
      'https://other.test/': { title: 'Before', elements: [link('Shop', 'https://shop.test/')] },
      'https://shop.test/': { title: 'Shop', elements: [] }
    }
    const driver = new FakeDriver(site, 'https://other.test/')
    await driver.act('click', 0)
    const result = await run(driver, fakeJev((r) => pick(r, /Go back/)))
    expect(result.status).toBe('left_site')
    expect(result.steps).toEqual(['Went back to the previous page'])
  })
})

/** Page 1 links to page 2, and so on, so every step lands on a page it hasn't seen. */
const chain = (): Record<string, FakePage> =>
  Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`https://shop.test/${i + 1}`, { title: `Page ${i + 1}`, elements: [link('Next', `https://shop.test/${i + 2}`)] }])
  )

describe("Jev's confidence", () => {
  const menu = (): Record<string, FakePage> => ({
    'https://shop.test/': { title: 'Shop', elements: [link('Deals', 'https://shop.test/deals'), link('New', 'https://shop.test/new')] },
    'https://shop.test/deals': { title: 'Deals', elements: [] },
    'https://shop.test/new': { title: 'New', elements: [] }
  })

  it('hands back when the best action is a guess, naming its candidates', async () => {
    const result = await run(new FakeDriver(menu(), 'https://shop.test/'), fakeJev((r) => pick(r, /Click link "Deals"/, 0.25, 0.1)))
    expect(result.status).toBe('unsure')
    expect(result.detail).toMatch(/link "Deals" \(25%\); link "New" \(10%\)/)
  })

  it('follows a less sure pick when the policy allows it', async () => {
    const driver = new FakeDriver(menu(), 'https://shop.test/')
    await run(driver, fakeJev((r) => pick(r, /Click link "Deals"/, 0.25, 0.1)), { policy: { minActionP: 0.2 }, maxSteps: 1 })
    expect(driver.acts).toEqual(['click Deals'])
  })

  it('ends the run when Jev picks no action it was offered', async () => {
    const result = await run(new FakeDriver(menu(), 'https://shop.test/'), fakeJev(() => choose('click_e999')))
    expect(result.status).toBe('error')
    expect(result.detail).toMatch(/didn't pick any of the actions/)
  })

  it('judges stuck only after three steps', async () => {
    const result = await run(new FakeDriver(chain(), 'https://shop.test/1'), fakeJev((r) => pick(r, /Click link "Next"/), { stuck: 0.95 }))
    expect(result.status).toBe('stuck')
    expect(result.steps).toHaveLength(3)
  })

  it("doesn't repeat an action that changed nothing, and stops once it has tried all Jev would consider", async () => {
    const site = { 'https://shop.test/': { title: 'Shop', elements: [button('Refresh')] } }
    const driver = new FakeDriver(site, 'https://shop.test/')
    const onlyRefresh = fakeJev(() => ({ type: 'choice', choice: 'click_e0', confidence: 0.9, probabilities: { click_e0: 0.9 } }), { risky: () => 0 })
    const result = await run(driver, onlyRefresh)
    expect(driver.acts).toEqual(['click Refresh'])
    expect(result.status).toBe('stuck')
    expect(result.detail).toMatch(/already tried/)
  })

  it('hands back rather than repeat an action on a page it has come back to', async () => {
    const site = {
      'https://shop.test/a': { title: 'A', elements: [link('Next', 'https://shop.test/b')] },
      'https://shop.test/b': { title: 'B', elements: [link('Next', 'https://shop.test/a')] }
    }
    const result = await run(new FakeDriver(site, 'https://shop.test/a'), fakeJev((r) => pick(r, /Click link "Next"/)))
    expect(result.steps).toHaveLength(2)
    expect(result.status).toBe('unsure')
  })
})

describe('limits', () => {
  it('stops after max steps', async () => {
    const result = await run(new FakeDriver(chain(), 'https://shop.test/1'), fakeJev((r) => pick(r, /Click link "Next"/)), { maxSteps: 3 })
    expect(result.status).toBe('out_of_steps')
    expect(result.steps).toHaveLength(3)
  })

  it('stops when time runs out', async () => {
    const slow = fakeJev((r) => pick(r, /Click link "Next"/))
    const systemOne = slow.systemOne.bind(slow)
    slow.systemOne = async (request, options) => {
      await new Promise((r) => setTimeout(r, 5))
      return systemOne(request, options)
    }
    const result = await run(new FakeDriver(chain(), 'https://shop.test/1'), slow, { policy: { maxSeconds: 0 } })
    expect(result.status).toBe('out_of_steps')
    expect(result.detail).toMatch(/Ran out of time/)
  })

  it('stops when cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await run(new FakeDriver(chain(), 'https://shop.test/1'), fakeJev((r) => pick(r, /Next/)), { signal: controller.signal })
    expect(result.status).toBe('error')
    expect(result.detail).toBe('Cancelled by the user.')
  })
})

describe('the trace', () => {
  it("records each step with Jev's likeliest choices, and the run's cost", async () => {
    const site = {
      'https://shop.test/?ref=mail': { title: 'Shop', elements: [field('Email', { sensitive: true }), button('Subscribe')] }
    }
    const driver = new FakeDriver(site, 'https://shop.test/?ref=mail')
    const seen: BrowseTraceStep[] = []
    const jev = fakeJev((r) => pick(r, Object.values(r.questions.action.criteria!).some((d) => d.endsWith('(empty)')) ? /Type into/ : /Click button/))
    const result = await run(driver, jev, { texts: ['me@example.com'], onStep: (s) => seen.push(s) })

    expect(result.status).toBe('irreversible')
    expect(seen).toEqual(result.trace)
    const [typed, stopped] = result.trace
    expect(typed.page).toBe('https://shop.test/')
    expect(typed.offered).toBe(3)
    expect(typed.top[0]).toEqual({ label: 'type_e0', action: 'Type into text field "Email" (empty)', p: 0.9 })
    expect(typed.outcome).toBe('Typed into text field "Email"')
    expect(stopped).toMatchObject({ irreversible: 0.9, outcome: 'Stopped: irreversible' })
    expect(JSON.stringify(result.trace)).not.toContain('me@example.com')
    // Two step questions, the text and the irreversible check.
    expect(result.usage).toMatchObject({ calls: 4, inputTokens: 40, model: 'fake-jev' })
  })
})
