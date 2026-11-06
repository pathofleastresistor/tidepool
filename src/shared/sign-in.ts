/**
 * Google refuses sign-in from embedded browsers, however much they look like Chrome, and lands
 * on accounts.google.com/…/signin/rejected ("This browser or app may not be secure"). On that
 * page this returns where to go in the default browser instead: the site the sign-in was for,
 * found by following the continue= links out of accounts.google.com. Anywhere else, undefined.
 */
export function googleSignInRejected(url: string): string | undefined {
  let page: URL
  try {
    page = new URL(url)
  } catch {
    return undefined
  }
  if (page.hostname !== 'accounts.google.com' || !/\/signin\/rejected\b/.test(page.pathname)) return undefined
  let next = page.searchParams.get('continue')
  for (let hops = 0; next && hops < 5; hops++) {
    try {
      const target = new URL(next)
      if (target.protocol !== 'https:') break
      if (target.hostname !== 'accounts.google.com') return target.href
      next = target.searchParams.get('continue')
    } catch {
      break
    }
  }
  return 'https://accounts.google.com/'
}
