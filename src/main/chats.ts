import Anthropic from '@anthropic-ai/sdk'
import { emptyChat, type ChatState } from '@shared/chat-state'
import type { AppModelContext, ConversationEvent, ConversationSummary, ToolApprovalAnswer } from '@shared/types'
import { ChatSession, type AppTools } from './chat'
import type { McpManager } from './mcp-manager'
import { getApiKey } from './settings'
import type { Store } from './store'
import type { WebMcpRegistry } from './webmcp'

const TITLE_MODEL = 'claude-haiku-4-5'
const TITLE_SYSTEM =
  'Write a title for this conversation in 2 to 6 words, the way a person would name a chat: plain words, ' +
  'no quotes, no ending punctuation. Reply with the title only.'

/** A title to show until Claude Haiku names the chat: the start of the first message. */
function provisionalTitle(text: string): string {
  const line = text.trim().split('\n')[0]
  if (line.length <= 48) return line
  const cut = line.slice(0, 48)
  return `${cut.slice(0, cut.lastIndexOf(' ') > 24 ? cut.lastIndexOf(' ') : 48)}…`
}

/**
 * Every chat, in every project. Sessions are loaded from the store the first time they're opened
 * or sent to, and several can answer at once: events are tagged with their conversation.
 */
export class ChatManager {
  private sessions = new Map<string, ChatSession>()

  constructor(
    private store: Store,
    private mcp: McpManager,
    private webmcp: WebMcpRegistry,
    private appTools: AppTools,
    private emit: (event: ConversationEvent) => void,
    /** A project's list of chats changed. */
    private listChanged: (projectId: string) => void,
    private log: (line: string) => void
  ) {}

  list(projectId: string): ConversationSummary[] {
    return this.store
      .listConversations(projectId)
      .map((row) => ({ ...row, busy: this.sessions.get(row.id)?.busy ?? false }))
  }

  create(projectId: string): ConversationSummary {
    const row = this.store.createConversation(projectId)
    this.listChanged(projectId)
    return { ...row, busy: false }
  }

  open(id: string): ChatState {
    return this.session(id)?.snapshot() ?? emptyChat()
  }

  async send(id: string, text: string, fromApp: boolean): Promise<void> {
    const session = this.session(id)
    const row = this.store.getConversation(id)
    if (!session || !row) throw new Error('That chat no longer exists')
    const first = session.isEmpty
    if (first && !row.title) this.store.setTitle(id, provisionalTitle(text))
    this.store.touch(id)
    const turn = session.send(text, fromApp)
    this.listChanged(row.projectId)
    try {
      await turn
    } finally {
      this.listChanged(row.projectId)
      if (first) void this.nameChat(id, row.projectId, text, session.lastReplyText())
    }
  }

  stop(id: string): void {
    this.sessions.get(id)?.stop()
  }

  remove(id: string): void {
    const row = this.store.getConversation(id)
    this.sessions.get(id)?.stop()
    this.sessions.delete(id)
    this.store.deleteConversation(id)
    if (row) this.listChanged(row.projectId)
  }

  /** The project is being deleted, and its chats go with it. */
  removeProject(projectId: string): void {
    for (const id of this.store.conversationIds(projectId)) {
      this.sessions.get(id)?.stop()
      this.sessions.delete(id)
      this.store.deleteConversation(id)
    }
    this.listChanged(projectId)
  }

  setAppContext(id: string, appId: string, ctx: AppModelContext | null): void {
    this.session(id)?.setAppContext(appId, ctx)
  }

  answerApproval(callId: string, answer: ToolApprovalAnswer): void {
    for (const session of this.sessions.values()) if (session.answerApproval(callId, answer)) return
  }

  stopAll(): void {
    for (const session of this.sessions.values()) session.stop()
  }

  private session(id: string): ChatSession | undefined {
    let session = this.sessions.get(id)
    if (session) return session
    const row = this.store.getConversation(id)
    if (!row) return undefined
    session = new ChatSession(
      id,
      row.projectId,
      this.store.loadMessages(id),
      this.store.loadTranscript(id) ?? emptyChat(),
      this.mcp,
      this.webmcp,
      this.store,
      this.appTools,
      (event) => this.emit({ conversationId: id, event })
    )
    this.sessions.set(id, session)
    return session
  }

  /** Asks Claude Haiku for a short title once the first exchange is done. The provisional one stays if it fails. */
  private async nameChat(id: string, projectId: string, userText: string, replyText: string): Promise<void> {
    const apiKey = getApiKey()
    if (!apiKey) return
    try {
      const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 20_000 })
      const response = await client.messages.create({
        model: TITLE_MODEL,
        max_tokens: 64,
        system: TITLE_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `<user_message>\n${userText.slice(0, 4000)}\n</user_message>\n<assistant_reply>\n${replyText.slice(0, 4000)}\n</assistant_reply>`
          }
        ]
      })
      const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
      const title = text.trim().split('\n')[0].replace(/^["'“]+|["'”.]+$/g, '').trim().slice(0, 80)
      if (!title || !this.store.getConversation(id)) return
      this.store.setTitle(id, title)
      this.listChanged(projectId)
    } catch (err) {
      this.log(`chat title failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
