import type { ChatEvent, ToolApproval, ToolResult } from '@shared/types'

export interface ToolCall {
  callId: string
  server: string
  serverKey: string
  tool: string
  input: Record<string, unknown>
  uiResourceUri?: string
  result?: ToolResult
  /** A call waiting for the user's OK, until they answer. Saved before `kind` existed means a website tool. */
  approval?: ToolApproval & { answered: boolean }
  /** Claude is still writing its input: how many characters so far. Gone once the call starts. */
  drafting?: number
}

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; call: ToolCall }
  | { kind: 'notice'; text: string }

export type Item =
  | { kind: 'user'; id: string; text: string; fromApp?: boolean }
  | { kind: 'assistant'; id: string; segments: Segment[]; done: boolean; stopReason?: string | null }
  | { kind: 'error'; id: string; message: string }

export interface ChatState {
  items: Item[]
  busy: boolean
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number }
}

export type Action =
  | { type: 'user'; text: string; fromApp?: boolean }
  | { type: 'event'; event: ChatEvent }
  /** "Always" answers every call from that site still waiting, as the main process does. */
  | { type: 'approval-answered'; callId: string; siteId: string; always: boolean }
  | { type: 'reset' }
  /** Replace everything with a saved or in-progress conversation. */
  | { type: 'load'; state: ChatState }
  /**
   * The app stopped mid-turn (it quit or crashed). Calls that never finished get an error result,
   * so nothing is left waiting for an answer that can't arrive.
   */
  | { type: 'interrupted' }

export const emptyChat = (): ChatState => ({ items: [], busy: false })

// Items are made in both processes (the main process keeps the saved copy), so ids can't be a counter.
const id = (): string => `item-${crypto.randomUUID()}`

function updateLastAssistant(state: ChatState, fn: (segments: Segment[]) => Segment[]): ChatState {
  const items = [...state.items]
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'assistant') {
      items[i] = { ...item, segments: fn(item.segments) }
      return { ...state, items }
    }
  }
  return state
}

function appendText(segments: Segment[], kind: 'text' | 'thinking', text: string): Segment[] {
  const last = segments[segments.length - 1]
  if (last && last.kind === kind) {
    return [...segments.slice(0, -1), { kind, text: last.text + text }]
  }
  return [...segments, { kind, text }]
}

/** A call Claude was still writing when the turn ended never ran, so it isn't shown. */
const dropDrafts = (segments: Segment[]): Segment[] => segments.filter((s) => s.kind !== 'tool' || s.call.drafting === undefined)

function finishAssistant(state: ChatState, stopReason: string | null): ChatState {
  const items = state.items.map((item) =>
    item.kind === 'assistant' && !item.done ? { ...item, segments: dropDrafts(item.segments), done: true, stopReason } : item
  )
  return { ...state, items, busy: false }
}

export function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'reset':
      return emptyChat()
    case 'load':
      return action.state
    case 'interrupted': {
      const interrupted: ToolResult = { content: [{ type: 'text', text: 'Interrupted: the app closed before this finished.' }], isError: true }
      const items = state.items.map((item) =>
        item.kind === 'assistant' && !item.done
          ? {
              ...item,
              done: true,
              stopReason: 'aborted',
              segments: item.segments.map((seg) =>
                seg.kind === 'tool' && !seg.call.result
                  ? {
                      ...seg,
                      call: {
                        ...seg.call,
                        result: interrupted,
                        approval: seg.call.approval && { ...seg.call.approval, answered: true }
                      }
                    }
                  : seg
              )
            }
          : item
      )
      return { ...state, items, busy: false }
    }
    case 'user':
      return {
        ...state,
        busy: true,
        items: [...state.items, { kind: 'user', id: id(), text: action.text, fromApp: action.fromApp }]
      }
    case 'approval-answered':
      return updateLastAssistant(state, (s) =>
        s.map((seg) =>
          seg.kind === 'tool' &&
          seg.call.approval &&
          (seg.call.callId === action.callId || (action.always && seg.call.approval.siteId === action.siteId))
            ? { ...seg, call: { ...seg.call, approval: { ...seg.call.approval, answered: true } } }
            : seg
        )
      )
    case 'event': {
      const e = action.event
      switch (e.type) {
        case 'turn-start':
          return {
            ...state,
            busy: true,
            items: [...state.items, { kind: 'assistant', id: id(), segments: [], done: false }]
          }
        case 'text-delta':
          return updateLastAssistant(state, (s) => appendText(s, 'text', e.text))
        case 'thinking-delta':
          return updateLastAssistant(state, (s) => appendText(s, 'thinking', e.text))
        case 'tool-drafting':
          return updateLastAssistant(state, (s) =>
            s.some((seg) => seg.kind === 'tool' && seg.call.callId === e.callId)
              ? s.map((seg) =>
                  seg.kind === 'tool' && seg.call.callId === e.callId ? { ...seg, call: { ...seg.call, drafting: e.chars } } : seg
                )
              : [...s, { kind: 'tool', call: { callId: e.callId, server: e.server, serverKey: '', tool: e.tool, input: {}, drafting: e.chars } }]
          )
        case 'tool-start': {
          const call: ToolCall = {
            callId: e.callId,
            server: e.server,
            serverKey: e.serverKey,
            tool: e.tool,
            input: e.input,
            uiResourceUri: e.uiResourceUri,
            approval: e.approval && { ...e.approval, answered: false }
          }
          // It takes the place of its draft, if it had one.
          return updateLastAssistant(state, (s) =>
            s.some((seg) => seg.kind === 'tool' && seg.call.callId === e.callId)
              ? s.map((seg) => (seg.kind === 'tool' && seg.call.callId === e.callId ? { kind: 'tool', call } : seg))
              : [...s, { kind: 'tool', call }]
          )
        }
        case 'tool-result':
          return updateLastAssistant(state, (s) =>
            s.map((seg) =>
              seg.kind === 'tool' && seg.call.callId === e.callId
                ? { ...seg, call: { ...seg.call, result: e.result } }
                : seg
            )
          )
        case 'fallback':
          return updateLastAssistant(state, (s) => [
            ...s,
            { kind: 'notice', text: `${e.from} declined; continued on ${e.to}` }
          ])
        case 'usage':
          return {
            ...state,
            usage: {
              inputTokens: e.inputTokens,
              outputTokens: e.outputTokens,
              cacheReadTokens: e.cacheReadTokens
            }
          }
        case 'turn-end':
          return finishAssistant(state, e.stopReason)
        case 'error': {
          const finished = finishAssistant(state, 'error')
          return { ...finished, items: [...finished.items, { kind: 'error', id: id(), message: e.message }] }
        }
      }
    }
  }
  return state
}
