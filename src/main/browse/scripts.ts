/**
 * The scripts a driver runs in the page: one reads its controls into a numbered list, one acts on
 * a control from that list, and one fingerprints the page to tell when it has stopped changing.
 * They're plain DOM code, so any driver that can run a script in the page can use them; run them
 * somewhere the page's own scripts can't reach, like an isolated world.
 */

/** Commit-sounding labels and link addresses are checked with Jev before clicking. */
export const COMMIT_WORDS =
  /\b(buy|purchase|pay|order|checkout|check out|place|submit|send|post|publish|delete|remove|cancel|confirm|book|reserve|subscribe|transfer|sign up|register|donate|unsubscribe)\b/i

/**
 * In-page test for a search box, shared by the snapshot and the actions so they agree on which
 * fields get Enter after typing. Being a form's only field isn't enough: signups and comment boxes
 * look like that too, and pressing Enter there would submit without the irreversible check.
 */
const IS_SEARCH_BOX = `(el) => {
  const hint = (el.getAttribute('name') || '') + ' ' + (el.id || '') + ' ' + (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '')
  return (el.getAttribute('type') || '').toLowerCase() === 'search' || (el.getAttribute('role') || '').toLowerCase() === 'searchbox' ||
    /search|query|\\bq\\b/i.test(hint)
}`

export const FINGERPRINT_SCRIPT = `location.href + ':' + (document.body ? document.body.innerText.length + ':' + document.body.getElementsByTagName('*').length : '')`

/**
 * Lists the page's visible controls and keeps references to them in this isolated world, where
 * the actions find them by number. Password fields are left out: a run never types passwords.
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const SEL = 'a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], ' +
    '[role=option], [role=checkbox], [role=radio], [role=switch], [role=searchbox], [role=textbox], [role=combobox], [contenteditable=""], [contenteditable=true]'
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
  const isSearchBox = ${IS_SEARCH_BOX}
  const COMMIT = new RegExp(${JSON.stringify(COMMIT_WORDS.source)}, 'i')
  // Fields whose values stay on the page: payment, one-time codes, contact and account details.
  const sensitive = (el, type) =>
    type === 'email' || type === 'tel' ||
    /\\b(cc-|one-time-code|username|email|tel|street-address|address-line|postal-code|bday)/i.test(el.getAttribute('autocomplete') || '') ||
    /card|cvc|cvv|ssn|otp|pin|iban|account/i.test((el.getAttribute('name') || '') + ' ' + (el.id || ''))
  // A <label> can wrap its control; leave the control's own text (a dropdown's options) out.
  const labelText = (l) => {
    const copy = l.cloneNode(true)
    copy.querySelectorAll('select, input, textarea, button').forEach((n) => n.remove())
    return copy.textContent
  }
  const refs = []
  const out = []
  for (const el of document.querySelectorAll(SEL)) {
    if (out.length >= 400) break
    if (el.disabled || el.closest('[aria-hidden="true"], [inert]')) continue
    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) continue
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') continue
    const tag = el.tagName.toLowerCase()
    const role = (el.getAttribute('role') || '').toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    if (type === 'hidden' || type === 'password' || type === 'file') continue
    let kind = 'click'
    let roleName = role || tag
    if (tag === 'select') { kind = 'select'; roleName = 'dropdown' }
    else if (tag === 'textarea' || el.isContentEditable || role === 'textbox' || role === 'searchbox' ||
      (tag === 'input' && !['submit', 'button', 'reset', 'checkbox', 'radio', 'range', 'color', 'image'].includes(type)) ||
      (role === 'combobox' && tag === 'input')) {
      kind = 'type'
      roleName = isSearchBox(el) ? 'search box' : 'text field'
    }
    else if (type === 'checkbox' || role === 'checkbox' || role === 'switch') roleName = 'checkbox'
    else if (type === 'radio' || role === 'radio') roleName = 'radio button'
    else if (tag === 'a' || role === 'link') roleName = 'link'
    else if (tag === 'button' || tag === 'input' || role === 'button') roleName = 'button'
    const labelledBy = el.getAttribute('aria-labelledby')
    const label = clean(
      el.getAttribute('aria-label') ||
      (labelledBy && labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ')) ||
      (el.labels && el.labels[0] && labelText(el.labels[0])) ||
      el.getAttribute('placeholder') ||
      (kind === 'click' && (el.innerText || el.value)) ||
      el.getAttribute('title') ||
      el.querySelector?.('img[alt]')?.getAttribute('alt') ||
      el.getAttribute('name') || ''
    )
    if (!label && kind === 'click') continue
    const item = { i: refs.length, kind, role: roleName, label, inView: rect.bottom > 0 && rect.top < innerHeight,
      button: roleName === 'button' || type === 'submit' }
    if (kind === 'type') {
      const value = clean(el.isContentEditable ? el.innerText : el.value)
      if (sensitive(el, type)) { item.sensitive = true; item.filled = !!value }
      else item.value = value
    }
    if (kind === 'select') {
      item.value = clean(el.selectedOptions[0]?.label || '')
      item.options = Array.from(el.options).map((o) => clean(o.label || o.value)).filter(Boolean).slice(0, 250)
    }
    if (roleName === 'checkbox' || roleName === 'radio button') item.checked = el.checked ?? el.getAttribute('aria-checked') === 'true'
    if (tag === 'a') {
      try {
        const u = new URL(el.href)
        item.href = (u.origin === location.origin ? '' : u.host) + u.pathname.slice(0, 60)
        if (COMMIT.test((u.pathname + ' ' + u.search).replace(/[\\/_\\-+=&?.]/g, ' '))) item.commitLink = true
      } catch {}
    }
    refs.push(el)
    out.push(item)
  }
  window.__jevBrowseRefs = refs
  const doc = document.documentElement
  return {
    url: location.href,
    title: document.title,
    text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 3000),
    atTop: scrollY <= 2,
    atBottom: innerHeight + scrollY >= doc.scrollHeight - 2,
    fingerprint: location.href + ':' + (document.body ? document.body.innerText.length : 0) + ':' + out.length,
    elements: out
  }
})()`

/**
 * One action on an element from the last snapshot. Values are set through the element's native
 * setter and announced with input and change events, so frameworks like React notice. Links that
 * would open a new tab open in this one, so the run can follow them.
 */
export const ACT_SCRIPT = `(op, index, arg) => {
  const el = (window.__jevBrowseRefs || [])[index]
  if (!el || !el.isConnected) return 'gone'
  el.scrollIntoView({ block: 'center', inline: 'center' })
  if (op === 'click') {
    if (el.tagName === 'A' && el.target && el.target !== '_self') el.target = '_self'
    const r = el.getBoundingClientRect()
    const at = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 }
    el.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType: 'mouse', isPrimary: true }))
    el.dispatchEvent(new MouseEvent('mousedown', at))
    el.focus && el.focus({ preventScroll: true })
    el.dispatchEvent(new PointerEvent('pointerup', { ...at, pointerType: 'mouse', isPrimary: true }))
    el.dispatchEvent(new MouseEvent('mouseup', at))
    el.click()
    return 'ok'
  }
  if (op === 'select') {
    const option = Array.from(el.options).find((o) => (o.label || o.value).replace(/\\s+/g, ' ').trim().slice(0, 80) === arg)
    if (!option) return 'gone'
    el.value = option.value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return 'ok'
  }
  el.focus({ preventScroll: true })
  if (el.isContentEditable) {
    document.execCommand('selectAll')
    document.execCommand('insertText', false, arg)
  } else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, arg)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  if ((${IS_SEARCH_BOX})(el)) {
    const key = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }
    const go = el.dispatchEvent(new KeyboardEvent('keydown', key))
    el.dispatchEvent(new KeyboardEvent('keypress', key))
    el.dispatchEvent(new KeyboardEvent('keyup', key))
    if (go && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit()
  }
  return 'ok'
}`
