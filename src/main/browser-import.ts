import { execFileSync } from 'node:child_process'
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { app, type Session } from 'electron'
import type { AddressFields, DetectedBrowser, ImportKinds, ImportResult } from '@shared/types'

/**
 * Migrating cookies, saved logins, addresses and payment cards out of the user's existing browser
 * into Tidepool's own web profile — the same "import from Chrome" that Edge, Brave, Arc and Vivaldi
 * ship. It reads one profile's on-disk stores (all Chromium browsers share the format) and decrypts them with that
 * browser's key from the login Keychain, which macOS gates behind the user's approval.
 *
 * macOS only for now. It cannot carry over sessions a site has bound to the source browser with
 * Device-Bound Session Credentials (Google, from Chrome 147): those cookies are tied to that
 * browser's Secure Enclave key and are dead once copied, so for such sites the user signs in
 * afresh in Tidepool (the in-app Google sign-in already works). Everything else transfers.
 */

interface Candidate {
  id: string
  /** Matched against the OS default-browser name, and shown in the UI. */
  name: string
  /** Under ~/Library/Application Support. */
  dir: string
  /** The login-Keychain item holding this browser's storage key ("<Name> Safe Storage"). */
  keychainService: string
}

const CANDIDATES: Candidate[] = [
  { id: 'chrome', name: 'Google Chrome', dir: 'Google/Chrome', keychainService: 'Chrome Safe Storage' },
  { id: 'brave', name: 'Brave', dir: 'BraveSoftware/Brave-Browser', keychainService: 'Brave Safe Storage' },
  { id: 'edge', name: 'Microsoft Edge', dir: 'Microsoft Edge', keychainService: 'Microsoft Edge Safe Storage' },
  { id: 'arc', name: 'Arc', dir: 'Arc/User Data', keychainService: 'Arc' },
  { id: 'vivaldi', name: 'Vivaldi', dir: 'Vivaldi', keychainService: 'Vivaldi Safe Storage' },
  { id: 'opera', name: 'Opera', dir: 'com.operasoftware.Opera', keychainService: 'Opera Safe Storage' },
  { id: 'chromium', name: 'Chromium', dir: 'Chromium', keychainService: 'Chromium Safe Storage' }
]

/**
 * The browsers to look at. Tests set TIDEPOOL_IMPORT_DIR to a temp folder standing in for
 * ~/Library/Application Support and get an extra "Test Browser" candidate there, so the import
 * path can be exercised without a real browser profile or the Keychain.
 */
function candidates(): Candidate[] {
  if (process.env.TIDEPOOL_IMPORT_DIR) {
    return [...CANDIDATES, { id: 'testbrowser', name: 'Test Browser', dir: 'TestBrowser', keychainService: 'Test Browser Safe Storage' }]
  }
  return CANDIDATES
}

const supportBase = (): string => process.env.TIDEPOOL_IMPORT_DIR || join(homedir(), 'Library', 'Application Support')

const supportPath = (dir: string): string => join(supportBase(), dir)

interface Profile {
  /** The folder under the browser's data folder: "Default", "Profile 4". */
  dir: string
  /** The name the browser shows for it, from its Local State. */
  name?: string
}

/**
 * The browser's profiles, the one used last first. Chromium lists them in Local State's
 * profile.info_cache; we also pick up Default and any "Profile N" folder in case that file is
 * missing or stale. Only folders that exist are returned.
 */
function profilesOf(c: Candidate): Profile[] {
  const base = supportPath(c.dir)
  let info: Record<string, { name?: unknown }> = {}
  let lastUsed = ''
  try {
    const state = JSON.parse(readFileSync(join(base, 'Local State'), 'utf8'))
    if (state?.profile?.info_cache && typeof state.profile.info_cache === 'object') info = state.profile.info_cache
    if (typeof state?.profile?.last_used === 'string') lastUsed = state.profile.last_used
  } catch {
    // No Local State (or unreadable); fall back to the folders on disk.
  }
  const dirs = new Set<string>(['Default', ...Object.keys(info)])
  try {
    for (const d of readdirSync(base)) if (/^Profile \d+$/.test(d)) dirs.add(d)
  } catch {
    return []
  }
  const order = (d: string): number => (d === lastUsed ? -2 : d === 'Default' ? -1 : Number(d.replace(/\D/g, '')) || 0)
  return [...dirs]
    .filter((d) => isProfileDir(d) && existsSync(join(base, d)))
    .sort((a, b) => order(a) - order(b))
    .map((dir) => ({ dir, name: typeof info[dir]?.name === 'string' ? (info[dir].name as string) : undefined }))
}

/** A user profile folder (not Guest or System), and a name that's safe to join onto a path. */
const isProfileDir = (d: string): boolean => /^(Default|Profile \d+)$/.test(d)

/** Chromium moved the cookie DB under Network/ a few years ago; older profiles keep it at the root. */
function cookieDbPath(profile: string): string | undefined {
  for (const p of [join(profile, 'Network', 'Cookies'), join(profile, 'Cookies')]) if (existsSync(p)) return p
  return undefined
}

/**
 * The saved-login stores, account first. Chrome keeps passwords saved to the user's Google
 * account (Google Password Manager, the default since 2024) in "Login Data For Account", and only
 * on-device ones in "Login Data" — which is often empty. Both share one layout and one key.
 */
function loginDbPaths(profile: string): string[] {
  return ['Login Data For Account', 'Login Data'].map((f) => join(profile, f)).filter((p) => existsSync(p))
}

function webDataPath(profile: string): string | undefined {
  const p = join(profile, 'Web Data')
  return existsSync(p) ? p : undefined
}

/** A count from a copy of a browser DB, or 0 when the table isn't there (an older or newer schema). */
function countRows(dbPath: string, sql: string): number {
  try {
    return withDbCopy(dbPath, (db) => Number((db.prepare(sql).get() as { n: number | bigint }).n) || 0)
  } catch {
    return 0
  }
}

/** The browsers' profiles we can find, the OS's default browser first so the UI can lead with it. */
export function detectBrowsers(): DetectedBrowser[] {
  if (process.platform !== 'darwin' && !process.env.TIDEPOOL_IMPORT_DIR) return []
  let defaultName = ''
  try {
    defaultName = app.getApplicationNameForProtocol('https://example.com') || ''
  } catch {
    // No default handler resolvable; nothing to flag.
  }
  const found: DetectedBrowser[] = []
  for (const c of candidates()) {
    for (const p of profilesOf(c)) {
      const profile = join(supportPath(c.dir), p.dir)
      const web = webDataPath(profile)
      found.push({
        id: c.id,
        name: c.name,
        profile: p.dir,
        profileName: p.name,
        isDefault: defaultName.toLowerCase().includes(c.name.toLowerCase()),
        hasCookies: Boolean(cookieDbPath(profile)),
        passwordCount: loginDbPaths(profile).reduce(
          (n, db) => n + countRows(db, 'SELECT count(*) AS n FROM logins WHERE length(password_value) > 0'),
          0
        ),
        addressCount: web ? countAddresses(web) : 0,
        cardCount: web ? countCards(web) : 0
      })
    }
  }
  // Default browser first, then the rest in their listed order (a stable sort keeps profile order).
  return found.sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
}

// MARK: - Decryption

/**
 * The AES key Chromium derives from its Keychain secret: PBKDF2-SHA1 over the secret with the
 * fixed "saltysalt" salt and 1003 iterations, to 16 bytes (documented in Chromium's
 * os_crypt_mac.mm). The same key decrypts both cookies and saved passwords.
 */
function deriveKey(secret: string): Buffer {
  return pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1')
}

/** The browser's storage secret from the login Keychain; prompts the user for access on macOS. */
function keychainSecret(service: string): string | undefined {
  if (process.env.TIDEPOOL_IMPORT_KEY) return process.env.TIDEPOOL_IMPORT_KEY
  try {
    return execFileSync('security', ['find-generic-password', '-w', '-s', service], { encoding: 'utf8' }).trim()
  } catch {
    return undefined
  }
}

/**
 * Decrypts one stored value. macOS values are AES-128-CBC with a fixed all-spaces IV, tagged with
 * a "v10" version prefix. Anything without that prefix is left alone (older plaintext, or a value
 * this key can't open). Returns raw bytes; callers strip any leading domain hash.
 */
function decryptValue(key: Buffer, blob: Uint8Array): Buffer | undefined {
  const enc = Buffer.from(blob)
  const version = enc.subarray(0, 3).toString('latin1')
  if (version !== 'v10' && version !== 'v11') return undefined
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
    return Buffer.concat([decipher.update(enc.subarray(3)), decipher.final()])
  } catch {
    return undefined
  }
}

/**
 * Reads a copy of a locked SQLite store. The browser keeps its DBs open, so we copy the file to a
 * temp path (leaving the original untouched) and read that, then delete the copy.
 */
function withDbCopy<T>(src: string, fn: (db: DatabaseSync) => T): T {
  const tmp = join(tmpdir(), `tidepool-import-${randomUUID().slice(0, 8)}.sqlite`)
  copyFileSync(src, tmp)
  const db = new DatabaseSync(tmp)
  try {
    return fn(db)
  } finally {
    db.close()
    try {
      rmSync(tmp, { force: true })
    } catch {
      // Best effort; it's in the OS temp dir.
    }
  }
}

// MARK: - Cookies

const CHROME_EPOCH_OFFSET_SEC = 11644473600 // seconds between 1601-01-01 and the UNIX epoch

interface CookieRow {
  host_key: string
  name: string
  encrypted_value: Uint8Array
  path: string
  // Integer columns are read as BigInt: expires_utc (microseconds since 1601) overflows a JS number.
  expires_utc: bigint
  is_secure: bigint
  is_httponly: bigint
  samesite: bigint
}

/** Chromium's samesite ints → Electron's cookie sameSite. no_restriction needs a secure cookie. */
function sameSite(value: number, secure: boolean): 'unspecified' | 'no_restriction' | 'lax' | 'strict' {
  if (value === 2) return 'strict'
  if (value === 1) return 'lax'
  if (value === 0) return secure ? 'no_restriction' : 'unspecified'
  return 'unspecified'
}

async function importCookies(profile: string, key: Buffer, ses: Session): Promise<number> {
  const dbPath = cookieDbPath(profile)
  if (!dbPath) return 0
  const rows = withDbCopy(dbPath, (db) => {
    const stmt = db.prepare(
      `SELECT host_key, name, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies`
    )
    // expires_utc (microseconds since 1601) can exceed a JS number, so read integers as BigInt.
    stmt.setReadBigInts(true)
    return stmt.all() as unknown as CookieRow[]
  })
  let imported = 0
  for (const row of rows) {
    let value = decryptValue(key, row.encrypted_value)
    if (!value) continue
    // Recent Chromium prepends SHA-256(host_key) to the plaintext; drop it when it's there.
    if (value.length >= 32 && value.subarray(0, 32).equals(createHash('sha256').update(row.host_key).digest())) {
      value = value.subarray(32)
    }
    const host = row.host_key.replace(/^\./, '')
    const secure = row.is_secure === 1n
    const expiresUtc = Number(row.expires_utc)
    try {
      await ses.cookies.set({
        url: `${secure ? 'https' : 'http'}://${host}${row.path || '/'}`,
        name: row.name,
        value: value.toString('utf8'),
        // __Host- cookies must have no domain; others take the stored domain (leading dot and all).
        domain: row.name.startsWith('__Host-') ? undefined : row.host_key,
        path: row.path || '/',
        secure,
        httpOnly: row.is_httponly === 1n,
        sameSite: sameSite(Number(row.samesite), secure),
        expirationDate: expiresUtc > 0 ? expiresUtc / 1e6 - CHROME_EPOCH_OFFSET_SEC : undefined
      })
      imported++
    } catch {
      // A cookie Electron won't accept (prefix rules, an already-expired date); skip it.
    }
  }
  return imported
}

// MARK: - Saved logins

interface LoginRow {
  origin_url: string
  username_value: string
  password_value: Uint8Array
}

export interface ImportedCredential {
  origin: string
  host: string
  /** Empty for a password saved without a username; autofill then fills just the password. */
  username: string
  password: string
  /** The browser it came from, kept so the settings list can show its origin. */
  source?: string
}

/**
 * Every saved login in the profile, from both stores, account copies winning where the same login
 * is in both. Logins for apps (android://…) and ones whose password won't decrypt are counted as
 * skipped; "never save for this site" entries have no password and aren't logins at all.
 */
function readLogins(profile: string, key: Buffer): { credentials: ImportedCredential[]; skipped: number } {
  const seen = new Set<string>()
  const credentials: ImportedCredential[] = []
  let skipped = 0
  for (const dbPath of loginDbPaths(profile)) {
    const rows = withDbCopy(dbPath, (db) =>
      db
        .prepare(`SELECT origin_url, username_value, password_value FROM logins WHERE length(password_value) > 0`)
        .all() as unknown as LoginRow[]
    )
    for (const row of rows) {
      let url: URL
      try {
        url = new URL(row.origin_url)
      } catch {
        skipped++
        continue
      }
      const password = decryptValue(key, row.password_value)?.toString('utf8')
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !url.hostname || !password) {
        skipped++
        continue
      }
      const username = row.username_value ?? ''
      const id = `${row.origin_url}\n${username}`
      if (seen.has(id)) continue
      seen.add(id)
      credentials.push({ origin: row.origin_url, host: url.hostname, username, password })
    }
  }
  return { credentials, skipped }
}

// MARK: - Addresses

/**
 * Where a Chromium version keeps saved addresses: one row per address, and its parts as typed
 * tokens beside it. Current Chrome uses addresses/address_type_tokens; 2023–24 builds split
 * on-device and account addresses into local_addresses and contact_info. Tried in order; all that
 * exist are read. Addresses aren't encrypted by the browser, so they don't need the Keychain key.
 */
const ADDRESS_TABLES = [
  ['addresses', 'address_type_tokens'],
  ['local_addresses', 'local_addresses_type_tokens'],
  ['contact_info', 'contact_info_type_tokens']
] as const

/** Chromium's FieldType numbers (components/autofill/core/browser/field_types.h) for what we fill. */
const FIELD_TYPES: Record<number, keyof AddressFields> = {
  3: 'givenName',
  5: 'familyName',
  7: 'name',
  9: 'email',
  14: 'phone',
  30: 'line1',
  31: 'line2',
  33: 'city',
  34: 'state',
  35: 'postalCode',
  36: 'country',
  60: 'organization',
  77: 'street'
}

export interface ImportedAddress {
  /** The source browser's id for the address, so re-importing updates it in place. */
  key: string
  fields: AddressFields
  source?: string
}

const emptyAddress = (): AddressFields => ({
  name: '',
  givenName: '',
  familyName: '',
  organization: '',
  street: '',
  line1: '',
  line2: '',
  city: '',
  state: '',
  postalCode: '',
  country: '',
  email: '',
  phone: ''
})

function countAddresses(webData: string): number {
  return ADDRESS_TABLES.reduce((n, [table]) => n + countRows(webData, `SELECT count(*) AS n FROM ${table}`), 0)
}

function readAddresses(profile: string): ImportedAddress[] {
  const webData = webDataPath(profile)
  if (!webData) return []
  const byGuid = new Map<string, AddressFields>()
  withDbCopy(webData, (db) => {
    for (const [table, tokens] of ADDRESS_TABLES) {
      let rows: { guid: string; type: number; value: string }[]
      try {
        rows = db
          .prepare(`SELECT t.guid AS guid, t.type AS type, t.value AS value FROM ${tokens} t JOIN ${table} a ON a.guid = t.guid`)
          .all() as unknown as typeof rows
      } catch {
        continue // Not this Chromium version's layout.
      }
      for (const row of rows) {
        const field = FIELD_TYPES[Number(row.type)]
        const value = typeof row.value === 'string' ? row.value.trim() : ''
        if (!field || !value) continue
        const address = byGuid.get(row.guid) ?? emptyAddress()
        address[field] = value
        byGuid.set(row.guid, address)
      }
    }
  })
  const addresses: ImportedAddress[] = []
  for (const [guid, a] of byGuid) {
    // Fill in the forms a page might ask for from the ones the browser stored.
    if (!a.name) a.name = [a.givenName, a.familyName].filter(Boolean).join(' ')
    if (a.name && !a.givenName && !a.familyName) {
      const i = a.name.lastIndexOf(' ')
      if (i > 0) [a.givenName, a.familyName] = [a.name.slice(0, i), a.name.slice(i + 1)]
      else a.givenName = a.name
    }
    if (!a.street) a.street = [a.line1, a.line2].filter(Boolean).join('\n')
    if (!a.line1 && a.street) {
      const [first, ...rest] = a.street.split('\n')
      a.line1 = first
      if (!a.line2) a.line2 = rest.join(', ')
    }
    if (!a.name && !a.street && !a.email && !a.phone) continue
    addresses.push({ key: guid, fields: a })
  }
  return addresses
}

// MARK: - Payment cards

export interface ImportedCard {
  /** The source browser's id for the card, so re-importing updates it in place. */
  key: string
  nameOnCard: string
  nickname: string
  number: string
  expMonth: number
  expYear: number
  /** Only there if the user let the browser keep it. */
  cvc: string
  source?: string
}

/** Cards saved on this device. Their numbers (and codes, if kept) use the same key as passwords. */
function countCards(webData: string): number {
  return countRows(webData, 'SELECT count(*) AS n FROM credit_cards WHERE length(card_number_encrypted) > 0')
}

/**
 * The profile's on-device cards, decrypted. Google Pay cards (masked_credit_cards) only have their
 * last four digits on disk — the full number stays on Google's servers — so they're counted as
 * skipped rather than imported.
 */
function readCards(profile: string, key: Buffer): { cards: ImportedCard[]; skipped: number } {
  const webData = webDataPath(profile)
  if (!webData) return { cards: [], skipped: 0 }
  const skippedServer = countRows(webData, 'SELECT count(*) AS n FROM masked_credit_cards')
  const rows = withDbCopy(webData, (db) => {
    const cvcs = new Map<string, Uint8Array | string>()
    try {
      const stored = db.prepare('SELECT guid, value_encrypted FROM local_stored_cvc').all() as unknown as {
        guid: string
        value_encrypted: Uint8Array | string
      }[]
      for (const r of stored) cvcs.set(r.guid, r.value_encrypted)
    } catch {
      // Older Chromium, from before it could keep security codes.
    }
    try {
      return (
        db
          .prepare(
            `SELECT guid, name_on_card, nickname, expiration_month, expiration_year, card_number_encrypted
             FROM credit_cards WHERE length(card_number_encrypted) > 0`
          )
          .all() as unknown as {
          guid: string
          name_on_card: string | null
          nickname: string | null
          expiration_month: number
          expiration_year: number
          card_number_encrypted: Uint8Array
        }[]
      ).map((r) => ({ ...r, cvc: cvcs.get(r.guid) }))
    } catch {
      return []
    }
  })
  const cards: ImportedCard[] = []
  let skipped = skippedServer
  for (const r of rows) {
    const number = decryptValue(key, r.card_number_encrypted)?.toString('utf8').replace(/\D/g, '')
    if (!number || number.length < 12) {
      skipped++
      continue
    }
    // The code column is declared text but holds the encrypted bytes; accept either.
    const cvcBlob = typeof r.cvc === 'string' ? Buffer.from(r.cvc, 'latin1') : r.cvc
    const cvc = cvcBlob ? (decryptValue(key, cvcBlob)?.toString('utf8') ?? '') : ''
    cards.push({
      key: r.guid,
      nameOnCard: r.name_on_card ?? '',
      nickname: r.nickname ?? '',
      number,
      expMonth: Number(r.expiration_month) || 0,
      expYear: Number(r.expiration_year) || 0,
      cvc: /^\d{3,4}$/.test(cvc) ? cvc : ''
    })
  }
  return { cards, skipped }
}

// MARK: - Entry point

/**
 * Imports the chosen kinds from one profile of a detected browser. Cookies go straight into the
 * given web session; logins, addresses and cards are handed back for the caller to store
 * (passwords and card numbers encrypted — they never touch disk in the clear).
 */
export async function importFromBrowser(
  browserId: string,
  profileDir: string,
  kinds: ImportKinds,
  ses: Session
): Promise<{
  result: ImportResult
  credentials: ImportedCredential[]
  addresses: ImportedAddress[]
  cards: ImportedCard[]
}> {
  const candidate = candidates().find((c) => c.id === browserId)
  if (!candidate) throw new Error(`Unknown browser: ${browserId}`)
  const found = profilesOf(candidate).find((p) => p.dir === profileDir)
  if (!found) throw new Error(`${candidate.name} has no profile "${profileDir}" to import.`)
  const profile = join(supportPath(candidate.dir), found.dir)
  const source = found.name ? `${candidate.name} (${found.name})` : candidate.name

  const result: ImportResult = {
    browserId,
    profile: found.dir,
    cookies: 0,
    passwords: 0,
    passwordsSkipped: 0,
    addresses: 0,
    cards: 0,
    cardsSkipped: 0
  }
  const credentials: ImportedCredential[] = []
  const addresses: ImportedAddress[] = []
  const cards: ImportedCard[] = []

  // Cookies, passwords and card numbers are encrypted with the browser's key; addresses aren't.
  if (kinds.cookies || kinds.passwords || kinds.cards) {
    const secret = keychainSecret(candidate.keychainService)
    if (!secret) {
      throw new Error(
        `Couldn't read ${candidate.name}'s encryption key from the Keychain. ` +
          'Approve the access prompt (Tidepool needs it to read the saved data), then try again.'
      )
    }
    const key = deriveKey(secret)
    if (kinds.cookies) result.cookies = await importCookies(profile, key, ses)
    if (kinds.passwords) {
      const logins = readLogins(profile, key)
      for (const c of logins.credentials) credentials.push({ ...c, source })
      result.passwords = credentials.length
      result.passwordsSkipped = logins.skipped
    }
    if (kinds.cards) {
      const read = readCards(profile, key)
      for (const c of read.cards) cards.push({ ...c, source })
      result.cards = cards.length
      result.cardsSkipped = read.skipped
    }
  }
  if (kinds.addresses) {
    for (const a of readAddresses(profile)) addresses.push({ ...a, source })
    result.addresses = addresses.length
  }
  return { result, credentials, addresses, cards }
}
