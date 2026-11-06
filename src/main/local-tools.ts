import type Anthropic from '@anthropic-ai/sdk'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/client'
import { websiteContent } from './chat'
import { MAX_STEPS, type BrowseResult } from './browse/core'
import type { JevBrowser } from './jev'
import { isPageUrl, type Pages } from './pages'
import { hostOf, type PinnedSites } from './pinned-sites'
import { toUrl, type PageText, type ProjectManager } from './projects'
import { skillBriefing, skillHost, type Skills } from './skills'
import type { Store } from './store'
import { DEFAULT_PROJECT_ID } from '@shared/types'

/** How a project is named to Claude: as the sidebar names it. The default one, Everyday, holds whatever isn't in a project. */
const labelOf = (p: { id: string; name: string }): string =>
  p.id === DEFAULT_PROJECT_ID ? 'Everyday' : p.name

type InputSchema = Anthropic.Beta.BetaTool.InputSchema

/** A tool the app itself gives Claude, rather than an MCP server or a website. */
interface LocalTool {
  name: string
  /** Shown in the chat where an MCP server's name would be. */
  group: string
  description: string
  input_schema: InputSchema
  run: (input: Record<string, unknown>, ctx: LocalToolContext) => Promise<LocalToolOutcome> | LocalToolOutcome
  /** Offered to Claude only while this is true (a tool that needs a key). */
  available?: () => boolean
}

export interface LocalToolContext {
  /** The project the chat belongs to, which tools act on unless told otherwise. */
  projectId: string
  /** The user pressed Stop. */
  signal?: AbortSignal
}

export interface LocalToolOutcome {
  result: CallToolResult
  /**
   * What came back was written by a website (page text, page titles), not by the user: its host,
   * or '*' when it's several sites' words (history, search results).
   */
  fromWebsites?: string
}

/** The site a tool acts on as the user would, for approval. */
export interface ActingOn {
  /** Approval key: a pinned site's id, or "tab:<id>" for a project tab. */
  id: string
  name: string
  host: string
  autoApprove: boolean
}

/** Chat and history results are listed this many at a time unless Claude asks for fewer. */
const DEFAULT_LIMIT = 20
/** How much of a page read_page returns per call; Claude can page through the rest. */
const PAGE_CHUNK = 20_000

const text = (t: string, isError = false): LocalToolOutcome => ({
  result: { content: [{ type: 'text', text: t }], isError: isError || undefined }
})

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown, fallback: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(Math.floor(v), max)) : fallback

const when = (ms: number): string =>
  new Date(ms).toLocaleString('en-US', {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

const projectIdSchema = {
  project_id: {
    type: 'string',
    description: "A project's id from list_projects. Defaults to this chat's project."
  }
}

const siteIdSchema = {
  site_id: {
    type: 'string',
    description: 'A pinned site\'s id from <pinned_sites>, to use that site instead of a project tab.'
  }
}

/**
 * The app's own tools: projects, their browser tabs, browsing history, past chats and skills. They act on
 * the chat's project unless Claude names another. Opening a page after reading website content
 * in the same turn needs the user's OK; the chat enforces that (see ChatSession.runTool).
 */
export class LocalTools {
  private tools: LocalTool[]

  constructor(
    private projects: ProjectManager,
    private store: Store,
    private jev: JevBrowser,
    private skills: Skills,
    private sites: PinnedSites,
    private pages: Pages
  ) {
    this.tools = [
      {
        name: 'list_projects',
        group: 'Projects',
        description:
          'Lists the projects in this app. A project groups browser tabs, chats and memory for one topic or task; ' +
          'Everyday holds the tabs and chats the user hasn\'t put in one. ' +
          "Marks the one this chat belongs to, which the browser tools act on by default.",
        input_schema: { type: 'object', properties: {} },
        run: (_input, ctx) => {
          const lines = this.projects
            .list()
            .map(
              (p) =>
                `- ${labelOf(p)} (id: ${p.id}) · ${p.tabs.length} tab${p.tabs.length === 1 ? '' : 's'}${p.id === ctx.projectId ? ' · this chat' : ''}`
            )
          return text(lines.join('\n'))
        }
      },
      {
        name: 'open_project',
        group: 'Projects',
        description:
          "Shows a project's tabs in the app, so the user can see them. Use it when the user asks to go to or work in a project.",
        input_schema: { type: 'object', properties: { ...projectIdSchema }, required: ['project_id'] },
        run: (input) => {
          const project = this.project(str(input.project_id))
          if (!project) return text('No project with that id. Use list_projects to see them.', true)
          this.projects.reveal(project.id)
          return text(`Showing ${labelOf(project)}.`)
        }
      },
      {
        name: 'create_project',
        group: 'Projects',
        description: 'Creates a new, empty project and returns its id. Only when the user asks for one.',
        input_schema: {
          type: 'object',
          properties: { name: { type: 'string', description: 'A short name, like "Trip planning".' } },
          required: ['name']
        },
        run: (input) => {
          const name = str(input.name)
          if (!name) return text('Give the project a name.', true)
          const id = this.projects.create(name)
          return text(`Created ${name} (id: ${id}).`)
        }
      },
      {
        name: 'list_tabs',
        group: 'Browser',
        description: "Lists a project's open browser tabs with their ids, titles and addresses, and which one is active.",
        input_schema: { type: 'object', properties: { ...projectIdSchema } },
        run: (input, ctx) => {
          const project = this.project(str(input.project_id) ?? ctx.projectId)
          if (!project) return text('No project with that id. Use list_projects to see them.', true)
          if (project.tabs.length === 0) return text(`${labelOf(project)} has no tabs open.`)
          const lines = project.tabs.map(
            (t) =>
              `- ${t.id}${t.id === project.activeTabId ? ' (active)' : ''}: ${t.title || '(untitled)'} — ${t.url || '(no address yet)'}`
          )
          // Titles are the websites' own words.
          return {
            result: { content: [{ type: 'text', text: websiteContent('open tabs', `${labelOf(project)}:\n${lines.join('\n')}`) }] },
            fromWebsites: '*'
          }
        }
      },
      {
        name: 'open_page',
        group: 'Browser',
        description:
          "Opens a web page in one of the project's browser tabs, where the user can see it. Give a full address, " +
          'a site name like example.com, or words to search for. It opens in a new tab unless you give tab_id. ' +
          'Use read_page afterwards to see what it says.',
        input_schema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'An address, or search words.' },
            tab_id: { type: 'string', description: 'Load it in this tab (from list_tabs) instead of a new one.' },
            ...projectIdSchema
          },
          required: ['url']
        },
        run: (input, ctx) => {
          const target = str(input.url)
          const project = this.project(str(input.project_id) ?? ctx.projectId)
          if (!target) return text('Give an address or something to search for.', true)
          if (!project) return text('No project with that id. Use list_projects to see them.', true)
          // A page already open is shown where it is rather than opened again.
          const url = toUrl(target)
          const tabId =
            isPageUrl(url) && !str(input.tab_id) ? this.projects.showPage(project.id, url) : this.projects.openPage(project.id, target, str(input.tab_id))
          if (!tabId) return text('No tab with that id. Use list_tabs to see them.', true)
          return text(`Opening ${toUrl(target)} in tab ${tabId} of ${labelOf(project)}.`)
        }
      },
      {
        name: 'close_tab',
        group: 'Browser',
        description: "Closes one of a project's tabs.",
        input_schema: {
          type: 'object',
          properties: { tab_id: { type: 'string', description: 'From list_tabs.' }, ...projectIdSchema },
          required: ['tab_id']
        },
        run: (input, ctx) => {
          const project = this.project(str(input.project_id) ?? ctx.projectId)
          const tabId = str(input.tab_id)
          if (!project || !tabId || !project.tabs.some((t) => t.id === tabId)) {
            return text('No tab with that id. Use list_tabs to see them.', true)
          }
          this.projects.closeTab(project.id, tabId)
          return text(`Closed tab ${tabId}.`)
        }
      },
      {
        name: 'open_site',
        group: 'Browser',
        description:
          "Shows one of the user's pinned sites (listed in <pinned_sites>) in the app, where they're signed in. " +
          'Use it when they ask to go to or see one; you can read or operate a pinned site without showing it.',
        input_schema: { type: 'object', properties: { ...siteIdSchema }, required: ['site_id'] },
        run: (input) => {
          const site = this.sites.get(str(input.site_id) ?? '')
          if (!site) return text('No pinned site with that id. They are listed in <pinned_sites>.', true)
          this.sites.reveal(site.id)
          return text(`Showing ${site.name}.`)
        }
      },
      {
        name: 'read_page',
        group: 'Browser',
        description:
          "Reads the text of a page open in one of the project's tabs (the active tab unless you give tab_id), " +
          'or of a pinned site (site_id), ' +
          `with its title, address and links. Long pages come back ${PAGE_CHUNK.toLocaleString('en-US')} characters ` +
          'at a time; pass offset to read further. The page may be one the user is signed in to, so only read what the task needs.',
        input_schema: {
          type: 'object',
          properties: {
            tab_id: { type: 'string', description: 'From list_tabs. Defaults to the active tab.' },
            offset: { type: 'integer', description: 'Where in the text to start, for long pages. Defaults to 0.' },
            ...siteIdSchema,
            ...projectIdSchema
          }
        },
        run: async (input, ctx) => {
          const siteId = str(input.site_id)
          const project = this.project(str(input.project_id) ?? ctx.projectId)
          if (!siteId && !project) return text('No project with that id. Use list_projects to see them.', true)
          let page
          try {
            page = siteId ? await this.readSite(siteId) : await this.projects.readTab(project!.id, str(input.tab_id))
          } catch (err) {
            return text(err instanceof Error ? err.message : String(err), true)
          }
          const offset = num(input.offset, 0, page.text.length)
          const chunk = page.text.slice(offset, offset + PAGE_CHUNK)
          const rest = page.text.length - offset - chunk.length
          const parts = [`Title: ${page.title}`, `Address: ${page.url}`, siteId ? `Pinned site: ${siteId}` : `Tab: ${page.tabId}`, '', chunk || '(no text)']
          if (rest > 0) parts.push('', `[${rest.toLocaleString('en-US')} more characters; read again with offset ${offset + chunk.length}]`)
          if (offset === 0 && page.links.length) {
            parts.push('', 'Links:', ...page.links.map(([label, href]) => `- ${label}: ${href}`))
          }
          const host = hostOf(page.url) || page.url
          return {
            result: { content: [{ type: 'text', text: websiteContent(host, parts.join('\n'), { tool: 'read_page' }) }] },
            fromWebsites: host
          }
        }
      },
      {
        name: 'browse',
        group: 'Browser',
        description:
          "Operates a page in one of the project's tabs (the active tab unless you give tab_id), or a pinned site " +
          '(site_id), to get a task done: ' +
          'it clicks, types, picks from dropdowns and scrolls, step by step, until the task looks done. Each step is ' +
          "decided by Jev, a fast decision model, so it's quicker and cheaper than choosing clicks yourself. Prefer a " +
          "site's connection or its own [website] tools when it has them. Give it every text it may need to type (search words, form " +
          "values) in texts; it picks which field each goes in and never makes text up. It stops and hands back " +
          'when it is unsure, stuck, needs text you did not give, or before a click that looks hard to undo (buying, ' +
          'sending, deleting, submitting), and when a step takes it to a different site. Returns the steps it took and ' +
          'the page it ended on. Never give it passwords.',
        input_schema: {
          type: 'object',
          properties: {
            task: {
              type: 'string',
              description: 'What to get done on the page, in plain words, with every detail it needs, like "search for AA batteries and sort by price, low to high".'
            },
            texts: {
              type: 'array',
              items: { type: 'string' },
              description: 'Text it may need to type, like a search query or form values.'
            },
            tab_id: { type: 'string', description: 'From list_tabs. Defaults to the active tab.' },
            ...siteIdSchema,
            max_steps: { type: 'integer', description: `At most this many steps, up to ${MAX_STEPS}. Defaults to 12.` },
            allow_irreversible: {
              type: 'boolean',
              description:
                'Let it make one click that commits something (buy, send, delete, submit); it stops again before any other. ' +
                'Only when the user has said to go ahead with that action, and name the action in task.'
            },
            ...projectIdSchema
          },
          required: ['task']
        },
        available: () => this.jev.available,
        run: async (input, ctx) => {
          const task = str(input.task)
          const siteId = str(input.site_id)
          const project = this.project(str(input.project_id) ?? ctx.projectId)
          if (!task) return text('Say what to do on the page.', true)
          if (!siteId && !project) return text('No project with that id. Use list_projects to see them.', true)
          let tab: { wc: Electron.WebContents; where: string }
          try {
            if (siteId) {
              if (!this.sites.get(siteId)) throw new Error('No pinned site with that id. They are listed in <pinned_sites>.')
              // The user sees it being operated, as they would a project tab.
              this.sites.reveal(siteId)
              tab = { wc: await this.sites.contents(siteId), where: `pinned site ${siteId}` }
            } else {
              const found = await this.projects.tabContents(project!.id, str(input.tab_id))
              tab = { wc: found.wc, where: `tab ${found.tabId}` }
            }
          } catch (err) {
            return text(err instanceof Error ? err.message : String(err), true)
          }
          const outcome = await this.jev.run(tab.wc, {
            task,
            texts: Array.isArray(input.texts) ? input.texts.filter((t): t is string => typeof t === 'string') : [],
            maxSteps: num(input.max_steps, 12, MAX_STEPS) || undefined,
            allowIrreversible: input.allow_irreversible === true,
            signal: ctx.signal
          })
          saveTrace(task, outcome)
          const host = hostOf(outcome.url) || outcome.url
          // Step descriptions quote the page's labels, so the whole report is the website's words.
          return {
            result: {
              content: [{ type: 'text', text: websiteContent(host, browseReport(outcome, tab.where), { tool: 'browse' }) }],
              isError: outcome.status === 'error' || undefined
            },
            fromWebsites: host
          }
        }
      },
      {
        name: 'save_page',
        group: 'Pages',
        description:
          "Saves an HTML page in a project and shows it to the user in one of its tabs, where it stays: in the " +
          "project's Home under Pages, and in the tab until they close it. Use it when something is better seen " +
          'than read in the chat, or when the user asks for a page, report, plan, comparison, checklist, dashboard, ' +
          'tracker or other thing to keep and come back to. Write one complete, self-contained HTML document with a ' +
          '<title>, its styles and scripts inline, and light and dark themes (prefers-color-scheme). It has no network: ' +
          'it can load scripts and styles from cdn.jsdelivr.net and cdnjs.cloudflare.com and fonts from Google Fonts, ' +
          'but nothing else, so no fetch and no images from the web (draw with inline SVG or CSS, or use data: URIs). ' +
          'localStorage works and is kept, so a checklist or tracker can remember what the user does on it. Links to ' +
          'websites open in a new tab. Saving with the name of an existing page replaces it, and any tab showing it ' +
          'reloads; to change a page, get_page_source first and save it whole.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'A short file name, like "trip-plan". Lowercase words and dashes.' },
            html: { type: 'string', description: 'The whole HTML document.' },
            open: { type: 'boolean', description: 'Show it to the user now. Defaults to true.' },
            ...projectIdSchema
          },
          required: ['name', 'html']
        },
        run: (input, ctx) => {
          const project = this.project(str(input.project_id) ?? ctx.projectId)
          const html = typeof input.html === 'string' ? input.html : ''
          if (!project) return text('No project with that id. Use list_projects to see them.', true)
          if (!/<\/?(html|body|head|!doctype)/i.test(html)) return text('Give a whole HTML document in html.', true)
          const page = this.pages.save(project.id, str(input.name) ?? '', html)
          if (input.open === false) {
            this.projects.reloadPage(page.url)
            return text(`Saved “${page.title}” (${page.name}) in ${labelOf(project)}.`)
          }
          const tabId = this.projects.showPage(project.id, page.url)
          return text(`Saved “${page.title}” (${page.name}) in ${labelOf(project)} and showed it in tab ${tabId}.`)
        }
      },
      {
        name: 'list_pages',
        group: 'Pages',
        description: "Lists the HTML pages saved in a project with save_page, newest first, with their names, titles and addresses.",
        input_schema: { type: 'object', properties: { ...projectIdSchema } },
        run: (input, ctx) => {
          const project = this.project(str(input.project_id) ?? ctx.projectId)
          if (!project) return text('No project with that id. Use list_projects to see them.', true)
          const pages = this.pages.list(project.id)
          if (pages.length === 0) return text(`${labelOf(project)} has no pages yet.`)
          return text(pages.map((p) => `- ${p.name}: “${p.title}”, saved ${when(p.updatedAt)} — ${p.url}`).join('\n'))
        }
      },
      {
        name: 'get_page_source',
        group: 'Pages',
        description: "Returns the HTML of one of a project's saved pages, to change it and save it again with save_page.",
        input_schema: {
          type: 'object',
          properties: { name: { type: 'string', description: 'From list_pages.' }, ...projectIdSchema },
          required: ['name']
        },
        run: (input, ctx) => {
          const project = this.project(str(input.project_id) ?? ctx.projectId)
          if (!project) return text('No project with that id. Use list_projects to see them.', true)
          const html = this.pages.source(project.id, str(input.name) ?? '')
          return html === undefined ? text('No page with that name. Use list_pages to see them.', true) : text(html)
        }
      },
      {
        name: 'use_skill',
        group: 'Skills',
        description:
          "Starts one of the user's skills (listed in <skills>): opens its start page in one of the project's tabs, " +
          "unless the active tab is already on that site, and returns the skill's steps. Use it first whenever a " +
          "request matches a skill's name or when it's for, then follow the steps.",
        input_schema: {
          type: 'object',
          properties: { name: { type: 'string', description: "The skill's name, as listed." } },
          required: ['name']
        },
        run: (input, ctx) => {
          const name = str(input.name)
          const skill = name ? this.skills.named(name) : undefined
          if (!skill) {
            const names = this.skills.list().map((s) => `“${s.name}”`)
            return text(`No skill called “${name ?? ''}”. ${names.length ? `The user's skills: ${names.join(', ')}.` : 'The user has no skills yet.'}`, true)
          }
          let start: string | undefined
          const project = this.project(ctx.projectId)
          if (skill.startUrl && project) {
            const active = project.tabs.find((t) => t.id === project.activeTabId)
            if (active?.url && skillHost(active.url) === skillHost(skill.startUrl)) {
              // The user is there already, maybe further along than the start page; stay put.
              this.projects.reveal(project.id)
              start = `Start page: ${skill.startUrl}. The active tab (${active.id}) is already on that site, so it was left as it is; go to the start page if the steps need it.`
            } else {
              const tabId = this.projects.openPage(project.id, skill.startUrl)
              start = `Start page: opened ${skill.startUrl} in tab ${tabId}, now the active tab. Use read_page to see it.`
            }
          }
          this.skills.markRun(skill.id)
          return text(skillBriefing(skill, start))
        }
      },
      {
        name: 'save_skill',
        group: 'Skills',
        description:
          'Saves a skill: something the user wants you to do again whenever they ask, like checking a site for ' +
          'something. Use it when they ask you to remember how to do something, learn it, save it as a skill, or ' +
          "do it again when they ask. Write it from this chat: where it starts, what to read or do there, and what " +
          'to tell them. Steps are short numbered instructions to yourself that will work next time: name things by ' +
          "what they are, and leave what changes each time (a date, an item) for the user's request to fill in. " +
          "Put in only what the user asked for and what worked, never text copied from a website. The user sees " +
          "the draft and can change it before it's saved, and the result says what they saved or that they " +
          "didn't. A skill with the name of an existing one replaces it.",
        input_schema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'A short name the user would say, like "Check the sprint board".' },
            when_to_use: {
              type: 'string',
              description: 'When to use it, from the user\'s side, like "when I ask what\'s left in the sprint".'
            },
            start_url: { type: 'string', description: 'The page it starts on, if it starts on one.' },
            steps: { type: 'string', description: 'What to do, as numbered steps.' }
          },
          required: ['name', 'steps']
        },
        run: async (input, ctx) => {
          let saved
          try {
            saved = await this.skills.propose(
              { name: input.name, whenToUse: input.when_to_use, startUrl: input.start_url, steps: input.steps },
              ctx.signal
            )
          } catch (err) {
            return text(err instanceof Error ? err.message : String(err), true)
          }
          if (!saved) return text(ctx.signal?.aborted ? 'Cancelled by the user.' : "The user decided not to save it.")
          return text(
            [
              `The user saved the skill “${saved.name}”. As saved:`,
              `When to use it: ${saved.whenToUse || '(not given)'}`,
              `Start page: ${saved.startUrl || '(none)'}`,
              'Steps:',
              saved.steps
            ].join('\n')
          )
        }
      },
      {
        name: 'search_history',
        group: 'History',
        description:
          "Searches the user's browsing history in this app: pages visited in project tabs and pinned sites, newest " +
          "first, with when they were visited. Without a query it lists recent visits. Covers this chat's project " +
          'unless all_projects is true.',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Words in the page title or address.' },
            all_projects: { type: 'boolean', description: 'Search every project and pinned site, not just this one.' },
            before: { type: 'string', description: 'Only visits before this date and time (ISO 8601), to go further back.' },
            limit: { type: 'integer', description: `How many to return, up to 100. Defaults to ${DEFAULT_LIMIT}.` }
          }
        },
        run: (input, ctx) => {
          const before = str(input.before) ? Date.parse(str(input.before)!) : undefined
          const entries = this.store.searchHistory({
            query: str(input.query),
            projectId: input.all_projects === true ? undefined : ctx.projectId,
            before: before && Number.isFinite(before) ? before : undefined,
            limit: num(input.limit, DEFAULT_LIMIT, 100) || DEFAULT_LIMIT
          })
          if (entries.length === 0) return text('No visits found.')
          const names = new Map(this.projects.list().map((p) => [p.id, labelOf(p)]))
          const lines = entries.map((e) => {
            const where = e.siteName ?? (e.projectId ? names.get(e.projectId) : undefined)
            return `- ${when(e.visitedAt)} · ${e.title || '(untitled)'} — ${e.url}${where && input.all_projects === true ? ` (${where})` : ''}`
          })
          return {
            result: { content: [{ type: 'text', text: websiteContent('browsing history', lines.join('\n')) }] },
            fromWebsites: '*'
          }
        }
      },
      {
        name: 'search_chats',
        group: 'Chats',
        description:
          "Searches the user's earlier chats in this app for words, and returns the best matches with the text " +
          "around them. Covers this chat's project unless all_projects is true.",
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Words to look for.' },
            all_projects: { type: 'boolean', description: 'Search chats in every project.' },
            limit: { type: 'integer', description: `How many chats to return, up to 50. Defaults to 10.` }
          },
          required: ['query']
        },
        run: (input, ctx) => {
          const query = str(input.query)
          if (!query) return text('Give some words to search for.', true)
          const hits = this.store.searchChats(query, {
            projectId: input.all_projects === true ? undefined : ctx.projectId,
            limit: num(input.limit, 10, 50) || 10
          })
          if (hits.length === 0) return text('No chats matched.')
          const names = new Map(this.projects.list().map((p) => [p.id, labelOf(p)]))
          const lines = hits.map(
            (h) =>
              `- "${h.title || 'Untitled chat'}"${input.all_projects === true ? (h.projectId === DEFAULT_PROJECT_ID ? ' outside projects' : ` in ${names.get(h.projectId) ?? 'a deleted project'}`) : ''}, ${when(h.at)}: ${h.snippet.replace(/\s+/g, ' ')}`
          )
          return text(lines.join('\n'))
        }
      }
    ]
  }

  /** Sorted by name so the tool list, and the prompt cache prefix, stays the same. */
  definitions(): Array<{ name: string; group: string; description: string; input_schema: InputSchema }> {
    return this.tools
      .filter((t) => t.available?.() ?? true)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, group, description, input_schema }) => ({ name, group, description, input_schema }))
  }

  has(name: string): boolean {
    return this.tools.some((t) => t.name === name)
  }

  /**
   * The website a tool acts on as the user would, which needs the user's OK like a website's own
   * tools (and shares their "Always allow"). Reading doesn't count; operating the page does.
   */
  siteFor(name: string, input: Record<string, unknown>, ctx: LocalToolContext): ActingOn | undefined {
    if (name !== 'browse') return undefined
    const siteId = str(input.site_id)
    if (siteId) {
      const site = this.sites.get(siteId)
      return site && { id: site.id, name: site.name, host: this.sites.currentHost(site.id), autoApprove: site.autoApprove }
    }
    const tab = this.projects.tabSource(str(input.project_id) ?? ctx.projectId, str(input.tab_id))
    return tab && { ...tab, host: tab.name }
  }

  /** Opening a page is where data could leave through an address, so it can need the user's OK. */
  navigationTarget(name: string, input: Record<string, unknown>): string | undefined {
    const url = name === 'open_page' && str(input.url) ? toUrl(str(input.url)!) : undefined
    // A project's own page sends nothing anywhere by being opened.
    return url && !isPageUrl(url) ? url : undefined
  }

  async run(name: string, input: Record<string, unknown>, ctx: LocalToolContext): Promise<LocalToolOutcome> {
    const tool = this.tools.find((t) => t.name === name)
    if (!tool) return text(`Unknown tool ${name}`, true)
    try {
      return await tool.run(input, ctx)
    } catch (err) {
      return text(err instanceof Error ? err.message : String(err), true)
    }
  }

  private async readSite(id: string): Promise<PageText> {
    if (!this.sites.get(id)) throw new Error('No pinned site with that id. They are listed in <pinned_sites>.')
    return { ...(await this.projects.readContents(await this.sites.contents(id))), tabId: '' }
  }

  private project(id: string | undefined): ReturnType<ProjectManager['list']>[number] | undefined {
    return id ? this.projects.list().find((p) => p.id === id) : undefined
  }
}

/**
 * Keeps a record of each browse run when TIDEPOOL_BROWSE_TRACE names a folder: the task, how it
 * ended, what it cost and Jev's view of every step, one JSON line per run, for finding out why
 * runs go the way they do. It stays on this machine, and typed values in sensitive fields stay out.
 */
function saveTrace(task: string, outcome: BrowseResult): void {
  const dir = process.env.TIDEPOOL_BROWSE_TRACE
  if (!dir) return
  const at = new Date().toISOString()
  const { status, detail, usage, trace } = outcome
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, `browse-${at.slice(0, 10)}.jsonl`), JSON.stringify({ at, task, status, detail, usage, trace }) + '\n')
  } catch (err) {
    console.warn('browse trace not saved:', err instanceof Error ? err.message : err)
  }
}

/** What browse tells Claude: how it ended and what to do about it, the steps, and where it is now. */
function browseReport(outcome: BrowseResult, where: string): string {
  const next: Record<BrowseResult['status'], string> = {
    done: 'Check the page text below (or read_page) to confirm, then tell the user.',
    needs_text: 'Call browse again with the text for that field in texts, or ask the user for it.',
    irreversible:
      'Ask the user before going further. If they agree, call browse again with allow_irreversible: true, which allows that one action.',
    left_site: 'If the task needs this site too, call browse again to continue here; the user will be asked about this site.',
    unsure: 'Take it from here: read_page, then call browse with a narrower task, or tell the user.',
    stuck: 'Try read_page to see why, then a different or narrower task.',
    out_of_steps: 'Check where it got to; call browse again to continue if it was making progress.',
    error: 'Tell the user what went wrong.'
  }
  const lines = [
    `Status: ${outcome.status}. ${outcome.detail}`,
    `Next: ${next[outcome.status]}`,
    '',
    outcome.steps.length ? 'Steps:' : 'No steps taken.',
    ...outcome.steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    `Now on: ${outcome.title || '(untitled)'} — ${outcome.url} (${where})`,
    '',
    outcome.text || '(no text)'
  ]
  return lines.join('\n')
}
