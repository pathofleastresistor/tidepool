import { safeStorage } from 'electron'
import type { AutofillMatch, SavedLogin } from '@shared/types'
import type { CredentialRow, Store } from './store'
import type { ImportedCredential } from './browser-import'
import { confirmOwner } from './touch-id'

/**
 * The saved-login store behind autofill. Passwords are encrypted with the OS keychain via Electron
 * safeStorage (the same protection as the API key) and only ever decrypted to fill a form, after
 * the user clears a Touch ID / password prompt. The renderer and the web preload only ever see
 * usernames and hosts through here; the password crosses the boundary once, at fill time.
 */
export class Passwords {
  constructor(private store: Store) {}

  private canEncrypt(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  /** Stores imported logins, encrypting each password. Returns how many were saved. */
  save(credentials: ImportedCredential[]): number {
    if (!credentials.length) return 0
    if (!this.canEncrypt()) throw new Error('Encrypted storage is unavailable, so passwords cannot be saved safely.')
    const rows = credentials
      .filter((c) => c.password)
      .map((c) => ({
        origin: c.origin,
        host: c.host.toLowerCase(),
        username: c.username,
        passwordEnc: safeStorage.encryptString(c.password),
        source: c.source
      }))
    this.store.upsertCredentials(rows)
    return rows.length
  }

  /** Every saved login's metadata for the settings list; never includes passwords. */
  list(): SavedLogin[] {
    return this.store.listCredentials().map(toSavedLogin)
  }

  remove(id: number): void {
    this.store.deleteCredential(id)
  }

  clear(): void {
    this.store.clearCredentials()
  }

  /**
   * Logins that could fill a form on `pageUrl`, most specific host first — usernames only, so the
   * page/preload can offer them without a password ever being decrypted. A saved login matches the
   * page's exact host or a parent domain of it (a login for example.com fills app.example.com).
   */
  matches(pageUrl: string): AutofillMatch[] {
    let host: string
    try {
      host = new URL(pageUrl).hostname.toLowerCase()
    } catch {
      return []
    }
    const rows = this.store.credentialsForHost(parentHosts(host))
    return rows.map((r) => ({ id: r.id, host: r.host, username: r.username }))
  }

  /**
   * The username and password for one saved login, for filling a form — gated behind the OS
   * biometric/password prompt. Throws if the user cancels or storage can't be decrypted.
   */
  async reveal(id: number, reason: string): Promise<{ username: string; password: string }> {
    const row = this.store.getCredential(id)
    if (!row) throw new Error('That saved login no longer exists.')
    await confirmOwner(reason)
    return { username: row.username, password: decryptPassword(row) }
  }
}

function toSavedLogin(r: CredentialRow): SavedLogin {
  return { id: r.id, origin: r.origin, host: r.host, username: r.username, source: r.source ?? undefined, importedAt: r.importedAt }
}

function decryptPassword(r: CredentialRow): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Encrypted storage is unavailable on this device.')
  return safeStorage.decryptString(Buffer.from(r.passwordEnc))
}

/** A host and each of its parent domains down to the registrable-ish level, e.g. app.example.com → [app.example.com, example.com]. */
function parentHosts(host: string): string[] {
  const parts = host.split('.')
  const hosts: string[] = []
  // Stop at two labels (example.com); we don't fill across a bare public suffix like ".com".
  for (let i = 0; i <= parts.length - 2; i++) hosts.push(parts.slice(i).join('.'))
  return hosts
}
