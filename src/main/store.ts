import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type Anthropic from '@anthropic-ai/sdk'
import type { ChatState } from '@shared/chat-state'
import type {
  AddressFields,
  ChatSearchHit,
  HistoryEntry,
  MemoryFile,
  MemorySuggestion,
  SavedAddress,
  ShoppingIdea,
  Skill,
  SkillDraft
} from '@shared/types'
import type { PageKind, PageTopic } from './jev'
import { completeAddress, type CompletionVisit } from './address-completion'

type MessageParam = Anthropic.Beta.BetaMessageParam

/** A conversation as stored; `busy` is added by whoever knows which ones are running. */
export interface ConversationRow {
  id: string
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
}

/** What Jev made of a page, and numbers from its structured data (see main/page-facts.ts). */
export interface PageFactsRow {
  url: string
  host: string
  kind: PageKind
  topic: PageTopic
  store: boolean
  summarizable: boolean
  price: number | null
  currency: string | null
  inStock: boolean | null
  rating: number | null
  classifiedAt: number
}

/** A saved login as stored; passwordEnc is the safeStorage-encrypted password (see main/passwords.ts). */
export interface CredentialRow {
  id: number
  origin: string
  host: string
  username: string
  passwordEnc: Uint8Array
  source: string | null
  importedAt: number
}

/** A saved card as stored; numberEnc/cvcEnc are safeStorage-encrypted (see main/cards.ts). */
export interface CardRow {
  id: number
  sourceKey: string
  nameOnCard: string
  nickname: string
  network: string
  lastFour: string
  expMonth: number
  expYear: number
  numberEnc: Uint8Array
  cvcEnc: Uint8Array | null
  source: string | null
  importedAt: number
}

/** Each step brings the schema from the version before it to its own; they run in order. */
const MIGRATIONS = [
  // 1: chats
  `CREATE TABLE IF NOT EXISTS conversations (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     transcript TEXT NOT NULL DEFAULT '{"items":[],"busy":false}'
   );
   CREATE INDEX IF NOT EXISTS conversations_by_project ON conversations (project_id, updated_at DESC);
   CREATE TABLE IF NOT EXISTS messages (
     conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     message TEXT NOT NULL,
     PRIMARY KEY (conversation_id, seq)
   );
   CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5 (
     text, conversation_id UNINDEXED, role UNINDEXED, created_at UNINDEXED
   );`,
  // 2: browsing history and memory
  `CREATE TABLE visits (
     id INTEGER PRIMARY KEY,
     url TEXT NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     visited_at INTEGER NOT NULL,
     project_id TEXT,
     site_name TEXT
   );
   CREATE INDEX visits_by_time ON visits (visited_at DESC);
   CREATE INDEX visits_by_project ON visits (project_id, visited_at DESC);
   CREATE VIRTUAL TABLE visit_search USING fts5 (title, url, content = 'visits', content_rowid = 'id');
   CREATE TRIGGER visits_ai AFTER INSERT ON visits BEGIN
     INSERT INTO visit_search (rowid, title, url) VALUES (new.id, new.title, new.url);
   END;
   CREATE TRIGGER visits_ad AFTER DELETE ON visits BEGIN
     INSERT INTO visit_search (visit_search, rowid, title, url) VALUES ('delete', old.id, old.title, old.url);
   END;
   CREATE TRIGGER visits_au AFTER UPDATE ON visits BEGIN
     INSERT INTO visit_search (visit_search, rowid, title, url) VALUES ('delete', old.id, old.title, old.url);
     INSERT INTO visit_search (rowid, title, url) VALUES (new.id, new.title, new.url);
   END;
   CREATE TABLE memories (
     project_id TEXT NOT NULL,
     path TEXT NOT NULL,
     content TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (project_id, path)
   );`,
  // 3: memory suggested from browsing, and where each project's last look at its browsing ended
  `CREATE TABLE memory_suggestions (
     id INTEGER PRIMARY KEY,
     project_id TEXT NOT NULL,
     path TEXT NOT NULL,
     text TEXT NOT NULL,
     reason TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'pending',
     created_at INTEGER NOT NULL
   );
   CREATE INDEX memory_suggestions_by_project ON memory_suggestions (project_id, status, created_at DESC);
   CREATE TABLE memory_suggestion_runs (
     project_id TEXT PRIMARY KEY,
     ran_at INTEGER NOT NULL,
     last_visit_id INTEGER NOT NULL
   );`,
  // 4: saved logins imported from another browser, for autofill. password_enc is the password
  // encrypted with the OS keychain via Electron safeStorage (see main/passwords.ts); the plaintext
  // password is never stored. host is the registrable-ish host used to match a page to a login.
  `CREATE TABLE credentials (
     id INTEGER PRIMARY KEY,
     origin TEXT NOT NULL,
     host TEXT NOT NULL,
     username TEXT NOT NULL,
     password_enc BLOB NOT NULL,
     source TEXT,
     imported_at INTEGER NOT NULL,
     UNIQUE (origin, username)
   );
   CREATE INDEX credentials_by_host ON credentials (host);`,
  // 5: what Jev made of pages the user looked at. Every column is a label from our own lists
  // (main/jev.ts) or a number checked on the way in, never text from the page, so nothing built
  // from it can carry a page's instructions.
  `CREATE TABLE page_facts (
     url TEXT PRIMARY KEY,
     host TEXT NOT NULL,
     kind TEXT NOT NULL,
     topic TEXT NOT NULL,
     store INTEGER NOT NULL,
     summarizable INTEGER NOT NULL,
     price REAL,
     currency TEXT,
     in_stock INTEGER,
     rating REAL,
     classified_at INTEGER NOT NULL
   );
   CREATE INDEX page_facts_by_host ON page_facts (host);`,
  // 6: shopping ideas: an interest from memory paired with a store good for it
  `CREATE TABLE shopping_ideas (
     id INTEGER PRIMARY KEY,
     project_id TEXT NOT NULL,
     interest TEXT NOT NULL,
     term TEXT NOT NULL,
     host TEXT NOT NULL,
     is_new INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'active',
     created_at INTEGER NOT NULL
   );
   CREATE INDEX shopping_ideas_by_project ON shopping_ideas (project_id, status);
   CREATE TABLE shopping_idea_runs (
     project_id TEXT PRIMARY KEY,
     ran_at INTEGER NOT NULL,
     input_hash TEXT NOT NULL
   );`,
  // 7: skills: routines the user taught, which Claude repeats when asked. Not per project, since
  // a way of doing something works wherever you are.
  `CREATE TABLE skills (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     when_to_use TEXT NOT NULL DEFAULT '',
     start_url TEXT NOT NULL DEFAULT '',
     steps TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     last_run_at INTEGER
   );
   CREATE UNIQUE INDEX skills_by_name ON skills (name COLLATE NOCASE);`,
  // 8: saved addresses imported from another browser, for form autofill. source_key is the source
  // browser's id for the address, so re-importing updates it in place; fields is AddressFields JSON.
  `CREATE TABLE addresses (
     id INTEGER PRIMARY KEY,
     source_key TEXT NOT NULL UNIQUE,
     fields TEXT NOT NULL,
     source TEXT,
     imported_at INTEGER NOT NULL
   );`,
  // 9: payment cards imported from another browser, for form autofill. number_enc and cvc_enc are
  // encrypted with the OS keychain via Electron safeStorage (see main/cards.ts), like passwords;
  // last_four and network are kept in the clear so the list can show a card without decrypting it.
  `CREATE TABLE cards (
     id INTEGER PRIMARY KEY,
     source_key TEXT NOT NULL UNIQUE,
     name_on_card TEXT NOT NULL,
     nickname TEXT NOT NULL,
     network TEXT NOT NULL,
     last_four TEXT NOT NULL,
     exp_month INTEGER NOT NULL,
     exp_year INTEGER NOT NULL,
     number_enc BLOB NOT NULL,
     cvc_enc BLOB,
     source TEXT,
     imported_at INTEGER NOT NULL
   );`
]

const SKILLS_SELECT = `SELECT id, name, when_to_use AS whenToUse, start_url AS startUrl, steps, created_at AS createdAt,
  updated_at AS updatedAt, last_run_at AS lastRunAt FROM skills`

const FACTS_SELECT = `SELECT url, host, kind, topic, store, summarizable, price, currency, in_stock AS inStock, rating,
  classified_at AS classifiedAt FROM page_facts`
type RawFacts = Omit<PageFactsRow, 'store' | 'summarizable' | 'inStock'> & { store: number; summarizable: number; inStock: number | null }
const factsRow = (r: RawFacts): PageFactsRow => ({
  ...r,
  store: r.store === 1,
  summarizable: r.summarizable === 1,
  inStock: r.inStock === null ? null : r.inStock === 1
})

const CARD_SELECT = `SELECT id, source_key AS sourceKey, name_on_card AS nameOnCard, nickname, network,
  last_four AS lastFour, exp_month AS expMonth, exp_year AS expYear, number_enc AS numberEnc, cvc_enc AS cvcEnc,
  source, imported_at AS importedAt FROM cards`

const ADDRESS_SELECT =`SELECT id, fields, source, imported_at AS importedAt FROM addresses`
type RawAddress = { id: number; fields: string; source: string | null; importedAt: number }
const addressRow = (r: RawAddress): SavedAddress => ({
  ...(JSON.parse(r.fields) as AddressFields),
  id: r.id,
  source: r.source ?? undefined,
  importedAt: r.importedAt
})

/**
 * Turns what someone typed into an FTS5 query: every word must appear, as a word or the start
 * of one. Punctuation is dropped, so nothing typed can be read as query syntax.
 */
export function ftsQuery(text: string): string | undefined {
  const words = text.match(/[\p{L}\p{N}]+/gu)
  return words?.length ? words.map((w) => `"${w}"*`).join(' ') : undefined
}

/**
 * The app's SQLite database (app.db in the user data folder). It holds chats (the exact messages
 * sent to Claude, which are only ever appended to since earlier turns can't be edited once
 * thinking blocks are in them, and the transcript as the UI shows it), browsing history, and
 * each project's memory, with full-text search over chats and history.
 */
export class Store {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.migrate()
  }

  private migrate(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.transaction(() => this.db.exec(`${MIGRATIONS[v]}\nPRAGMA user_version = ${v + 1};`))
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }

  // MARK: - Conversations

  listConversations(projectId: string): ConversationRow[] {
    return this.db
      .prepare(
        `SELECT id, project_id AS projectId, title, created_at AS createdAt, updated_at AS updatedAt
         FROM conversations WHERE project_id = ? ORDER BY updated_at DESC`
      )
      .all(projectId) as unknown as ConversationRow[]
  }

  getConversation(id: string): ConversationRow | undefined {
    return this.db
      .prepare(
        `SELECT id, project_id AS projectId, title, created_at AS createdAt, updated_at AS updatedAt
         FROM conversations WHERE id = ?`
      )
      .get(id) as ConversationRow | undefined
  }

  createConversation(projectId: string): ConversationRow {
    const now = Date.now()
    const row: ConversationRow = { id: randomUUID(), projectId, title: '', createdAt: now, updatedAt: now }
    this.db
      .prepare('INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.id, row.projectId, row.title, row.createdAt, row.updatedAt)
    return row
  }

  setTitle(id: string, title: string): void {
    this.db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, id)
  }

  touch(id: string): void {
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  }

  deleteConversation(id: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM message_search WHERE conversation_id = ?').run(id)
      this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
    })
  }

  /** Every conversation id in a project, e.g. to delete them with it. */
  conversationIds(projectId: string): string[] {
    return (this.db.prepare('SELECT id FROM conversations WHERE project_id = ?').all(projectId) as Array<{ id: string }>).map(
      (r) => r.id
    )
  }

  // MARK: - Messages

  appendMessage(conversationId: string, message: MessageParam): void {
    this.db
      .prepare(
        `INSERT INTO messages (conversation_id, seq, message)
         VALUES (?, (SELECT COALESCE(MAX(seq), -1) + 1 FROM messages WHERE conversation_id = ?), ?)`
      )
      .run(conversationId, conversationId, JSON.stringify(message))
  }

  loadMessages(conversationId: string): MessageParam[] {
    const rows = this.db
      .prepare('SELECT message FROM messages WHERE conversation_id = ? ORDER BY seq')
      .all(conversationId) as Array<{ message: string }>
    return rows.map((r) => JSON.parse(r.message) as MessageParam)
  }

  saveTranscript(conversationId: string, state: ChatState): void {
    this.db.prepare('UPDATE conversations SET transcript = ? WHERE id = ?').run(JSON.stringify(state), conversationId)
  }

  loadTranscript(conversationId: string): ChatState | undefined {
    const row = this.db.prepare('SELECT transcript FROM conversations WHERE id = ?').get(conversationId) as
      | { transcript: string }
      | undefined
    return row ? (JSON.parse(row.transcript) as ChatState) : undefined
  }

  /** Makes what was said findable by chat search. */
  indexText(conversationId: string, role: 'user' | 'assistant', text: string): void {
    if (!text.trim()) return
    this.db
      .prepare('INSERT INTO message_search (text, conversation_id, role, created_at) VALUES (?, ?, ?, ?)')
      .run(text, conversationId, role, Date.now())
  }

  /** Chats whose words match, best match first, with a snippet around it. */
  searchChats(query: string, opts: { projectId?: string; limit: number }): ChatSearchHit[] {
    const match = ftsQuery(query)
    if (!match) return []
    const rows = this.db
      .prepare(
        `SELECT c.id AS conversationId, c.title, c.project_id AS projectId, s.role, s.created_at AS at,
                snippet(message_search, 0, '[', ']', '…', 24) AS snippet
         FROM message_search s JOIN conversations c ON c.id = s.conversation_id
         WHERE message_search MATCH ? ${opts.projectId ? 'AND c.project_id = ?' : ''}
         ORDER BY rank LIMIT ?`
      )
      .all(...([match, ...(opts.projectId ? [opts.projectId] : []), opts.limit * 3] as Array<string | number>)) as unknown as Array<
      ChatSearchHit & { role: 'user' | 'assistant' }
    >
    // One hit per chat: its best match.
    const seen = new Set<string>()
    return rows.filter((r) => !seen.has(r.conversationId) && seen.add(r.conversationId)).slice(0, opts.limit)
  }

  // MARK: - Browsing history

  addVisit(visit: { url: string; title: string; projectId: string | null; siteName?: string }): number {
    const result = this.db
      .prepare('INSERT INTO visits (url, title, visited_at, project_id, site_name) VALUES (?, ?, ?, ?, ?)')
      .run(visit.url, visit.title, Date.now(), visit.projectId, visit.siteName ?? null)
    return Number(result.lastInsertRowid)
  }

  setVisitTitle(id: number, title: string): void {
    this.db.prepare('UPDATE visits SET title = ? WHERE id = ? AND title != ?').run(title, id, title)
  }

  /** Newest first. With a query, visits whose title or address has every word. */
  searchHistory(opts: { query?: string; projectId?: string; limit: number; before?: number }): HistoryEntry[] {
    const match = opts.query ? ftsQuery(opts.query) : undefined
    if (opts.query && !match) return []
    const where: string[] = []
    const args: Array<string | number> = []
    if (match) {
      where.push('v.id IN (SELECT rowid FROM visit_search WHERE visit_search MATCH ?)')
      args.push(match)
    }
    if (opts.projectId) {
      where.push('v.project_id = ?')
      args.push(opts.projectId)
    }
    if (opts.before) {
      where.push('v.visited_at < ?')
      args.push(opts.before)
    }
    args.push(opts.limit)
    return this.db
      .prepare(
        `SELECT v.id, v.url, v.title, v.visited_at AS visitedAt, v.project_id AS projectId, v.site_name AS siteName
         FROM visits v ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY v.visited_at DESC LIMIT ?`
      )
      .all(...args) as unknown as HistoryEntry[]
  }

  /**
   * The rest of an address being typed, from history (see completeAddress). Only the newest few
   * thousand matching visits are looked at, which is plenty to rank by and keeps each keystroke quick.
   */
  completeAddress(typed: string, projectId?: string): string | undefined {
    const text = typed.replace(/^https?:\/\//i, '')
    if (!text || /\s/.test(text)) return undefined
    const prefix = `${likeEscape(text)}%`
    const visits = this.db
      .prepare(
        `SELECT url, visited_at AS visitedAt, project_id AS projectId FROM visits
         WHERE url LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\'
         ORDER BY visited_at DESC LIMIT 5000`
      )
      .all(`https://${prefix}`, `http://${prefix}`, `https://www.${prefix}`, `http://www.${prefix}`) as unknown as CompletionVisit[]
    return completeAddress(typed, visits, { now: Date.now(), projectId })
  }

  /** Addresses in history that mention a site, for finding the hosts it was visited under. */
  urlsMentioning(text: string, limit = 5000): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT url FROM visits WHERE instr(url, ?) > 0 LIMIT ?')
      .all(text, limit) as Array<{ url: string }>
    return rows.map((r) => r.url)
  }

  deleteVisit(id: number): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT url FROM visits WHERE id = ?').get(id) as { url: string } | undefined
      this.db.prepare('DELETE FROM visits WHERE id = ?').run(id)
      // What was learned about a page goes with the last visit to it.
      if (row) this.db.prepare('DELETE FROM page_facts WHERE url = ? AND NOT EXISTS (SELECT 1 FROM visits WHERE url = ?)').run(row.url, row.url)
    })
  }

  clearHistory(): void {
    this.db.exec(`DELETE FROM visits; DELETE FROM page_facts; INSERT INTO visit_search (visit_search) VALUES ('rebuild');`)
  }

  /**
   * A project's visits that may be to one site (or its www. twin), newest first: the address
   * only has to contain the host, so callers check it. The default project's include pinned
   * sites' visits, as in projectVisits.
   */
  siteVisits(projectId: string, host: string, opts: { since: number; limit: number; includeUnfiled: boolean }): HistoryEntry[] {
    return this.db
      .prepare(
        `SELECT id, url, title, visited_at AS visitedAt, project_id AS projectId, site_name AS siteName FROM visits
         WHERE (project_id = ? ${opts.includeUnfiled ? 'OR project_id IS NULL' : ''}) AND visited_at >= ?
           AND instr(url, ?) > 0
         ORDER BY visited_at DESC LIMIT ?`
      )
      .all(projectId, opts.since, host, opts.limit) as unknown as HistoryEntry[]
  }

  // MARK: - Shopping ideas

  /**
   * Stores (sites with a page Jev called a store) this project's visits since `since` went to,
   * with how many pages there were about each topic. Pages labeled sensitive aren't counted.
   */
  storeSites(projectId: string, opts: { since: number; includeUnfiled: boolean }): Array<{ host: string; topic: string; pages: number }> {
    return this.db
      .prepare(
        `SELECT f.host AS host, f.topic AS topic, COUNT(*) AS pages FROM visits v JOIN page_facts f ON f.url = v.url
         WHERE (v.project_id = ? ${opts.includeUnfiled ? 'OR v.project_id IS NULL' : ''}) AND v.visited_at >= ?
           AND f.topic != 'sensitive' AND f.host IN (SELECT host FROM page_facts WHERE store = 1)
         GROUP BY f.host, f.topic`
      )
      .all(projectId, opts.since) as unknown as Array<{ host: string; topic: string; pages: number }>
  }

  shoppingIdeas(projectId: string): ShoppingIdea[] {
    return (
      this.db
        .prepare(
          `SELECT id, interest, term, host, is_new AS isNew FROM shopping_ideas
           WHERE project_id = ? AND status = 'active' ORDER BY id`
        )
        .all(projectId) as unknown as Array<Omit<ShoppingIdea, 'isNew'> & { isNew: number }>
    ).map((r) => ({ ...r, isNew: r.isNew === 1 }))
  }

  shoppingIdea(id: number): (ShoppingIdea & { projectId: string }) | undefined {
    const r = this.db
      .prepare(`SELECT id, project_id AS projectId, interest, term, host, is_new AS isNew FROM shopping_ideas WHERE id = ?`)
      .get(id) as (Omit<ShoppingIdea, 'isNew'> & { projectId: string; isNew: number }) | undefined
    return r && { ...r, isNew: r.isNew === 1 }
  }

  /** The project's ideas now; the ones before that weren't dismissed are dropped. */
  replaceShoppingIdeas(projectId: string, ideas: Array<Omit<ShoppingIdea, 'id'>>): void {
    this.transaction(() => {
      this.db.prepare(`DELETE FROM shopping_ideas WHERE project_id = ? AND status = 'active'`).run(projectId)
      const insert = this.db.prepare(
        'INSERT INTO shopping_ideas (project_id, interest, term, host, is_new, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      for (const i of ideas) insert.run(projectId, i.interest, i.term, i.host, i.isNew ? 1 : 0, Date.now())
    })
  }

  dismissShoppingIdea(id: number): void {
    this.db.prepare(`UPDATE shopping_ideas SET status = 'dismissed' WHERE id = ?`).run(id)
  }

  /** Ideas the user dismissed, newest first, so they aren't suggested again. */
  dismissedShoppingIdeas(projectId: string, limit: number): Array<{ interest: string; host: string }> {
    return this.db
      .prepare(`SELECT interest, host FROM shopping_ideas WHERE project_id = ? AND status = 'dismissed' ORDER BY id DESC LIMIT ?`)
      .all(projectId, limit) as unknown as Array<{ interest: string; host: string }>
  }

  shoppingIdeaRun(projectId: string): { ranAt: number; inputHash: string } | undefined {
    return this.db
      .prepare('SELECT ran_at AS ranAt, input_hash AS inputHash FROM shopping_idea_runs WHERE project_id = ?')
      .get(projectId) as { ranAt: number; inputHash: string } | undefined
  }

  setShoppingIdeaRun(projectId: string, inputHash: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO shopping_idea_runs (project_id, ran_at, input_hash) VALUES (?, ?, ?)')
      .run(projectId, Date.now(), inputHash)
  }

  // MARK: - Page facts

  pageFacts(url: string): PageFactsRow | undefined {
    const row = this.db.prepare(`${FACTS_SELECT} WHERE url = ?`).get(url) as RawFacts | undefined
    return row && factsRow(row)
  }

  /** Facts for each of these addresses that has them. */
  pageFactsFor(urls: string[]): Map<string, PageFactsRow> {
    if (!urls.length) return new Map()
    const rows = this.db
      .prepare(`${FACTS_SELECT} WHERE url IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify([...new Set(urls)])) as unknown as RawFacts[]
    return new Map(rows.map((r) => [r.url, factsRow(r)]))
  }

  /** Whether Jev called any page on this site a store. */
  isStore(host: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM page_facts WHERE host = ? AND store = 1 LIMIT 1').get(host)
  }

  setPageFacts(f: PageFactsRow): void {
    const flag = (b: boolean | null): number | null => (b === null ? null : b ? 1 : 0)
    this.db
      .prepare(
        `INSERT OR REPLACE INTO page_facts
         (url, host, kind, topic, store, summarizable, price, currency, in_stock, rating, classified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(f.url, f.host, f.kind, f.topic, flag(f.store), flag(f.summarizable), f.price, f.currency, flag(f.inStock), f.rating, f.classifiedAt)
  }

  /** A deleted project's visits stay in history, just no longer filed under it. */
  forgetProjectVisits(projectId: string): void {
    this.db.prepare('UPDATE visits SET project_id = NULL WHERE project_id = ?').run(projectId)
  }

  // MARK: - Memory

  memoryFiles(projectId: string): MemoryFile[] {
    return this.db
      .prepare('SELECT path, content, updated_at AS updatedAt FROM memories WHERE project_id = ? ORDER BY path')
      .all(projectId) as unknown as MemoryFile[]
  }

  readMemory(projectId: string, path: string): string | undefined {
    const row = this.db.prepare('SELECT content FROM memories WHERE project_id = ? AND path = ?').get(projectId, path) as
      | { content: string }
      | undefined
    return row?.content
  }

  writeMemory(projectId: string, path: string, content: string): void {
    this.db
      .prepare(
        `INSERT INTO memories (project_id, path, content, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (project_id, path) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
      )
      .run(projectId, path, content, Date.now())
  }

  /** Deletes a file, or everything under a directory path. */
  deleteMemory(projectId: string, path: string): number {
    const result = this.db
      .prepare(`DELETE FROM memories WHERE project_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')`)
      .run(projectId, path, `${likeEscape(path)}/%`)
    return Number(result.changes)
  }

  /** Moves a file, or everything under a directory path. */
  renameMemory(projectId: string, from: string, to: string): void {
    this.transaction(() => {
      const rows = this.db
        .prepare(`SELECT path FROM memories WHERE project_id = ? AND (path = ? OR path LIKE ? ESCAPE '\\')`)
        .all(projectId, from, `${likeEscape(from)}/%`) as Array<{ path: string }>
      const move = this.db.prepare('UPDATE memories SET path = ?, updated_at = ? WHERE project_id = ? AND path = ?')
      for (const { path } of rows) move.run(to + path.slice(from.length), Date.now(), projectId, path)
    })
  }

  deleteProjectMemory(projectId: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM memories WHERE project_id = ?').run(projectId)
      this.db.prepare('DELETE FROM memory_suggestions WHERE project_id = ?').run(projectId)
      this.db.prepare('DELETE FROM memory_suggestion_runs WHERE project_id = ?').run(projectId)
    })
  }

  // MARK: - Memory suggested from browsing

  /**
   * A project's visits after `afterId`, oldest first. The default project's include pinned
   * sites' visits, which aren't in any project.
   */
  projectVisits(projectId: string, opts: { afterId: number; since: number; limit: number; includeUnfiled: boolean }): HistoryEntry[] {
    return this.db
      .prepare(
        `SELECT id, url, title, visited_at AS visitedAt, project_id AS projectId, site_name AS siteName FROM visits
         WHERE (project_id = ? ${opts.includeUnfiled ? 'OR project_id IS NULL' : ''}) AND id > ? AND visited_at >= ?
         ORDER BY id DESC LIMIT ?`
      )
      .all(projectId, opts.afterId, opts.since, opts.limit)
      .reverse() as unknown as HistoryEntry[]
  }

  suggestionRun(projectId: string): { ranAt: number; lastVisitId: number } | undefined {
    return this.db
      .prepare('SELECT ran_at AS ranAt, last_visit_id AS lastVisitId FROM memory_suggestion_runs WHERE project_id = ?')
      .get(projectId) as { ranAt: number; lastVisitId: number } | undefined
  }

  setSuggestionRun(projectId: string, lastVisitId: number): void {
    this.db
      .prepare(
        `INSERT INTO memory_suggestion_runs (project_id, ran_at, last_visit_id) VALUES (?, ?, ?)
         ON CONFLICT (project_id) DO UPDATE SET ran_at = excluded.ran_at, last_visit_id = excluded.last_visit_id`
      )
      .run(projectId, Date.now(), lastVisitId)
  }

  addSuggestion(s: { projectId: string; path: string; text: string; reason: string }): void {
    this.db
      .prepare('INSERT INTO memory_suggestions (project_id, path, text, reason, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(s.projectId, s.path, s.text, s.reason, Date.now())
  }

  pendingSuggestions(): MemorySuggestion[] {
    return this.db
      .prepare(
        `SELECT id, project_id AS projectId, path, text, reason, created_at AS createdAt FROM memory_suggestions
         WHERE status = 'pending' ORDER BY created_at DESC, id`
      )
      .all() as unknown as MemorySuggestion[]
  }

  suggestion(id: number): (MemorySuggestion & { status: string }) | undefined {
    return this.db
      .prepare(
        `SELECT id, project_id AS projectId, path, text, reason, status, created_at AS createdAt
         FROM memory_suggestions WHERE id = ?`
      )
      .get(id) as (MemorySuggestion & { status: string }) | undefined
  }

  /** The project's latest suggestions of any status, so the same thing isn't suggested twice. */
  pastSuggestions(projectId: string, limit: number): Array<{ text: string; status: string }> {
    return this.db
      .prepare('SELECT text, status FROM memory_suggestions WHERE project_id = ? ORDER BY id DESC LIMIT ?')
      .all(projectId, limit) as Array<{ text: string; status: string }>
  }

  setSuggestionStatus(id: number, status: 'accepted' | 'dismissed', text?: string): void {
    this.db
      .prepare('UPDATE memory_suggestions SET status = ?, text = COALESCE(?, text) WHERE id = ?')
      .run(status, text ?? null, id)
  }

  // MARK: - Skills

  skills(): Skill[] {
    return this.db.prepare(`${SKILLS_SELECT} ORDER BY name COLLATE NOCASE`).all() as unknown as Skill[]
  }

  skill(id: string): Skill | undefined {
    return this.db.prepare(`${SKILLS_SELECT} WHERE id = ?`).get(id) as Skill | undefined
  }

  skillNamed(name: string): Skill | undefined {
    return this.db.prepare(`${SKILLS_SELECT} WHERE name = ? COLLATE NOCASE`).get(name) as Skill | undefined
  }

  /** Adds a skill, or changes the one with `id`. Names are unique, ignoring case. */
  saveSkill(draft: SkillDraft, id?: string): Skill {
    const now = Date.now()
    if (id) {
      this.db
        .prepare('UPDATE skills SET name = ?, when_to_use = ?, start_url = ?, steps = ?, updated_at = ? WHERE id = ?')
        .run(draft.name, draft.whenToUse, draft.startUrl, draft.steps, now, id)
      return this.skill(id)!
    }
    const newId = randomUUID()
    this.db
      .prepare(
        'INSERT INTO skills (id, name, when_to_use, start_url, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(newId, draft.name, draft.whenToUse, draft.startUrl, draft.steps, now, now)
    return this.skill(newId)!
  }

  deleteSkill(id: string): void {
    this.db.prepare('DELETE FROM skills WHERE id = ?').run(id)
  }

  markSkillRun(id: string): void {
    this.db.prepare('UPDATE skills SET last_run_at = ? WHERE id = ?').run(Date.now(), id)
  }

  // MARK: - Saved logins (credentials)

  /** Adds or replaces logins, in one transaction. passwordEnc is already safeStorage-encrypted by the caller. */
  upsertCredentials(list: { origin: string; host: string; username: string; passwordEnc: Uint8Array; source?: string }[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO credentials (origin, host, username, password_enc, source, imported_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (origin, username) DO UPDATE SET
         password_enc = excluded.password_enc, source = excluded.source, imported_at = excluded.imported_at`
    )
    const now = Date.now()
    this.transaction(() => {
      for (const c of list) stmt.run(c.origin, c.host, c.username, c.passwordEnc, c.source ?? null, now)
    })
  }

  /** Logins whose host is one of these, for autofill. Most specific host first. */
  credentialsForHost(hosts: string[]): CredentialRow[] {
    if (!hosts.length) return []
    const placeholders = hosts.map(() => '?').join(', ')
    return this.db
      .prepare(
        `SELECT id, origin, host, username, password_enc AS passwordEnc, source, imported_at AS importedAt
         FROM credentials WHERE host IN (${placeholders}) ORDER BY length(host) DESC, imported_at DESC`
      )
      .all(...hosts) as unknown as CredentialRow[]
  }

  getCredential(id: number): CredentialRow | undefined {
    return this.db
      .prepare(
        `SELECT id, origin, host, username, password_enc AS passwordEnc, source, imported_at AS importedAt
         FROM credentials WHERE id = ?`
      )
      .get(id) as CredentialRow | undefined
  }

  /** Every saved login's metadata (passwords stay encrypted), for the settings list. */
  listCredentials(): CredentialRow[] {
    return this.db
      .prepare(
        `SELECT id, origin, host, username, password_enc AS passwordEnc, source, imported_at AS importedAt
         FROM credentials ORDER BY host, username`
      )
      .all() as unknown as CredentialRow[]
  }

  deleteCredential(id: number): void {
    this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id)
  }

  clearCredentials(): void {
    this.db.exec('DELETE FROM credentials')
  }

  // MARK: - Saved addresses

  /** Adds or replaces addresses by their source key, in one transaction. Returns how many were saved. */
  upsertAddresses(list: { key: string; fields: AddressFields; source?: string }[]): number {
    const stmt = this.db.prepare(
      `INSERT INTO addresses (source_key, fields, source, imported_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (source_key) DO UPDATE SET
         fields = excluded.fields, source = excluded.source, imported_at = excluded.imported_at`
    )
    const now = Date.now()
    this.transaction(() => {
      for (const a of list) stmt.run(a.key, JSON.stringify(a.fields), a.source ?? null, now)
    })
    return list.length
  }

  listAddresses(): SavedAddress[] {
    const rows = this.db
      .prepare(`${ADDRESS_SELECT} ORDER BY imported_at DESC, id`)
      .all() as unknown as RawAddress[]
    return rows.map(addressRow)
  }

  getAddress(id: number): SavedAddress | undefined {
    const row = this.db.prepare(`${ADDRESS_SELECT} WHERE id = ?`).get(id) as RawAddress | undefined
    return row && addressRow(row)
  }

  deleteAddress(id: number): void {
    this.db.prepare('DELETE FROM addresses WHERE id = ?').run(id)
  }

  clearAddresses(): void {
    this.db.exec('DELETE FROM addresses')
  }

  // MARK: - Saved payment cards

  /** Adds or replaces cards by their source key, in one transaction. Numbers and codes arrive encrypted. */
  upsertCards(list: Omit<CardRow, 'id' | 'importedAt'>[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO cards (source_key, name_on_card, nickname, network, last_four, exp_month, exp_year, number_enc, cvc_enc, source, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source_key) DO UPDATE SET
         name_on_card = excluded.name_on_card, nickname = excluded.nickname, network = excluded.network,
         last_four = excluded.last_four, exp_month = excluded.exp_month, exp_year = excluded.exp_year,
         number_enc = excluded.number_enc, cvc_enc = excluded.cvc_enc, source = excluded.source,
         imported_at = excluded.imported_at`
    )
    const now = Date.now()
    this.transaction(() => {
      for (const c of list) {
        stmt.run(c.sourceKey, c.nameOnCard, c.nickname, c.network, c.lastFour, c.expMonth, c.expYear, c.numberEnc, c.cvcEnc, c.source, now)
      }
    })
  }

  listCards(): CardRow[] {
    return this.db.prepare(`${CARD_SELECT} ORDER BY imported_at DESC, id`).all() as unknown as CardRow[]
  }

  getCard(id: number): CardRow | undefined {
    return this.db.prepare(`${CARD_SELECT} WHERE id = ?`).get(id) as CardRow | undefined
  }

  deleteCard(id: number): void {
    this.db.prepare('DELETE FROM cards WHERE id = ?').run(id)
  }

  clearCards(): void {
    this.db.exec('DELETE FROM cards')
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }
}

const likeEscape = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`)
