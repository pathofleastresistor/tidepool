import { describe, expect, it } from 'vitest'
import { completeAddress, type CompletionVisit } from './address-completion'

const now = Date.UTC(2026, 8, 27)
const DAY = 24 * 60 * 60 * 1000
const visit = (url: string, daysAgo = 0, projectId: string | null = null): CompletionVisit => ({ url, visitedAt: now - daysAgo * DAY, projectId })
const complete = (typed: string, visits: CompletionVisit[], projectId?: string): string | undefined => completeAddress(typed, visits, { now, projectId })

describe('completeAddress', () => {
  it('fills in the rest of a site you have been to', () => {
    expect(complete('gi', [visit('https://github.com/anthropics/claude-code')])).toBe('github.com')
  })

  it('reads hosts without www. unless you type it', () => {
    const visits = [visit('https://www.newsdaily.com/section/world')]
    expect(complete('ne', visits)).toBe('newsdaily.com')
    expect(complete('www.ne', visits)).toBe('www.newsdaily.com')
  })

  it('keeps what you typed as you typed it, scheme and case', () => {
    const visits = [visit('https://github.com/')]
    expect(complete('GI', visits)).toBe('GIthub.com')
    expect(complete('https://gi', visits)).toBe('https://github.com')
  })

  it('completes only the host until a path is started, then whole pages', () => {
    const visits = [visit('https://github.com/anthropics/claude-code?tab=readme'), visit('https://github.com/pulls')]
    expect(complete('github', visits)).toBe('github.com')
    expect(complete('github.com/an', visits)).toBe('github.com/anthropics/claude-code?tab=readme')
  })

  it('keeps ports, for local servers', () => {
    expect(complete('local', [visit('http://localhost:5173/app')])).toBe('localhost:5173')
  })

  it('prefers the site visited most, and recently', () => {
    const visits = [visit('https://gmail.com', 1), visit('https://github.com', 1), visit('https://github.com', 2)]
    expect(complete('g', visits)).toBe('github.com')
    // Many old visits lose to a few this week.
    const old = Array.from({ length: 5 }, () => visit('https://gitlab.com', 200))
    expect(complete('git', [...old, visit('https://github.com', 1)])).toBe('github.com')
  })

  it("counts the project you're in for more", () => {
    const visits = [visit('https://gmail.com', 1, 'home'), visit('https://github.com', 1, 'work')]
    expect(complete('g', visits, 'work')).toBe('github.com')
    expect(complete('g', visits, 'home')).toBe('gmail.com')
  })

  it("adds nothing once you've typed a site or page you've been to", () => {
    const visits = [visit('https://github.com'), visit('https://github.community'), visit('https://github.community')]
    expect(complete('github.com', visits)).toBeUndefined()
    const pages = [visit('http://127.0.0.1:5173/site'), visit('http://127.0.0.1:5173/site/page2'), visit('http://127.0.0.1:5173/site/page2')]
    expect(complete('http://127.0.0.1:5173/site', pages)).toBeUndefined()
  })

  it('leaves searches and non-web pages alone', () => {
    expect(complete('best running', [visit('https://bestrunning.com')])).toBeUndefined()
    expect(complete('', [visit('https://github.com')])).toBeUndefined()
    expect(complete('ab', [visit('about:blank')])).toBeUndefined()
    expect(complete('xy', [visit('https://github.com')])).toBeUndefined()
  })
})
