import type { SiteData } from '@shared/types'

/** Second-level labels under a country code that are sold like top-level ones (bbc.co.uk, abc.net.au). */
const COUNTRY_SECOND_LEVELS = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ne', 'or', 'go', 'gob', 'nic'])
/** Hosting domains whose subdomains belong to different people, so each is a site of its own. */
const SHARED_HOSTS = new Set([
  'github.io',
  'gitlab.io',
  'pages.dev',
  'workers.dev',
  'vercel.app',
  'netlify.app',
  'herokuapp.com',
  'appspot.com',
  'web.app',
  'firebaseapp.com',
  'blogspot.com',
  'azurewebsites.net',
  'cloudfront.net'
])

const isIp = (host: string): boolean => /^\d+(\.\d+){3}$/.test(host) || host.includes(':')

/**
 * The site a host is part of, as Chrome groups them in its site settings: the registrable domain,
 * so accounts.google.com and mail.google.com are both google.com. Without the public suffix list
 * this is a close guess, which is enough for grouping and for picking what to clear.
 */
export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/^\.+/, '').replace(/\.$/, '')
  if (!h || isIp(h) || !h.includes('.')) return h
  const labels = h.split('.')
  const lastTwo = labels.slice(-2).join('.')
  let keep = 2
  if (SHARED_HOSTS.has(lastTwo)) keep = 3
  else if (labels.at(-1)!.length === 2 && COUNTRY_SECOND_LEVELS.has(labels.at(-2)!)) keep = 3
  return labels.slice(-keep).join('.')
}

/** Whether a host (or a cookie's domain, leading dot and all) is the site or under it. */
export function belongsTo(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/^\.+/, '')
  return h === site || h.endsWith(`.${site}`)
}

/** Every site that has cookies, with how many, the most first. */
export function groupSites(cookieDomains: string[]): SiteData[] {
  const counts = new Map<string, number>()
  for (const domain of cookieDomains) {
    const site = siteOf(domain)
    if (site) counts.set(site, (counts.get(site) ?? 0) + 1)
  }
  return [...counts]
    .map(([site, cookies]) => ({ site, cookies }))
    .sort((a, b) => b.cookies - a.cookies || a.site.localeCompare(b.site))
}

/**
 * What someone typed as a site ("https://www.Example.com/path", "example.com") as the site it
 * names, or undefined when it isn't a host at all.
 */
export function parseSite(typed: string): string | undefined {
  const text = typed.trim().toLowerCase()
  if (!text || /\s/.test(text)) return undefined
  let host: string
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`).hostname
  } catch {
    return undefined
  }
  if (host.startsWith('[')) return undefined
  if (!host.includes('.') && host !== 'localhost') return undefined
  return siteOf(host)
}

/**
 * The origins a site's storage and cache may be kept under: each origin it was visited at (port
 * and all), each host its cookies name over https and http, and the bare site and its www. twin.
 * Storage is kept per origin, so clearing needs each one by name.
 */
export function originsFor(site: string, hosts: Iterable<string>, urls: Iterable<string> = []): string[] {
  const all = new Set<string>()
  for (const url of urls) {
    try {
      const u = new URL(url)
      if ((u.protocol === 'https:' || u.protocol === 'http:') && belongsTo(u.hostname, site)) all.add(u.origin)
    } catch {
      // not an address
    }
  }
  for (const host of [site, ...(site.includes('.') ? [`www.${site}`] : []), ...hosts]) {
    const h = host.toLowerCase().replace(/^\.+/, '')
    if (belongsTo(h, site)) all.add(`https://${h}`).add(`http://${h}`)
  }
  return [...all]
}
