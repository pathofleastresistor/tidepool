#!/usr/bin/env node
// A stand-in for Home Assistant's MCP server, over stdio, for tests/e2e-pinned.mjs: one tool that
// only reads (marked readOnlyHint) and one that changes something.
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const states = { 'fan.living_room': 'on', 'light.porch': 'off' }
const server = new McpServer({ name: 'fake-home', version: '1.0.0' })

server.registerTool(
  'get_states',
  { description: 'Lists every device and whether it is on.', inputSchema: z.object({}), annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: 'text', text: Object.entries(states).map(([id, s]) => `${id}: ${s}`).join('\n') }] })
)

server.registerTool(
  'turn_off',
  { description: 'Turns a device off.', inputSchema: z.object({ entity_id: z.string() }) },
  async ({ entity_id }) => {
    states[entity_id] = 'off'
    return { content: [{ type: 'text', text: `Turned off ${entity_id}.` }] }
  }
)

await server.connect(new StdioServerTransport())
