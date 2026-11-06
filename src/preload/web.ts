import { contextBridge, ipcRenderer } from 'electron'
import type { AddressFields, CardFill, WebMcpTool } from '@shared/types'

/** Runs in every frame of websites and browser tabs, before the page's own scripts. */

// MARK: - WebMCP

/** Chromium's WebMCP (enable-blink-features=WebMCP); only the parts used here. */
interface RegisteredTool {
  name: string
  title?: string
  description: string
  inputSchema?: string
  annotations?: object
  origin: string
}
interface ModelContext extends EventTarget {
  getTools(): Promise<RegisteredTool[]>
  /** Chromium wants the input as a JSON string; the result is the tool's return value, stringified. */
  executeTool(tool: RegisteredTool, input: string, options?: { signal?: AbortSignal }): Promise<string | null>
}

const MAX_TOOLS = 200

/**
 * Tells the app which WebMCP tools the page has registered, whenever that changes. Only the top
 * frame reports: its getTools() already includes tools its iframes registered. This runs in the
 * preload's isolated world, so the page can't reach ipcRenderer, and what's sent is plain data
 * (getTools() entries also carry the registering window, which can't cross IPC).
 */
function reportWebMcpTools(): void {
  const modelContext = (document as Document & { modelContext?: ModelContext }).modelContext
  if (window !== window.top || !modelContext) return

  let scheduled = false
  const report = (): void => {
    if (scheduled) return
    scheduled = true
    // A page often registers several tools in a row; send one snapshot for the batch.
    setTimeout(async () => {
      scheduled = false
      try {
        const tools = (await modelContext.getTools()).slice(0, MAX_TOOLS).map(
          (t): WebMcpTool => ({
            name: String(t.name),
            title: t.title || undefined,
            description: String(t.description ?? ''),
            inputSchema: parseSchema(t.inputSchema),
            annotations: t.annotations ? { ...t.annotations } : undefined,
            origin: String(t.origin)
          })
        )
        ipcRenderer.send('webmcp:tools', tools)
      } catch {
        // The document is going away.
      }
    }, 50)
  }

  modelContext.addEventListener('toolchange', report)
  // A page restored from the back/forward cache comes back with its tools but no toolchange.
  window.addEventListener('pageshow', (e) => e.persisted && report())
  // Leaving the page takes its tools with it.
  window.addEventListener('pagehide', () => ipcRenderer.send('webmcp:tools', []))

  // Claude calling one of the page's tools (main/webmcp.ts execute()).
  const running = new Map<string, AbortController>()
  ipcRenderer.on('webmcp:execute', async (_e, call: { callId: string; name: string; input: string }) => {
    const abort = new AbortController()
    running.set(call.callId, abort)
    try {
      const tool = (await modelContext.getTools()).find((t) => t.name === call.name)
      if (!tool) throw new Error(`The page no longer has a tool named ${call.name}.`)
      const result = await modelContext.executeTool(tool, call.input, { signal: abort.signal })
      ipcRenderer.send('webmcp:result', { callId: call.callId, ok: true, result: result ?? '' })
    } catch (err) {
      const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      ipcRenderer.send('webmcp:result', { callId: call.callId, ok: false, error })
    } finally {
      running.delete(call.callId)
    }
  })
  ipcRenderer.on('webmcp:cancel', (_e, callId: string) => running.get(callId)?.abort())
}

function parseSchema(schema: string | undefined): unknown {
  if (!schema) return undefined
  try {
    return JSON.parse(schema)
  } catch {
    return schema
  }
}

try {
  reportWebMcpTools()
} catch {
  // Never let this break the page.
}

// MARK: - Autofill

interface AutofillMatch {
  id: number
  host: string
  username: string
}

interface AddressOffer {
  id: number
  label: string
}

type CardOffer = AddressOffer

/** A row in the fill chip. */
interface ChipItem {
  kind: 'login' | 'card' | 'address'
  label: string
  detail: string
  title: string
  /** What typing in the field narrows on (a login's username); rows without one go once typing starts. */
  match?: string
  pick: () => void
}

type AddressField = keyof AddressFields

/** The HTML autocomplete tokens that name an address part (the spec's names, not ours). */
const AUTOCOMPLETE_FIELDS: Record<string, AddressField> = {
  name: 'name',
  'given-name': 'givenName',
  'family-name': 'familyName',
  organization: 'organization',
  'street-address': 'street',
  'address-line1': 'line1',
  'address-line2': 'line2',
  'address-level2': 'city',
  'address-level1': 'state',
  'postal-code': 'postalCode',
  country: 'country',
  'country-name': 'country',
  email: 'email',
  tel: 'phone'
}

/**
 * For fields without autocomplete tokens, a guess from the field's name, id, placeholder and
 * label. Order matters: the first match wins, so the narrower patterns come first.
 */
const HINT_FIELDS: [RegExp, AddressField][] = [
  [/e-?mail/, 'email'],
  [/phone|tel\b|mobile/, 'phone'],
  [/first.?name|given.?name|fname/, 'givenName'],
  [/last.?name|family.?name|surname|lname/, 'familyName'],
  [/company|organi[sz]ation|business/, 'organization'],
  [/address.?(line)?.?2|apt|suite|unit\b/, 'line2'],
  [/address|street|line.?1/, 'line1'],
  [/city|town|locality/, 'city'],
  [/state|province|region|county/, 'state'],
  [/zip|postal|post.?code/, 'postalCode'],
  [/country/, 'country'],
  [/full.?name|^name$|your.?name/, 'name']
]

type CardField = 'number' | 'name' | 'exp' | 'expMonth' | 'expYear' | 'cvc'

/** The HTML autocomplete tokens for card parts. */
const CARD_AUTOCOMPLETE: Record<string, CardField> = {
  'cc-number': 'number',
  'cc-name': 'name',
  'cc-exp': 'exp',
  'cc-exp-month': 'expMonth',
  'cc-exp-year': 'expYear',
  'cc-csc': 'cvc'
}

/** Guesses for card fields without autocomplete tokens; first match wins. */
const CARD_HINTS: [RegExp, CardField][] = [
  [/name.?on.?card|card.?holder|cc.?name/, 'name'],
  [/cvc|cvv|csc|security.?code|card.?code|verification/, 'cvc'],
  [/card.?num|cc.?num|credit.?card|debit.?card|^card$|pan\b/, 'number'],
  [/exp\w*.?month|^mm$|\bmonth\b/, 'expMonth'],
  [/exp\w*.?year|^yy(yy)?$|\byear\b/, 'expYear'],
  [/expir|exp.?date|mm.?\/?.?yy/, 'exp']
]

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * Offers saved logins on sign-in forms, saved cards on payment forms and saved addresses on
 * address forms. When such a field is focused and there's something saved for it (asked of the
 * main process, which only sends back usernames and short labels like "Visa •••• 4242"), a small
 * "Fill" chip appears by the field. Choosing one asks the main process for the details — which
 * prompts for Touch ID there — and fills the form. The chip lives in a shadow root so the page's
 * styles can't reach it, and nothing here exposes saved data to the page's own scripts until the
 * user picks something and confirms it's them.
 */
function setupAutofill(): void {
  if (window !== window.top && window.location.href === 'about:blank') return

  let matches: AutofillMatch[] = []
  let addresses: AddressOffer[] = []
  let cards: CardOffer[] = []
  let host: HTMLElement | null = null
  let anchorField: HTMLInputElement | null = null

  const isPassword = (el: Element | null): el is HTMLInputElement =>
    el instanceof HTMLInputElement && el.type === 'password'
  const isUsername = (el: Element | null): el is HTMLInputElement => {
    if (!(el instanceof HTMLInputElement)) return false
    if (!['text', 'email', ''].includes(el.type)) return false
    const hint = `${el.autocomplete} ${el.name} ${el.id}`.toLowerCase()
    return /user|email|login|account|mail/.test(hint) || el.type === 'email'
  }

  /** The password field and the username field in the same form as `field`. */
  const fieldsNear = (field: HTMLInputElement): { user: HTMLInputElement | null; pass: HTMLInputElement | null } => {
    const scope = field.form ?? document
    const inputs = Array.from(scope.querySelectorAll('input'))
    const pass = inputs.find(isPassword) ?? null
    // The username is the last username-like field before the password (or `field` itself).
    const upto = pass ? inputs.slice(0, inputs.indexOf(pass)) : inputs
    const user = [...upto].reverse().find(isUsername) ?? (isUsername(field) ? field : null)
    return { user, pass }
  }

  /** The autocomplete token that names a field's part: the last one, after any section/billing prefix. */
  const autocompleteToken = (el: Element): string =>
    (el.getAttribute('autocomplete') ?? '').trim().toLowerCase().split(/\s+/).pop() ?? ''

  /** Which address part a form control asks for, if any. */
  const addressFieldOf = (el: Element): AddressField | undefined => {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) return
    if (el instanceof HTMLInputElement && !['text', 'email', 'tel', 'search', ''].includes(el.type)) return
    if (el.disabled || (el instanceof HTMLInputElement && el.readOnly)) return
    const token = autocompleteToken(el)
    if (token === 'off' || token === 'username' || token.includes('password') || token.startsWith('cc-')) return
    if (AUTOCOMPLETE_FIELDS[token]) return AUTOCOMPLETE_FIELDS[token]
    const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent ?? '' : ''
    const placeholder = el instanceof HTMLSelectElement ? '' : el.placeholder
    const hint = `${el.name} ${el.id} ${placeholder} ${el.getAttribute('aria-label') ?? ''} ${label}`.toLowerCase().trim()
    if (el instanceof HTMLInputElement && el.type === 'email') return 'email'
    if (el instanceof HTMLInputElement && el.type === 'tel') return 'phone'
    return HINT_FIELDS.find(([re]) => re.test(hint))?.[1]
  }

  /**
   * The address controls in the same form as `field`, when it looks like an address form: at
   * least three address parts, one of them a street, city or postcode, and no password field.
   */
  const addressFieldsNear = (field: Element): Map<HTMLElement, AddressField> | undefined => {
    const scope = (field as HTMLInputElement).form ?? document
    if (scope.querySelector('input[type="password"]')) return
    const found = new Map<HTMLElement, AddressField>()
    for (const el of Array.from(scope.querySelectorAll<HTMLElement>('input, select, textarea'))) {
      const part = addressFieldOf(el)
      if (part) found.set(el, part)
    }
    const parts = new Set(found.values())
    const hasPlace = ['street', 'line1', 'city', 'postalCode'].some((p) => parts.has(p as AddressField))
    return found.size >= 3 && hasPlace && found.has(field as HTMLElement) ? found : undefined
  }

  /** Which card part a form control asks for, if any. */
  const cardFieldOf = (el: Element): CardField | undefined => {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement)) return
    if (el instanceof HTMLInputElement && !['text', 'tel', 'number', 'password', ''].includes(el.type)) return
    if (el.disabled || (el instanceof HTMLInputElement && el.readOnly)) return
    const token = autocompleteToken(el)
    if (CARD_AUTOCOMPLETE[token]) return CARD_AUTOCOMPLETE[token]
    const placeholder = el instanceof HTMLSelectElement ? '' : el.placeholder
    const hint = `${el.name} ${el.id} ${placeholder} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase().trim()
    const part = CARD_HINTS.find(([re]) => re.test(hint))?.[1]
    // A password box is only ever a card's security code, never its number or name.
    return el instanceof HTMLInputElement && el.type === 'password' && part !== 'cvc' ? undefined : part
  }

  /**
   * The card controls in the same form (or frame) as `field`, when it looks like a payment form:
   * the field has a cc-* autocomplete token, or the form has a card-number field. Payment
   * providers often put each field in its own iframe; each frame then fills what it holds.
   */
  const cardFieldsNear = (field: Element): Map<HTMLElement, CardField> | undefined => {
    const scope = (field as HTMLInputElement).form ?? document
    const found = new Map<HTMLElement, CardField>()
    for (const el of Array.from(scope.querySelectorAll<HTMLElement>('input, select'))) {
      const part = cardFieldOf(el)
      if (part) found.set(el, part)
    }
    if (!found.has(field as HTMLElement)) return
    const hasNumber = [...found.values()].includes('number')
    return hasNumber || autocompleteToken(field).startsWith('cc-') ? found : undefined
  }

  /** Sets a value the way a real keystroke would, so React and friends notice the change. */
  const setValue = (input: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    setter ? setter.call(input, value) : (input.value = value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  /**
   * Picks the first option whose value or text matches one of `wants`, in order (a state's code
   * or its name; a month as "03", "3" or "Mar"), if there is one.
   */
  const setSelect = (select: HTMLSelectElement, ...wants: string[]): void => {
    const options = Array.from(select.options)
    let option: HTMLOptionElement | undefined
    for (const want of wants.map((w) => w.toLowerCase())) {
      option = options.find((o) => o.value.toLowerCase() === want || o.text.trim().toLowerCase() === want)
      if (option) break
    }
    if (!option) return
    select.value = option.value
    select.dispatchEvent(new Event('input', { bubbles: true }))
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const hideChip = (): void => {
    host?.remove()
    host = null
    chipItems = []
  }

  const fillLogin = async (match: AutofillMatch): Promise<void> => {
    hideChip()
    let login: { username: string; password: string }
    try {
      login = await ipcRenderer.invoke('passwords:fill', match.id, match.host)
    } catch {
      return // The user cancelled the Touch ID prompt, or autofill is off.
    }
    if (!anchorField) return
    const { user, pass } = fieldsNear(anchorField)
    if (user && login.username) setValue(user, login.username)
    if (pass) setValue(pass, login.password)
  }

  const fillAddress = async (offer: AddressOffer): Promise<void> => {
    hideChip()
    const fields = anchorField && addressFieldsNear(anchorField)
    if (!fields) return
    let address: AddressFields
    try {
      address = await ipcRenderer.invoke('addresses:fill', offer.id)
    } catch {
      return // The user cancelled Touch ID, autofill is off, or the address was deleted.
    }
    for (const [el, part] of fields) {
      const value = address[part]
      if (!value) continue
      if (el instanceof HTMLSelectElement) setSelect(el, value)
      // One-line street boxes get the lines joined; a textarea keeps them on their own lines.
      else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
        setValue(el, part === 'street' && el instanceof HTMLInputElement ? value.replace(/\n/g, ', ') : value)
    }
  }

  const fillCard = async (offer: CardOffer): Promise<void> => {
    hideChip()
    const fields = anchorField && cardFieldsNear(anchorField)
    if (!fields) return
    let card: CardFill
    try {
      card = await ipcRenderer.invoke('cards:fill', offer.id)
    } catch {
      return // The user cancelled Touch ID, autofill is off, or the page isn't secure.
    }
    const mm = String(card.expMonth).padStart(2, '0')
    const yyyy = String(card.expYear)
    const yy = yyyy.slice(-2)
    /** A text box's value for a part. Years go in as two digits when the box is that short or says YY. */
    const textFor = (el: HTMLInputElement, part: CardField): string => {
      switch (part) {
        case 'number':
          return card.number
        case 'name':
          return card.nameOnCard
        case 'cvc':
          return card.cvc
        case 'expMonth':
          return mm
        case 'expYear':
          return el.maxLength === 2 || (/yy/i.test(el.placeholder) && !/yyyy/i.test(el.placeholder)) ? yy : yyyy
        case 'exp':
          return `${mm}/${/yyyy/i.test(el.placeholder) || el.maxLength >= 7 ? yyyy : yy}`
      }
    }
    for (const [el, part] of fields) {
      if (el instanceof HTMLSelectElement) {
        if (part === 'expMonth') setSelect(el, mm, String(card.expMonth), MONTHS[card.expMonth - 1] ?? '')
        else if (part === 'expYear') setSelect(el, yyyy, yy)
      } else if (el instanceof HTMLInputElement) {
        const value = textFor(el, part)
        if (value) setValue(el, value)
      }
    }
  }

  /** The chip's rows, their shadow root, and which one the arrow keys have picked (-1: none). */
  let chipItems: ChipItem[] = []
  let chipRoot: ShadowRoot | null = null
  let active = -1

  const ICONS: Record<ChipItem['kind'], string> = {
    login:
      '<path d="M14.5 3a6.5 6.5 0 0 0-6.2 8.4L3 16.7V21h4.3v-2.3h2.3v-2.3h2.3l1.3-1.3A6.5 6.5 0 1 0 14.5 3Z"/>' +
      '<circle cx="16.5" cy="7.5" r="1.5"/>',
    card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/>',
    address: '<path d="M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>'
  }

  const STYLE =
    ':host{all:initial}' +
    '.panel{--bg:#fff;--fg:#1d1d1f;--dim:#6e6e73;--line:rgba(0,0,0,.1);--hover:rgba(0,0,0,.05);' +
    '--pick:#0a66e8;--icon-bg:rgba(0,0,0,.05);' +
    'box-sizing:border-box;padding:4px;border-radius:10px;background:var(--bg);color:var(--fg);' +
    'border:1px solid var(--line);box-shadow:0 10px 30px rgba(0,0,0,.18),0 2px 6px rgba(0,0,0,.08);' +
    'font:13px/1.25 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;' +
    'animation:in .12s ease-out;transform-origin:top left}' +
    '.panel.up{transform-origin:bottom left}' +
    '@media (prefers-color-scheme:dark){.panel{--bg:#2a2a2d;--fg:#f2f2f4;--dim:#a1a1a8;' +
    '--line:rgba(255,255,255,.1);--hover:rgba(255,255,255,.07);--pick:#2f7cf6;--icon-bg:rgba(255,255,255,.08);' +
    'box-shadow:0 10px 30px rgba(0,0,0,.5),0 2px 6px rgba(0,0,0,.3)}}' +
    '@keyframes in{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}' +
    '.panel.up{animation-name:in-up}' +
    '@keyframes in-up{from{opacity:0;transform:translateY(4px) scale(.98)}to{opacity:1;transform:none}}' +
    '.row{display:flex;align-items:center;gap:10px;width:100%;box-sizing:border-box;margin:0;padding:7px 8px;' +
    'border:0;border-radius:7px;background:none;color:inherit;font:inherit;text-align:left;cursor:default}' +
    '.row:hover{background:var(--hover)}' +
    '.row.on{background:var(--pick);color:#fff}.row.on .sub{color:rgba(255,255,255,.8)}' +
    '.row.on .icon{background:rgba(255,255,255,.2);color:#fff}' +
    '.icon{flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:7px;' +
    'background:var(--icon-bg);color:var(--dim)}' +
    '.icon svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.7;' +
    'stroke-linecap:round;stroke-linejoin:round}' +
    '.text{min-width:0;flex:1}' +
    '.main,.sub{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.main{font-weight:500}.sub{font-size:11.5px;color:var(--dim);margin-top:1px}'

  /** Puts the panel under the field (or over it, when there's no room below), inside the window. */
  const placeChip = (): void => {
    if (!host || !anchorField) return
    const rect = anchorField.getBoundingClientRect()
    const width = Math.min(Math.max(rect.width, 260), 380, window.innerWidth - 16)
    host.style.width = `${Math.round(width)}px`
    host.style.left = `${Math.round(Math.min(Math.max(rect.left, 8), window.innerWidth - width - 8))}px`
    const height = host.offsetHeight
    const up = rect.bottom + 6 + height > window.innerHeight && rect.top - 6 - height > 0
    host.style.top = `${Math.round(up ? rect.top - 6 - height : rect.bottom + 6)}px`
    chipRoot?.querySelector('.panel')?.classList.toggle('up', up)
  }

  /** The rows still worth offering for what's typed so far: those whose `match` starts with it. */
  const visibleItems = (): ChipItem[] => {
    const typed = anchorField?.value.trim().toLowerCase() ?? ''
    if (!typed) return chipItems
    if (isPassword(anchorField)) return [] // Typing a password by hand: get out of the way.
    return chipItems.filter((item) => item.match?.toLowerCase().startsWith(typed))
  }

  const renderChip = (): void => {
    const items = visibleItems().slice(0, 5)
    if (!items.length) {
      host?.remove()
      host = null
      return
    }
    if (!host) {
      host = document.createElement('div')
      host.style.cssText = 'position:fixed;z-index:2147483647;'
      chipRoot = host.attachShadow({ mode: 'closed' })
      document.documentElement.append(host)
    }
    const root = chipRoot as ShadowRoot
    active = Math.min(active, items.length - 1)
    const panel = document.createElement('div')
    panel.className = 'panel'
    panel.setAttribute('role', 'listbox')
    items.forEach((item, i) => {
      const row = document.createElement('button')
      row.className = i === active ? 'row on' : 'row'
      row.setAttribute('role', 'option')
      row.title = item.title
      row.tabIndex = -1
      const icon = document.createElement('span')
      icon.className = 'icon'
      icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[item.kind]}</svg>`
      const text = document.createElement('span')
      text.className = 'text'
      const main = document.createElement('span')
      main.className = 'main'
      main.textContent = item.label
      const sub = document.createElement('span')
      sub.className = 'sub'
      sub.textContent = item.detail
      text.append(main, sub)
      row.append(icon, text)
      // mousedown, not click, so it fires before the field blurs.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault()
        item.pick()
      })
      row.addEventListener('mouseenter', () => {
        active = -1
        root.querySelectorAll('.row.on').forEach((r) => r.classList.remove('on'))
      })
      panel.append(row)
    })
    const style = document.createElement('style')
    style.textContent = STYLE
    root.replaceChildren(style, panel)
    placeChip()
  }

  const showChip = (field: HTMLInputElement, items: ChipItem[]): void => {
    if (!items.length) return
    hideChip()
    anchorField = field
    chipItems = items
    active = -1
    renderChip()
  }

  // While the chip is open: arrows move through it, Enter fills, Escape closes, typing narrows it.
  document.addEventListener(
    'keydown',
    (e) => {
      if (!host || e.target !== anchorField) return
      const items = visibleItems().slice(0, 5)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        active = active < 0 ? (step > 0 ? 0 : items.length - 1) : (active + step + items.length) % items.length
        renderChip()
      } else if (e.key === 'Enter' && active >= 0 && items[active]) {
        e.preventDefault()
        e.stopPropagation()
        items[active].pick()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        hideChip()
      } else if (e.key === 'Tab') {
        hideChip()
      }
    },
    true
  )
  document.addEventListener(
    'input',
    (e) => {
      if (e.target === anchorField && chipItems.length) renderChip()
    },
    true
  )
  window.addEventListener('resize', placeChip)

  document.addEventListener(
    'focusin',
    (e) => {
      const el = e.target instanceof Element ? e.target : null
      // Cards first: a security-code box can be a password field, and must not offer logins.
      if (el instanceof HTMLInputElement && cards.length && cardFieldsNear(el)) {
        showChip(
          el,
          cards.map((c) => ({
            kind: 'card',
            label: c.label,
            detail: 'Saved card',
            title: 'Fill saved card',
            pick: () => void fillCard(c)
          }))
        )
      } else if ((isPassword(el) || isUsername(el)) && matches.length) {
        showChip(
          el,
          matches.map((m) => ({
            kind: 'login',
            label: m.username || 'Saved password',
            detail: `\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 \u00b7 ${m.host}`,
            title: `Fill saved login for ${m.host}`,
            match: m.username,
            pick: () => void fillLogin(m)
          }))
        )
      } else if (el instanceof HTMLInputElement && addresses.length && addressFieldsNear(el)) {
        showChip(
          el,
          addresses.map((a) => ({
            kind: 'address',
            label: a.label,
            detail: 'Saved address',
            title: 'Fill saved address',
            pick: () => void fillAddress(a)
          }))
        )
      }
    },
    true
  )
  // Let a chip click land before hiding; any other click dismisses it.
  document.addEventListener('focusout', () => setTimeout(hideChip, 150), true)
  window.addEventListener('scroll', hideChip, true)

  const refresh = (): void => {
    ipcRenderer
      .invoke('passwords:match', window.location.href)
      .then((result: AutofillMatch[]) => {
        matches = Array.isArray(result) ? result : []
      })
      .catch(() => {
        matches = []
      })
    ipcRenderer
      .invoke('addresses:offer')
      .then((result: AddressOffer[]) => {
        addresses = Array.isArray(result) ? result : []
      })
      .catch(() => {
        addresses = []
      })
    // Cards only on secure pages; the main process checks the frame again before filling.
    if (!window.isSecureContext) return
    ipcRenderer
      .invoke('cards:offer')
      .then((result: CardOffer[]) => {
        cards = Array.isArray(result) ? result : []
      })
      .catch(() => {
        cards = []
      })
  }
  refresh()
  window.addEventListener('pageshow', refresh)
}

try {
  setupAutofill()
} catch {
  // Never let autofill break the page.
}
