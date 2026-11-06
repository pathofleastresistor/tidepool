import { describe, expect, it } from 'vitest'
import { belongsTo, groupSites, originsFor, parseSite, siteOf } from './site-data'

describe('siteOf', () => {
  it('groups subdomains under the registrable domain', () => {
    expect(siteOf('accounts.google.com')).toBe('google.com')
    expect(siteOf('.mail.google.com')).toBe('google.com')
    expect(siteOf('github.com')).toBe('github.com')
  })

  it('keeps a country second level with the name before it', () => {
    expect(siteOf('www.bbc.co.uk')).toBe('bbc.co.uk')
    expect(siteOf('shop.abc.net.au')).toBe('abc.net.au')
    expect(siteOf('news.example.de')).toBe('example.de')
  })

  it('treats each subdomain of a shared host as its own site', () => {
    expect(siteOf('alice.github.io')).toBe('alice.github.io')
    expect(siteOf('docs.my-app.vercel.app')).toBe('my-app.vercel.app')
  })

  it('leaves addresses and single-label hosts alone', () => {
    expect(siteOf('127.0.0.1')).toBe('127.0.0.1')
    expect(siteOf('localhost')).toBe('localhost')
  })
})

describe('belongsTo', () => {
  it('matches the site and its subdomains, not lookalikes', () => {
    expect(belongsTo('.google.com', 'google.com')).toBe(true)
    expect(belongsTo('mail.google.com', 'google.com')).toBe(true)
    expect(belongsTo('notgoogle.com', 'google.com')).toBe(false)
  })
})

describe('groupSites', () => {
  it('counts cookies per site, the most first', () => {
    expect(groupSites(['.google.com', 'accounts.google.com', 'github.com', '.youtube.com', 'www.youtube.com', 'm.youtube.com'])).toEqual([
      { site: 'youtube.com', cookies: 3 },
      { site: 'google.com', cookies: 2 },
      { site: 'github.com', cookies: 1 }
    ])
  })
})

describe('parseSite', () => {
  it('reads a typed address or host as its site', () => {
    expect(parseSite('https://www.Example.com/path?q=1')).toBe('example.com')
    expect(parseSite(' mail.google.com ')).toBe('google.com')
    expect(parseSite('localhost')).toBe('localhost')
  })

  it('refuses what is not a host', () => {
    expect(parseSite('')).toBeUndefined()
    expect(parseSite('hello world')).toBeUndefined()
    expect(parseSite('google')).toBeUndefined()
  })
})

describe('originsFor', () => {
  it('keeps the port of an origin the site was visited at', () => {
    expect(originsFor('localhost', [], ['http://localhost:5173/app', 'https://example.com/'])).toEqual([
      'http://localhost:5173',
      'https://localhost',
      'http://localhost'
    ])
  })

  it('names every known host of the site over both schemes', () => {
    expect(originsFor('google.com', ['mail.google.com', 'github.com', '.accounts.google.com'])).toEqual([
      'https://google.com',
      'http://google.com',
      'https://www.google.com',
      'http://www.google.com',
      'https://mail.google.com',
      'http://mail.google.com',
      'https://accounts.google.com',
      'http://accounts.google.com'
    ])
  })
})
