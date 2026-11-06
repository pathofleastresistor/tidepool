import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import electronPath from 'electron'
import { _electron } from 'playwright-core'

// End-to-end test for importing cookies, saved logins, addresses and payment cards from another
// browser, and the stores behind autofill. It builds a fake Chromium browser (a "Test Browser") with two profiles
// whose Cookies, Login Data, Login Data For Account and Web Data are laid out and encrypted exactly
// as Chrome's are on macOS, points the app at it with the test seams (TIDEPOOL_IMPORT_DIR /
// TIDEPOOL_IMPORT_KEY), and checks the real decryption, cookie injection, encrypted password
// storage, and filling address and card forms in a web page behind a stand-in for Touch ID
// (TIDEPOOL_TEST_TOUCH_ID). No real browser, Keychain, sensor, or network.
// Run `npm run build` first. On Linux CI, wrap with `xvfb-run -a`.
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

// MARK: - A fake Chromium browser

const support = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-import-support-'))
const profile = path.join(support, 'TestBrowser', 'Default')
fs.mkdirSync(path.join(profile, 'Network'), { recursive: true })

const SECRET = 'test-secret-123'
const key = crypto.pbkdf2Sync(SECRET, 'saltysalt', 1003, 16, 'sha1')
/** Encrypts a value the way Chrome does on macOS: AES-128-CBC, all-spaces IV, "v10" prefix. */
const encv10 = (buf) => {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  return Buffer.concat([Buffer.from('v10'), cipher.update(buf), cipher.final()])
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest()

const cookies = new DatabaseSync(path.join(profile, 'Network', 'Cookies'))
cookies.exec(
  `CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB, path TEXT,
     expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER)`
)
const addCookie = cookies.prepare(
  `INSERT INTO cookies (host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
)
// A modern cookie: the plaintext is prefixed with SHA-256(host_key), which the importer must strip.
// Its expires_utc (microseconds since 1601, ~2030) is larger than a JS number can hold, so the
// importer must read it as a BigInt rather than throwing a RangeError.
addCookie.run('example.com', 'sid', encv10(Buffer.concat([sha256('example.com'), Buffer.from('choc-chip')])), '/', 13537929600000000n, 1, 1, 1)
// An older cookie with no domain-hash prefix.
addCookie.run('.test.dev', 'pref', encv10(Buffer.from('plainval')), '/', 0, 0, 0, 0)
cookies.close()

/** Writes a Login Data-shaped store with these [origin, username, password bytes] rows. */
const writeLogins = (file, rows) => {
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE logins (origin_url TEXT, username_value TEXT, password_value BLOB, signon_realm TEXT)`)
  const add = db.prepare(`INSERT INTO logins (origin_url, username_value, password_value, signon_realm) VALUES (?, ?, ?, ?)`)
  for (const [origin, user, pw] of rows) add.run(origin, user, pw, origin)
  db.close()
}
// On-device logins ("Login Data"): the same alice login as the account store, with an older
// password, and a "never save" entry with no password, which isn't a login at all.
writeLogins(path.join(profile, 'Login Data'), [
  ['https://example.com/login', 'alice@example.com', encv10(Buffer.from('old-password'))],
  ['https://empty.example/', 'bob', Buffer.alloc(0)]
])
// Logins saved to the Google account ("Login Data For Account"), where Chrome keeps most of them
// now: alice again (this copy wins), a password saved with no username, an Android app login and
// one whose password won't decrypt (both skipped).
writeLogins(path.join(profile, 'Login Data For Account'), [
  ['https://example.com/login', 'alice@example.com', encv10(Buffer.from('hunter2'))],
  ['https://nouser.example/', '', encv10(Buffer.from('pin-1234'))],
  ['android://hash@com.example.app/', 'carol', encv10(Buffer.from('app-pass'))],
  ['https://broken.example/', 'dan', Buffer.concat([Buffer.from('v10'), Buffer.alloc(16, 7)])]
])

// Saved addresses (Web Data): one row per address, its parts as typed tokens. Chromium's field
// type numbers: 7 full name, 9 email, 14 phone, 33 city, 34 state, 35 zip, 36 country, 77 street.
const webData = new DatabaseSync(path.join(profile, 'Web Data'))
webData.exec(`CREATE TABLE addresses (guid VARCHAR PRIMARY KEY, use_count INTEGER, record_type INTEGER);
  CREATE TABLE address_type_tokens (guid VARCHAR, type INTEGER, value VARCHAR, verification_status INTEGER)`)
webData.prepare(`INSERT INTO addresses (guid, use_count, record_type) VALUES (?, 1, 0)`).run('addr-1')
const addToken = webData.prepare(
  `INSERT INTO address_type_tokens (guid, type, value, verification_status) VALUES (?, ?, ?, 0)`
)
for (const [type, value] of [
  [7, 'Alice Example'],
  [9, 'alice@example.com'],
  [14, '+1 555 0100'],
  [77, '12 Main St\nApt 4'],
  [33, 'Springfield'],
  [34, 'OR'],
  [35, '97477'],
  [36, 'US']
])
  addToken.run('addr-1', type, value)

// Payment cards: a current Visa with its security code kept, an expired Mastercard (imported, but
// not offered), and a Google Pay card, of which only the last four digits are ever on disk.
webData.exec(`CREATE TABLE credit_cards (guid VARCHAR PRIMARY KEY, name_on_card VARCHAR, expiration_month INTEGER,
    expiration_year INTEGER, card_number_encrypted BLOB, nickname VARCHAR);
  CREATE TABLE local_stored_cvc (guid VARCHAR PRIMARY KEY, value_encrypted VARCHAR, last_updated_timestamp INTEGER);
  CREATE TABLE masked_credit_cards (id VARCHAR, name_on_card VARCHAR, network VARCHAR, last_four VARCHAR)`)
const addCard = webData.prepare(
  `INSERT INTO credit_cards (guid, name_on_card, expiration_month, expiration_year, card_number_encrypted, nickname)
   VALUES (?, ?, ?, ?, ?, ?)`
)
addCard.run('card-1', 'Alice Example', 12, 2031, encv10(Buffer.from('4111111111111111')), '')
addCard.run('card-2', 'Alice Example', 1, 2020, encv10(Buffer.from('5555555555554444')), 'Old card')
webData
  .prepare(`INSERT INTO local_stored_cvc (guid, value_encrypted, last_updated_timestamp) VALUES (?, ?, 0)`)
  .run('card-1', encv10(Buffer.from('123')))
webData
  .prepare(`INSERT INTO masked_credit_cards (id, name_on_card, network, last_four) VALUES ('gpay-1', 'Alice', 'visa', '0005')`)
  .run()
webData.close()

// A second profile, with only account logins. Local State names both, and says which was used last.
const profile2 = path.join(support, 'TestBrowser', 'Profile 2')
fs.mkdirSync(profile2, { recursive: true })
writeLogins(path.join(profile2, 'Login Data For Account'), [
  ['https://work.example/', 'erin@work.example', encv10(Buffer.from('w0rk'))]
])
fs.writeFileSync(
  path.join(support, 'TestBrowser', 'Local State'),
  JSON.stringify({
    profile: { last_used: 'Profile 2', info_cache: { Default: { name: 'Personal' }, 'Profile 2': { name: 'Work' } } }
  })
)

// MARK: - A page with an address form, to check the fill chip in a real web page

const PAY_FORM = `<!doctype html><title>Pay</title><form>
    <input id="ccname" autocomplete="cc-name">
    <input id="ccnum" name="cardnumber">
    <select id="mon" name="exp-month">${Array.from({ length: 12 }, (_, i) => `<option>${String(i + 1).padStart(2, '0')}</option>`).join('')}</select>
    <input id="yr" name="exp-year" maxlength="2" placeholder="YY">
    <input id="cvc" name="cvc" type="password">
  </form>`
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  if (req.url === '/pay') return res.end(PAY_FORM)
  res.end(`<!doctype html><title>Checkout</title><form>
    <input id="fullname" autocomplete="name">
    <input id="email" type="email">
    <input id="street" name="address1" placeholder="Street address">
    <input id="apt" name="address2">
    <input id="city" name="city">
    <select id="state" name="state"><option value="">--</option><option value="CA">California</option><option value="OR">Oregon</option></select>
    <input id="zip" autocomplete="postal-code">
    <input id="tel" type="tel">
  </form>`)
})
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve))
// 127.0.0.1 counts as a secure page, so cards are offered there as on an https site.
const siteUrl = `http://127.0.0.1:${site.address().port}/checkout`
const payUrl = `http://127.0.0.1:${site.address().port}/pay`

// MARK: - App

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-import-'))
fs.writeFileSync(path.join(userDataDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }))
const logs = []
const app = await _electron.launch({
  executablePath: electronPath,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `${REPO}/out/main/index.js`, `--user-data-dir=${userDataDir}`],
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: 'test-key',
    TIDEPOOL_E2E: '1',
    TIDEPOOL_IMPORT_DIR: support,
    TIDEPOOL_IMPORT_KEY: SECRET,
    TIDEPOOL_TEST_TOUCH_ID: 'allow'
  }
})
app.process().stderr.on('data', (d) => logs.push(String(d)))
const win = await app.firstWindow()

let failed = false
const step = async (name, fn) => {
  try {
    await fn()
    console.log('PASS', name)
  } catch (e) {
    failed = true
    console.log('FAIL', name, '-', e.message.split('\n')[0])
  }
}
const assert = (cond, message) => {
  if (!cond) throw new Error(message)
}

const ALL = { cookies: true, passwords: true, addresses: true, cards: true }
const LOGINS_ONLY = { cookies: false, passwords: true, addresses: false, cards: false }
/** Answers the next Touch ID prompts: 'allow', or 'deny' as if the user cancelled. */
const touchId = (answer) => app.evaluate((_electron, a) => (process.env.TIDEPOOL_TEST_TOUCH_ID = a), answer)

/**
 * Opens `url` in a hidden window in the websites' profile (so the web preload runs), focuses the
 * field `focusId`, clicks the fill chip's first button, and returns the values of `ids`, or
 * { error } if no chip appeared.
 */
const fillVia = (url, focusId, ids) =>
  app.evaluate(
    async ({ BrowserWindow }, [url, focusId, ids]) => {
      const w = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { partition: 'persist:web' } })
      try {
        await w.loadURL(url)
        const wc = w.webContents
        // Give the preload a moment to ask what's saved, then focus the field.
        await new Promise((r) => setTimeout(r, 500))
        const chip = await wc.executeJavaScript(`(() => {
          document.getElementById(${JSON.stringify(focusId)}).dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
          const host = [...document.documentElement.children].find((el) => el.tagName === 'DIV' && el.style.zIndex === '2147483647')
          if (!host) return null
          const r = host.getBoundingClientRect()
          return { x: r.x + 20, y: r.y + 10 }
        })()`)
        if (!chip) return { error: 'no fill chip appeared' }
        const at = { x: Math.round(chip.x), y: Math.round(chip.y), button: 'left', clickCount: 1 }
        wc.sendInputEvent({ type: 'mouseDown', ...at })
        wc.sendInputEvent({ type: 'mouseUp', ...at })
        await new Promise((r) => setTimeout(r, 500))
        return await wc.executeJavaScript(
          `Object.fromEntries(${JSON.stringify(ids)}.map((id) => [id, document.getElementById(id).value]))`
        )
      } finally {
        w.destroy()
      }
    },
    [url, focusId, ids]
  )
const run = (profileDir, kinds) =>
  win.evaluate(([p, k]) => window.api.browserImport.run('testbrowser', p, k), [profileDir, kinds])

try {
  await step('detect lists each profile, last used first, with what it holds', async () => {
    const browsers = (await win.evaluate(() => window.api.browserImport.detect())).filter((b) => b.id === 'testbrowser')
    assert(browsers.length === 2, `expected 2 test profiles, got ${browsers.length}`)
    const [work, personal] = browsers
    assert(work.profile === 'Profile 2' && work.profileName === 'Work', `first: ${work.profile} ${work.profileName}`)
    assert(personal.profile === 'Default' && personal.profileName === 'Personal', `second: ${personal.profile}`)
    assert(personal.hasCookies, 'Default should have cookies')
    // Both stores count, and the "never save" entry with no password doesn't.
    assert(personal.passwordCount === 5, `Default passwords: ${personal.passwordCount}`)
    assert(personal.addressCount === 1, `Default addresses: ${personal.addressCount}`)
    assert(personal.cardCount === 2, `Default cards: ${personal.cardCount}`)
    assert(work.passwordCount === 1 && work.addressCount === 0 && work.cardCount === 0, 'Work holds one login only')
  })

  await step('import brings over cookies, logins from both stores, addresses and cards', async () => {
    const result = await run('Default', ALL)
    assert(result.cookies === 2, `expected 2 cookies, got ${result.cookies}`)
    // alice (once, from the account) and the no-username login; the app login and the broken one skipped.
    assert(result.passwords === 2, `expected 2 saved logins, got ${result.passwords}`)
    assert(result.passwordsSkipped === 2, `expected 2 skipped, got ${result.passwordsSkipped}`)
    assert(result.addresses === 1, `expected 1 address, got ${result.addresses}`)
    // Both on-device cards; the Google Pay one is skipped.
    assert(result.cards === 2, `expected 2 cards, got ${result.cards}`)
    assert(result.cardsSkipped === 1, `expected 1 card skipped, got ${result.cardsSkipped}`)
  })

  await step('the imported cards show in the list, without their numbers or codes', async () => {
    const list = await win.evaluate(() => window.api.cards.list())
    assert(list.length === 2, `expected 2 cards, got ${list.length}`)
    const visa = list.find((c) => c.lastFour === '1111')
    assert(visa?.network === 'Visa' && visa.expMonth === 12 && visa.expYear === 2031, `visa: ${JSON.stringify(visa)}`)
    assert(visa.hasCvc && visa.nameOnCard === 'Alice Example', 'the Visa keeps its name and has a code')
    const old = list.find((c) => c.lastFour === '4444')
    assert(old?.network === 'Mastercard' && old.nickname === 'Old card' && !old.hasCvc, `old: ${JSON.stringify(old)}`)
    const text = JSON.stringify(list)
    assert(!text.includes('4111111111111111') && !text.includes('"123"'), 'the list must never carry a number or code')
  })

  await step('the imported logins show in the list, without their passwords', async () => {
    const list = await win.evaluate(() => window.api.passwords.list())
    assert(list.length === 2, `expected 2 saved logins, got ${list.length}`)
    const alice = list.find((l) => l.host === 'example.com')
    assert(alice?.username === 'alice@example.com', `alice: ${JSON.stringify(alice)}`)
    assert(alice.source === 'Test Browser (Personal)', `source: ${alice.source}`)
    assert(list.some((l) => l.host === 'nouser.example' && l.username === ''), 'the no-username login should be there')
    assert(list.every((l) => !('password' in l) && !('passwordEnc' in l)), 'the list must never carry a password')
  })

  await step('the imported address shows in the list, with its parts', async () => {
    const [address, ...rest] = await win.evaluate(() => window.api.addresses.list())
    assert(address && !rest.length, 'expected 1 saved address')
    assert(address.name === 'Alice Example', `name: ${address.name}`)
    assert(address.givenName === 'Alice' && address.familyName === 'Example', 'the name should split into parts')
    assert(address.line1 === '12 Main St' && address.line2 === 'Apt 4', `lines: ${address.line1} / ${address.line2}`)
    assert(address.city === 'Springfield' && address.state === 'OR' && address.postalCode === '97477', 'city/state/zip')
  })

  await step('another profile imports on its own', async () => {
    const result = await run('Profile 2', LOGINS_ONLY)
    assert(result.passwords === 1, `expected 1 saved login, got ${result.passwords}`)
    const list = await win.evaluate(() => window.api.passwords.list())
    assert(
      list.some((l) => l.host === 'work.example' && l.source === 'Test Browser (Work)'),
      'the Work login should be there'
    )
  })

  await step('an unknown profile is refused', async () => {
    const error = await run('../../etc', LOGINS_ONLY).then(
      () => null,
      (e) => e.message
    )
    assert(error && /no profile/.test(error), `expected a refusal, got ${error}`)
  })

  await step('re-importing updates in place rather than duplicating', async () => {
    await run('Default', ALL)
    const logins = await win.evaluate(() => window.api.passwords.list())
    const addresses = await win.evaluate(() => window.api.addresses.list())
    const cards = await win.evaluate(() => window.api.cards.list())
    assert(logins.length === 3, `expected still 3 saved logins, got ${logins.length}`)
    assert(addresses.length === 1, `expected still 1 address, got ${addresses.length}`)
    assert(cards.length === 2, `expected still 2 cards, got ${cards.length}`)
  })

  await step("a web page's address form fills from the chip, after Touch ID", async () => {
    const filled = await fillVia(siteUrl, 'street', ['fullname', 'email', 'street', 'apt', 'city', 'state', 'zip', 'tel'])
    assert(!filled.error, filled.error)
    const want = {
      fullname: 'Alice Example',
      email: 'alice@example.com',
      street: '12 Main St',
      apt: 'Apt 4',
      city: 'Springfield',
      state: 'OR',
      zip: '97477',
      tel: '+1 555 0100'
    }
    for (const [id, value] of Object.entries(want)) assert(filled[id] === value, `${id}: got "${filled[id]}", want "${value}"`)
  })

  await step('a payment form fills the current card, after Touch ID', async () => {
    const filled = await fillVia(payUrl, 'ccnum', ['ccname', 'ccnum', 'mon', 'yr', 'cvc'])
    assert(!filled.error, filled.error)
    const want = { ccname: 'Alice Example', ccnum: '4111111111111111', mon: '12', yr: '31', cvc: '123' }
    for (const [id, value] of Object.entries(want)) assert(filled[id] === value, `${id}: got "${filled[id]}", want "${value}"`)
  })

  await step('cancelling Touch ID fills nothing', async () => {
    await touchId('deny')
    try {
      const card = await fillVia(payUrl, 'ccnum', ['ccnum', 'cvc'])
      assert(!card.error, card.error)
      assert(card.ccnum === '' && card.cvc === '', `card filled anyway: ${JSON.stringify(card)}`)
      const address = await fillVia(siteUrl, 'street', ['street', 'city'])
      assert(!address.error, address.error)
      assert(address.street === '' && address.city === '', `address filled anyway: ${JSON.stringify(address)}`)
    } finally {
      await touchId('allow')
    }
  })

  await step('autofill is on by default and can be turned off', async () => {
    const before = await win.evaluate(() => window.api.settings.get())
    assert(before.autofill === true, 'autofill should default on')
    const after = await win.evaluate(() => window.api.settings.update({ autofill: false }))
    assert(after.autofill === false, 'autofill should turn off')
  })

  await step('a saved login can be deleted, and all cleared', async () => {
    const [login] = await win.evaluate(() => window.api.passwords.list())
    await win.evaluate((id) => window.api.passwords.remove(id), login.id)
    assert((await win.evaluate(() => window.api.passwords.list())).length === 2, 'one login should be gone')
    await win.evaluate(() => window.api.passwords.clear())
    assert((await win.evaluate(() => window.api.passwords.list())).length === 0, 'all logins should be cleared')
  })

  await step('a saved address can be deleted, and all cleared', async () => {
    const [address] = await win.evaluate(() => window.api.addresses.list())
    await win.evaluate((id) => window.api.addresses.remove(id), address.id)
    assert((await win.evaluate(() => window.api.addresses.list())).length === 0, 'the address should be gone')
    await run('Default', { cookies: false, passwords: false, addresses: true, cards: false })
    await win.evaluate(() => window.api.addresses.clear())
    assert((await win.evaluate(() => window.api.addresses.list())).length === 0, 'all addresses should be cleared')
  })

  await step('a saved card can be deleted, and all cleared', async () => {
    const [card] = await win.evaluate(() => window.api.cards.list())
    await win.evaluate((id) => window.api.cards.remove(id), card.id)
    assert((await win.evaluate(() => window.api.cards.list())).length === 1, 'one card should be gone')
    await win.evaluate(() => window.api.cards.clear())
    assert((await win.evaluate(() => window.api.cards.list())).length === 0, 'all cards should be cleared')
  })
} finally {
  await app.close()
  site.close()
  fs.rmSync(support, { recursive: true, force: true })
  fs.rmSync(userDataDir, { recursive: true, force: true })
  if (failed) {
    console.error(logs.join(''))
    process.exit(1)
  }
}
