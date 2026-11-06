import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import electronPath from 'electron'
import { _electron } from 'playwright-core'

// End-to-end test for the app's own tools: Claude opening and reading pages in a project's tabs,
// the check before opening a page after reading website content, browsing history (recorded,
// searched by Claude, and in the History window), searching earlier chats, and each project's
// memory. A mock Claude API scripts the tool calls. No network or API key.
// Run `npm run build` first. On Linux CI, wrap with `xvfb-run -a`.
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-assistant-out-'))

// MARK: - A small website

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  if (req.url.startsWith('/b')) return res.end('<title>Beta page</title><h1>Beta</h1><p>The second page.</p>')
  res.end(`<title>Alpha page</title><h1>Alpha</h1>
    <p>The secret phrase is tangerine.</p>
    <script>document.title = 'Alpha page'</script>
    <a href="/b">Go to beta</a>`)
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const SITE = `http://127.0.0.1:${site.address().port}`

// MARK: - Mock Claude API

const requests = []
/** What was sent when memory was suggested from browsing. */
const memoryPrompts = []
/** One function per API request, (request) => content blocks. Unscripted requests end the turn. */
let script = []
const api = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    const request = JSON.parse(body)
    // Memory suggested from browsing: one canned note, and the prompt kept to check what was sent.
    if (String(request.system ?? '').startsWith('You suggest memory notes')) {
      memoryPrompts.push(request.messages[0].content)
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        id: 'msg_m', type: 'message', role: 'assistant', model: request.model, stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify({ suggestions: [{ note: 'Is looking up kumquat recipes.', file: 'Interests', reason: '2 searches' }] }) }],
        usage: { input_tokens: 1, output_tokens: 1 }
      }))
    }
    // Naming a new chat, or anything else asked of Claude Haiku on the side.
    if (String(request.system ?? '').startsWith('Write a title') || request.output_config?.format) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        id: 'msg_t', type: 'message', role: 'assistant', model: request.model, stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: request.output_config ? '{"suggestions":[]}' : 'A test chat' }], usage: { input_tokens: 1, output_tokens: 1 }
      }))
    }
    requests.push(request)
    let blocks
    try {
      blocks = script.shift()?.(request) ?? [{ type: 'text', text: 'END' }]
    } catch (err) {
      blocks = [{ type: 'text', text: `SCRIPT ERROR ${err.message}` }]
    }
    const events = [
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }
    ]
    blocks.forEach((b, index) => {
      if (b.type === 'text') {
        events.push(
          { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } }
        )
      } else {
        events.push(
          { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } },
          { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } }
        )
      }
      events.push({ type: 'content_block_stop', index })
    })
    const stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
    events.push(
      { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' }
    )
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    res.end()
  })
})
await new Promise((r) => api.listen(0, '127.0.0.1', r))

/** Calls one of the app's tools (or memory) by name, as Claude would. */
const call = (name, input) => (request) => {
  if (!(request.tools ?? []).some((t) => t.name === name)) {
    throw new Error(`${name} wasn't offered; tools: ${(request.tools ?? []).map((t) => t.name)}`)
  }
  return [{ type: 'tool_use', id: `toolu_${name}_${requests.length}`, name, input }]
}
/** The text of the tool results Claude got back in a request. */
const resultsOf = (request) =>
  request.messages.at(-1).content.filter((b) => b.type === 'tool_result').map((b) =>
    typeof b.content === 'string' ? b.content : b.content.map((c) => c.text).join('')
  )

// MARK: - App

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-assistant-'))
fs.writeFileSync(path.join(userDataDir, 'mcp.json'), JSON.stringify({ mcpServers: {} }))
const logs = []
const app = await _electron.launch({
  executablePath: electronPath,
  args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `${REPO}/out/main/index.js`, `--user-data-dir=${userDataDir}`],
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: 'test-key',
    TIDEPOOL_E2E: '1',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.address().port}`
  }
})
app.process().stderr.on('data', (d) => logs.push(String(d)))
const win = await app.firstWindow()
// The chat and the dock live in overlays: pages of their own, drawn above websites (src/main/overlays.ts).
const overlayPage = async (app, name, timeout = 10000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    for (const page of app.windows()) if (page.url() === 'about:blank' && (await page.title()) === name) return page
  }
  throw new Error(`the ${name} overlay never opened`)
}
const chatWin = await overlayPage(app, 'chat')
const dockWin = await overlayPage(app, 'dock')
win.on('pageerror', (e) => logs.push(`[renderer] ${e.message}\n`))

let failed = false
const step = async (name, fn) => {
  try {
    await fn()
    console.log('PASS', name)
  } catch (e) {
    failed = true
    console.log('FAIL', name, '-', e.message.split('\n')[0])
    await win.screenshot({ path: `${OUT}/fail-${name.replace(/\W+/g, '_')}.png` }).catch(() => {})
  }
}
const assert = (cond, message) => {
  if (!cond) throw new Error(message)
}
const until = async (fn, label, ms = 10000) => {
  for (const start = Date.now(); Date.now() - start < ms; await win.waitForTimeout(100)) if (await fn()) return
  throw new Error(`timed out: ${label}`)
}
const turnsEnded = () => chatWin.locator('.msg.assistant', { hasText: 'END' }).count()
/** Sends a message and waits for the turn to finish (the mock replies END when the script runs out). */
const chat = async (text, steps = [], during = async () => {}) => {
  const before = await turnsEnded()
  script = steps
  if (!(await win.locator('.layout.chat-open').count())) await dockWin.getByRole('button', { name: 'Show chat' }).click()
  await chatWin.getByPlaceholder('Message Tidepool…').fill(text)
  await chatWin.keyboard.press('Enter')
  await during()
  await until(async () => (await turnsEnded()) > before, `turn for "${text}" to end`, 20000)
}
const projectTabs = win.locator('.tab-row')
const projects = () => win.evaluate(() => window.api.projects.list())
/** Opens a project's active tab from the sidebar (its Home when it has none), or Everyday's first tab (Home when it has none). */
const openSpace = async (name) => {
  if (name === 'Everyday') {
    const tab = win.locator('.everyday .tab-row')
    if (await tab.count()) await tab.first().locator('.tab-main').click()
    else await win.locator('.sidebar').getByRole('button', { name: 'Home', exact: true }).click()
    return
  }
  await win.locator('.project-row', { hasText: name }).locator('.tab-main').click()
  const project = (await win.evaluate(() => window.api.projects.list())).find((p) => p.name === name)
  if (project.activeTabId) await win.locator(`.project-strip .project-tab[data-tab-id="${project.activeTabId}"]`).click()
}

try {
  await dockWin.locator('.dock').waitFor()

  await step("Claude gets the app's tools and knows the chat's project", async () => {
    await chat('Plan: the kumquat launch is on Friday')
    const r = requests.at(-1)
    const names = r.tools.map((t) => t.name)
    for (const tool of ['list_projects', 'open_project', 'list_tabs', 'open_page', 'read_page', 'close_tab', 'search_history', 'search_chats', 'memory', 'web_search']) {
      assert(names.includes(tool), `${tool} missing: ${names}`)
    }
    assert(r.tools.find((t) => t.name === 'memory').type === 'memory_20250818', 'memory tool type')
    assert(/^web_search_2026/.test(r.tools.find((t) => t.name === 'web_search').type), 'web search type')
    assert(r.system.includes('<app_context>') && r.system.includes('This chat is in Everyday'), 'app context missing from the system prompt')
  })

  await step("open_page opens a tab in the chat's project, without asking", async () => {
    await chat('open alpha', [call('open_page', { url: `${SITE}/a` })])
    await projectTabs.filter({ hasText: 'Alpha page' }).waitFor({ timeout: 10000 })
    assert((await chatWin.locator('.approval').count()) === 0, 'it asked, with nothing read yet')
    const general = (await projects()).find((p) => p.name === 'General')
    assert(general.tabs.some((t) => t.url === `${SITE}/a`), 'the tab is not in General')
  })

  await step("read_page returns the page's text, marked as the website's", async () => {
    await chat('what does it say?', [call('read_page', {})])
    const [text] = resultsOf(requests.at(-1))
    assert(text.includes('tangerine'), `page text missing: ${text.slice(0, 200)}`)
    assert(text.startsWith('<website_content'), 'not marked as website content')
    assert(text.includes(`${SITE}/b`), 'links missing')
  })

  await step('after reading a page, opening another asks first, and Deny stops it', async () => {
    await chat('read it then go to beta', [call('read_page', {}), call('open_page', { url: `${SITE}/b` })], async () => {
      await chatWin.locator('.approval', { hasText: 'Open this page?' }).waitFor({ timeout: 10000 })
      assert(await chatWin.locator('.approval-url', { hasText: `${SITE}/b` }).count(), 'the address is not shown')
      await chatWin.locator('.approval').getByRole('button', { name: 'Deny' }).click()
    })
    const [text] = resultsOf(requests.at(-1))
    assert(/declined/.test(text), `result: ${text}`)
    assert(!(await projectTabs.filter({ hasText: 'Beta page' }).count()), 'it opened anyway')
  })

  await step('Open lets it through', async () => {
    await chat('try again', [call('read_page', {}), call('open_page', { url: `${SITE}/b` })], async () => {
      await chatWin.locator('.approval', { hasText: 'Open this page?' }).waitFor({ timeout: 10000 })
      await chatWin.locator('.approval').getByRole('button', { name: 'Open' }).click()
    })
    await projectTabs.filter({ hasText: 'Beta page' }).waitFor({ timeout: 10000 })
  })

  await step('a new turn starts trusted again', async () => {
    await chat('open alpha again', [call('open_page', { url: `${SITE}/a?again` })])
    assert((await chatWin.locator('.approval').count()) === 0, 'it asked in a turn that read nothing')
  })

  await step('visits go in history, and Claude can search it', async () => {
    await chat('when did I see alpha?', [call('search_history', { query: 'alpha' })])
    const [text] = resultsOf(requests.at(-1))
    assert(text.includes('Alpha page') && text.includes(`${SITE}/a`), `history result: ${text}`)
    assert(!text.includes('Beta page'), 'the search matched pages it should not')
  })

  await step('the History window lists visits, searches, and opens them', async () => {
    await win.locator('.sidebar').getByRole('button', { name: /^Library/ }).click()
    await win.locator('.library-tabs').getByRole('tab', { name: /^History/ }).click()
    const rows = win.locator('.history-row')
    await rows.filter({ hasText: 'Beta page' }).waitFor({ timeout: 5000 })
    await rows.filter({ hasText: 'Alpha page' }).first().waitFor({ timeout: 5000 })
    await win.locator('.history-day', { hasText: 'Today' }).waitFor({ timeout: 5000 })
    await win.screenshot({ path: `${OUT}/history.png` })
    await win.getByLabel('Search history').fill('beta')
    await until(async () => (await rows.count()) === 1, 'the search to narrow it to Beta')
    const before = (await projects()).find((p) => p.name === 'General').tabs.length
    await rows.first().locator('.history-open').click()
    await win.locator('.library-modal').waitFor({ state: 'detached', timeout: 5000 })
    await until(async () => (await projects()).find((p) => p.name === 'General').tabs.length === before + 1, 'a tab to open')
  })

  await step('removing a visit and clearing history', async () => {
    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+y' : 'Control+y')
    const rows = win.locator('.history-row')
    await rows.first().waitFor({ timeout: 5000 })
    const count = await rows.count()
    await rows.first().hover()
    await rows.first().locator('.history-remove').click()
    await until(async () => (await rows.count()) === count - 1, 'the row to go')
    win.once('dialog', (d) => void d.accept())
    await win.getByRole('button', { name: 'Clear history…' }).click()
    await win.locator('.history-empty').waitFor({ timeout: 5000 })
    await win.keyboard.press('Escape')
    const left = await win.evaluate(() => window.api.history.search({}))
    assert(left.length === 0, `${left.length} visits left`)
  })

  await step('Claude can search earlier chats', async () => {
    await win.locator('.sidebar').getByRole('button', { name: 'New chat', exact: true }).click()
    await chat('when is the launch?', [call('search_chats', { query: 'kumquat' })])
    const [text] = resultsOf(requests.at(-1))
    assert(/kumquat/i.test(text) && text.includes('A test chat'), `chat search result: ${text}`)
  })

  await step("memory: Claude's notes are saved in the project, and shown there", async () => {
    await chat('remember I like tangerines', [
      call('memory', { command: 'create', path: '/memories/preferences.md', file_text: 'Likes tangerines\n' })
    ])
    const [text] = resultsOf(requests.at(-1))
    assert(text === 'File created successfully at: /memories/preferences.md', `create: ${text}`)
    await chat('what do you remember?', [call('memory', { command: 'view', path: '/memories' })])
    const [listing] = resultsOf(requests.at(-1))
    assert(listing.includes('/memories/preferences.md'), `listing: ${listing}`)
    await win.locator('.sidebar').getByRole('button', { name: /^Library/ }).click()
    await win.locator('.library-tabs').getByRole('tab', { name: /^Memory/ }).click()
    await win.locator('.memory-file', { hasText: 'preferences.md' }).click()
    const editor = win.getByLabel('Contents of /memories/preferences.md')
    assert((await editor.inputValue()).includes('Likes tangerines'), 'contents not shown')
    await editor.fill('Likes tangerines and kumquats\n')
    await win.locator('.library-modal').getByRole('button', { name: 'Save', exact: true }).click()
    await win.screenshot({ path: `${OUT}/memory.png` })
    await win.keyboard.press('Escape')
    await chat('read it', [call('memory', { command: 'view', path: '/memories/preferences.md' })])
    const [file] = resultsOf(requests.at(-1))
    assert(file.includes('     1\tLikes tangerines and kumquats'), `file view: ${file}`)
  })

  await step('memory: paths outside /memories are refused', async () => {
    await chat('sneaky', [call('memory', { command: 'view', path: '/memories/../etc' })])
    const [text] = resultsOf(requests.at(-1))
    assert(/not allowed|outside/.test(text), `traversal result: ${text}`)
  })

  await step("memory and chats belong to their project; others can't see them", async () => {
    await win.evaluate(() => window.api.projects.create('Other'))
    await openSpace('Other')
    await win.locator('.sidebar-label', { hasText: 'Chats in Other' }).waitFor({ timeout: 5000 })
    await chat('what do you remember here?', [call('memory', { command: 'view', path: '/memories' })])
    const [listing] = resultsOf(requests.at(-1))
    assert(!listing.includes('preferences.md'), `Other sees General's memory: ${listing}`)
    assert(requests.at(-1).system.includes('project "Other"'), 'the prompt names the wrong project')
    await chat('find the launch', [call('search_chats', { query: 'kumquat' })])
    assert(/No chats matched/.test(resultsOf(requests.at(-1))[0]), "Other's chat search found General's chats")
    await chat('find it anywhere', [call('search_chats', { query: 'kumquat', all_projects: true })])
    assert(/outside projects/.test(resultsOf(requests.at(-1))[0]), 'all_projects did not find it')
  })

  await step('list_projects marks the chat’s project', async () => {
    await chat('what projects are there?', [call('list_projects', {})])
    const [text] = resultsOf(requests.at(-1))
    assert(/Other \(id: [^)]+\) · \d+ tabs? · this chat/.test(text) && text.includes('Everyday (id: general)'), `projects: ${text}`)
  })
  await step('memory is suggested from browsing, and only what the user adds goes in', async () => {
    await win.evaluate(() => window.api.settings.update({ memoryExcludedSites: [] }))
    await openSpace('Everyday')
    await win.evaluate((url) => window.api.projects.newTab('general', url), `${SITE}/a?q=kumquat+recipes`)
    await until(async () => (await win.evaluate(() => window.api.history.search({ query: 'Alpha' }))).length > 0, 'the visit to be recorded')
    await win.locator('.sidebar').getByRole('button', { name: /^Library/ }).click()
    await win.locator('.library-tabs').getByRole('tab', { name: /^Memory/ }).click()
    const group = win.locator('.memory-group').first()
    await group.getByRole('button', { name: 'Suggest from browsing' }).click()
    await win.locator('.memory-suggestion', { hasText: 'Is looking up kumquat recipes.' }).waitFor({ timeout: 10000 })
    const card = win.locator('.memory-suggestion').first()
    const prompt = memoryPrompts.at(-1)
    assert(prompt.includes('"kumquat recipes" on 127.0.0.1'), `the typed search wasn't sent: ${prompt}`)
    assert(!prompt.includes('secret phrase') && !prompt.includes('The second page'), 'page text was sent')
    assert(/<website_content site="127\.0\.0\.1">\s*Alpha page/.test(prompt), 'page titles should be marked as the website\'s')
    // The sidebar counts what's waiting.
    await win.locator('.sidebar').getByRole('button', { name: 'Library (1 to review)' }).waitFor({ state: 'attached', timeout: 5000 })
    await win.locator('.sidebar-footer').screenshot({ path: `${OUT}/sidebar-footer.png` })
    await card.getByRole('button', { name: 'Edit' }).click()
    await card.getByLabel('Suggested note').fill('Likes kumquat recipes.')
    await card.getByRole('button', { name: 'Add to memory' }).click()
    await card.waitFor({ state: 'detached', timeout: 5000 })
    const files = await win.evaluate(() => window.api.memory.list('general'))
    const interests = files.find((f) => f.path === '/memories/interests.md')
    assert(interests?.content.includes('- Likes kumquat recipes.'), `interests.md: ${JSON.stringify(files)}`)
    await win.screenshot({ path: `${OUT}/memory-suggestions.png` })
    // Browsed again, the same thing isn't looked at twice; excluded sites aren't looked at at all.
    // (A tab only loads while it's on screen, so the dialog closes first.)
    await win.keyboard.press('Escape')
    await win.locator('.library-modal').waitFor({ state: 'detached', timeout: 5000 })
    await win.evaluate(() => window.api.settings.update({ memoryExcludedSites: ['127.0.0.1'] }))
    await win.evaluate((url) => window.api.projects.newTab('general', url), `${SITE}/b?q=secret+search`)
    await until(async () => (await win.evaluate(() => window.api.history.search({ query: 'Beta' }))).length > 0, 'the second visit')
    const sent = memoryPrompts.length
    await win.locator('.sidebar').getByRole('button', { name: /^Library/ }).click()
    await win.locator('.library-tabs').getByRole('tab', { name: /^Memory/ }).click()
    await group.getByRole('button', { name: 'Suggest from browsing' }).click()
    await win.locator('.memory-group', { hasText: 'Nothing new to suggest' }).first().waitFor({ timeout: 5000 })
    assert(memoryPrompts.length === sent, 'an excluded site was sent')
    await win.keyboard.press('Escape')
  })

  await step('Remember this page saves a note to memory', async () => {
    await win.evaluate(() => window.api.settings.update({ memoryExcludedSites: [] }))
    await openSpace('Everyday')
    await win.getByRole('button', { name: 'Remember this page' }).click()
    const box = win.getByLabel('What to remember')
    assert((await box.inputValue()).includes(`${SITE}/b`), `prefilled with ${await box.inputValue()}`)
    await box.fill('Beta page, for the launch')
    await win.getByRole('button', { name: 'Remember', exact: true }).click()
    await box.waitFor({ state: 'detached', timeout: 5000 })
    const files = await win.evaluate(() => window.api.memory.list('general'))
    const saved = files.find((f) => f.path === '/memories/saved-pages.md')
    assert(/^- Beta page, for the launch \(saved /.test(saved?.content ?? ''), `saved-pages.md: ${saved?.content}`)
  })
} finally {
  await app.close().catch(() => {})
  site.close()
  api.close()
  fs.writeFileSync(`${OUT}/logs.txt`, logs.join(''))
  console.log(`Screenshots and logs: ${OUT}`)
  if (failed) process.exitCode = 1
}
