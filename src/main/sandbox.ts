import { protocol, type CustomScheme } from 'electron'
import type { UiResource } from '@shared/types'

/**
 * MCP Apps render untrusted HTML from MCP servers. Following the spec's double-iframe
 * design, the renderer embeds an outer "sandbox proxy" iframe served from a separate
 * origin (mcp-sandbox://<server-key>/), which then loads the app HTML into an inner
 * iframe and relays postMessage traffic both ways. Each server gets its own origin, so
 * apps from different servers can't read each other's storage, and none of them can
 * touch the host renderer or the preload bridge.
 */
export const SANDBOX_SCHEME = 'mcp-sandbox'

/**
 * Must run before app 'ready'. Electron takes one list of privileged schemes, so the app's others
 * (pages.ts) come in here too.
 */
export function registerSandboxScheme(others: CustomScheme[] = []): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SANDBOX_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false }
    },
    ...others
  ])
}

// Reject entries that could break out of a CSP directive or inject keywords.
function sanitizeDomains(domains?: string[]): string {
  if (!Array.isArray(domains)) return ''
  return domains.filter((d) => typeof d === 'string' && !/[;\r\n'" ,]/.test(d)).join(' ')
}

/** Same policy as the ext-apps reference host: inline code allowed, network limited to declared domains. */
function buildCsp(csp?: UiResource['csp']): string {
  const resources = sanitizeDomains(csp?.resourceDomains)
  const connect = sanitizeDomains(csp?.connectDomains)
  const frames = sanitizeDomains(csp?.frameDomains)
  const baseUris = sanitizeDomains(csp?.baseUriDomains)
  return [
    "default-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resources}`,
    `style-src 'self' 'unsafe-inline' blob: data: ${resources}`,
    `img-src 'self' data: blob: ${resources}`,
    `font-src 'self' data: blob: ${resources}`,
    `media-src 'self' data: blob: ${resources}`,
    `connect-src 'self' ${connect}`,
    `worker-src 'self' blob: ${resources}`,
    frames ? `frame-src ${frames}` : "frame-src 'none'",
    "object-src 'none'",
    baseUris ? `base-uri ${baseUris}` : "base-uri 'none'"
  ]
    .map((d) => d.trim())
    .join('; ')
}

const PROXY_HTML = /* html */ `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="color-scheme" content="light dark" />
<style>
  html, body { margin: 0; height: 100%; width: 100%; background: transparent; overflow: hidden; }
  iframe { border: 0; width: 100%; height: 100%; display: block; background: transparent; color-scheme: inherit; }
</style>
</head>
<body>
<script>
(() => {
  if (window.self === window.top) throw new Error('sandbox proxy must be framed');
  const OWN_ORIGIN = location.origin;
  const ESCAPE_MESSAGE = 'tidepool/escape';
  const inner = document.createElement('iframe');
  inner.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
  document.body.appendChild(inner);

  // A fullscreen app covers the whole host window, and keys pressed in here never reach the
  // host document. Relay Escape (and nothing else) so the host can always offer a way out.
  // Not a JSON-RPC message, so the app bridge ignores it; not cancelled, so the app still
  // sees the key.
  const relayEscape = (doc) => {
    if (!doc) return;
    doc.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') window.parent.postMessage({ type: ESCAPE_MESSAGE }, '*');
    }, true);
  };
  relayEscape(document);

  // Mirrors buildAllowAttribute() from @modelcontextprotocol/ext-apps.
  const PERMISSION_FEATURES = { camera: 'camera', microphone: 'microphone', geolocation: 'geolocation', clipboardWrite: 'clipboard-write' };
  function allowAttribute(permissions) {
    if (!permissions) return '';
    return Object.keys(PERMISSION_FEATURES).filter((k) => permissions[k]).map((k) => PERMISSION_FEATURES[k]).join('; ');
  }

  // The host is the app's renderer. It may put this frame in an overlay window it opened (see
  // overlays.ts), in which case messages it sends come from the opener, not the parent.
  const fromHost = (source) => source === window.parent || (source !== null && source === window.parent.opener);
  window.addEventListener('message', (event) => {
    if (fromHost(event.source)) {
      const data = event.data;
      if (data && data.method === 'ui/notifications/sandbox-resource-ready') {
        const { html, sandbox, permissions } = data.params || {};
        if (typeof sandbox === 'string') inner.setAttribute('sandbox', sandbox);
        const allow = allowAttribute(permissions);
        if (allow) inner.setAttribute('allow', allow);
        if (typeof html === 'string') {
          const doc = inner.contentDocument;
          if (doc) { doc.open(); doc.write(html); doc.close(); relayEscape(doc); } else { inner.srcdoc = html; }
        }
      } else if (inner.contentWindow) {
        inner.contentWindow.postMessage(data, '*');
      }
    } else if (event.source === inner.contentWindow) {
      if (event.origin !== OWN_ORIGIN) return;
      // The parent is always this app's own renderer; its origin differs between dev
      // (http://localhost) and packaged builds (file://), so target '*'.
      window.parent.postMessage(event.data, '*');
    }
  });

  window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} }, '*');
})();
</script>
</body>
</html>`

/** Must run after app 'ready'. */
export function handleSandboxProtocol(): void {
  protocol.handle(SANDBOX_SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.pathname !== '/sandbox.html') return new Response('Not found', { status: 404 })
    let csp: UiResource['csp']
    try {
      const raw = url.searchParams.get('csp')
      csp = raw ? JSON.parse(raw) : undefined
    } catch {
      csp = undefined
    }
    return new Response(PROXY_HTML, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': buildCsp(csp),
        'Cache-Control': 'no-store'
      }
    })
  })
}
