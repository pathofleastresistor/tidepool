import type { AddressFields } from './types'

/** A one-line name for a saved address, like "Amit Varia · 12 Main St": who, then where. */
export function addressLabel(a: AddressFields): string {
  const who = a.name || a.organization || a.email
  const where = a.line1 || a.city || a.phone
  return [who, where].filter(Boolean).join(' · ') || 'Saved address'
}
