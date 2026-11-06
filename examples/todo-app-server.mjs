#!/usr/bin/env node
// A tiny MCP server with one MCP App, for poking at the client's MCP Apps support.
// Runs over stdio with no build step. Add it to mcp.json as:
//
//   "todo-board": { "command": "node", "args": ["/absolute/path/to/examples/todo-app-server.mjs"] }
//
// What it exercises:
//   - show_todo_board: model-visible tool with a ui:// resource (tool input + result → the app)
//   - add_todo / toggle_todo: model *and* app tools; the app calls them via tools/call
//   - clear_done: app-only tool (visibility: ["app"]) hidden from Claude
//   - ui/message: "Ask Claude to prioritize" posts a user message into the chat
//   - ui/update-model-context: the app keeps Claude's view of the board current
//   - ui/open-link, ui/notifications/size-changed, host theme/style variables

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { z } from 'zod'

const require = createRequire(import.meta.url)
// The View-side SDK, bundled with its dependencies, so the app HTML needs no build step.
const APP_SDK_SOURCE = readFileSync(require.resolve('@modelcontextprotocol/ext-apps/app-with-deps'), 'utf8')

const todos = [
  { id: 1, text: 'Try an MCP App in my own client', done: true },
  { id: 2, text: 'Read the MCP Apps spec', done: false }
]
let nextId = 3

const snapshot = () => ({ todos: todos.map((t) => ({ ...t })) })
const summary = () =>
  todos.length === 0
    ? 'The board is empty.'
    : todos.map((t) => `${t.done ? '[x]' : '[ ]'} #${t.id} ${t.text}`).join('\n')
const result = (prefix) => ({
  content: [{ type: 'text', text: `${prefix}\n${summary()}` }],
  structuredContent: snapshot()
})

const RESOURCE_URI = 'ui://todo-board/board.html'

const APP_HTML = /* html */ `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 14px 16px;
    font-family: var(--font-sans, system-ui, sans-serif);
    background: var(--color-background-primary, transparent);
    color: var(--color-text-primary, inherit);
    font-size: 14px;
  }
  h3 { margin: 0 0 10px; font-size: 15px; display: flex; justify-content: space-between; align-items: baseline; }
  h3 small { font-weight: normal; color: var(--color-text-secondary, gray); font-size: 12px; }
  ul { list-style: none; padding: 0; margin: 0 0 12px; }
  li { display: flex; gap: 8px; align-items: center; padding: 5px 0; border-bottom: 1px solid var(--color-border-primary, #8883); }
  li.done span { text-decoration: line-through; color: var(--color-text-secondary, gray); }
  form, .actions { display: flex; gap: 8px; }
  .actions { margin-top: 10px; flex-wrap: wrap; }
  input[type=text] { flex: 1; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--color-border-secondary, #8886); background: transparent; color: inherit; font: inherit; }
  button { padding: 6px 10px; border-radius: 6px; border: 1px solid var(--color-border-secondary, #8886); background: var(--color-background-secondary, #8881); color: inherit; font: inherit; cursor: pointer; }
  button.accent { background: #c96442; border-color: #c96442; color: white; }
  a { color: var(--color-text-info, #3b82f6); cursor: pointer; }
</style>
</head>
<body>
  <h3>Todo board <small id="status">connecting…</small></h3>
  <ul id="list"></ul>
  <form id="add"><input type="text" id="text" placeholder="Add a todo…" /><button>Add</button></form>
  <div class="actions">
    <button id="clear">Clear done (app-only tool)</button>
    <button id="ask" class="accent">Ask Claude to prioritize</button>
    <button id="full">Fullscreen</button>
    <a id="spec">MCP Apps spec ↗</a>
  </div>
  <script id="sdk" type="text/plain">${Buffer.from(APP_SDK_SOURCE).toString('base64')}</script>
  <script type="module">
    const sdkSource = new TextDecoder().decode(Uint8Array.from(atob(document.getElementById('sdk').textContent), (c) => c.charCodeAt(0)));
    const { App, applyDocumentTheme, applyHostStyleVariables } = await import(URL.createObjectURL(new Blob([sdkSource], { type: 'text/javascript' })));

    const $ = (id) => document.getElementById(id);
    let todos = [];

    const app = new App({ name: 'Todo board', version: '1.0.0' });

    function render() {
      $('list').innerHTML = '';
      for (const t of todos) {
        const li = document.createElement('li');
        li.className = t.done ? 'done' : '';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = t.done;
        box.onchange = () => call('toggle_todo', { id: t.id });
        const span = document.createElement('span');
        span.textContent = t.text;
        li.append(box, span);
        $('list').append(li);
      }
      const open = todos.filter((t) => !t.done).length;
      $('status').textContent = open + ' open · ' + (todos.length - open) + ' done';
      // Keep Claude's picture of the board current for the next user turn.
      app.updateModelContext({
        content: [{ type: 'text', text: 'Current todo board:\\n' + todos.map((t) => (t.done ? '[x] ' : '[ ] ') + '#' + t.id + ' ' + t.text).join('\\n') }]
      }).catch(() => {});
    }

    function applyResult(result) {
      if (result?.structuredContent?.todos) {
        todos = result.structuredContent.todos;
        render();
      }
    }

    async function call(name, args) {
      applyResult(await app.callServerTool({ name, arguments: args }));
    }

    function applyHostContext(ctx) {
      if (ctx?.theme && applyDocumentTheme) applyDocumentTheme(ctx.theme);
      if (ctx?.styles?.variables && applyHostStyleVariables) applyHostStyleVariables(ctx.styles.variables);
      if (ctx?.displayMode) {
        // Published so the host's tests can wait for the app to have caught up.
        document.body.dataset.displayMode = ctx.displayMode;
        $('full').textContent = ctx.displayMode === 'fullscreen' ? 'Exit fullscreen' : 'Fullscreen';
      }
    }

    app.ontoolinput = (params) => { $('status').textContent = 'loading…'; };
    app.ontoolresult = (result) => applyResult(result);
    app.onhostcontextchanged = (ctx) => applyHostContext(ctx);

    $('add').onsubmit = (e) => {
      e.preventDefault();
      const text = $('text').value.trim();
      if (!text) return;
      $('text').value = '';
      call('add_todo', { text });
    };
    $('clear').onclick = () => call('clear_done', {});
    $('ask').onclick = () => app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Look at my todo board and suggest what I should do first, and why.' }]
    });
    $('spec').onclick = () => app.openLink({ url: 'https://github.com/modelcontextprotocol/ext-apps' });
    $('full').onclick = async () => {
      const ctx = app.getHostContext();
      const next = ctx?.displayMode === 'fullscreen' ? 'inline' : 'fullscreen';
      if (ctx?.availableDisplayModes?.includes(next)) await app.requestDisplayMode({ mode: next });
    };

    await app.connect();
    applyHostContext(app.getHostContext());
  </script>
</body>
</html>`

function createServer() {
  const server = new McpServer(
    { name: 'todo-board', version: '1.0.0' },
    { instructions: 'A shared todo board. Use show_todo_board to display it to the user as an interactive UI.' }
  )

  registerAppTool(
    server,
    'show_todo_board',
    {
      title: 'Show todo board',
      description: 'Display the interactive todo board to the user. Returns the current todos.',
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: RESOURCE_URI } }
    },
    async () => result('Showing the board.')
  )

  registerAppTool(
    server,
    'add_todo',
    {
      title: 'Add todo',
      description: 'Add a todo item to the board.',
      inputSchema: z.object({ text: z.string().min(1).describe('What needs doing') }),
      _meta: { ui: { visibility: ['model', 'app'] } }
    },
    async ({ text }) => {
      todos.push({ id: nextId++, text, done: false })
      return result(`Added "${text}".`)
    }
  )

  registerAppTool(
    server,
    'toggle_todo',
    {
      title: 'Toggle todo',
      description: 'Mark a todo done or not done by id.',
      inputSchema: z.object({ id: z.number().int() }),
      _meta: { ui: { visibility: ['model', 'app'] } }
    },
    async ({ id }) => {
      const todo = todos.find((t) => t.id === id)
      if (!todo) return { content: [{ type: 'text', text: `No todo #${id}` }], isError: true }
      todo.done = !todo.done
      return result(`#${id} is now ${todo.done ? 'done' : 'open'}.`)
    }
  )

  registerAppTool(
    server,
    'clear_done',
    {
      title: 'Clear done',
      description: 'Remove completed todos. Only callable from the app UI.',
      inputSchema: z.object({}),
      _meta: { ui: { visibility: ['app'] } }
    },
    async () => {
      for (let i = todos.length - 1; i >= 0; i--) if (todos[i].done) todos.splice(i, 1)
      return result('Cleared completed todos.')
    }
  )

  registerAppResource(server, 'Todo board UI', RESOURCE_URI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: APP_HTML }]
  }))

  return server
}

await createServer().connect(new StdioServerTransport())
