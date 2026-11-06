import type { Item } from '@shared/chat-state'
import { useState } from 'react'
import type { Voice } from '../use-voice'
import { withShortcut } from '../commands'
import { ChevronIcon, SparkleIcon } from './Icons'
import { MicButton, VoiceCard } from './Voice'

/** A button for what's on screen: a page's own suggestion, or something Tidepool can always do there. */
export interface ContextAction {
  label: string
  /** Sent as a message; without it the action runs `onSelect` instead. */
  prompt?: string
  onSelect?: () => void
  title?: string
}

/** One line on what Claude is doing, or the start of what it said. Empty when there's nothing new. */
export function replyPeek(items: Item[], busy: boolean): string {
  const last = items[items.length - 1]
  if (!last) return ''
  if (last.kind === 'error') return last.message
  if (last.kind === 'user') return busy ? 'Thinking…' : ''
  const segments = last.segments
  const text = segments
    .filter((s) => s.kind === 'text')
    .map((s) => (s.kind === 'text' ? s.text : ''))
    .join(' ')
    .replace(/[#*_`>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const tail = segments[segments.length - 1]
  if (busy && tail?.kind === 'tool' && tail.call.drafting !== undefined && tail.call.tool === 'save_page') return 'Building the page…'
  if (busy && tail?.kind === 'tool' && !tail.call.result) return `Using ${tail.call.tool.replace(/_/g, ' ')}…`
  if (text) return text
  return busy ? 'Thinking…' : ''
}

const COLLAPSED_KEY = 'dockSuggestionsCollapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

/** Things to do here, as chips: the dock's panel shows them as a list, the chat above its box. */
export function Suggestions(props: {
  context: string
  fromSite: boolean
  actions: ContextAction[]
  onPrompt: (text: string) => void
  /** Draws them as rows (the dock) rather than a line of chips (the chat). */
  list?: boolean
  /** A way to fold them away, in the header. */
  onCollapse?: () => void
}): React.JSX.Element {
  const run = (a: ContextAction): void => (a.prompt ? props.onPrompt(a.prompt) : a.onSelect?.())
  return (
    <div
      className={`suggestions ${props.fromSite ? '' : 'generic'} ${props.list ? 'list' : ''}`}
      role="group"
      aria-label={`Suggestions for ${props.context}`}
    >
      {(props.list || props.fromSite) && (
        <div className="suggestions-head">
          <span
            className="suggestions-from"
            title={props.fromSite ? 'Suggested from the tools this site offers. Tidepool still asks before running any of them.' : undefined}
          >
            <SparkleIcon />
            <span className="suggestions-from-name">{props.fromSite ? props.context : `Try on ${props.context}`}</span>
          </span>
          {props.onCollapse && (
            <button className="icon quiet suggestions-collapse" onClick={props.onCollapse} aria-label="Hide suggestions" title="Hide suggestions">
              <ChevronIcon />
            </button>
          )}
        </div>
      )}
      {props.actions.map((a) => (
        <button key={a.label} className="suggestion" title={a.title} onClick={() => run(a)}>
          <span className="suggestion-label">{a.label}</span>
          {props.list && <ChevronIcon />}
        </button>
      ))}
    </div>
  )
}

/**
 * The assistant while the chat is closed, floating at the bottom right over whatever is open,
 * websites included (it's drawn in an overlay). One panel: the mic and a way into the chat at the
 * bottom, and above them what fits the moment: what the mic is hearing, or things to do here. The
 * latest from Claude takes the chat's place in the bar. While the chat is open it's hidden, and
 * the chat has all of this itself.
 */
export function Dock(props: {
  /** Where the suggestions come from, shown in front of them. */
  context: string
  /** Marks `actions` as coming from the site's own tools. */
  fromSite: boolean
  actions: ContextAction[]
  onPrompt: (text: string) => void
  onOpenChat: () => void
  /** Claude is answering in the chat. */
  busy: boolean
  /** The latest from Claude. */
  peek: string
  /** There's a reply in the chat the user hasn't opened yet. */
  unread: boolean
  /** Null where there's no voice input. */
  voice: Voice | null
  /** The widest the dock may get, so it stays on the stage. */
  maxWidth: number
}): React.JSX.Element {
  const [collapsed, setCollapsedState] = useState(readCollapsed)
  const setCollapsed = (value: boolean): void => {
    setCollapsedState(value)
    try {
      localStorage.setItem(COLLAPSED_KEY, String(value))
    } catch {
      // Remembering it is a convenience.
    }
  }
  const v = props.voice
  // What the mic is hearing, or why it can't, takes the panel while there's any.
  const voiceCard = v && (v.problem || v.notice || v.state !== 'idle') ? <VoiceCard voice={v} /> : null
  const hasActions = props.actions.length > 0 && !props.peek
  const panel = voiceCard ?? (hasActions && !collapsed && (
    <Suggestions
      list
      context={props.context}
      fromSite={props.fromSite}
      actions={props.actions}
      onPrompt={props.onPrompt}
      onCollapse={() => setCollapsed(true)}
    />
  ))
  return (
    <div className="dock" role="toolbar" aria-label="Assistant" style={{ maxWidth: props.maxWidth }}>
      {panel && <div className="dock-panel">{panel}</div>}
      <div className="dock-bar">
        {props.voice && <MicButton voice={props.voice} />}
        <button
          className={`dock-ask ${props.peek ? 'peek' : ''} ${props.busy ? 'busy' : ''}`}
          onClick={props.onOpenChat}
          aria-label="Show chat"
          title={withShortcut('Show chat', 'chat.toggle')}
        >
          {props.busy && <span className="tab-spinner" aria-hidden="true" />}
          <span className="peek-text">{props.peek || 'Ask Tidepool…'}</span>
          {props.unread && <span className="attention-dot" aria-hidden="true" />}
        </button>
        {hasActions && collapsed && !voiceCard && (
          <button
            className="dock-ideas"
            onClick={() => setCollapsed(false)}
            aria-label={`Show ${props.actions.length} suggestions`}
            title={`Suggestions for ${props.context}`}
          >
            <SparkleIcon />
            {props.actions.length}
          </button>
        )}
      </div>
    </div>
  )
}
