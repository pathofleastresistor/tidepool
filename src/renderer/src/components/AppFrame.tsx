import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AppBridge,
  PostMessageTransport,
  buildAllowAttribute,
  type McpUiHostContext,
  type McpUiResourcePermissions
} from '@modelcontextprotocol/ext-apps/app-bridge'
import type { ToolResult } from '@shared/types'
import { useAppHost } from '../app-host'
import { useEscape } from '../escape'
import { HOST_STYLE_VARIABLES } from '../host-styles'

const HOST_INFO = { name: 'tidepool', version: '0.1.0' }
const INITIAL_HEIGHT = 120
const MAX_INLINE_HEIGHT = 6000
/** Escape relayed out of the sandbox proxy; keep in sync with src/main/sandbox.ts. */
const ESCAPE_MESSAGE = 'tidepool/escape'

export interface AppFrameProps {
  callId: string
  server: string
  serverKey: string
  tool: string
  uiResourceUri: string
  input: Record<string, unknown>
  result?: ToolResult
  /** ui/message from the app: the host posts it into the chat as a user message. */
  onAppMessage: (text: string) => void
  onLog: (line: string) => void
}

function currentTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function waitForProxyReady(iframe: HTMLIFrameElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      if (event.source === iframe.contentWindow && event.data?.method === 'ui/notifications/sandbox-proxy-ready') {
        window.removeEventListener('message', onMessage)
        resolve()
      }
    }
    window.addEventListener('message', onMessage)
    signal.addEventListener('abort', () => {
      window.removeEventListener('message', onMessage)
      reject(new Error('aborted'))
    })
  })
}

/**
 * Hosts one MCP App (a tool's ui:// resource) using the official AppBridge from
 * @modelcontextprotocol/ext-apps. The bridge speaks the MCP Apps JSON-RPC dialect over
 * postMessage to the sandboxed iframe; tool calls and resource reads it makes are proxied
 * to the owning MCP server through the main process.
 */
export function AppFrame(props: AppFrameProps): React.JSX.Element {
  const { callId, server, serverKey, tool, uiResourceUri, input, result } = props
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const bridgeRef = useRef<AppBridge | null>(null)
  const exitButtonRef = useRef<HTMLButtonElement>(null)
  const callbacksRef = useRef(props)
  callbacksRef.current = props
  const host = useAppHost()
  // An app belongs to the conversation it was shown in; the transcript remounts when that changes.
  const conversationIdRef = useRef(host.conversationId)
  const hostRef = useRef(host)
  hostRef.current = host
  // Fullscreen is window-level state: only one app holds it, and the layout docks the chat
  // beside whichever one does.
  const fullscreen = host.fullscreenCallId === callId
  const sentDisplayMode = useRef<'inline' | 'fullscreen'>('inline')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string>()
  const [height, setHeight] = useState(INITIAL_HEIGHT)
  const [prefersBorder, setPrefersBorder] = useState(true)
  const sentResult = useRef(false)

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    const abort = new AbortController()
    let resizeObserver: ResizeObserver | undefined
    let themeQuery: MediaQueryList | undefined
    let onThemeChange: (() => void) | undefined
    const log = (line: string): void => callbacksRef.current.onLog(`[${server}/${tool}] ${line}`)

    const hostContext: McpUiHostContext = {
      theme: currentTheme(),
      platform: 'desktop',
      displayMode: 'inline',
      availableDisplayModes: ['inline', 'fullscreen'],
      containerDimensions: { maxHeight: MAX_INLINE_HEIGHT },
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      userAgent: 'tidepool/0.1.0',
      deviceCapabilities: { hover: true, touch: false },
      styles: { variables: HOST_STYLE_VARIABLES }
    }

    const bridge = new AppBridge(
      null,
      HOST_INFO,
      {
        openLinks: {},
        serverTools: {},
        serverResources: {},
        logging: {},
        updateModelContext: { text: {}, structuredContent: {} },
        message: { text: {} }
      },
      { hostContext }
    )
    bridgeRef.current = bridge

    // Register every handler before connect(); apps may call immediately after initializing.
    bridge.oncalltool = async (params) => {
      log(`tools/call ${params.name}`)
      return (await window.api.mcp.callTool(server, params.name, params.arguments ?? {})) as never
    }
    bridge.onreadresource = async (params) => (await window.api.mcp.readResource(server, params.uri)) as never
    bridge.onlistresources = async () => (await window.api.mcp.listResources(server)) as never
    bridge.onopenlink = async ({ url }) => {
      await window.api.openLink(url)
      return {}
    }
    bridge.onmessage = async (params) => {
      const text = params.content
        .map((c) => (c.type === 'text' ? c.text : ''))
        .filter(Boolean)
        .join('\n')
      log(`ui/message: ${text.slice(0, 120)}`)
      if (text) callbacksRef.current.onAppMessage(text)
      return {}
    }
    bridge.onupdatemodelcontext = async (params) => {
      const hasContent = (params.content?.length ?? 0) > 0
      const hasStructured = params.structuredContent && Object.keys(params.structuredContent).length > 0
      log('ui/update-model-context')
      const conversationId = conversationIdRef.current
      if (!conversationId) return {}
      await window.api.chat.setAppContext(
        conversationId,
        hasContent || hasStructured
          ? {
              appId: callId,
              server,
              tool,
              content: params.content as Array<{ type: string; text?: string }> | undefined,
              structuredContent: params.structuredContent as Record<string, unknown> | undefined
            }
          : null,
        callId
      )
      return {}
    }
    bridge.onloggingmessage = (params) => log(`${params.level}: ${JSON.stringify(params.data)}`)
    bridge.onsizechange = ({ height: h }) => {
      if (h !== undefined) setHeight(Math.min(Math.max(Math.ceil(h), 24), MAX_INLINE_HEIGHT))
    }
    bridge.onrequestdisplaymode = async ({ mode }) => {
      const next = mode === 'fullscreen' ? 'fullscreen' : 'inline'
      hostRef.current.setDisplayMode(callId, next)
      return { mode: next }
    }
    bridge.onrequestteardown = () => log('app requested teardown')

    const initialized = new Promise<void>((resolve) => {
      bridge.oninitialized = () => resolve()
    })

    ;(async () => {
      const resource = await window.api.mcp.readUiResource(server, uiResourceUri)
      if (abort.signal.aborted) return
      setPrefersBorder(resource.prefersBorder ?? true)

      const allow = buildAllowAttribute(resource.permissions as McpUiResourcePermissions | undefined)
      if (allow) iframe.setAttribute('allow', allow)
      const proxyReady = waitForProxyReady(iframe, abort.signal)
      const csp = encodeURIComponent(JSON.stringify(resource.csp ?? {}))
      iframe.src = `mcp-sandbox://${serverKey}/sandbox.html?csp=${csp}`
      await proxyReady

      const win = iframe.contentWindow
      if (!win) throw new Error('sandbox iframe has no window')
      await bridge.connect(new PostMessageTransport(win, win))
      await bridge.sendSandboxResourceReady({
        html: resource.html,
        csp: resource.csp,
        permissions: resource.permissions as McpUiResourcePermissions | undefined
      })
      await initialized
      if (abort.signal.aborted) return
      log('initialized')
      await bridge.sendToolInput({ arguments: input })
      setReady(true)

      // Height changes are driven by the app itself, so only report width changes.
      let lastWidth = 0
      // Made in the iframe's own window: the chat can be in an overlay window, and an observer
      // only sees layout in its own window's document.
      const view = (iframe.ownerDocument.defaultView ?? window) as typeof window
      resizeObserver = new view.ResizeObserver(([entry]) => {
        const width = Math.round(entry.contentRect.width)
        if (width > 0 && width !== lastWidth) {
          lastWidth = width
          void bridge.sendHostContextChange({ containerDimensions: { width, maxHeight: MAX_INLINE_HEIGHT } })
        }
      })
      resizeObserver.observe(iframe)
      themeQuery = window.matchMedia('(prefers-color-scheme: dark)')
      onThemeChange = () => void bridge.sendHostContextChange({ theme: currentTheme() })
      themeQuery.addEventListener('change', onThemeChange)
    })().catch((err) => {
      if (!abort.signal.aborted) setError(err instanceof Error ? err.message : String(err))
    })

    return () => {
      abort.abort()
      // A fullscreen app that goes away (e.g. New chat) must not leave the layout in app mode.
      hostRef.current.setDisplayMode(callId, 'inline')
      resizeObserver?.disconnect()
      if (onThemeChange) themeQuery?.removeEventListener('change', onThemeChange)
      bridgeRef.current = null
      // Give the app a moment to clean up, then drop the connection.
      void Promise.race([bridge.teardownResource({}), new Promise((r) => setTimeout(r, 500))])
        .catch(() => {})
        .finally(() => void bridge.close())
    }
    // The frame is created once per tool call; later prop changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId])

  // Deliver the tool result once both the app and the result are ready.
  useEffect(() => {
    const bridge = bridgeRef.current
    if (!ready || !result || !bridge || sentResult.current) return
    sentResult.current = true
    void bridge.sendToolResult(result as never)
  }, [ready, result])

  // Tell the app whenever its display mode changes, whoever changed it: the app itself, the
  // user leaving fullscreen, or another app taking fullscreen over.
  useEffect(() => {
    const mode = fullscreen ? 'fullscreen' : 'inline'
    if (!ready || mode === sentDisplayMode.current) return
    sentDisplayMode.current = mode
    void bridgeRef.current?.sendHostContextChange({ displayMode: mode })
  }, [fullscreen, ready])

  const exitFullscreen = useCallback((): void => {
    hostRef.current.setDisplayMode(callId, 'inline')
  }, [callId])

  // A fullscreen app covers the whole window, so Escape has to get the user out. Keys pressed
  // inside the sandboxed iframe never reach this document, so the sandbox proxy relays Escape
  // back to us (see src/main/sandbox.ts); the Escape stack covers the host's own focus.
  useEscape(exitFullscreen, fullscreen)
  useEffect(() => {
    if (!fullscreen) return
    const onRelayed = (e: MessageEvent): void => {
      if (e.source === iframeRef.current?.contentWindow && e.data?.type === ESCAPE_MESSAGE) exitFullscreen()
    }
    window.addEventListener('message', onRelayed)
    // Put focus on the way out, so Escape works before the user clicks anywhere.
    exitButtonRef.current?.focus()
    return () => {
      window.removeEventListener('message', onRelayed)
    }
  }, [fullscreen, exitFullscreen])

  // The placeholder sits before the frame so the frame's position among its siblings never
  // changes: React would otherwise remount it, and a remounted iframe reloads the app.
  return (
    <>
      {fullscreen && (
        <button className="app-frame-placeholder" onClick={exitFullscreen}>
          Showing fullscreen · <u>bring it back here</u>
        </button>
      )}
    <div className={`app-frame ${fullscreen ? 'fullscreen' : ''} ${prefersBorder ? 'bordered' : ''}`}>
      {fullscreen && (
        <div className="app-frame-bar">
          <span className="app-frame-title">
            {server} › <b>{tool}</b>
          </span>
          <span className="app-frame-actions">
            <button ref={exitButtonRef} className="app-frame-action" onClick={exitFullscreen}>
              <span aria-hidden="true">↙</span> Exit fullscreen <kbd>esc</kbd>
            </button>
          </span>
        </div>
      )}
      {error && <div className="app-frame-error">Failed to load MCP App: {error}</div>}
      <iframe
        ref={iframeRef}
        title={`${server} / ${tool}`}
        sandbox="allow-scripts allow-same-origin allow-forms"
        style={{ height: fullscreen ? '100%' : height }}
      />
    </div>
    </>
  )
}
