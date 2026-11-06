/** A past visit, as much of it as completion needs. */
export interface CompletionVisit {
  url: string
  visitedAt: number
  projectId: string | null
}

const DAY = 24 * 60 * 60 * 1000

/** What a visit counts for, by age: recent visits count most, old ones still a little. */
function recencyWeight(age: number): number {
  if (age < 4 * DAY) return 100
  if (age < 14 * DAY) return 70
  if (age < 31 * DAY) return 50
  if (age < 90 * DAY) return 30
  return 10
}

/** Visits in the project you're typing in count this much more than other projects'. */
const SAME_PROJECT = 1.5

/**
 * How a visited page reads in an address bar: host (with any port) then path and query, no
 * scheme or fragment, and no bare trailing slash.
 */
function forms(url: string): { host: string; page: string } | undefined {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return undefined
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
  const host = u.host.toLowerCase()
  const rest = `${u.pathname}${u.search}`
  return { host, page: rest === '/' ? host : `${host}${rest}` }
}

/**
 * What to fill in after `typed` in an address bar, from where you've been: the rest of the
 * address you most likely mean, or undefined. Only a site's host is completed, unless a path has
 * been started (`typed` has a /), since a whole page is rarely the one you're after. Among
 * matches, the one visited most often and most recently wins.
 */
export function completeAddress(typed: string, visits: CompletionVisit[], opts: { now: number; projectId?: string }): string | undefined {
  if (!typed || /\s/.test(typed)) return undefined
  // A scheme you typed stays as you typed it; what's after it is matched.
  const scheme = /^https?:\/\//i.exec(typed)?.[0] ?? ''
  const text = typed.slice(scheme.length).toLowerCase()
  if (!text) return undefined
  const byPath = text.includes('/')

  const scores = new Map<string, { score: number; last: number }>()
  for (const visit of visits) {
    const f = forms(visit.url)
    if (!f) continue
    // Typing "www." means you want it; otherwise hosts read without it.
    const bare = f.host.replace(/^www\./, '')
    const candidates = byPath ? [f.page, f.page.replace(/^www\./, '')] : [f.host, bare]
    const candidate = candidates.find((c) => c.toLowerCase().startsWith(text))
    if (!candidate) continue
    const weight = recencyWeight(opts.now - visit.visitedAt) * (opts.projectId && visit.projectId === opts.projectId ? SAME_PROJECT : 1)
    const seen = scores.get(candidate)
    scores.set(candidate, { score: (seen?.score ?? 0) + weight, last: Math.max(seen?.last ?? 0, visit.visitedAt) })
  }

  // Already all there (you've typed a site or page you've been to): nothing to add, even if
  // somewhere longer is visited more.
  if ([...scores.keys()].some((c) => c.length === text.length)) return undefined
  let best: [string, { score: number; last: number }] | undefined
  for (const entry of scores) {
    if (!best || entry[1].score > best[1].score || (entry[1].score === best[1].score && entry[1].last > best[1].last)) best = entry
  }
  // What you typed keeps its case; only the rest comes from history.
  return best && typed + best[0].slice(text.length)
}
