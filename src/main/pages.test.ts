import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pageSlug, pageUrl, Pages, parsePageUrl, titleOf } from './pages'

describe('pageSlug', () => {
  it('makes lowercase dashed names', () => {
    expect(pageSlug('Trip Plan: Lisbon 2026!')).toBe('trip-plan-lisbon-2026')
    expect(pageSlug('café-menu.html')).toBe('cafe-menu')
  })

  it('refuses names with nothing left', () => {
    expect(pageSlug('../..')).toBeUndefined()
    expect(pageSlug('   ')).toBeUndefined()
  })
})

describe('parsePageUrl', () => {
  it('reads back what pageUrl makes', () => {
    expect(parsePageUrl(pageUrl('a1b2c3d4', 'trip-plan'))).toEqual({ projectId: 'a1b2c3d4', name: 'trip-plan' })
  })

  it('refuses paths out of the folder and other schemes', () => {
    expect(parsePageUrl('tidepool-page://a1b2c3d4/..%2F..%2Fsettings')).toBeUndefined()
    expect(parsePageUrl('tidepool-page://a1b2c3d4/sub/page')).toBeUndefined()
    expect(parsePageUrl('https://a1b2c3d4/trip-plan')).toBeUndefined()
  })
})

describe('titleOf', () => {
  it('reads the title, entities and all', () => {
    expect(titleOf('<html><head><title>\n  Tom &amp; Jerry\n</title>')).toBe('Tom & Jerry')
    expect(titleOf('<p>no title</p>')).toBe('')
  })
})

describe('Pages', () => {
  let root: string
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('saves, lists, replaces and removes a project’s pages', () => {
    root = mkdtempSync(join(tmpdir(), 'pages-'))
    const changed: string[] = []
    const pages = new Pages(root, (id) => changed.push(id))
    const saved = pages.save('proj1', 'Trip Plan', '<!doctype html><title>Trip</title>')
    expect(saved).toMatchObject({ name: 'trip-plan', title: 'Trip', url: 'tidepool-page://proj1/trip-plan' })
    pages.save('proj1', 'trip-plan', '<!doctype html><title>Trip, again</title>')
    expect(pages.list('proj1').map((p) => p.title)).toEqual(['Trip, again'])
    expect(pages.list('other')).toEqual([])
    expect(pages.source('proj1', 'trip-plan')).toContain('again')
    pages.remove('proj1', 'trip-plan')
    expect(pages.list('proj1')).toEqual([])
    expect(changed).toEqual(['proj1', 'proj1', 'proj1'])
  })

  it('refuses a bad project id or a page too big', () => {
    root = mkdtempSync(join(tmpdir(), 'pages-'))
    const pages = new Pages(root, () => {})
    expect(() => pages.save('../x', 'a', '<html>')).toThrow()
    expect(() => pages.save('proj1', 'big', 'x'.repeat(2_000_001))).toThrow(/too big/)
  })
})
