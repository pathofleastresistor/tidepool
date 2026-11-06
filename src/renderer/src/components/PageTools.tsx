import { useState } from 'react'
import type { WebMcpSource, WebMcpTool } from '@shared/types'
import { ToolsIcon } from './Icons'
import { Modal } from './Modals'

/** The page on screen: a pinned site, or a project's active tab (id "tab:<id>"). */
export interface OpenPage {
  id: string
  name: string
  url: string
  autoApprove: boolean
}

/**
 * Debug view of the WebMCP tools the open page has registered, as the app received them. It
 * shows what reached the main process, which is what the chat offers Claude.
 */
export function PageToolsModal(props: {
  page: OpenPage | undefined
  source: WebMcpSource | undefined
  onClose: () => void
}): React.JSX.Element {
  const { page, source } = props
  const tools = source?.tools ?? []
  return (
    <Modal title="Page tools (WebMCP)" onClose={props.onClose}>
      <p className="muted">
        Tools the open page registered with <code>document.modelContext.registerTool()</code>, as the app received
        them. Tidepool can call these while the page is open. What they return reaches it marked as the website's
        words, text only.
      </p>
      {!page ? (
        <p className="muted pad">No page is open. Open a pinned site or a project from the sidebar to see its tools.</p>
      ) : (
        <section className="page-tools-source">
          <div className="row between">
            <strong className="page-tools-label">{page.name}</strong>
            <span className="badge muted">
              {tools.length} tool{tools.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="small muted page-tools-url">{source?.url ?? page.url}</div>
          <AskToggle key={page.id} page={page} />
          {tools.length === 0 && <p className="muted small">This page hasn't registered any tools.</p>}
          {tools.map((t) => (
            <ToolRow key={`${t.origin} ${t.name}`} tool={t} pageOrigin={originOf(source?.url ?? '')} />
          ))}
        </section>
      )}
    </Modal>
  )
}

/** Shows the new setting at once; saving it takes a round trip to the main process. */
function AskToggle(props: { page: OpenPage }): React.JSX.Element {
  const [ask, setAsk] = useState(!props.page.autoApprove)
  return (
    <label className="check small">
      <input
        type="checkbox"
        checked={ask}
        onChange={async (e) => {
          setAsk(e.target.checked)
          await window.api.webmcp.setAutoApprove(props.page.id, !e.target.checked)
        }}
      />
      Ask before Tidepool runs this site's tools
    </label>
  )
}

function ToolRow(props: { tool: WebMcpTool; pageOrigin: string }): React.JSX.Element {
  const { tool } = props
  const hints = Object.entries(tool.annotations ?? {}).filter(([, v]) => v === true)
  return (
    <details className="tool-details page-tool">
      <summary>
        <code>{tool.name}</code>
        {tool.title && <span className="muted"> · {tool.title}</span>}
        {hints.map(([k]) => (
          <span key={k} className="badge muted">
            {k.replace(/Hint$/, '')}
          </span>
        ))}
      </summary>
      <p className="small">{tool.description || <span className="muted">No description.</span>}</p>
      {tool.origin && tool.origin !== props.pageOrigin && (
        <p className="small muted">Registered by an iframe from {tool.origin}</p>
      )}
      <div className="label">Input schema</div>
      <pre>{tool.inputSchema === undefined ? '(none)' : JSON.stringify(tool.inputSchema, null, 2)}</pre>
    </details>
  )
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * In a page's toolbar, when the page offers tools (WebMCP): how many, and a way to see them and
 * whether Tidepool asks before using them. Nothing shows for pages without tools.
 */
export function PageToolsButton(props: { count: number; onOpen: () => void }): React.JSX.Element | null {
  if (props.count === 0) return null
  const tools = `${props.count} tool${props.count === 1 ? '' : 's'}`
  return (
    <button
      className="icon page-tools-button"
      onClick={props.onOpen}
      aria-label={`Page tools (${tools})`}
      title={`This page offers Tidepool ${tools}`}
    >
      <ToolsIcon />
      <span className="count">{props.count}</span>
    </button>
  )
}
