import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron } from 'playwright-core'

// End-to-end smoke test: launches the built app against a mock Anthropic API and the example
// todo-board MCP server, then drives the Add Server UI, the agent loop, and the MCP App bridge.
// Run `npm run build` first. On Linux CI, wrap with `xvfb-run -a`.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-e2e-out-'))
const requests = []
/** Chat-naming requests to Claude Haiku, kept apart from the chat's. */
const titleRequests = []

// Mock Anthropic Messages API (streaming)
const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  res.end()
}
const start = (id) => ({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 40 } } })
// A tiny website for the browser tests. It signs you in with a persistent cookie, like a real
// site would, and remembers the headers it was sent.
const siteRequests = []
const serveSite = (req, res) => {
  if (!req.url.startsWith('/site')) {
    res.writeHead(404)
    return res.end()
  }
  siteRequests.push({ url: req.url, headers: req.headers })
  const second = req.url.startsWith('/site/page2')
  if (req.url.startsWith('/site/signin')) {
    res.writeHead(200, { 'content-type': 'text/html' })
    return res.end('<!doctype html><title>Sign-in page</title><body><h1>Sign in</h1></body>')
  }
  res.writeHead(200, {
    'content-type': 'text/html',
    'set-cookie': 'session=signed-in; Max-Age=86400; Path=/; HttpOnly'
  })
  res.end(`<!doctype html><title>${second ? 'Second page' : 'Test Site'}</title>
<body><h1>${second ? 'Second page' : 'Test Site'}</h1><a id="next" href="/site/page2">Next</a>
<p><a id="signin" href="/site/signin" target="_blank">Sign in</a></p>
<p><a id="elsewhere" href="http://localhost:${req.headers.host.split(':')[1]}/site/page2" target="_blank">Elsewhere</a></p></body>`)
}
const api = http.createServer((req, res) => {
  if (req.method === 'GET') return serveSite(req, res)
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const json = JSON.parse(body || '{}')
    if (String(json.system ?? '').startsWith('Write a title')) {
      titleRequests.push(json)
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ id: 'msg_t', type: 'message', role: 'assistant', model: json.model, stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: '"Todo board check-in."' }], usage: { input_tokens: 1, output_tokens: 1 } }))
    }
    requests.push({ url: req.url, headers: req.headers, body: json })
    const last = json.messages?.at(-1)
    const hasToolResult = Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_result')
    const text = Array.isArray(last?.content) ? last.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : ''
    if (!hasToolResult && /board/i.test(text) && !/suggest/i.test(text)) {
      const tool = json.tools.find((t) => t.name.endsWith('show_todo_board'))
      return sse(res, [start('m1'),
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Opening your board.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: tool.name, input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } },
        { type: 'message_stop' }])
    }
    if (/long answer/i.test(text)) {
      const lines = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of a long streamed answer.\n\n`)
      const events = [start('m3'), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        ...lines.map((line) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: line } })),
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 600 } },
        { type: 'message_stop' }]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let i = 0
      const tick = setInterval(() => {
        const e = events[i++]
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        if (i === events.length) { clearInterval(tick); res.end() }
      }, 40)
      return
    }
    const reply = hasToolResult
      ? 'Here is your **todo board**.'
      : /step/i.test(text)
        ? 'Step one is reading the spec.'
        : 'Start with reading the spec.'
    sse(res, [start('m2'),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: 'message_stop' }])
  })
})
await new Promise((r) => api.listen(0, '127.0.0.1', r))
const port = api.address().port

// --user-data-dir keeps the test off the real profile and works on every platform,
// unlike XDG_CONFIG_HOME, which macOS ignores.
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-'))
// Scripted speech: tests/fake-speech-helper.mjs reads what to "say" from here.
const speechControl = path.join(userDataDir, 'fake-speech')
const say = (mode) => fs.writeFileSync(speechControl, mode)
const launchOptions = {
  executablePath: electronPath,
  args: [
    ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    `${REPO}/out/main/index.js`,
    `--user-data-dir=${userDataDir}`
  ],
  env: {
    ...process.env,
    TIDEPOOL_E2E: '1', // open without taking focus from whoever is using the machine
    TIDEPOOL_SIGNIN_HOSTS: `127.0.0.1:${port}`, // the test site's "sign in" link counts as a sign-in page
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    TIDEPOOL_SPEECH_HELPER: `${REPO}/tests/fake-speech-helper.mjs`,
    FAKE_SPEECH_CONTROL: speechControl
  }
}
const logs = []
let app, win, chatWin, dockWin, voiceWin
// The chat and the dock live in overlays: pages of their own, drawn above websites (src/main/overlays.ts).
const overlayPage = async (app, name, timeout = 10000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    for (const page of app.windows()) if (page.url() === 'about:blank' && (await page.title()) === name) return page
  }
  throw new Error(`the ${name} overlay never opened`)
}
const launch = async () => {
  app = await _electron.launch(launchOptions)
  app.process().stderr.on('data', (d) => logs.push(String(d)))
  app.process().stdout.on('data', (d) => logs.push('[stdout] ' + String(d)))
  app.process().on('exit', (code, signal) => logs.push(`[main exited] code=${code} signal=${signal}\n`))
  win = await app.firstWindow()
  chatWin = await overlayPage(app, 'chat')
  dockWin = await overlayPage(app, 'dock')
  // The mic is in the dock while the chat is closed, and in the chat's message box while it's open.
  voiceWin = chatWin
  win.on('console', (m) => logs.push('[renderer] ' + m.text()))
}
await launch()
/** A pinned site's tile, found by its name (tiles show just the icon); `state` is a class like '.active'. */
const pinTile = (name, state = '') => win.locator(`.pin-tile${state}`, { has: win.locator(`[aria-label="${name}"]`) })
/** Waits for a project (its row is marked) or Everyday's active tab to be what's on screen. */
const spaceOnScreen = async (name) => {
  if (name === 'Everyday') await win.locator('.everyday .tab-row.active').waitFor({ timeout: 5000 })
  else await win.locator('.project-row.active', { hasText: name }).waitFor({ timeout: 5000 })
}
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
// The chat window starts closed; the action bar's chat button opens it.
const until = async (check, what, timeout = 5000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await check()) return
  throw new Error(what)
}
/** An overlay's native view: where it is in the window, whether it shows, and its place in the stack. */
const overlayView = (name = 'chat') =>
  app.evaluate(({ BaseWindow }, name) => {
    const views = BaseWindow.getAllWindows()[0].contentView.children
    const isOverlay = (v, n) => v.webContents?.getURL() === 'about:blank' && v.webContents.getTitle() === n
    const i = views.findIndex((v) => isOverlay(v, name))
    const topSite = views.findLastIndex((v) => v.webContents && v.getVisible() && !v.webContents.getURL().startsWith('about:'))
    const chat = views.findIndex((v) => isOverlay(v, 'chat'))
    return i < 0 ? null : { bounds: views[i].getBounds(), visible: views[i].getVisible(), aboveSites: i > topSite, aboveChat: i > chat }
  }, name)
const openChat = async () => {
  if (!(await win.locator('.layout.chat-open').count())) await dockWin.getByRole('button', { name: 'Show chat' }).click()
  await chatWin.locator('.composer textarea').waitFor({ state: 'visible', timeout: 5000 })
}
const step = async (name, fn) => { try { await fn(); console.log('PASS', name) } catch (e) { console.log('FAIL', name, e.message.split('\n')[0]); await win.screenshot({ path: `${OUT}/fail-${name.replace(/\W+/g, '_')}.png` }); await chatWin?.screenshot({ path: `${OUT}/fail-${name.replace(/\W+/g, '_')}-chat.png` }).catch(() => {}); await dockWin?.screenshot({ path: `${OUT}/fail-${name.replace(/\W+/g, '_')}-dock.png` }).catch(() => {}); throw e } }

try {
  await step('MCP servers live in Settings', async () => {
    await win.locator('.sidebar').getByRole('button', { name: 'Settings' }).click()
    await win.locator('.settings-nav').getByRole('button', { name: 'MCP servers' }).click()
    await win.getByRole('button', { name: '+ Add server' }).click()
  })
  await step('add local server via form', async () => {
    await win.getByPlaceholder('e.g. my-server').fill('todo-board')
    await win.getByRole('button', { name: 'Local (command)' }).click()
    await win.getByPlaceholder('npx').fill('node')
    await win.getByPlaceholder('-y @modelcontextprotocol/server-everything').fill(`${REPO}/examples/todo-app-server.mjs`)
    await win.getByRole('button', { name: 'Add server' }).click()
    await win.locator('.server-card', { hasText: 'todo-board' }).locator('text=4 tools').waitFor({ timeout: 20000 })
  })
  await step('validation: bad URL rejected', async () => {
    await win.getByRole('button', { name: '+ Add server' }).click()
    await win.getByPlaceholder('e.g. my-server').fill('remote-one')
    await win.getByPlaceholder('https://example.com/mcp').fill('not a url')
    await win.getByRole('button', { name: 'Add server' }).click()
    await win.locator('text=Enter a full URL').waitFor({ timeout: 3000 })
  })
  await step('add remote server with header (unreachable → error status)', async () => {
    await win.getByPlaceholder('https://example.com/mcp').fill('http://127.0.0.1:9/mcp')
    await win.getByPlaceholder('Authorization: Bearer your-token').fill('Authorization: Bearer abc')
    await win.getByRole('button', { name: 'Add server' }).click()
    await win.locator('.server-card', { hasText: 'remote-one' }).locator('.dot.error').waitFor({ timeout: 20000 })
    const cfg = JSON.parse(fs.readFileSync(path.join(userDataDir, 'mcp.json'), 'utf8'))
    if (cfg.mcpServers['remote-one'].headers.Authorization !== 'Bearer abc') throw new Error('header not saved: ' + JSON.stringify(cfg))
    if (cfg.mcpServers['todo-board'].args[0] !== `${REPO}/examples/todo-app-server.mjs`) throw new Error('args not saved')
  })
  await step('disable toggle + remove', async () => {
    const card = win.locator('.server-card', { hasText: 'remote-one' })
    await card.locator('.switch').click()
    await card.locator('text=· disabled').waitFor({ timeout: 5000 })
    win.once('dialog', (d) => d.accept())
    await card.getByRole('button', { name: 'Remove' }).click()
    await card.waitFor({ state: 'detached', timeout: 5000 })
  })
  await win.screenshot({ path: `${OUT}/servers-modal.png` })
  await win.keyboard.press('Escape')

  await step('chat → tool call → MCP App renders', async () => {
    await openChat()
    await chatWin.getByPlaceholder('Message Tidepool…').fill('Show my todo board')
    await chatWin.keyboard.press('Enter')
    await chatWin.locator('text=Here is your').waitFor({ timeout: 15000 })
    const outer = chatWin.frameLocator('.app-frame iframe')
    const inner = outer.frameLocator('iframe')
    await inner.locator('text=Read the MCP Apps spec').waitFor({ timeout: 15000 })
    await inner.locator('text=1 open · 1 done').waitFor({ timeout: 5000 })
  })
  const inner = chatWin.frameLocator('.app-frame iframe').frameLocator('iframe')
  // Playwright waits for an element to stop moving inside its own frame, not for the frame
  // itself to stop moving in the page. Entering or leaving fullscreen re-lays out the window
  // (sidebar, dock), so a click inside the app right after can land where the button used to
  // be. Wait until the frame holds still across two animation frames first.
  const frameSettled = () =>
    chatWin.waitForFunction(
      () =>
        new Promise((resolve) => {
          const el = document.querySelector('.app-frame iframe')
          const a = el.getBoundingClientRect()
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const b = el.getBoundingClientRect()
              resolve(a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)
            })
          )
        }),
      null,
      { timeout: 5000 }
    )
  const clickInApp = async (locator) => {
    await frameSettled()
    await locator.click()
  }
  await step('app calls server tools (add + app-only clear)', async () => {
    await inner.getByPlaceholder('Add a todo…').fill('Ship the client')
    await clickInApp(inner.getByRole('button', { name: 'Add' }))
    await inner.locator('text=Ship the client').waitFor({ timeout: 5000 })
    await clickInApp(inner.getByRole('button', { name: /Clear done/ }))
    await inner.locator('text=2 open · 0 done').waitFor({ timeout: 5000 })
  })
  await step('app iframe grew to content height', async () => {
    const h = await chatWin.locator('.app-frame iframe').evaluate((el) => el.getBoundingClientRect().height)
    if (h <= 120) throw new Error('height still ' + h)
  })
  await win.screenshot({ path: `${OUT}/app-rendered.png` })
  await step('app requests fullscreen, host offers a way out', async () => {
    await clickInApp(inner.getByRole('button', { name: 'Fullscreen' }))
    await chatWin.locator('.app-frame.fullscreen').waitFor({ timeout: 5000 })
    // The exit control must be visible, on top of the app, and actually clickable.
    const exit = chatWin.getByRole('button', { name: /exit fullscreen/i })
    await exit.waitFor({ state: 'visible', timeout: 5000 })
    await win.screenshot({ path: `${OUT}/fullscreen.png` })
    // Playwright clicks are injected into the renderer and bypass macOS window-drag
    // regions, so a click here passing does not prove a real one would. Assert the
    // geometry instead: the button must opt out of the drag region it sits on.
    const region = await exit.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('-webkit-app-region').trim()
    )
    if (region !== 'no-drag') {
      throw new Error(`exit button is in a "${region}" region; the OS would swallow real clicks`)
    }
    // The app fills the space beside the sidebar rather than covering it, which also keeps its
    // bar clear of the macOS window buttons.
    const sidebar = await win.locator('.sidebar').boundingBox()
    const bar = await chatWin.locator('.app-frame-bar').boundingBox()
    if (!sidebar || !(await win.locator('.sidebar').isVisible())) throw new Error('sidebar hidden by a fullscreen app')
    // The app is in the chat's overlay, so its coordinates start at the overlay's corner.
    const offset = (await overlayView()).bounds
    if (bar.x + offset.x < sidebar.x + sidebar.width - 1) throw new Error(`app (left ${bar.x + offset.x}) covers the sidebar (right ${sidebar.x + sidebar.width})`)
    await exit.click({ timeout: 5000 })
    await chatWin.locator('.app-frame.fullscreen').waitFor({ state: 'detached', timeout: 5000 })
    // The app must be told, so its own toggle stays in sync.
    await inner.locator('body[data-display-mode="inline"]').waitFor({ timeout: 5000 })
    await inner.getByRole('button', { name: 'Fullscreen' }).waitFor({ timeout: 5000 })
  })
  await step('Escape also leaves fullscreen', async () => {
    await clickInApp(inner.getByRole('button', { name: 'Fullscreen' }))
    await inner.locator('body[data-display-mode="fullscreen"]').waitFor({ timeout: 5000 })
    await chatWin.locator('.app-frame.fullscreen').waitFor({ timeout: 5000 })
    await win.keyboard.press('Escape')
    await chatWin.locator('.app-frame.fullscreen').waitFor({ state: 'detached', timeout: 5000 })
  })
  await step('ui/message posts into chat with model context', async () => {
    await clickInApp(inner.getByRole('button', { name: 'Ask Claude to prioritize' }))
    await chatWin.locator('text=sent by MCP App').waitFor({ timeout: 5000 })
    await chatWin.locator('text=Start with reading the spec.').waitFor({ timeout: 10000 })
    const lastReq = requests.at(-1).body
    const blocks = lastReq.messages.at(-1).content
    if (!blocks.some((b) => b.type === 'text' && b.text.includes('<app_context') && b.text.includes('Ship the client')))
      throw new Error('app context missing: ' + JSON.stringify(blocks).slice(0, 300))
  })
  await step('chat stays available beside a fullscreen app', async () => {
    await clickInApp(inner.getByRole('button', { name: 'Fullscreen' }))
    await inner.locator('body[data-display-mode="fullscreen"]').waitFor({ timeout: 5000 })
    await win.locator('.layout.chat-open.app-fullscreen').waitFor({ timeout: 5000 })
    await win.screenshot({ path: `${OUT}/fullscreen-docked.png` })

    // The app and the chat window sit side by side rather than on top of each other.
    const app = await chatWin.locator('.app-frame.fullscreen').boundingBox()
    const composer = await chatWin.locator('.composer').boundingBox()
    if (!app || !composer) throw new Error('app or composer not laid out')
    if (app.x + app.width > composer.x + 1) throw new Error(`app (right ${app.x + app.width}) overlaps chat (left ${composer.x})`)

    const input = chatWin.getByPlaceholder('Ask about this app…')
    await input.fill('What is step one?')
    await chatWin.keyboard.press('Enter')
    await chatWin.locator('text=Step one is reading the spec.').waitFor({ timeout: 10000 })
    // Asking a question must not knock the app out of fullscreen.
    await inner.locator('body[data-display-mode="fullscreen"]').waitFor({ timeout: 2000 })
    await chatWin.locator('.app-frame.fullscreen').waitFor({ timeout: 2000 })
  })
  await step('chat can be hidden to give the app the whole window', async () => {
    await chatWin.getByRole('button', { name: 'Minimize chat' }).click()
    await win.locator('.layout.app-fullscreen:not(.chat-open)').waitFor({ timeout: 5000 })
    const inOverlay = await chatWin.locator('.app-frame.fullscreen').boundingBox()
    const offset = (await overlayView()).bounds
    const app = inOverlay && { ...inOverlay, x: inOverlay.x + offset.x, y: inOverlay.y + offset.y }
    const viewport = await win.evaluate(() => window.innerWidth)
    const sidebar = await win.locator('.sidebar').boundingBox()
    if (!app || Math.abs(app.x + app.width - viewport) > 2 || Math.abs(app.x - sidebar.width) > 2)
      throw new Error(`app spans ${app?.x}–${app && app.x + app.width}, expected ${sidebar.width}–${viewport}`)
    if (await chatWin.locator('.composer textarea').isVisible()) throw new Error('composer still visible')
    // The dock (the mic and the way back to the chat) floats over a fullscreen app.
    const dock = await overlayView('dock')
    if (!dock?.visible || !dock.aboveChat) throw new Error(`dock not above the app: ${JSON.stringify(dock)}`)
    await dockWin.getByRole('button', { name: 'Show chat' }).click()
    await win.locator('.layout.chat-open.app-fullscreen').waitFor({ timeout: 5000 })
    await chatWin.getByRole('button', { name: /exit fullscreen/i }).click()
    await win.locator('.layout.app-fullscreen').waitFor({ state: 'detached', timeout: 5000 })
    await inner.locator('body[data-display-mode="inline"]').waitFor({ timeout: 5000 })
  })
  const scroller = chatWin.locator('.scroll')
  const distanceFromBottom = () => scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
  await step('streaming reply is followed while at the bottom', async () => {
    await chatWin.getByPlaceholder('Message Tidepool…').fill('Give me a long answer')
    await chatWin.keyboard.press('Enter')
    await chatWin.locator('text=Line 60 of a long streamed answer.').waitFor({ timeout: 15000 })
    await win.waitForTimeout(300)
    const d = await distanceFromBottom()
    if (d > 48) throw new Error(`fell behind the stream: ${d}px from the bottom`)
    if (await chatWin.locator('.jump-to-latest').isVisible()) throw new Error('jump button shown while at bottom')
  })
  await step('scrolling up mid-stream stops the follow', async () => {
    await chatWin.getByPlaceholder('Message Tidepool…').fill('Another long answer please')
    await chatWin.keyboard.press('Enter')
    // Wait until this reply has started streaming, then scroll away from the bottom.
    await chatWin.locator('.msg.assistant').last().locator('text=Line 3 of a long streamed answer.').waitFor({ timeout: 15000 })
    await scroller.evaluate((el) => { el.scrollTop = 0 })
    await chatWin.locator('.msg.assistant').last().locator('text=Line 60 of a long streamed answer.').waitFor({ timeout: 15000 })
    const top = await scroller.evaluate((el) => el.scrollTop)
    if (top > 5) throw new Error(`yanked back down to ${top}px while reading above`)
    await chatWin.locator('.jump-to-latest').waitFor({ timeout: 2000 })
    await chatWin.locator('.jump-to-latest').click()
    const d = await distanceFromBottom()
    if (d > 48) throw new Error(`jump to latest left us ${d}px from the bottom`)
    await chatWin.locator('.jump-to-latest').waitFor({ state: 'detached', timeout: 2000 })
  })
  const composerBox = chatWin.locator('.composer textarea')
  const userMessages = chatWin.locator('.msg.user .bubble')
  const talk = voiceWin.getByRole('button', { name: 'Talk to Tidepool' })
  const replyDone = () => chatWin.locator('.composer .stop').waitFor({ state: 'detached', timeout: 15000 })
  // The app's CSP forbids eval, so the check is data, not code.
  const composerValue = ({ equals, startsWith }, timeout = 5000) =>
    chatWin.waitForFunction(
      ({ equals, startsWith }) => {
        const v = document.querySelector('.composer textarea').value
        return equals !== undefined ? v === equals : v.startsWith(startsWith)
      },
      { equals, startsWith },
      { timeout }
    )

  await step('voice: speaking sends the message by itself', async () => {
    const before = await userMessages.count()
    say('speak:How long do I simmer the queso?')
    await talk.click()
    await voiceWin.locator('.voice-card', { hasText: 'Listening' }).waitFor({ timeout: 5000 })
    await chatWin.waitForFunction((n) => document.querySelectorAll('.msg.user .bubble').length === n, before + 1, { timeout: 10000 })
    const sent = await userMessages.last().innerText()
    if (sent !== 'How long do I simmer the queso?') throw new Error(`sent "${sent}"`)
    if ((await composerBox.inputValue()) !== '') throw new Error('composer not cleared')
    await talk.waitFor({ timeout: 5000 })
    await replyDone()
  })
  await step('voice: tapping the mic sends early', async () => {
    const before = await userMessages.count()
    say('endless')
    await talk.click()
    await composerValue({ startsWith: 'How long do I' })
    await win.screenshot({ path: `${OUT}/voice-listening.png` })
    await voiceWin.locator('.voice-card', { hasText: 'Listening' }).waitFor({ timeout: 5000 })
    await voiceWin.getByRole('button', { name: 'Send what you said' }).click()
    await chatWin.waitForFunction((n) => document.querySelectorAll('.msg.user .bubble').length === n, before + 1, { timeout: 5000 })
    if (!(await userMessages.last().innerText()).startsWith('How long do I')) throw new Error('wrong text sent')
    await replyDone()
  })
  await step('voice: pressing Send while listening sends once', async () => {
    const before = await userMessages.count()
    say('endless')
    await talk.click()
    await composerValue({ startsWith: 'How long do I' })
    await chatWin.locator('.composer').getByRole('button', { name: 'Send', exact: true }).click()
    await chatWin.waitForFunction((n) => document.querySelectorAll('.msg.user .bubble').length === n, before + 1, { timeout: 5000 })
    await replyDone()
    // The helper's final transcript arrives after the click; it must not post a second copy.
    await win.waitForTimeout(800)
    const after = await userMessages.count()
    if (after !== before + 1) throw new Error(`sent ${after - before} messages`)
  })
  await step('voice: words the recognizer drops at the end still go out', async () => {
    const before = await userMessages.count()
    say('lose-final:What goes with queso')
    await talk.click()
    await chatWin.waitForFunction((n) => document.querySelectorAll('.msg.user .bubble').length === n, before + 1, { timeout: 10000 })
    const sent = await userMessages.last().innerText()
    if (sent !== 'What goes with queso') throw new Error(`sent "${sent}"`)
    await replyDone()
  })
  await step('voice: the shortcut starts and sends, even with a website focused', async () => {
    const before = await userMessages.count()
    say('endless')
    await win.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+Space`)
    await composerValue({ startsWith: 'How long do I' })
    // Pressed again in a plain page, standing in for a website: nothing there relays keys to the
    // app, so it only works if the main process catches it first.
    await app.evaluate(async ({ BrowserWindow }) => {
      const page = new BrowserWindow({ show: false })
      await page.loadURL('data:text/html,<input autofocus>')
      page.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space', modifiers: [process.platform === 'darwin' ? 'meta' : 'control', 'shift'] })
      setTimeout(() => page.destroy(), 500)
    })
    await chatWin.waitForFunction((n) => document.querySelectorAll('.msg.user .bubble').length === n, before + 1, { timeout: 5000 })
    await replyDone()
  })
  await step('voice: cancel keeps what was typed and sends nothing', async () => {
    const before = await userMessages.count()
    await composerBox.fill('Typed first')
    say('endless')
    await talk.click()
    await composerValue({ startsWith: 'Typed first How' })
    await voiceWin.locator('.voice-card').getByRole('button', { name: 'Cancel' }).click()
    await composerValue({ equals: 'Typed first' })
    await talk.waitFor({ timeout: 5000 })
    if ((await userMessages.count()) !== before) throw new Error('cancel sent a message')
    await composerBox.fill('')
  })
  await step('voice: a permission problem says how to fix it', async () => {
    say('denied')
    await talk.click()
    await voiceWin.getByRole('alert').filter({ hasText: 'Microphone access is off.' }).waitFor({ timeout: 5000 })
    // Present, but not clicked: it would open System Settings on the machine running the test.
    await voiceWin.getByRole('button', { name: 'Open Microphone settings' }).waitFor({ timeout: 2000 })
    await voiceWin.getByRole('alert').getByRole('button', { name: 'Dismiss' }).click()
    await voiceWin.getByRole('alert').waitFor({ state: 'detached', timeout: 2000 })
  })
  await step('voice: speaking while Claude answers sends right after', async () => {
    const before = await userMessages.count()
    await composerBox.fill('Give me a long answer')
    await chatWin.keyboard.press('Enter')
    await chatWin.locator('.composer .stop').waitFor({ timeout: 5000 })
    say('speak:And what about the peppers?')
    await talk.click()
    // Heard while the reply is still streaming, so it waits in the box...
    await composerValue({ equals: 'And what about the peppers?' })
    if (!(await chatWin.locator('.composer .stop').isVisible())) throw new Error('reply finished too early to test queueing')
    // ...and goes out on its own once the reply is done.
    await chatWin.waitForFunction((n) => document.querySelectorAll('.msg.user .bubble').length === n, before + 2, { timeout: 15000 })
    const sent = await userMessages.last().innerText()
    if (sent !== 'And what about the peppers?') throw new Error(`queued message sent as "${sent}"`)
    await replyDone()
  })
  const siteUrl = `http://127.0.0.1:${port}/site`
  // The site is a native view, not part of the page, so inspect it from the main process.
  const siteView = () =>
    app.evaluate(({ BaseWindow }) => {
      for (const w of BaseWindow.getAllWindows()) {
        const view = w.contentView.children.find((v) => v.webContents?.getURL().includes('/site'))
        if (view) {
          return { visible: view.getVisible(), bounds: view.getBounds(), url: view.webContents.getURL(), title: view.webContents.getTitle(), partition: view.webContents.session.storagePath }
        }
      }
      return null
    })
  const slotRect = () => win.locator('.web-view-slot').evaluate((el) => el.getBoundingClientRect().toJSON())
  const untilView = async (check, what, timeout = 5000) => {
    const end = Date.now() + timeout
    let last
    while (Date.now() < end) {
      last = await siteView()
      if (last && check(last)) return last
      await win.waitForTimeout(100)
    }
    throw new Error(`${what}; view is ${JSON.stringify(last)}`)
  }

  await step('web: pin a site from the sidebar', async () => {
    await win.locator('.sidebar').getByRole('button', { name: 'Pin a site' }).click()
    await win.getByPlaceholder('gmail.com', { exact: true }).fill(siteUrl)
    await win.getByPlaceholder('Gmail', { exact: true }).fill('Test Site')
    await win.locator('.modal').getByRole('button', { name: 'Pin site' }).click()
    await pinTile('Test Site', '.active').waitFor({ timeout: 5000 })
    await win.locator('.web-title', { hasText: 'Test Site' }).waitFor({ timeout: 10000 })
    const view = await untilView((v) => v.visible && v.title === 'Test Site', 'site never showed')
    // The native view sits exactly over the slot the page reserved for it.
    const slot = await slotRect()
    for (const k of ['x', 'y', 'width', 'height']) {
      if (Math.abs(view.bounds[k] - slot[k]) > 1) throw new Error(`view ${k} ${view.bounds[k]} != slot ${slot[k]}`)
    }
    if (!view.partition || view.partition === (await app.evaluate(({ session }) => session.defaultSession.storagePath))) {
      throw new Error('site is not in its own persistent profile')
    }
  })
  await step('web: the first page is the start of its history', async () => {
    // The site is the first page in its history.
    if (!(await win.getByRole('button', { name: 'Back', exact: true }).isDisabled())) throw new Error('Back is enabled on the first page')
  })
  await step('web: dialogs hide the site and bring it back', async () => {
    await win.getByRole('button', { name: 'Settings' }).click()
    await untilView((v) => !v.visible, 'site stayed on top of the Settings dialog')
    await win.keyboard.press('Escape')
    await untilView((v) => v.visible, 'site did not come back after the dialog closed')
  })
  // A real mouse click in the site. A scripted .click() has no user gesture, which changes how
  // Chromium treats the navigation it causes.
  const clickInSite = (selector) =>
    app.evaluate(async ({ BaseWindow }, selector) => {
      const view = BaseWindow.getAllWindows()[0].contentView.children.find((v) => v.getVisible() && v.webContents?.getURL().includes('/site'))
      const wc = view.webContents
      const r = await wc.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
      const at = { x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 }
      wc.sendInputEvent({ type: 'mouseDown', ...at })
      wc.sendInputEvent({ type: 'mouseUp', ...at })
    }, selector)

  await step('web: back and forward', async () => {
    // A real mouse click on the link. A scripted .click() has no user gesture, and Chromium
    // leaves such history entries out of Back/Forward (so sites can't trap the Back button).
    await app.evaluate(async ({ BaseWindow }) => {
      const view = BaseWindow.getAllWindows()[0].contentView.children.find((v) => v.webContents?.getURL().includes('/site'))
      const wc = view.webContents
      const r = await wc.executeJavaScript("(() => { const r = document.getElementById('next').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()")
      const at = { x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 }
      wc.sendInputEvent({ type: 'mouseDown', ...at })
      wc.sendInputEvent({ type: 'mouseUp', ...at })
    })
    await win.locator('.web-title', { hasText: 'Second page' }).waitFor({ timeout: 5000 })
    await win.getByRole('button', { name: 'Back', exact: true }).click()
    await win.locator('.web-title', { hasText: 'Test Site' }).waitFor({ timeout: 5000 })
    if (await win.getByRole('button', { name: 'Forward', exact: true }).isDisabled()) throw new Error('forward not enabled after going back')
  })
  await step('web: a new-tab sign-in link signs in here, not in the browser', async () => {
    await clickInSite('#signin')
    await win.locator('.web-title', { hasText: 'Sign-in page' }).waitFor({ timeout: 5000 })
    await untilView((v) => v.visible && v.url.includes('/site/signin'), 'sign-in did not open in the site view')
    await win.getByRole('button', { name: 'Back', exact: true }).click()
    await win.locator('.web-title', { hasText: 'Test Site' }).waitFor({ timeout: 5000 })
  })
  await step('web: the chat window floats over the site and can be hidden', async () => {
    await win.locator('.layout.chat-open.on-page').waitFor({ timeout: 5000 })
    const view = (await siteView()).bounds
    // The site keeps its whole slot; the chat is drawn over it, in a view stacked above.
    const slot = await slotRect()
    if (Math.abs(view.width - slot.width) > 1) throw new Error(`site ${view.width} wide in a ${slot.width} slot`)
    const overlay = await overlayView()
    if (!overlay?.visible || !overlay.aboveSites) throw new Error(`chat overlay not above the site: ${JSON.stringify(overlay)}`)
    const o = overlay.bounds
    if (o.x < view.x || o.x + o.width > view.x + view.width + 1 || o.y + o.height > view.y + view.height + 1)
      throw new Error(`chat overlay ${JSON.stringify(o)} is not over the site ${JSON.stringify(view)}`)
    await composerBox.fill('What is step one?')
    await chatWin.keyboard.press('Enter')
    await replyDone()
    await chatWin.getByRole('button', { name: 'Minimize chat' }).click()
    await win.locator('.layout.on-page:not(.chat-open)').waitFor({ timeout: 5000 })
    await until(async () => !(await overlayView()).visible, 'chat overlay still showing after hiding the chat')
    // The dock floats over the site too, in its bottom-right corner.
    const dock = await overlayView('dock')
    if (!dock?.visible || !dock.aboveSites) throw new Error(`dock not above the site: ${JSON.stringify(dock)}`)
    if (dock.bounds.x + dock.bounds.width > view.x + view.width + 1 || dock.bounds.y + dock.bounds.height > view.y + view.height + 1)
      throw new Error(`dock ${JSON.stringify(dock.bounds)} is not over the site ${JSON.stringify(view)}`)
    await dockWin.getByRole('button', { name: 'Show chat' }).click()
    await win.locator('.layout.chat-open.on-page').waitFor({ timeout: 5000 })
    await until(async () => (await overlayView()).visible, 'chat overlay did not come back')
  })
  await step('web: closing returns Home', async () => {
    await win.getByRole('button', { name: 'Close website' }).click()
    await win.locator('.web-pane').waitFor({ state: 'detached', timeout: 5000 })
    await win.waitForTimeout(300)
    if (await siteView()) throw new Error('site view still exists after closing its tab')
    // Like closing a tab: the page is unloaded, but the site stays in the sidebar.
    await pinTile('Test Site', '.asleep').waitFor({ timeout: 5000 })
    await win.locator('.sidebar .titlebar-button.active[aria-label="Home"]').waitFor({ timeout: 5000 })
  })

  // Project tabs are native views too; with several around, look at the one on screen.
  const shownView = () =>
    app.evaluate(({ BaseWindow }) => {
      const views = BaseWindow.getAllWindows()[0].contentView.children.filter((v) => v.webContents && !v.webContents.getURL().startsWith('about:'))
      const view = views.find((v) => v.getVisible())
      return {
        count: views.length,
        shown: view && { bounds: view.getBounds(), url: view.webContents.getURL(), title: view.webContents.getTitle() }
      }
    })
  const untilShown = async (check, what, timeout = 5000) => {
    const end = Date.now() + timeout
    let last
    while (Date.now() < end) {
      last = await shownView()
      if (last.shown && check(last.shown)) return last.shown
      await win.waitForTimeout(100)
    }
    throw new Error(`${what}; views are ${JSON.stringify(last)}`)
  }
  // A project's tabs, across the top of its page after its Home.
  const projectTabs = win.locator('.project-strip .project-tab[data-tab-id]')
  const projectHomeTab = win.locator('.project-strip .project-home-tab')

  await step('projects: a new project opens on its Home, whose box opens a page in a new tab', async () => {
    await win.locator('.sidebar').getByRole('button', { name: 'New project' }).click()
    await win.getByPlaceholder('Trip planning').fill('Research')
    await win.locator('.modal').getByRole('button', { name: 'Create project' }).click()
    await spaceOnScreen('Research')
    await win.locator('.project-home', { hasText: 'No chats in Research yet.' }).waitFor({ timeout: 5000 })
    if ((await projectHomeTab.getAttribute('aria-selected')) !== 'true') throw new Error('Home is not the selected tab')
    if (await projectHomeTab.getByRole('button', { name: /^Close/ }).count()) throw new Error('Home can be closed')
    if (await projectTabs.count()) throw new Error('a new project has tabs')
    await win.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Open a page in Research', null, { timeout: 5000 })
    await win.keyboard.type(siteUrl)
    await win.keyboard.press('Enter')
    await projectTabs.filter({ hasText: 'Test Site' }).waitFor({ timeout: 10000 })
    const view = await untilShown((v) => v.title === 'Test Site', 'tab never showed')
    const slot = await slotRect()
    for (const k of ['x', 'y', 'width', 'height']) {
      if (Math.abs(view.bounds[k] - slot[k]) > 1) throw new Error(`view ${k} ${view.bounds[k]} != slot ${slot[k]}`)
    }
  })
  await step('projects: a new-tab link opens a tab in the same project', async () => {
    await clickInSite('#signin')
    await projectTabs.filter({ hasText: 'Sign-in page' }).waitFor({ timeout: 5000 })
    if ((await projectTabs.count()) !== 2) throw new Error(`${await projectTabs.count()} tabs`)
    await untilShown((v) => v.title === 'Sign-in page', 'new tab is not the one showing')
    await projectTabs.filter({ hasText: 'Test Site' }).click()
    await untilShown((v) => v.title === 'Test Site', 'switching tabs did not switch the view')
    // Closing the active tab shows its neighbour. (Keeping the sign-in page also leaves the
    // pinned site as the only view at the site's first address, for the steps below.)
    await projectTabs.filter({ hasText: 'Test Site' }).getByRole('button', { name: /^Close/ }).click()
    await projectTabs.filter({ hasText: 'Test Site' }).waitFor({ state: 'detached', timeout: 5000 })
    await untilShown((v) => v.title === 'Sign-in page', 'closing the active tab did not show the next')
  })
  await step("projects: Home shows the project's page again, and a tab goes back to its page", async () => {
    await projectHomeTab.click()
    await win.locator('.project-home').waitFor({ timeout: 5000 })
    await until(async () => !(await shownView()).shown, 'the page stayed on screen over Home')
    await projectTabs.filter({ hasText: 'Sign-in page' }).click()
    await untilShown((v) => v.title === 'Sign-in page', 'the tab did not come back')
  })
  await step('projects: the address bar searches words', async () => {
    await win.locator('.project-strip').getByRole('button', { name: 'New tab', exact: true }).click()
    await win.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Address', null, { timeout: 5000 })
    // It goes at the top of the project's tabs.
    if ((await projectTabs.first().innerText()).trim() !== 'New tab') throw new Error('the new tab is not first')
    await win.getByLabel('Address').fill('two words')
    await win.getByLabel('Address').press('Enter')
    await untilShown((v) => v.url.startsWith('https://www.google.com/search?q=two%20words') || v.url.includes('q=two+words'), 'not searched', 10000).catch(async (e) => {
      // No network in some sandboxes: the tab still has to have been sent to the search URL.
      const tab = (await win.evaluate(() => window.api.projects.list())).find((p) => p.name === 'Research').tabs[0]
      if (!/google\.com\/search\?q=two(%20|\+)words/.test(tab.url)) throw e
    })
    await projectTabs.first().getByRole('button', { name: /^Close/ }).click()
  })
  await step('projects: the address bar fills in a site from history', async () => {
    await win.locator('.project-strip').getByRole('button', { name: 'New tab', exact: true }).click()
    await win.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Address', null, { timeout: 5000 })
    const host = `127.0.0.1:${port}`
    const box = () => win.getByLabel('Address').evaluate((el) => ({ value: el.value, start: el.selectionStart, end: el.selectionEnd }))
    const filled = (typed) => until(async () => {
      const b = await box()
      return b.value === host && b.start === typed.length && b.end === host.length
    }, `"${typed}" was not filled in to ${host}`)
    await win.keyboard.type('127.0')
    await filled('127.0')
    // Backspace takes the fill away, and typing brings it back.
    await win.keyboard.press('Backspace')
    if ((await box()).value !== '127.0') throw new Error(`Backspace left ${JSON.stringify(await box())}`)
    await win.keyboard.type('.')
    await filled('127.0.')
    await win.keyboard.press('Enter')
    await until(async () => {
      const tab = (await win.evaluate(() => window.api.projects.list())).find((p) => p.name === 'Research').tabs[0]
      return tab.url?.startsWith(`http://${host}/`)
    }, 'Enter did not go to the filled-in site')
    await projectTabs.first().getByRole('button', { name: /^Close/ }).click()
  })
  await step('projects: links from a pinned site open in the last-used project', async () => {
    await pinTile('Test Site').click()
    await untilShown((v) => v.url === siteUrl, 'pinned site did not open')
    await clickInSite('#elsewhere')
    await spaceOnScreen('Research')
    await projectTabs.filter({ hasText: 'Second page' }).waitFor({ timeout: 10000 })
    await untilShown((v) => v.url.startsWith('http://localhost:'), 'the link is not the tab showing')
    await win.screenshot({ path: `${OUT}/project.png` })
  })
  await step('projects: a pinned site hides when a project shows, and back', async () => {
    await pinTile('Test Site').click()
    await untilShown((v) => v.url === siteUrl, 'pinned site not showing')
    await openSpace('Research')
    await untilShown((v) => v.url.startsWith('http://localhost:'), 'project tab not showing')
    const visible = await app.evaluate(({ BaseWindow }) =>
      BaseWindow.getAllWindows()[0].contentView.children.filter((v) => v.webContents && v.getVisible() && !v.webContents.getURL().startsWith('about:')).length
    )
    if (visible !== 1) throw new Error(`${visible} views visible at once`)
  })
  await step('chats: each project has its own', async () => {
    // Opening Research moved the chat there, and it has none yet.
    await spaceOnScreen('Research')
    if (await win.locator('.sidebar .chat-row').count()) throw new Error('Research lists chats it does not have')
    await chatWin.getByPlaceholder('Message Tidepool…').fill('A research question')
    await chatWin.keyboard.press('Enter')
    await chatWin.locator('.msg.assistant', { hasText: 'Start with reading the spec.' }).last().waitFor({ timeout: 10000 })
    await win.locator('.sidebar .chat-row', { hasText: 'Todo board check-in' }).waitFor({ timeout: 5000 })
    // Back outside the project, the chat from there is still there.
    await openSpace('Everyday')
    await win.locator('.sidebar-label > span', { hasText: /^Chats$/ }).waitFor({ timeout: 5000 })
    if ((await win.locator('.sidebar .chat-row').count()) !== 1) throw new Error(`Chats outside projects lists ${await win.locator('.sidebar .chat-row').count()} chats`)
    await win.locator('.sidebar .chat-row').click()
    await chatWin.locator('text=Here is your').first().waitFor({ timeout: 5000 })
    await chatWin.locator('.app-frame iframe').first().waitFor({ timeout: 5000 })
  })
  await step('chats: the first exchange names the chat', async () => {
    await win.locator('.sidebar .chat-row', { hasText: 'Todo board check-in' }).first().waitFor({ timeout: 5000 })
    const t = titleRequests[0]
    if (t?.model !== 'claude-haiku-4-5') throw new Error(`title model ${t?.model}`)
    if (!t.messages[0].content.includes('Show my todo board')) throw new Error('title request lacks the message')
  })
  await step('chats: a new chat starts empty, and the old one reopens', async () => {
    await win.locator('.sidebar').getByRole('button', { name: 'New chat', exact: true }).click()
    await chatWin.locator('.empty').waitFor({ timeout: 5000 })
    await win.locator('.sidebar .chat-row', { hasText: 'Todo board check-in' }).click()
    await chatWin.locator('text=sent by MCP App').waitFor({ timeout: 5000 })
    await chatWin.locator('text=Step one is reading the spec.').first().waitFor({ timeout: 5000 })
    // Its history came back too: the next turn sends everything so far.
    const replies = await chatWin.locator('.msg.assistant').count()
    await chatWin.getByPlaceholder('Message Tidepool…').fill('And after that?')
    await chatWin.keyboard.press('Enter')
    await chatWin.locator('.msg.assistant').nth(replies).locator('.markdown').first().waitFor({ timeout: 10000 })
    await chatWin.locator('.composer .send.primary').waitFor({ timeout: 10000 })
    const sent = requests.at(-1).body.messages
    if (!sent.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('Show my todo board')))
      throw new Error('the reopened chat lost its history')
  })
  await step('chats: the Library lists every chat, and opens one', async () => {
    await win.locator('.sidebar').getByRole('button', { name: /^Library/ }).click()
    await win.locator('.library-tabs').getByRole('tab', { name: 'Chats' }).click()
    const rows = win.locator('.library-panel .history-row')
    // The one outside projects and the one in Research, whose row says so.
    await rows.nth(1).waitFor({ timeout: 5000 })
    await rows.filter({ hasText: 'Research' }).waitFor({ timeout: 5000 })
    await win.getByLabel('Search chats').fill('nothing like this')
    await win.locator('.library-panel', { hasText: 'No chats match.' }).waitFor({ timeout: 5000 })
    await win.getByLabel('Search chats').fill('')
    await rows.filter({ hasNotText: 'Research' }).getByRole('button').first().click()
    await win.locator('.modal').waitFor({ state: 'detached', timeout: 5000 })
    await chatWin.locator('text=sent by MCP App').waitFor({ timeout: 5000 })
  })
  await step('request shape', async () => {
    const r = requests[0]
    const b = r.body
    if (b.model !== 'claude-opus-5') throw new Error('model ' + b.model)
    if (b.tools.some((t) => t.name.endsWith('clear_done'))) throw new Error('app-only tool leaked to model')
    if (b.fallbacks !== 'default' || !String(r.headers['anthropic-beta']).includes('server-side-fallback-2026-07-01')) throw new Error('fallbacks missing')
    if (b.thinking?.type !== 'adaptive' || b.output_config?.effort !== 'high') throw new Error('thinking/effort ' + JSON.stringify([b.thinking, b.output_config]))
    const tr = requests[1].body.messages.at(-1).content[0]
    if (tr.type !== 'tool_result' || tr.tool_use_id !== 'toolu_1') throw new Error('tool_result shape')
    if (!b.system.includes('mcp_server_instructions')) throw new Error('server instructions missing')
  })
  await step('sidebar: its handle drags it wider, and pages come back after', async () => {
    const handle = win.getByRole('separator', { name: 'Resize sidebar' })
    const box = await handle.boundingBox()
    const before = (await win.locator('.sidebar').boundingBox()).width
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await win.mouse.down()
    await win.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 })
    await win.mouse.up()
    const after = (await win.locator('.sidebar').boundingBox()).width
    if (Math.abs(after - before - 60) > 2) throw new Error(`sidebar went from ${before} to ${after}, not 60 wider`)
    await win.locator('.sidebar-resize.dragging').waitFor({ state: 'detached', timeout: 5000 })
    await win.screenshot({ path: `${OUT}/sidebar-wide.png` })
  })
  await win.screenshot({ path: `${OUT}/final.png` })
  console.log(`Screenshots and logs: ${OUT}`)
  await app.close()
  await launch()
  await step('sidebar: its width survives a restart, and double-clicking the handle resets it', async () => {
    const width = async () => Math.round((await win.locator('.sidebar').boundingBox()).width)
    await until(async () => (await width()) === 308, 'the sidebar to come back 308 wide')
    await win.getByRole('separator', { name: 'Resize sidebar' }).dblclick()
    await until(async () => (await width()) === 248, 'the sidebar to go back to 248')
  })
  await step('web: sites and sign-ins survive a restart', async () => {
    await pinTile('Test Site').waitFor({ timeout: 10000 })
    const cookies = await app.evaluate(({ session }) =>
      session.fromPartition('persist:web').cookies.get({ name: 'session' })
    )
    if (cookies[0]?.value !== 'signed-in') throw new Error(`sign-in cookie lost: ${JSON.stringify(cookies)}`)
    await pinTile('Test Site').click()
    await untilView((v) => v.visible && v.title === 'Test Site', 'site did not reopen after restart')
  })
  await step('chats: saved chats reopen after a restart, apps and all', async () => {
    await win.locator('.sidebar-label > span', { hasText: /^Chats$/ }).waitFor({ timeout: 5000 })
    await win.locator('.sidebar .chat-row', { hasText: 'Todo board check-in' }).click()
    await chatWin.locator('text=Here is your').first().waitFor({ timeout: 5000 })
    await chatWin.locator('text=And after that?').waitFor({ timeout: 5000 })
    await chatWin.frameLocator('.app-frame iframe >> nth=0').frameLocator('iframe').locator('text=Read the MCP Apps spec').waitFor({ timeout: 15000 })
  })
  await step('projects: tabs survive a restart and load when shown', async () => {
    await openSpace('Research')
    // After the restart: this window's strip, not the one before it.
    const tabs = win.locator('.project-strip .project-tab[data-tab-id]')
    await tabs.filter({ hasText: 'Sign-in page' }).waitFor({ timeout: 5000 })
    await tabs.filter({ hasText: 'Second page' }).waitFor({ timeout: 5000 })
    const shown = await app.evaluate(({ BaseWindow }) => {
      const view = BaseWindow.getAllWindows()[0].contentView.children.find((v) => v.webContents && v.getVisible() && !v.webContents.getURL().startsWith('about:'))
      return view?.webContents.getURL()
    })
    // The tab that was active, and only that one, loads.
    const end = Date.now() + 10000
    let url = shown
    while (!url?.startsWith('http://localhost:') && Date.now() < end) {
      await win.waitForTimeout(100)
      url = await app.evaluate(({ BaseWindow }) =>
        BaseWindow.getAllWindows()[0].contentView.children.find((v) => v.webContents && v.getVisible() && !v.webContents.getURL().startsWith('about:'))?.webContents.getURL()
      )
    }
    if (!url?.startsWith('http://localhost:')) throw new Error(`showing ${url}`)
  })
  await step('sidebar: rename a project from its ⋯ menu', async () => {
    await win.locator('.project-row', { hasText: 'Research' }).hover()
    await win.locator('.sidebar').getByRole('button', { name: 'More for Research' }).click()
    await win.getByRole('menu', { name: 'Research' }).getByRole('menuitem', { name: 'Rename…' }).click()
    await win.locator('.modal input').fill('Reading')
    await win.locator('.modal').getByRole('button', { name: 'Rename' }).click()
    await win.locator('.project-row', { hasText: 'Reading' }).waitFor({ timeout: 5000 })
    if (await win.locator('.web-toolbar').getByRole('button', { name: /^Edit/ }).count()) throw new Error('an edit button is still in the page toolbar')
  })
  await step('sidebar: edit a pinned site from its right-click menu', async () => {
    await pinTile('Test Site').click({ button: 'right' })
    await win.getByRole('menu', { name: 'Test Site' }).getByRole('menuitem', { name: 'Edit…' }).click()
    await win.getByPlaceholder('Gmail', { exact: true }).fill('Renamed Site')
    await win.locator('.modal').getByRole('button', { name: 'Save' }).click()
    await pinTile('Renamed Site').waitFor({ timeout: 5000 })
    // Editing from the sidebar leaves you where you were.
    await spaceOnScreen('Reading')
  })
  await step('sidebar: a menu closes on Escape and a click elsewhere', async () => {
    const menu = win.getByRole('menu')
    await win.locator('.project-row', { hasText: 'Reading' }).hover()
    await win.locator('.sidebar').getByRole('button', { name: 'More for Reading' }).click()
    await menu.waitFor({ timeout: 5000 })
    await win.waitForTimeout(250) // past the menu's opening animation
    await win.screenshot({ path: `${OUT}/sidebar-menu.png` })
    await win.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached', timeout: 5000 })
    await win.locator('.project-row', { hasText: 'Reading' }).hover()
    await win.locator('.sidebar').getByRole('button', { name: 'More for Reading' }).click()
    await menu.waitFor({ timeout: 5000 })
    // Somewhere empty low in the sidebar, clear of the menu.
    const lists = await win.locator('.sidebar-lists').boundingBox()
    await win.mouse.click(lists.x + 20, lists.y + lists.height - 10)
    await menu.waitFor({ state: 'detached', timeout: 5000 })
  })
  await step('pinning a tab moves it to the pinned sites, page and all', async () => {
    // After the restart: this window's strip, not the one before it.
    const tabs = win.locator('.project-strip .project-tab[data-tab-id]')
    await tabs.filter({ hasText: 'Second page' }).click()
    await untilShown((v) => v.title === 'Second page', 'the tab to show')
    const before = await tabs.count()
    // Something only this page has, to tell it apart from a copy loaded fresh.
    const mark = (script) =>
      app.evaluate(({ BaseWindow }, script) => {
        const view = BaseWindow.getAllWindows()[0].contentView.children.find((v) => v.getVisible() && v.webContents?.getURL().includes('/site/page2'))
        return view?.webContents.executeJavaScript(script)
      }, script)
    await mark('window.pinnedMark = "same page"')
    await win.getByRole('button', { name: 'Pin this site' }).click()
    await pinTile('localhost', '.active').waitFor({ timeout: 5000 })
    // The pinned site is on screen now, not the project's strip, so count the project's tabs.
    const reading = async () => (await win.evaluate(() => window.api.projects.list())).find((p) => p.name === 'Reading').tabs.length
    await until(async () => (await reading()) === before - 1, 'the tab to leave the project')
    await untilShown((v) => v.title === 'Second page', 'the pinned site to show the page')
    const kept = await mark('window.pinnedMark')
    if (kept !== 'same page') throw new Error(`the pinned site is a new page (mark: ${kept})`)
    const views = (await shownView()).count
    win.once('dialog', (d) => void d.accept())
    await pinTile('localhost').click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Unpin' }).click()
    await pinTile('localhost').waitFor({ state: 'detached', timeout: 5000 })
    if ((await shownView()).count !== views - 1) throw new Error('unpinning left the page open')
  })
  await step('tabs move between projects and Everyday, from the menu and by dragging', async () => {
    const tabsIn = async (name) =>
      (await win.evaluate(() => window.api.projects.list())).find((p) => (name === 'Everyday' ? p.id === 'general' : p.name === name)).tabs.map((t) => t.title)
    const views = (await shownView()).count
    // Dragged from the project's tab strip into Everyday, in the sidebar.
    await openSpace('Reading')
    await win.locator('.project-strip .project-tab', { hasText: 'Sign-in page' }).dragTo(win.locator('.everyday'))
    await win.locator('.everyday .tab-row', { hasText: 'Sign-in page' }).waitFor({ timeout: 5000 })
    if ((await tabsIn('Reading')).includes('Sign-in page')) throw new Error('the tab is still in Reading')
    if ((await tabsIn('Everyday'))[0] !== 'Sign-in page') throw new Error(`Everyday is ${await tabsIn('Everyday')}`)
    // Dragged onto the project's row, it goes back, first in its tabs.
    await win.locator('.everyday .tab-row', { hasText: 'Sign-in page' }).dragTo(win.locator('.project-row', { hasText: 'Reading' }))
    await until(async () => (await tabsIn('Reading'))[0] === 'Sign-in page', 'the tab to go back to Reading')
    if ((await tabsIn('Everyday')).includes('Sign-in page')) throw new Error('the tab is still in Everyday')
    if ((await tabsIn('Reading'))[0] !== 'Sign-in page') throw new Error(`Reading is ${await tabsIn('Reading')}`)
    // The page moved with it rather than being closed and opened again.
    if ((await shownView()).count !== views) throw new Error('moving the tab closed or opened a page')
  })
  await step('sidebar: delete a project and unpin a site, after confirming', async () => {
    win.once('dialog', (d) => void d.dismiss())
    await win.locator('.project-row', { hasText: 'Reading' }).hover()
    await win.locator('.sidebar').getByRole('button', { name: 'More for Reading' }).click()
    await win.getByRole('menuitem', { name: 'Delete project' }).click()
    await win.waitForTimeout(300)
    if (!(await win.locator('.project-row', { hasText: 'Reading' }).count())) throw new Error('deleted without confirming')
    win.once('dialog', (d) => void d.accept())
    await win.locator('.project-row', { hasText: 'Reading' }).hover()
    await win.locator('.sidebar').getByRole('button', { name: 'More for Reading' }).click()
    await win.getByRole('menuitem', { name: 'Delete project' }).click()
    await win.locator('.project-row', { hasText: 'Reading' }).waitFor({ state: 'detached', timeout: 5000 })
    // The chat goes back outside projects, and the project's chats went with it.
    await win.locator('.sidebar-label > span', { hasText: /^Chats$/ }).waitFor({ timeout: 5000 })
    const chats = await win.evaluate(async () => {
      const projects = await window.api.projects.list()
      return (await Promise.all(projects.map((p) => window.api.chat.list(p.id)))).flat().length
    })
    if (chats !== 1) throw new Error(`${chats} chats left; the deleted project's should be gone`)
    // What isn't in a project isn't shown as one, so it can't be renamed or deleted.
    const rows = await win.locator('.project-row').count()
    if (rows) throw new Error(`${rows} projects listed; tabs outside projects aren't one`)
    const left = await app.evaluate(({ BaseWindow }) =>
      BaseWindow.getAllWindows()[0].contentView.children.filter((v) => v.webContents?.getURL().includes('localhost')).length
    )
    if (left) throw new Error(`${left} of the project's tab views are still around`)
    win.once('dialog', (d) => void d.accept())
    await pinTile('Renamed Site').click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Unpin' }).click()
    await pinTile('Renamed Site').waitFor({ state: 'detached', timeout: 5000 })
  })
  await step('settings: clearing one site signs out of it and no other', async () => {
    // The test site's storage, and another site's cookie that has to survive.
    await app.evaluate(async ({ BrowserWindow, session }, url) => {
      await session.fromPartition('persist:web').cookies.set({ url: 'https://example.org/', name: 'keep', value: '1', expirationDate: Date.now() / 1000 + 86400 })
      const page = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:web' } })
      await page.loadURL(url)
      await page.webContents.executeJavaScript(`localStorage.setItem('left', 'behind')`)
      page.destroy()
    }, `http://localhost:${port}/site`)
    await win.locator('.sidebar').getByRole('button', { name: 'Settings' }).click()
    await win.getByRole('button', { name: 'General' }).click()
    const find = win.getByPlaceholder('Find or type a site, e.g. example.com')
    await win.locator('.site-data-list .login-row', { hasText: 'example.org' }).waitFor({ timeout: 5000 })
    await find.fill('localhost')
    const row = win.locator('.site-data-list .login-row', { hasText: 'localhost' })
    await row.waitFor({ timeout: 5000 })
    win.once('dialog', (d) => void d.accept())
    await row.getByRole('button', { name: 'Clear' }).click()
    await win.getByText('Cleared localhost.').waitFor({ timeout: 5000 })
    const left = await app.evaluate(async ({ BrowserWindow, session }, url) => {
      const cookies = await session.fromPartition('persist:web').cookies.get({})
      const page = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:web' } })
      await page.loadURL(url)
      const stored = await page.webContents.executeJavaScript(`localStorage.getItem('left')`)
      page.destroy()
      return { cookies: cookies.map((c) => `${c.domain} ${c.name}`), stored }
    }, `http://localhost:${port}/site/signin`)
    if (left.cookies.some((c) => c.startsWith('localhost'))) throw new Error(`localhost cookies left: ${left.cookies}`)
    if (!left.cookies.includes('example.org keep')) throw new Error(`another site's cookie went too: ${left.cookies}`)
    if (left.stored !== null) throw new Error(`localhost's storage wasn't cleared: ${left.stored}`)
    await win.keyboard.press('Escape')
  })
} finally {
  fs.writeFileSync(`${OUT}/logs.txt`, logs.join(''))
  await app.close().catch(() => {})
  api.close()
}
