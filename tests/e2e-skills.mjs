import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import electronPath from 'electron'
import { _electron } from 'playwright-core'

// End-to-end test for skills (src/main/skills.ts): the user does something once, Claude drafts a
// skill from it (save_skill), the user reviews and saves it, and later asks for it again
// (use_skill), from the chat or the dock. A local site plays the team board and a mock Claude API
// scripts the tool calls. No network or API keys. Run `npm run build` first. On Linux CI, wrap
// with `xvfb-run -a`.
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-skills-out-'))

// MARK: - The site

const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  if (req.url.startsWith('/board')) return res.end('<title>Board</title><h1>Sprint board</h1><p>3 cards overdue</p>')
  res.end('<title>Elsewhere</title><h1>Somewhere else</h1>')
})
await new Promise((r) => site.listen(0, '127.0.0.1', r))
const BOARD = `http://127.0.0.1:${site.address().port}/board`
/** The same server under another host, as another site. */
const OTHER = `http://localhost:${site.address().port}/`

// MARK: - Mock Claude API

const requests = []
let script = []
const api = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    const request = JSON.parse(body)
    if (!request.stream) {
      // Titles and other side requests.
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({
        id: 'msg_t', type: 'message', role: 'assistant', model: request.model, stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: request.output_config?.format ? '{"suggestions":[]}' : 'Board' }],
        usage: { input_tokens: 1, output_tokens: 1 }
      }))
    }
    requests.push(request)
    const blocks = script.shift()?.(request) ?? [{ type: 'text', text: 'END' }]
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

const call = (tool, input) => (request) => {
  if (!(request.tools ?? []).some((t) => t.name === tool)) {
    throw new Error(`${tool} wasn't offered; tools: ${(request.tools ?? []).map((t) => t.name)}`)
  }
  return [{ type: 'tool_use', id: `toolu_${tool}_${requests.length}`, name: tool, input }]
}
const toolResults = (request) => request.messages.at(-1).content.filter((b) => b.type === 'tool_result')
const resultText = (block) => (typeof block.content === 'string' ? block.content : block.content.map((c) => c.text).join(''))
const lastUserText = (request) => {
  const content = request.messages.filter((m) => m.role === 'user' && m.content.some?.((b) => b.type === 'text')).at(-1).content
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('')
}

// MARK: - App

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpc-skills-'))
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
const chat = async (text, steps = [], during = async () => {}) => {
  const before = await turnsEnded()
  script = steps
  if (!(await win.locator('.layout.chat-open').count())) await dockWin.getByRole('button', { name: 'Show chat' }).click()
  await chatWin.getByPlaceholder('Message Tidepool…').fill(text)
  await chatWin.keyboard.press('Enter')
  await during()
  await until(async () => (await turnsEnded()) > before, `turn for "${text}" to end`, 30000)
}
const review = () => win.locator('.skill-review')
const skills = () => win.evaluate(() => window.api.skills.list())
const DRAFT = {
  name: 'Check the board',
  when_to_use: "when I ask what's overdue",
  start_url: BOARD,
  steps: '1. Read the board.\n2. Tell me how many cards are overdue.'
}

try {
  await dockWin.locator('.dock').waitFor()

  await step('save_skill and use_skill are offered; no skills are listed yet', async () => {
    await chat('open the board', [call('open_page', { url: BOARD })])
    const names = requests.at(-1).tools.map((t) => t.name)
    assert(names.includes('save_skill') && names.includes('use_skill'), names.join(', '))
    assert(!requests.at(-1).system.includes('<skills>'), 'skills listed with none saved')
  })

  await step("the user can say no to a draft, and nothing's saved", async () => {
    await chat('save that as a skill', [call('save_skill', DRAFT)], async () => {
      await review().waitFor({ timeout: 15000 })
      await review().getByRole('button', { name: 'Don’t save' }).click()
    })
    const text = resultText(toolResults(requests.at(-1))[0])
    assert(text.includes('decided not to save'), text)
    assert((await skills()).length === 0, 'saved anyway')
  })

  await step('a draft missing its steps comes back to Claude without asking the user', async () => {
    await chat('save it with no steps', [call('save_skill', { name: 'Empty' })])
    const [result] = toolResults(requests.at(-1))
    assert(result.is_error && resultText(result).includes('Say what the skill does'), JSON.stringify(result))
    assert(!(await review().count()), 'review opened')
  })

  await step('the user reviews the draft, edits it, and saves it', async () => {
    await chat('save that as a skill', [call('save_skill', DRAFT)], async () => {
      await review().waitFor({ timeout: 15000 })
      assert(await review().getByText('Save this skill?').isVisible(), 'wrong title')
      const name = review().getByLabel('Name')
      assert((await name.inputValue()) === DRAFT.name, await name.inputValue())
      assert((await review().getByLabel('Steps').inputValue()) === DRAFT.steps, 'steps not shown')
      await win.screenshot({ path: `${OUT}/review.png` })
      await name.fill('Overdue cards')
      await review().getByRole('button', { name: 'Save skill' }).click()
    })
    const text = resultText(toolResults(requests.at(-1))[0])
    assert(text.includes('saved the skill “Overdue cards”'), text)
    const [saved] = await skills()
    assert(saved?.name === 'Overdue cards' && saved.startUrl === BOARD && saved.steps === DRAFT.steps, JSON.stringify(saved))
  })

  await step('saved skills are listed for Claude', async () => {
    await chat('hi')
    const system = requests.at(-1).system
    assert(system.includes('<skills>') && system.includes("- Overdue cards: when I ask what's overdue (starts on 127.0.0.1)"), system)
  })

  await step('use_skill stays on the site when the user is already there', async () => {
    const tabs = async () => (await win.evaluate(() => window.api.projects.list())).find((p) => p.id === 'general').tabs.length
    const before = await tabs()
    await chat("what's overdue?", [call('use_skill', { name: 'overdue cards' })])
    const text = resultText(toolResults(requests.at(-1))[0])
    assert(text.includes('Skill “Overdue cards”') && text.includes('already on that site'), text)
    assert(text.includes('2. Tell me how many cards are overdue.'), text)
    assert((await tabs()) === before, 'opened another tab')
    assert((await skills())[0].lastRunAt > 0, 'run not recorded')
  })

  await step('use_skill opens the start page when the user is somewhere else', async () => {
    await chat('go elsewhere', [call('open_page', { url: OTHER })])
    await chat("what's overdue?", [call('use_skill', { name: 'Overdue cards' })])
    const text = resultText(toolResults(requests.at(-1))[0])
    assert(text.includes(`opened ${BOARD} in tab`), text)
    const general = (await win.evaluate(() => window.api.projects.list())).find((p) => p.id === 'general')
    const active = general.tabs.find((t) => t.id === general.activeTabId)
    assert(active.url.startsWith(BOARD), active.url)
  })

  await step("use_skill names the user's skills when there's no such skill", async () => {
    await chat('run nothing', [call('use_skill', { name: 'Nope' })])
    const [result] = toolResults(requests.at(-1))
    assert(result.is_error && resultText(result).includes('“Overdue cards”'), JSON.stringify(result))
  })

  await step('on its site, the dock offers the skill, and a tap asks Claude to run it', async () => {
    await win.locator('.layout.chat-open').count().then(async (open) => {
      if (open) await chatWin.getByRole('button', { name: 'Minimize chat' }).click()
    })
    const button = dockWin.getByRole('button', { name: 'Overdue cards' })
    await button.waitFor({ timeout: 15000 })
    await dockWin.screenshot({ path: `${OUT}/dock.png` })
    const before = requests.length
    script = []
    await button.click()
    await until(async () => requests.length > before, 'the skill was sent')
    assert(lastUserText(requests.at(-1)) === 'Run my skill “Overdue cards”.', lastUserText(requests.at(-1)))
    // With the chat closed, the reply shows in the dock's bar, in place of its suggestions.
    await dockWin.locator('.peek', { hasText: 'END' }).waitFor({ timeout: 15000 })
  })

  await step('saving with the same name replaces the skill, after asking', async () => {
    await chat('update it', [call('save_skill', { ...DRAFT, name: 'Overdue Cards', steps: '1. Read the board.' })], async () => {
      await review().waitFor({ timeout: 15000 })
      assert(await review().getByText('Update “Overdue cards”?').isVisible(), 'not shown as an update')
      await review().getByRole('button', { name: 'Save skill' }).click()
    })
    const list = await skills()
    assert(list.length === 1 && list[0].name === 'Overdue Cards' && list[0].steps === '1. Read the board.', JSON.stringify(list))
  })

  await step('Stop withdraws a draft waiting for review', async () => {
    script = [call('save_skill', { ...DRAFT, name: 'Another' })]
    await chatWin.getByPlaceholder('Message Tidepool…').fill('save another')
    await chatWin.keyboard.press('Enter')
    await review().waitFor({ timeout: 15000 })
    const [latest] = await win.evaluate(() => window.api.chat.list('general'))
    await win.evaluate((id) => window.api.chat.stop(id), latest.id)
    await review().waitFor({ state: 'detached', timeout: 10000 })
    assert((await skills()).length === 1, 'saved anyway')
  })

  await step('the Skills page runs, edits and deletes skills', async () => {
    await win.locator('.sidebar').getByRole('button', { name: /^Library/ }).click()
    await win.locator('.library-tabs').getByRole('tab', { name: 'Skills' }).click()
    const modal = win.locator('.library-modal')
    await modal.waitFor()
    await modal.getByRole('button', { name: /^Overdue Cards/ }).click()
    await modal.getByLabel('Steps').fill('1. Read the board.\n2. List overdue cards by owner.')
    await modal.getByRole('button', { name: 'Save', exact: true }).click()
    await until(async () => (await skills())[0].steps.includes('by owner'), 'edit saved')
    await win.screenshot({ path: `${OUT}/skills-page.png` })
    win.once('dialog', (d) => d.accept())
    await modal.getByRole('button', { name: 'Delete' }).click()
    await until(async () => (await skills()).length === 0, 'deleted')
  })
} finally {
  if (failed) console.log(logs.join('').slice(-3000))
  console.log('screenshots in', OUT)
  await app.close()
  site.close()
  api.close()
}
process.exit(failed ? 1 : 0)
