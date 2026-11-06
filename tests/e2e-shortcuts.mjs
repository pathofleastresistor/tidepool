import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import electronPath from 'electron'
import { _electron } from 'playwright-core'

// End-to-end test for keyboard shortcuts and the menu bar (src/shared/commands.ts): keys pressed
// in the app and in its overlays, commands picked from the menu (which is how keys reach the app
// while a website has the keyboard), Quick Open, find in page, zoom, closing and reopening tabs,
// the shortcuts sheet, and changing a shortcut in Settings. No network or API key.
// Run `npm run build` first. On Linux CI, wrap with `xvfb-run -a`.
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-shortcuts-out-'))
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

// MARK: - A small website

let siteLoads = 0
const site = http.createServer((req, res) => {
  siteLoads++
  res.writeHead(200, { 'content-type': 'text/html' })
  if (req.url.startsWith('/b')) return res.end('<title>Beta page</title><h1>Beta</h1>')
  res.end('<title>Alpha page</title><h1>Alpha</h1><p>The secret phrase is tangerine.</p>')
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const SITE = `http://127.0.0.1:${site.address().port}`

// MARK: - Mock Claude API: a short reply, or a slow one for "slow"

const api = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    const request = JSON.parse(body)
    if (String(request.system ?? '').startsWith('Write a title') || request.output_config?.format) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        id: 'msg_t', type: 'message', role: 'assistant', model: request.model, stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: request.output_config ? '{"suggestions":[]}' : 'A test chat' }], usage: { input_tokens: 1, output_tokens: 1 }
      }))
    }
    const text = request.messages.at(-1).content
    const said = typeof text === 'string' ? text : text.map((b) => b.text ?? '').join(' ')
    const slow = /slow/.test(said)
    const pieces = slow ? Array.from({ length: 60 }, (_, i) => `Word ${i}. `) : ['The answer is ', 'kumquat.']
    const events = [
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      ...pieces.map((p) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p } })),
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' }
    ]
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let i = 0
    const tick = setInterval(() => {
      if (res.destroyed) return clearInterval(tick)
      const e = events[i++]
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      if (i === events.length) {
        clearInterval(tick)
        res.end()
      }
    }, slow ? 150 : 1)
  })
})
await new Promise((r) => api.listen(0, '127.0.0.1', r))

// MARK: - App

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-shortcuts-'))
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
win.on('pageerror', (e) => logs.push(`[renderer] ${e.message}\n`))
const overlayPage = async (name, timeout = 10000) => {
  for (const end = Date.now() + timeout; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    for (const page of app.windows()) if (page.url() === 'about:blank' && (await page.title()) === name) return page
  }
  throw new Error(`the ${name} overlay never opened`)
}
const chatWin = await overlayPage('chat')

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
const until = async (fn, label, ms = 8000) => {
  for (const start = Date.now(); Date.now() - start < ms; await win.waitForTimeout(100)) if (await fn()) return
  throw new Error(`timed out: ${label}`)
}
const press = (keys, page = win) => page.keyboard.press(keys.replace('Mod', MOD))
/** A key that closes the overlay it's pressed in (Enter or Escape in Quick Open, say). */
const pressClosing = (keys, page) => page.keyboard.press(keys).catch((e) => {
  if (!/closed/i.test(e.message)) throw e
})
const projects = () => win.evaluate(() => window.api.projects.list())
const general = async () => (await projects()).find((p) => p.name === 'General')
/** A menu item, as the menu bar has it now. */
const menuItem = (id) =>
  app.evaluate(({ Menu }, id) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(id)
    return item ? { label: item.label, enabled: item.enabled, accelerator: item.accelerator ?? null } : null
  }, id)
/** Picks a command from the menu bar, as a key pressed on a website does. */
const clickMenu = (id) => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id).click(), id)
/** The website on screen: its address and zoom. */
const pageView = () =>
  app.evaluate(({ BaseWindow }) => {
    const view = BaseWindow.getAllWindows()[0].contentView.children.find(
      (v) => v.webContents && v.getVisible() && v.webContents.getURL().startsWith('http')
    )
    return view ? { url: view.webContents.getURL(), zoom: view.webContents.getZoomFactor() } : null
  })
const chatOpen = async () => (await win.locator('.layout.chat-open').count()) > 0
const focusedLabel = () => win.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? null)

try {
  // The first launch asks for nothing (the key comes from the environment), so Home is up.
  await win.locator('.home').waitFor({ timeout: 10000 })

  await step('the menu bar lists the commands, with their shortcuts', async () => {
    const labels = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((i) => i.label))
    for (const name of ['File', 'Edit', 'View', 'Chat', 'Go', 'Window']) assert(labels.includes(name), `no ${name} menu: ${labels}`)
    const newTab = await menuItem('tab.new')
    assert(newTab?.accelerator === 'CmdOrCtrl+T', `New Tab: ${JSON.stringify(newTab)}`)
    // Copy and paste only work in a custom menu if its Edit menu has them.
    const roles = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find((i) => i.label === 'Edit').submenu.items.map((i) => i.role))
    assert(roles.includes('copy') && roles.includes('paste'), `Edit roles: ${roles}`)
  })

  await step('with no page on screen, page commands are off (⌘R no longer reloads the app)', async () => {
    const reload = await menuItem('page.reload')
    assert(reload && !reload.enabled, `Reload Page: ${JSON.stringify(reload)}`)
    const loads = await win.evaluate(() => performance.getEntriesByType('navigation').length)
    await press('Mod+r')
    await win.waitForTimeout(300)
    assert((await win.locator('.home').count()) === 1, 'Home went away')
    assert((await win.evaluate(() => performance.getEntriesByType('navigation').length)) === loads, 'the app reloaded')
  })

  await step('⌘J shows and hides the chat, from the app and from the chat itself', async () => {
    assert(!(await chatOpen()), 'the chat started open')
    await press('Mod+j')
    await until(chatOpen, 'the chat to open')
    await chatWin.locator('.composer textarea').waitFor({ state: 'visible', timeout: 5000 })
    await press('Mod+j', chatWin)
    await until(async () => !(await chatOpen()), 'the chat to close from its own window')
  })

  await step('a command picked from the menu reaches the app', async () => {
    await clickMenu('chat.toggle')
    await until(chatOpen, 'the chat to open from the menu')
    assert((await menuItem('chat.toggle')).label === 'Hide Chat', 'the menu still says Show Chat')
    await clickMenu('chat.toggle')
    await until(async () => !(await chatOpen()), 'the chat to close from the menu')
  })

  await step('⌘T opens a tab waiting for an address, and ⌘L goes back to the address', async () => {
    await press('Mod+t')
    // A new tab shows Home until it has a page, with its search box as the address bar.
    await win.locator('.home').waitFor({ timeout: 5000 })
    await until(async () => (await focusedLabel()) === 'Address', 'the address bar to have the keyboard')
    await win.keyboard.type(`${SITE}/a`)
    await win.keyboard.press('Enter')
    await until(async () => (await pageView())?.url === `${SITE}/a`, 'the page to show')
    await win.locator('.sidebar-label', { hasText: 'Chats' }).click()
    await press('Mod+l')
    await until(async () => (await focusedLabel()) === 'Address', '⌘L to focus the address bar')
    await win.keyboard.press('Escape')
  })

  await step('page commands turn on with a page on screen, and act on it from the menu', async () => {
    await until(async () => (await menuItem('page.reload'))?.enabled, 'Reload Page to turn on')
    const before = siteLoads
    await clickMenu('page.reload')
    await until(async () => siteLoads > before, 'the page to reload')
  })

  await step('zoom is kept per site', async () => {
    await press('Mod+Equal')
    await until(async () => (await pageView())?.zoom === 1.1, 'the page to zoom in')
    const saved = JSON.parse(fs.readFileSync(path.join(userDataDir, 'zoom.json'), 'utf8'))
    assert(saved[new URL(SITE).host] === 1.1, `zoom.json: ${JSON.stringify(saved)}`)
    await press('Mod+0')
    await until(async () => (await pageView())?.zoom === 1, 'the zoom to reset')
  })

  await step('⌘F finds in the page', async () => {
    await press('Mod+f')
    const findWin = await overlayPage('find')
    await findWin.getByLabel('Find', { exact: true }).fill('tangerine')
    await findWin.locator('.find-count', { hasText: '1/1' }).waitFor({ timeout: 5000 })
    await findWin.screenshot({ path: `${OUT}/find.png` })
    await pressClosing('Escape', findWin)
    await until(async () => !(await overlayPage('find', 300).catch(() => null)), 'the find bar to close')
  })

  await step('tabs: next and previous, close with ⌘W, bring back with ⌘⇧T', async () => {
    await win.evaluate(async (url) => {
      const general = (await window.api.projects.list()).find((p) => p.name === 'General')
      await window.api.projects.newTab(general.id, url)
    }, `${SITE}/b`)
    await until(async () => (await general()).tabs.length === 2, 'a second tab')
    const active = async () => {
      const p = await general()
      return p.tabs.find((t) => t.id === p.activeTabId)?.url
    }
    assert((await active()) === `${SITE}/b`, 'the new tab is not active')
    await press('Control+Tab')
    await until(async () => (await active()) === `${SITE}/a`, 'Ctrl+Tab to go round to the first tab')
    await press('Control+Shift+Tab')
    await until(async () => (await active()) === `${SITE}/b`, 'Ctrl+Shift+Tab to go back')
    await press('Mod+w')
    await until(async () => (await general()).tabs.length === 1, '⌘W to close the tab')
    await until(async () => (await menuItem('tab.reopen'))?.enabled, 'Reopen Closed Tab to turn on')
    await press('Mod+Shift+t')
    await until(async () => (await general()).tabs.some((t) => t.url === `${SITE}/b`), '⌘⇧T to bring it back')
  })

  await step('⌘K goes anywhere', async () => {
    await press('Mod+Shift+h')
    await win.locator('.home').waitFor({ timeout: 5000 })
    await press('Mod+k')
    const quick = await overlayPage('quick-open')
    await quick.getByLabel('Search').waitFor({ timeout: 5000 })
    await until(() => quick.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Search'), 'the box to have the keyboard')
    await quick.keyboard.type('beta')
    await quick.locator('.quick-open-item[aria-selected="true"]', { hasText: 'Beta page' }).waitFor({ timeout: 5000 })
    await quick.screenshot({ path: `${OUT}/quick-open.png` })
    await pressClosing('Enter', quick)
    await until(async () => (await pageView())?.url === `${SITE}/b`, 'Quick Open to show the tab')
  })

  await step('⌘K runs commands too, and Escape closes it', async () => {
    await press('Mod+k')
    const quick = await overlayPage('quick-open')
    await quick.getByLabel('Search').fill('show or hide chat')
    await quick.locator('.quick-open-item[aria-selected="true"] kbd').waitFor({ timeout: 5000 })
    await pressClosing('Enter', quick)
    await until(chatOpen, 'the command to open the chat')
    await press('Mod+j')
    await until(async () => !(await chatOpen()), 'the chat to close')
    await press('Mod+k')
    const again = await overlayPage('quick-open')
    await again.getByLabel('Search').waitFor({ timeout: 5000 })
    await pressClosing('Escape', again)
    await until(async () => !(await overlayPage('quick-open', 300).catch(() => null)), 'Escape to close Quick Open')
  })

  await step('⌘1 goes to the first thing in the sidebar, ⌘⇧H to Home, and ⌘W on Home leaves the window be', async () => {
    // With no sites pinned, the first thing is Everyday, which shows its active tab.
    await press('Mod+Shift+h')
    await win.locator('.home').waitFor({ timeout: 5000 })
    await press('Mod+w')
    await win.waitForTimeout(300)
    assert(await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length === 1), 'the window closed')
    await press('Mod+1')
    await win.locator('.everyday .tab-row.active').waitFor({ timeout: 5000 })
  })

  await step('copy the last reply', async () => {
    const saved = await app.evaluate(({ clipboard }) => clipboard.readText())
    try {
      await press('Mod+n')
      await chatWin.locator('.composer textarea').waitFor({ state: 'visible', timeout: 5000 })
      await chatWin.locator('.composer textarea').fill('what fruit?')
      await chatWin.keyboard.press('Enter')
      await chatWin.locator('.msg', { hasText: 'The answer is kumquat.' }).waitFor({ timeout: 10000 })
      await press('Mod+Shift+Semicolon', chatWin)
      await until(async () => (await app.evaluate(({ clipboard }) => clipboard.readText())) === 'The answer is kumquat.', 'the reply on the clipboard')
    } finally {
      await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), saved)
    }
  })

  await step('Escape in the message box stops the reply', async () => {
    const box = chatWin.locator('.composer textarea')
    await box.fill('a slow one please')
    await chatWin.keyboard.press('Enter')
    await chatWin.locator('.send.stop').waitFor({ timeout: 5000 })
    await box.press('Escape')
    await chatWin.locator('.send.stop').waitFor({ state: 'detached', timeout: 5000 })
    assert(await chatOpen(), 'Escape closed the chat as well')
  })

  await step('find in the chat, when that is where you are', async () => {
    await chatWin.locator('.composer textarea').focus()
    await press('Mod+f', chatWin)
    const findWin = await overlayPage('find')
    assert((await findWin.getByLabel('Find', { exact: true }).getAttribute('placeholder')) === 'Find in chat', 'it is searching the page')
    await findWin.getByLabel('Find', { exact: true }).fill('kumquat')
    await findWin.locator('.find-count', { hasText: /^[1-9]\d*\/[1-9]/ }).waitFor({ timeout: 5000 })
    await pressClosing('Escape', findWin)
    await press('Mod+j')
    await until(async () => !(await chatOpen()), 'the chat to close')
  })

  await step('⌘/ lists the shortcuts; Escape closes just that', async () => {
    await press('Mod+Slash')
    const sheet = win.locator('.shortcuts-modal')
    await sheet.waitFor({ timeout: 5000 })
    assert((await sheet.locator('.shortcut-row', { hasText: 'New Tab' }).count()) === 1, 'New Tab is not listed')
    await win.screenshot({ path: `${OUT}/shortcuts.png` })
    await win.keyboard.press('Escape')
    await sheet.waitFor({ state: 'detached', timeout: 5000 })
  })

  await step('changing a shortcut in Settings', async () => {
    await press('Mod+Comma')
    await win.locator('.settings-nav').getByRole('button', { name: 'Keyboard' }).click()
    const recorder = win.getByRole('button', { name: 'Change the shortcut for New Tab' })
    // A shortcut that's taken is refused.
    await recorder.click()
    await win.keyboard.press(`${MOD}+j`)
    await win.locator('.key-error', { hasText: 'Show or Hide Chat' }).waitFor({ timeout: 5000 })
    // Escape while recording cancels it, and leaves Settings open.
    await recorder.click()
    await win.keyboard.press('Escape')
    assert((await win.locator('.settings-modal').count()) === 1, 'Escape closed Settings')
    await recorder.click()
    await win.keyboard.press(`${MOD}+Shift+u`)
    await until(async () => (await menuItem('tab.new'))?.accelerator === 'CmdOrCtrl+Shift+U', 'the menu to show the new shortcut')
    const saved = JSON.parse(fs.readFileSync(path.join(userDataDir, 'settings.json'), 'utf8'))
    assert(saved.keyBindings['tab.new'] === 'CmdOrCtrl+Shift+U', `saved: ${JSON.stringify(saved.keyBindings)}`)
    await win.screenshot({ path: `${OUT}/keyboard-settings.png` })
    await win.keyboard.press('Escape')
    await win.locator('.settings-modal').waitFor({ state: 'detached', timeout: 5000 })
    const before = (await general()).tabs.length
    await press('Mod+Shift+u')
    await until(async () => (await general()).tabs.length === before + 1, 'the new shortcut to open a tab')
    await win.keyboard.press('Escape')
    await press('Mod+t')
    await win.waitForTimeout(400)
    assert((await general()).tabs.length === before + 1, 'the old shortcut still opens tabs')
  })

  await step('Ctrl+Tab in a project goes round through its Home too', async () => {
    // A project with one tab: two places to go between, the tab and Home.
    await win.evaluate(async (url) => {
      const id = await window.api.projects.create('Trip')
      await window.api.projects.newTab(id, url)
    }, `${SITE}/a`)
    await press('Mod+2')
    const home = win.locator('.project-strip .project-home-tab')
    const tabShown = async () => (await pageView())?.url === `${SITE}/a`
    await until(tabShown, 'the project to show its tab')
    await press('Control+Tab')
    await until(async () => (await home.getAttribute('aria-selected')) === 'true', 'Ctrl+Tab to go round to Home')
    await until(async () => !(await tabShown()), 'the page to get out of the way of Home')
    await press('Control+Tab')
    await until(tabShown, 'Ctrl+Tab to go from Home to the tab')
    assert((await home.getAttribute('aria-selected')) === 'false', 'Home is still selected')
    await press('Control+Shift+Tab')
    await until(async () => (await home.getAttribute('aria-selected')) === 'true', 'Ctrl+Shift+Tab to go back to Home')
  })
} finally {
  await app.close().catch(() => {})
  site.close()
  api.close()
  fs.writeFileSync(`${OUT}/logs.txt`, logs.join(''))
  console.log(`Screenshots and logs: ${OUT}`)
  if (failed) process.exitCode = 1
}
