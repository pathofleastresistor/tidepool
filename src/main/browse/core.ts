import { choice, noul, type ChoiceCriteria, type Questions, type SystemOneRequest, type SystemOneResult } from '@typesafe-ai/sdk'
import type { PageDriver, PageElement, Snapshot } from './driver'
import { COMMIT_WORDS } from './scripts'

/**
 * Operates a web page toward a task with TypeSafe's Jev, a "System One" decision model: it
 * doesn't write text, it picks one of the options it's given, with probabilities, in about a
 * tenth of a second. Each step reads the page's controls into a numbered list, asks Jev which
 * action best advances the task (and, separately, whether the task is done or stuck), and does
 * it. The caller hands over the task and any text to type; Jev only ever chooses among the page's
 * own controls and the caller's texts, never makes text up.
 *
 * The question design follows jkudish/jev-browser (MIT): one fan-out call per step, so the
 * done/stuck judgments can't rationalize the action choice, and a second-stage Choice for a
 * dropdown's option. It hands back rather than guessing: when the best action is unlikely, when
 * it needs text it wasn't given, before a click that looks irreversible, and when a step leads
 * to another site.
 *
 * The page is reached through a PageDriver, so the same loop runs in Electron, Playwright or an
 * extension.
 */

/** Jev's Choice takes at most 255 options; leave room for scroll and back. */
const MAX_ELEMENTS = 240
const DEFAULT_STEPS = 12
export const MAX_STEPS = 25

/** When a run stops and hands back. */
export interface BrowsePolicy {
  /** Stop when Jev is this sure the task is done. */
  doneP: number
  /** Stop when Jev is this sure the run is stuck (after three steps). */
  stuckP: number
  /** Below this, the chosen action is a guess; the caller decides instead. */
  minActionP: number
  /** A click Jev thinks is this likely to commit something (buy, send, delete) needs the user's OK. */
  irreversibleP: number
  /** A run stops after this long. */
  maxSeconds: number
}

export const DEFAULT_POLICY: BrowsePolicy = {
  doneP: 0.85,
  stuckP: 0.85,
  minActionP: 0.3,
  irreversibleP: 0.5,
  maxSeconds: 150
}

/** The part of TypeSafe's client a run uses, so another host or a test can stand in for it. */
export interface JevClient {
  systemOne<Q extends Questions>(request: SystemOneRequest<Q>, options?: { signal?: AbortSignal }): PromiseLike<SystemOneResult<Q>>
}

export interface BrowseOptions {
  task: string
  /** Text the caller supplied for typing; Jev picks which fits a field. */
  texts: string[]
  maxSteps?: number
  /** Allows one click that commits something; it stops again before any other. */
  allowIrreversible?: boolean
  signal?: AbortSignal
  /** Thresholds and limits other than the defaults. */
  policy?: Partial<BrowsePolicy>
  /** Called as each step's outcome is known, with what Jev saw and chose. */
  onStep?: (step: BrowseTraceStep) => void
}

/** One step of a run as Jev saw it, to find out afterwards why a run went the way it did. Not for the model driving the run. */
export interface BrowseTraceStep {
  /** Where the step started, without the query or fragment. */
  page: string
  /** How many actions Jev was offered. */
  offered: number
  /** Jev's likeliest actions, as offered, with their probabilities. */
  top: { label: string; action: string; p: number }[]
  done: number
  stuck: number
  /** How likely Jev thought the click was to commit something, when it was asked. */
  irreversible?: number
  /** What the step did, or why the run stopped on it. */
  outcome: string
}

/** What a run cost: Jev calls, input tokens and time waiting on Jev. */
export interface BrowseUsage {
  calls: number
  inputTokens: number
  ms: number
  model?: string
}

export type BrowseStatus = 'done' | 'needs_text' | 'irreversible' | 'left_site' | 'unsure' | 'stuck' | 'out_of_steps' | 'error'

export interface BrowseResult {
  status: BrowseStatus
  /** Why it stopped, for the caller. */
  detail: string
  steps: string[]
  url: string
  title: string
  /** The start of the page's text where it stopped. */
  text: string
  trace: BrowseTraceStep[]
  usage: BrowseUsage
}

export async function runBrowse(page: PageDriver, client: JevClient, opts: BrowseOptions): Promise<BrowseResult> {
  const policy = { ...DEFAULT_POLICY, ...opts.policy }
  const texts = opts.texts.map((t) => t.trim()).filter(Boolean).slice(0, 50)
  const maxSteps = Math.min(Math.max(opts.maxSteps ?? DEFAULT_STEPS, 1), MAX_STEPS)
  const deadline = Date.now() + policy.maxSeconds * 1000
  const signal = opts.signal
  const steps: string[] = []
  /** fingerprint|action pairs already done, so a click that changed nothing isn't repeated. */
  const tried = new Set<string>()
  /** The go-ahead covers one commit, not every one the run comes across. */
  let commitsAllowed = opts.allowIrreversible ? 1 : 0
  const trace: BrowseTraceStep[] = []
  const usage: BrowseUsage = { calls: 0, inputTokens: 0, ms: 0 }
  /** Every Jev call goes through here, so the run's usage adds up. */
  const ask = async <Q extends Questions>(request: SystemOneRequest<Q>): Promise<SystemOneResult<Q>> => {
    const start = Date.now()
    try {
      const reply = await client.systemOne(request, { signal })
      usage.inputTokens += reply.usage?.input_tokens ?? 0
      usage.model = reply.model
      return reply
    } finally {
      usage.calls++
      usage.ms += Date.now() - start
    }
  }
  /** The step in progress, until its outcome is known. */
  let current: BrowseTraceStep | undefined
  const record = (outcome: string): void => {
    if (!current) return
    current.outcome = outcome
    opts.onStep?.(current)
    current = undefined
  }

  let snap = await page.snapshot()
  /** The user approved acting on this site; the run stops if it ends up on another. */
  const site = originOf(snap.url)
  const finish = (status: BrowseStatus, detail: string): BrowseResult => {
    record(`Stopped: ${status}`)
    return { status, detail, steps, url: snap.url, title: snap.title, text: snap.text, trace, usage }
  }

  try {
    for (let n = 0; n < maxSteps; n++) {
      if (signal?.aborted) return finish('error', 'Cancelled by the user.')
      if (Date.now() > deadline) return finish('out_of_steps', `Ran out of time after ${steps.length} steps.`)

      const { options, byLabel } = actionOptions(snap)
      const state = {
        task: opts.task,
        page: { url: snap.url, title: snap.title, text: snap.text.slice(0, 1500) },
        scroll: snap.atTop ? 'at top' : snap.atBottom ? 'at bottom' : 'partway down',
        steps_so_far: steps.slice(-6),
        ...(texts.length ? { text_available_to_type: texts } : {})
      }
      const reply = await ask({
        state,
        questions: {
          action: choice('Which single action best advances the task on the current page?', options),
          goal_done: noul('The task has been achieved: the current page and the steps so far show the sought outcome', {
            true: 'The page being viewed is the sought destination, shows the sought information, or the requested change is made',
            false: 'The task is not finished yet'
          }),
          stuck: noul('The steps so far are not making progress toward the task (repeats, loops, or nothing changes)', {
            true: 'Recent steps repeat or nothing changes; a different approach is needed',
            false: 'Progress is visible, or the first steps are still reasonable'
          })
        }
      })
      const { action, goal_done, stuck } = reply.answers
      const ranked = Object.entries(action?.probabilities ?? {})
        .filter(([l]) => Object.hasOwn(options, l))
        .sort((a, b) => b[1] - a[1])
      const entry: BrowseTraceStep = {
        page: pageOf(snap.url),
        offered: Object.keys(options).length,
        top: ranked.slice(0, 3).map(([l, p]) => ({ label: l, action: String(options[l]), p })),
        done: goal_done?.noul ?? 0,
        stuck: stuck?.noul ?? 0,
        outcome: ''
      }
      trace.push(entry)
      current = entry

      if ((goal_done?.noul ?? 0) >= policy.doneP) return finish('done', 'Jev judged the task done.')
      if ((stuck?.noul ?? 0) >= policy.stuckP && steps.length >= 3) return finish('stuck', 'Jev judged that the steps stopped making progress.')

      // The most likely action not already tried on this exact page. Only options we offered count.
      if (!ranked.length) return finish('error', "Jev's reply didn't pick any of the actions it was offered.")
      const pick = ranked.find(([label]) => !tried.has(`${snap.fingerprint}|${label}`))
      if (!pick) return finish('stuck', 'Every likely action was already tried on this page without effect.')
      const [label, p] = pick
      if (p < policy.minActionP) {
        const top = ranked.slice(0, 3).map(([l, q]) => `${describe(byLabel.get(l), l)} (${Math.round(q * 100)}%)`)
        return finish('unsure', `Jev wasn't confident about the next step. Its top candidates: ${top.join('; ')}.`)
      }
      tried.add(`${snap.fingerprint}|${label}`)
      const el = byLabel.get(label)

      if (label === 'scroll_down' || label === 'scroll_up') {
        await page.scroll(label === 'scroll_down' ? 'down' : 'up')
        steps.push(label === 'scroll_down' ? 'Scrolled down' : 'Scrolled up')
      } else if (label === 'go_back') {
        if (!page.canGoBack()) return finish('stuck', 'Jev wanted to go back, but there is no earlier page.')
        page.goBack()
        steps.push('Went back to the previous page')
      } else if (el?.kind === 'type') {
        if (!texts.length) {
          return finish('needs_text', `The next step is typing into ${describe(el)}, and no text was given for it.`)
        }
        const which = await ask({
          state: { task: opts.task, page: { url: snap.url, title: snap.title }, field: describe(el) },
          questions: {
            text: choice(`Which text belongs in ${describe(el)}, given the task?`, {
              ...Object.fromEntries(texts.map((t, i) => [`t${i}`, t.slice(0, 200)])),
              none: 'None of these belongs in this field'
            })
          }
        })
        const chosen = which.answers.text?.choice
        if (chosen === 'none') {
          return finish('needs_text', `The next step is typing into ${describe(el)}, and none of the texts given fit it.`)
        }
        const value = offered(chosen, 't', texts)
        if (value === undefined) return finish('error', `Jev's reply didn't pick any of the texts for ${describe(el)}.`)
        const outcome = await page.act('type', el.i, value)
        if (outcome !== 'ok') return finish('error', 'The page changed before the field could be filled.')
        steps.push(`Typed "${value}" into ${name(el)}${isSearchy(el) ? ' and pressed Enter' : ''}`)
        // The caller sees what it typed; the trace keeps a sensitive field's value out, like Jev's view.
        if (el.sensitive) record(`Typed into ${name(el)}`)
      } else if (el?.kind === 'select') {
        const optionList = el.options ?? []
        if (!optionList.length) return finish('stuck', `${describe(el)} has no options to pick.`)
        const which = await ask({
          state: { task: opts.task, page: { url: snap.url, title: snap.title }, dropdown: describe(el) },
          questions: {
            option: choice(
              `Which option should be selected in ${describe(el)}, given the task?`,
              Object.fromEntries(optionList.slice(0, 250).map((o, i) => [`o${i}`, o.slice(0, 80)]))
            )
          }
        })
        const option = offered(which.answers.option?.choice, 'o', optionList.slice(0, 250))
        if (option === undefined) return finish('error', `Jev's reply didn't pick any of the options in ${describe(el)}.`)
        if ((await page.act('select', el.i, option)) !== 'ok') return finish('error', 'The page changed before the dropdown could be set.')
        steps.push(`Chose "${option}" in ${name(el)}`)
      } else if (el?.kind === 'click') {
        let committed = false
        if (el.button || el.commitLink || COMMIT_WORDS.test(el.label)) {
          const risk = await ask({
            state: { task: opts.task, page: { url: snap.url, title: snap.title, text: snap.text.slice(0, 800) }, about_to_click: describe(el) },
            questions: {
              irreversible: noul(
                'Clicking this would commit something that is hard to undo: buying or paying, sending or posting a message, submitting a form, deleting, booking, or changing an account',
                { true: 'It commits something hard to undo', false: 'It only opens, shows, filters, searches or navigates' }
              )
            }
          })
          // No answer counts as a yes: this check fails safe.
          const irreversible = risk.answers.irreversible?.noul ?? 1
          if (current) current.irreversible = irreversible
          if (irreversible >= policy.irreversibleP) {
            if (commitsAllowed === 0) {
              return finish('irreversible', `Stopped before clicking ${describe(el)}, which looks like it would commit something hard to undo.`)
            }
            commitsAllowed--
            committed = true
          }
        }
        if ((await page.act('click', el.i)) !== 'ok') return finish('error', 'The page changed before the click landed.')
        steps.push(`Clicked ${name(el)}${committed ? ' (with the go-ahead)' : ''}`)
      } else {
        return finish('error', `Jev picked an action the page doesn't have (${label}).`)
      }
      record(steps.at(-1) ?? '')

      await page.settle(signal)
      if (page.isClosed()) return finish('error', 'The tab was closed.')
      snap = await page.snapshot()
      if (site && originOf(snap.url) !== site) {
        return finish(
          'left_site',
          `The last step led to ${hostOf(snap.url)}, a different site from ${hostOf(site)}, where it was allowed to act, so it stopped there.`
        )
      }
    }
    return finish('out_of_steps', `Used all ${maxSteps} steps without Jev judging the task done.`)
  } catch (err) {
    if (signal?.aborted) return finish('error', 'Cancelled by the user.')
    return finish('error', `Jev request failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** The step Choice's options: the page's controls (on screen first), plus scrolling and going back. */
function actionOptions(snap: Snapshot): { options: ChoiceCriteria; byLabel: Map<string, PageElement> } {
  const ordered = [...snap.elements.filter((e) => e.inView), ...snap.elements.filter((e) => !e.inView)].slice(0, MAX_ELEMENTS)
  const options: ChoiceCriteria = {}
  const byLabel = new Map<string, PageElement>()
  for (const el of ordered) {
    const label = `${el.kind}_e${el.i}`
    options[label] = `${el.kind === 'type' ? 'Type into' : el.kind === 'select' ? 'Choose in' : 'Click'} ${describe(el)}${el.inView ? '' : ' (below or above the visible area)'}`
    byLabel.set(label, el)
  }
  if (!snap.atBottom) options.scroll_down = 'Scroll down to see more of the page'
  if (!snap.atTop) options.scroll_up = 'Scroll up'
  options.go_back = 'Go back to the previous page'
  return { options, byLabel }
}

/** What a control is called, like: button "Search". */
const name = (el: PageElement): string => `${el.role}${el.label ? ` "${el.label}"` : ''}`

/** A control with its current state, for Jev to choose between. */
function describe(el: PageElement | undefined, fallback = ''): string {
  if (!el) return fallback.replace(/_/g, ' ')
  const name = el.label ? ` "${el.label}"` : ''
  const state =
    el.checked !== undefined
      ? el.checked ? ' (checked)' : ' (unchecked)'
      : el.sensitive
        ? el.filled ? ' (filled)' : ' (empty)'
        : el.kind === 'type'
        ? el.value ? ` (currently "${el.value}")` : ' (empty)'
        : el.kind === 'select' && el.value ? ` (currently "${el.value}")` : ''
  const to = el.href ? ` → ${el.href}` : ''
  return `${el.role}${name}${state}${to}`
}

/** The item Jev chose from a list offered as prefix0, prefix1…, or undefined if it chose something else. */
function offered<T>(choice: string | undefined, prefix: string, items: T[]): T | undefined {
  const m = choice?.match(/^([a-z])(\d+)$/)
  return m && m[1] === prefix ? items[Number(m[2])] : undefined
}

/** An http(s) page's origin, or '' for anything else (a blank tab has no site to hold the run to). */
function originOf(url: string): string {
  try {
    const u = new URL(url)
    return /^https?:$/.test(u.protocol) ? u.origin : ''
  } catch {
    return ''
  }
}

/** A page's address without its query or fragment, which can carry searches, tokens or ids. */
function pageOf(url: string): string {
  try {
    const u = new URL(url)
    return u.origin + u.pathname
  } catch {
    return ''
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Search boxes get Enter after typing; other fields wait for Jev to pick the form's button. */
const isSearchy = (el: PageElement): boolean => el.role === 'search box'
