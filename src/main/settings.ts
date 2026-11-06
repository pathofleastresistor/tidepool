import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { JevProvider, McpConfigFile, PublicSettings, Settings } from '@shared/types'

const DEFAULT_SETTINGS: Settings = {
  model: 'claude-opus-5',
  effort: 'high',
  systemPrompt:
    'You are a helpful assistant running inside Tidepool, a desktop MCP client. ' +
    'Use the connected MCP tools when they help. Some tools render interactive UIs ' +
    '(MCP Apps) that the user can see and interact with directly in the chat, so you ' +
    "don't need to repeat everything such a UI already shows.",
  showThinking: true,
  refusalFallbacks: true,
  linksInBuiltInBrowser: true,
  pageSuggestions: true,
  webSearch: true,
  memory: true,
  browsingMemory: true,
  memoryExcludedSites: [],
  keyBindings: {},
  talkShortcut: '',
  autofill: true,
  skipApprovals: false
}

const EXAMPLE_CONFIG: McpConfigFile = {
  mcpServers: {
    everything: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
      disabled: true
    }
  }
}

function dataDir(): string {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  return dir
}

const settingsPath = (): string => join(dataDir(), 'settings.json')
const keyPath = (): string => join(dataDir(), 'api-key.bin')
export const mcpConfigPath = (): string => join(dataDir(), 'mcp.json')

export function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(settingsPath(), 'utf8')) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(), ...patch }
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2))
  return next
}

/** The API key entered in the UI, stored encrypted with the OS keychain via safeStorage. */
function storedApiKey(): string | undefined {
  if (!existsSync(keyPath())) return undefined
  try {
    const buf = readFileSync(keyPath())
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8')
  } catch {
    return undefined
  }
}

export function setApiKey(key: string): void {
  const trimmed = key.trim()
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(trimmed)
    : Buffer.from(trimmed, 'utf8')
  writeFileSync(keyPath(), buf, { mode: 0o600 })
}

/** A key set in the UI wins; otherwise fall back to ANTHROPIC_API_KEY from the environment. */
export function getApiKey(): string | undefined {
  return storedApiKey() || process.env.ANTHROPIC_API_KEY || undefined
}

const jevKeyPath = (): string => join(dataDir(), 'typesafe-key.bin')

/** The key for Jev (the browse tool), stored like the Anthropic key. */
function storedJevKey(): string | undefined {
  if (!existsSync(jevKeyPath())) return undefined
  try {
    const buf = readFileSync(jevKeyPath())
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8')
  } catch {
    return undefined
  }
}

export function setJevKey(key: string): void {
  const trimmed = key.trim()
  const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(trimmed) : Buffer.from(trimmed, 'utf8')
  writeFileSync(jevKeyPath(), buf, { mode: 0o600 })
}

/** How to reach Jev: TypeSafe directly, or through OpenRouter, which serves the same API. */
export interface JevAccess {
  key: string
  provider: JevProvider
  fromEnv: boolean
}

/** OpenRouter keys start with sk-or-; anything else is taken for a TypeSafe key. */
const providerOf = (key: string): JevProvider => (key.startsWith('sk-or-') ? 'openrouter' : 'typesafe')

/**
 * A key set in the UI wins; otherwise TYPESAFE_API_KEY, then an OpenRouter key in
 * OPENROUTER_API_KEY, from the environment.
 */
export function getJevAccess(): JevAccess | undefined {
  const stored = storedJevKey()
  if (stored) return { key: stored, provider: providerOf(stored), fromEnv: false }
  const env = process.env.TYPESAFE_API_KEY || (/^sk-or-/.test(process.env.OPENROUTER_API_KEY ?? '') ? process.env.OPENROUTER_API_KEY : undefined)
  return env ? { key: env, provider: providerOf(env), fromEnv: true } : undefined
}

export function publicSettings(): PublicSettings {
  const stored = storedApiKey()
  const jev = getJevAccess()
  return {
    ...loadSettings(),
    hasApiKey: Boolean(stored || process.env.ANTHROPIC_API_KEY),
    apiKeyFromEnv: !stored && Boolean(process.env.ANTHROPIC_API_KEY),
    jevProvider: jev?.provider ?? null,
    jevKeyFromEnv: jev?.fromEnv ?? false,
    mcpConfigPath: mcpConfigPath()
  }
}

export function readMcpConfigText(): string {
  if (!existsSync(mcpConfigPath())) {
    writeFileSync(mcpConfigPath(), JSON.stringify(EXAMPLE_CONFIG, null, 2))
  }
  return readFileSync(mcpConfigPath(), 'utf8')
}

export function readMcpConfig(): McpConfigFile {
  const parsed = JSON.parse(readMcpConfigText()) as Partial<McpConfigFile>
  return { mcpServers: parsed.mcpServers ?? {} }
}

/** Validates the JSON before writing so a typo in the editor can't brick the config. */
export function writeMcpConfigText(text: string): void {
  const parsed = JSON.parse(text) as Partial<McpConfigFile>
  if (!parsed || typeof parsed !== 'object' || typeof parsed.mcpServers !== 'object') {
    throw new Error('Config must be an object with an "mcpServers" key')
  }
  writeFileSync(mcpConfigPath(), JSON.stringify(parsed, null, 2))
}
