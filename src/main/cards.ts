import { safeStorage } from 'electron'
import type { CardFill, CardOffer, SavedCard } from '@shared/types'
import type { ImportedCard } from './browser-import'
import type { CardRow, Store } from './store'
import { confirmOwner } from './touch-id'

/**
 * The saved-card store behind card autofill. Like passwords (main/passwords.ts), the number and
 * security code are encrypted with the OS keychain via Electron safeStorage and only decrypted to
 * fill a form, after Touch ID. The settings list and the fill chip only ever see the network, the
 * last four digits and the expiry.
 */
export class Cards {
  constructor(private store: Store) {}

  /** Stores imported cards, encrypting each number and code. Returns how many were saved. */
  save(cards: ImportedCard[]): number {
    if (!cards.length) return 0
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Encrypted storage is unavailable, so cards cannot be saved safely.')
    }
    const rows = cards.map((c) => ({
      sourceKey: c.key,
      nameOnCard: c.nameOnCard,
      nickname: c.nickname,
      network: cardNetwork(c.number),
      lastFour: c.number.slice(-4),
      expMonth: c.expMonth,
      expYear: c.expYear,
      numberEnc: safeStorage.encryptString(c.number),
      cvcEnc: c.cvc ? safeStorage.encryptString(c.cvc) : null,
      source: c.source ?? null
    }))
    this.store.upsertCards(rows)
    return rows.length
  }

  /** Every saved card's metadata for the settings list; never the number or code. */
  list(): SavedCard[] {
    return this.store.listCards().map(toSavedCard)
  }

  /** Cards to offer on a payment form, unexpired ones only. */
  offers(): CardOffer[] {
    const now = new Date()
    return this.list()
      .filter((c) => !c.expYear || c.expYear > now.getFullYear() || (c.expYear === now.getFullYear() && c.expMonth >= now.getMonth() + 1))
      .map((c) => ({ id: c.id, label: cardLabel(c) }))
  }

  remove(id: number): void {
    this.store.deleteCard(id)
  }

  clear(): void {
    this.store.clearCards()
  }

  /** The full card for filling a form — gated behind Touch ID. Throws if the user cancels. */
  async reveal(id: number, host: string): Promise<CardFill> {
    const row = this.store.getCard(id)
    if (!row) throw new Error('That saved card no longer exists.')
    await confirmOwner(`fill your ${cardLabel(toSavedCard(row))} on ${host}`)
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Encrypted storage is unavailable on this device.')
    return {
      number: safeStorage.decryptString(Buffer.from(row.numberEnc)),
      nameOnCard: row.nameOnCard,
      expMonth: row.expMonth,
      expYear: row.expYear,
      cvc: row.cvcEnc ? safeStorage.decryptString(Buffer.from(row.cvcEnc)) : ''
    }
  }
}

function toSavedCard(r: CardRow): SavedCard {
  return {
    id: r.id,
    nameOnCard: r.nameOnCard,
    nickname: r.nickname,
    network: r.network,
    lastFour: r.lastFour,
    expMonth: r.expMonth,
    expYear: r.expYear,
    hasCvc: Boolean(r.cvcEnc),
    source: r.source ?? undefined,
    importedAt: r.importedAt
  }
}

/** "Visa •••• 4242", or the card's nickname when it has one. */
export const cardLabel = (c: Pick<SavedCard, 'nickname' | 'network' | 'lastFour'>): string =>
  `${c.nickname || c.network} •••• ${c.lastFour}`

/** The card network from the number's leading digits (the IIN ranges the networks publish). */
export function cardNetwork(number: string): string {
  if (/^4/.test(number)) return 'Visa'
  if (/^(5[1-5]|2[2-7])/.test(number)) return 'Mastercard'
  if (/^3[47]/.test(number)) return 'Amex'
  if (/^(6011|65|64[4-9])/.test(number)) return 'Discover'
  return 'Card'
}
