import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ToolApprovalAnswer } from '@shared/types'
import type { Item, Segment, ToolCall } from '@shared/chat-state'
import { AppFrame } from './AppFrame'
import { ChevronIcon, ShieldIcon } from './Icons'

export type ApprovalHandler = (call: ToolCall, answer: ToolApprovalAnswer) => void

interface TranscriptProps {
  items: Item[]
  busy: boolean
  onAppMessage: (text: string) => void
  onLog: (line: string) => void
  onApproval: ApprovalHandler
}

function MarkdownText({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a> }}
      >
        {text}
      </Markdown>
    </div>
  )
}

function ThinkingBlock({ text, live }: { text: string; live: boolean }): React.JSX.Element {
  return (
    <details className="thinking" open={live}>
      <summary>{live ? 'Thinking…' : 'Thought process'}</summary>
      <div className="thinking-body">{text}</div>
    </details>
  )
}

function resultText(call: ToolCall): string {
  if (!call.result) return ''
  const parts = call.result.content.map((c) =>
    c.type === 'text' ? String(c.text) : `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''}]`
  )
  if (call.result.structuredContent !== undefined) {
    parts.push('structuredContent:\n' + JSON.stringify(call.result.structuredContent, null, 2))
  }
  return parts.join('\n')
}

const isPlain = (v: unknown): boolean => v === null || ['string', 'number', 'boolean'].includes(typeof v)

/** What the call would send: a short key/value list when it's flat, the JSON when it isn't. */
function ApprovalArgs({ input }: { input: Record<string, unknown> }): React.JSX.Element {
  const entries = Object.entries(input)
  if (entries.every(([, v]) => isPlain(v))) {
    return (
      <dl className="approval-args">
        {entries.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
          </div>
        ))}
      </dl>
    )
  }
  return <pre className="approval-args">{JSON.stringify(input, null, 2)}</pre>
}

/**
 * Claude wants to open a page after reading what websites wrote in the same turn. That text could
 * be steering it, and an address can carry data away, so the user checks where it's going.
 */
function NavigateApprovalCard(props: { call: ToolCall; url: string; onApproval: ApprovalHandler }): React.JSX.Element {
  const { call, url } = props
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    void ref.current?.scrollIntoView({ block: 'nearest' })
  }, [])
  return (
    <div className="approval" ref={ref} role="group" aria-label="Open this page?">
      <div className="approval-head">
        <span className="approval-icon">
          <ShieldIcon />
        </span>
        <div className="approval-text">
          <div className="approval-title">Open this page?</div>
          <div className="approval-sub">
            Tidepool read content from websites in this turn, so it checks with you before going somewhere new. Make
            sure the address is one you want to visit.
          </div>
        </div>
      </div>
      <pre className="approval-args approval-url">{url}</pre>
      <div className="approval-actions">
        <button className="quiet" onClick={() => props.onApproval(call, 'deny')}>
          Deny
        </button>
        <span className="grow" />
        <button className="primary" onClick={() => props.onApproval(call, 'allow')}>
          Open
        </button>
      </div>
    </div>
  )
}

/** A website tool call held until the user says so, showing exactly what it would send. */
function ApprovalCard(props: { call: ToolCall; onApproval: ApprovalHandler }): React.JSX.Element {
  const { call } = props
  const approval = call.approval!
  const hasInput = Object.keys(call.input).length > 0
  const ref = useRef<HTMLDivElement>(null)
  // Claude is stuck until this is answered, so it can't be left below the fold.
  useEffect(() => {
    // Braces matter: scrollIntoView returns a promise in current Chromium, which React would
    // take for a cleanup function.
    void ref.current?.scrollIntoView({ block: 'nearest' })
  }, [])
  if (approval.kind === 'navigate') return <NavigateApprovalCard call={call} url={approval.url} onApproval={props.onApproval} />
  const site = approval.site
  const afterReading = approval.afterReading
  return (
    <div className="approval" ref={ref} role="group" aria-label={`Allow ${call.tool} on ${site}?`}>
      <div className="approval-head">
        <span className="approval-icon">
          <ShieldIcon />
        </span>
        <div className="approval-text">
          <div className="approval-title">
            Run <code>{call.tool}</code> on {site}?
          </div>
          <div className="approval-sub">
            {afterReading && (
              <>
                Claude read {afterReading} just before this, and what it says could be steering this call.{' '}
              </>
            )}
            {hasInput ? `It acts on ${site} as you, sending:` : `It acts on ${site} as you, with no input.`}
          </div>
        </div>
      </div>
      {hasInput && <ApprovalArgs input={call.input} />}
      <div className="approval-actions">
        <button className="quiet" onClick={() => props.onApproval(call, 'deny')}>
          Deny
        </button>
        <span className="grow" />
        {!afterReading && (
          <button
            onClick={() => props.onApproval(call, 'always')}
            aria-label={`Always allow on ${site}`}
            title={`Let Claude act on ${site} without asking, unless it just read another site. You can turn asking back on in Page tools.`}
          >
            Always allow
          </button>
        )}
        <button className="primary" onClick={() => props.onApproval(call, 'allow')}>
          Allow
        </button>
      </div>
    </div>
  )
}

/** What Claude is writing a call for, in words, for the calls that take a while to write. */
const DRAFTING_LABELS: Record<string, string> = { save_page: 'Building the page', save_skill: 'Writing the skill' }

/** A call Claude is still writing: named as soon as it starts, with how much it's written so far. */
function DraftingCall({ call }: { call: ToolCall }): React.JSX.Element {
  const label = DRAFTING_LABELS[call.tool]
  const size = call.drafting ? (call.drafting < 1000 ? `${call.drafting} characters` : `${Math.round(call.drafting / 1000)} KB`) : ''
  return (
    <div className="tool-call">
      <div className="tool-header running drafting" role="status">
        <span className="tool-status" />
        <span className="tool-name">
          {label ? <b>{label}</b> : <><span className="tool-server">{call.server}</span> <b>{call.tool}</b></>}
          {size && <span className="tool-server"> · {size}</span>}
        </span>
      </div>
    </div>
  )
}

function ToolCallBlock(props: {
  call: ToolCall
  onAppMessage: (text: string) => void
  onLog: (line: string) => void
  onApproval: ApprovalHandler
}): React.JSX.Element {
  const { call } = props
  const [open, setOpen] = useState(false)
  const waiting = call.approval && !call.approval.answered && !call.result
  const status = waiting ? 'waiting' : !call.result ? 'running' : call.result.isError ? 'error' : 'done'
  if (call.drafting !== undefined) return <DraftingCall call={call} />
  return (
    <div className="tool-call">
      {/* While it waits, the approval card stands in for the header, rather than repeating it. */}
      {waiting ? (
        <ApprovalCard call={call} onApproval={props.onApproval} />
      ) : (
        <button className={`tool-header ${status}`} onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="tool-status" />
          <span className="tool-name">
            <span className="tool-server">{call.server}</span> <b>{call.tool}</b>
          </span>
          {call.uiResourceUri && <span className="badge">MCP App</span>}
          <span className={`chevron ${open ? 'open' : ''}`}>
            <ChevronIcon />
          </span>
        </button>
      )}
      {open && (
        <div className="tool-details">
          <div className="label">Input</div>
          <pre>{JSON.stringify(call.input, null, 2)}</pre>
          {call.result && (
            <>
              <div className="label">Result{call.result.isError ? ' (error)' : ''}</div>
              <pre>{resultText(call)}</pre>
            </>
          )}
          {call.uiResourceUri && <div className="label">UI resource: {call.uiResourceUri}</div>}
        </div>
      )}
      {call.uiResourceUri && (
        <AppFrame
          callId={call.callId}
          server={call.server}
          serverKey={call.serverKey}
          tool={call.tool}
          uiResourceUri={call.uiResourceUri}
          input={call.input}
          result={call.result}
          onAppMessage={props.onAppMessage}
          onLog={props.onLog}
        />
      )}
    </div>
  )
}

function SegmentView(props: {
  segment: Segment
  live: boolean
  onAppMessage: (text: string) => void
  onLog: (line: string) => void
  onApproval: ApprovalHandler
}): React.JSX.Element | null {
  const { segment } = props
  switch (segment.kind) {
    case 'text':
      return <MarkdownText text={segment.text} />
    case 'thinking':
      return segment.text.trim() ? <ThinkingBlock text={segment.text} live={props.live} /> : null
    case 'tool':
      return (
        <ToolCallBlock
          call={segment.call}
          onAppMessage={props.onAppMessage}
          onLog={props.onLog}
          onApproval={props.onApproval}
        />
      )
    case 'notice':
      return <div className="notice">{segment.text}</div>
  }
}

export function Transcript({ items, busy, onAppMessage, onLog, onApproval }: TranscriptProps): React.JSX.Element {
  const lastItem = items[items.length - 1]

  if (items.length === 0) {
    return (
      <div className="empty">
        <p>Ask anything about what's on screen, or use your MCP servers' tools.</p>
        <p className="hint">Or tap the mic and just say it.</p>
      </div>
    )
  }

  return (
    <div className="transcript">
      {items.map((item, idx) => {
        if (item.kind === 'user') {
          return (
            <div key={item.id} className="msg user">
              {item.fromApp && <div className="from-app">sent by MCP App</div>}
              <div className="bubble">{item.text}</div>
            </div>
          )
        }
        if (item.kind === 'error') {
          return (
            <div key={item.id} className="msg error">
              {item.message}
            </div>
          )
        }
        const live = !item.done && idx === items.length - 1
        return (
          <div key={item.id} className="msg assistant">
            {item.segments.map((segment, i) => (
              <SegmentView
                key={i}
                segment={segment}
                live={live && i === item.segments.length - 1}
                onAppMessage={onAppMessage}
                onLog={onLog}
                onApproval={onApproval}
              />
            ))}
            {live && item.segments.length === 0 && <div className="typing">●●●</div>}
            {item.stopReason === 'aborted' && <div className="notice">Stopped</div>}
            {item.stopReason === 'refusal' && <div className="notice">Tidepool declined to continue this request.</div>}
            {item.stopReason === 'max_tokens' && <div className="notice">Response hit the max token limit.</div>}
          </div>
        )
      })}
      {busy && lastItem?.kind === 'user' && <div className="typing">●●●</div>}
    </div>
  )
}
