import { useEffect, useRef, useState } from 'react'
import { PageToolsButton } from './PageTools'
import type { ConversationSummary, Project, ProjectTab, ViewBounds } from '@shared/types'
import { useCommand, withShortcut } from '../commands'
import { useDragOrder } from '../use-drag-order'
import { useInlineCompletion } from '../use-inline-completion'
import { Modal } from './Modals'
import { Card, PagesCard, Row } from './Home'
import { BackIcon, ChatIcon, CloseIcon, ExternalIcon, ForwardIcon, HomeIcon, MemoryIcon, PageIcon, PinIcon, PlusIcon, ReloadIcon, SearchIcon } from './Icons'
import { tabDragSource, tabLabel } from './Sidebar'
import { SignInBlockedBanner } from './Web'

export function TabIcon({ tab }: { tab: ProjectTab }): React.JSX.Element {
  const [broken, setBroken] = useState<string>()
  if (tab.loading) return <span className="tab-spinner" aria-label="Loading" />
  if (isPage(tab.url)) return <PageIcon />
  if (tab.favicon && broken !== tab.favicon) {
    return <img className="tab-icon" src={tab.favicon} alt="" onError={() => setBroken(tab.favicon)} />
  }
  return <span className="tab-icon placeholder" aria-hidden="true" />
}

/** One of the project's pages, which Claude made (main/pages.ts), rather than a website. */
export const isPage = (url: string | undefined): boolean => !!url?.startsWith('tidepool-page://')

/**
 * A project's tabs, across the top of its page like a browser's: its Home first, which can't be
 * closed, then its tabs (click to show, drag to reorder or onto the sidebar to move, middle-click
 * or × to close, right-click to move to another project), then New tab.
 */
export function ProjectTabStrip(props: {
  project: Project
  /** The project's Home is showing rather than a tab. */
  homeSelected: boolean
  onHome: () => void
  onSelectTab: (tabId: string) => void
  onNewTab: () => void
}): React.JSX.Element {
  const { project, homeSelected } = props
  const api = window.api.projects
  const drag = useDragOrder(
    project.tabs.map((t) => t.id),
    (ids) => void api.reorderTabs(project.id, ids)
  )
  const byId = new Map(project.tabs.map((t) => [t.id, t]))
  return (
    <div className="project-strip" role="tablist" aria-label={`${project.name} tabs`}>
      <div
        className={`project-tab project-home-tab ${homeSelected ? 'active' : ''}`}
        role="tab"
        aria-selected={homeSelected}
        title={`${project.name}: chats and more`}
        onClick={props.onHome}
      >
        <HomeIcon />
        <span className="tab-title">{project.name}</span>
      </div>
      {drag.order.map((id) => {
        const tab = byId.get(id)
        if (!tab) return null
        const selected = !homeSelected && tab.id === project.activeTabId
        const name = tabLabel(tab)
        const reorder = drag.dragProps(id, tab.url || undefined)
        return (
          <div
            key={tab.id}
            className={`project-tab ${selected ? 'active' : ''} ${drag.isDragging(id) ? 'dragging' : ''}`}
            role="tab"
            aria-selected={selected}
            data-tab-id={tab.id}
            title={tab.url ? `${name}\n${tab.url}` : name}
            onClick={() => props.onSelectTab(tab.id)}
            onAuxClick={(e) => e.button === 1 && void api.closeTab(project.id, tab.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              void api.tabMenu(project.id, tab.id)
            }}
            {...reorder}
            onDragStart={(e) => {
              reorder.onDragStart?.(e)
              tabDragSource.start(project.id, tab.id)
            }}
            onDragEnd={(e) => {
              reorder.onDragEnd?.(e)
              tabDragSource.end()
            }}
          >
            <TabIcon tab={tab} />
            <span className="tab-title">{name}</span>
            <button
              className="tab-close"
              aria-label={`Close ${name}`}
              title={withShortcut('Close tab', 'tab.close')}
              onClick={(e) => {
                e.stopPropagation()
                void api.closeTab(project.id, tab.id)
              }}
            >
              <CloseIcon />
            </button>
          </div>
        )
      })}
      <button className="icon tab-new" aria-label="New tab" title={withShortcut('New tab', 'tab.new')} onClick={props.onNewTab}>
        <PlusIcon />
      </button>
      <span className="grow" />
    </div>
  )
}

/**
 * A project's Home, its first tab: its chats, all of them, with a new one a click away, and a box
 * that opens a page in a new tab here.
 */
export function ProjectHome(props: {
  project: Project
  conversations: ConversationSummary[]
  onOpenConversation: (id: string) => void
  onNewChat: () => void
  /** Opens what was typed, an address or a search, in a new tab in the project. */
  onSearch: (text: string) => void
  onOpenMemory: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const { project, conversations } = props
  const searchRef = useRef<HTMLInputElement>(null)
  const completion = useInlineCompletion({ ref: searchRef, setValue: setQuery, projectId: project.id })
  const tabs = project.tabs.length
  return (
    <section className="home project-home" aria-label={`${project.name} home`}>
      <div className="home-inner">
        <h1>{project.name}</h1>
        <p className="home-lede">
          {conversations.length} chat{conversations.length === 1 ? '' : 's'} · {tabs} tab{tabs === 1 ? '' : 's'} open
        </p>
        <form
          className="home-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault()
            if (!query.trim()) return
            props.onSearch(query.trim())
            setQuery('')
          }}
        >
          <SearchIcon />
          <input
            ref={searchRef}
            type="search"
            // A new project has nothing else to do yet.
            autoFocus={tabs === 0}
            aria-label={`Open a page in ${project.name}`}
            placeholder="Search Google or type an address"
            spellCheck={false}
            value={query}
            onChange={completion.onChange}
            onKeyDown={completion.onKeyDown}
          />
        </form>
        <div className="home-cards project-home-cards">
          <Card title="Chats" action={{ label: 'New chat', onSelect: props.onNewChat }}>
            {conversations.map((c) => (
              <Row
                key={c.id}
                icon={<ChatIcon />}
                busy={c.busy}
                name={c.title || 'New chat'}
                detail={new Date(c.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                onClick={() => props.onOpenConversation(c.id)}
              />
            ))}
            {conversations.length === 0 && <p className="muted small project-home-empty">No chats in {project.name} yet.</p>}
          </Card>
          <PagesCard projectId={project.id} emptyText={`Ask Claude to make a page, like a plan or a comparison, and it'll be kept here.`} />
          <Card title="Memory" action={{ label: 'Open', onSelect: props.onOpenMemory }}>
            <Row icon={<MemoryIcon />} name={`What Tidepool remembers for ${project.name}`} onClick={props.onOpenMemory} />
          </Card>
        </div>
      </div>
    </section>
  )
}

/**
 * A space's active tab: a toolbar with an address bar, then the page. The tabs themselves are in
 * the sidebar, and a tab with no page yet shows Home instead. Like a pinned site, the page is a
 * native view the main process lays over the slot, so this reports where the slot is. Main shows
 * whichever tab is active in the project.
 */
export function ProjectPane(props: {
  project: Project
  /** False while something (a dialog, a fullscreen app) needs the space the view covers. */
  visible: boolean
  /** Moves the tab to Pinned. */
  onPin: (tab: ProjectTab) => void
  pinnedUrls: Set<string>
  /** Opens "Remember this page" for the tab's page. */
  onRemember: (page: { title: string; url: string }) => void
  /** Tools the page on screen offers (WebMCP), and a look at them. */
  pageToolCount: number
  onOpenPageTools: () => void
}): React.JSX.Element {
  const { project, visible } = props
  const api = window.api.projects
  const active = project.tabs.find((t) => t.id === project.activeTabId)
  const slotRef = useRef<HTMLDivElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const completion = useInlineCompletion({ ref: addressRef, setValue: setAddress, projectId: project.id })

  useEffect(() => {
    const slot = slotRef.current
    if (!slot || !visible) {
      void api.hide()
      return
    }
    const bounds = (): ViewBounds => {
      const r = slot.getBoundingClientRect()
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    }
    void api.show(project.id, bounds())
    const update = (): void => void api.setBounds(bounds())
    const observer = new ResizeObserver(update)
    observer.observe(slot)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      void api.hide()
    }
  }, [api, project.id, visible])

  // The address bar follows the tab unless you're typing in it.
  useEffect(() => {
    if (!editing) setAddress(active?.url ?? '')
  }, [active?.url, active?.id, editing])

  // ⌘L. The app gives its page the keyboard first; a website may have had it.
  useCommand('tab.address', () => {
    addressRef.current?.focus()
    addressRef.current?.select()
  })

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (!address.trim()) return
    void api.navigate(project.id, address)
    setEditing(false)
    addressRef.current?.blur()
  }

  const pinned = active?.url ? props.pinnedUrls.has(active.url) : false
  // A page lives in its project: it can't be pinned, or opened in another browser.
  const onPage = isPage(active?.url)

  return (
    <section className="web-pane project-pane" aria-label={project.name}>
      <div className="web-toolbar">
        <button className="icon" onClick={() => api.back(project.id)} disabled={!active?.canGoBack} aria-label="Back" title={withShortcut('Back', 'page.back')}>
          <BackIcon />
        </button>
        <button className="icon" onClick={() => api.forward(project.id)} disabled={!active?.canGoForward} aria-label="Forward" title={withShortcut('Forward', 'page.forward')}>
          <ForwardIcon />
        </button>
        {active?.loading ? (
          <button className="icon" onClick={() => api.stop(project.id)} aria-label="Stop" title="Stop">
            <CloseIcon />
          </button>
        ) : (
          <button className="icon" onClick={() => api.reload(project.id)} disabled={!active?.loaded} aria-label="Reload" title={withShortcut('Reload', 'page.reload')}>
            <ReloadIcon />
          </button>
        )}
        <form className="address" onSubmit={submit}>
          <input
            ref={addressRef}
            value={address}
            spellCheck={false}
            aria-label="Address"
            placeholder="Search or enter address"
            onFocus={(e) => {
              setEditing(true)
              e.target.select()
            }}
            onBlur={() => setEditing(false)}
            onChange={completion.onChange}
            onKeyDown={(e) => {
              if (completion.onKeyDown(e)) return
              if (e.key === 'Escape') {
                // Handled here: Escape shouldn't also close whatever else is open.
                e.preventDefault()
                setAddress(active?.url ?? '')
                e.currentTarget.blur()
              }
            }}
          />
        </form>
        <button
          className="icon"
          onClick={() => active && props.onPin(active)}
          disabled={!active?.url || pinned || onPage}
          aria-label="Pin this site"
          title={onPage ? 'Pages stay in their project' : pinned ? 'Already pinned' : withShortcut('Pin: the tab moves to your pinned sites', 'page.pin')}
        >
          <PinIcon />
        </button>
        <PageToolsButton count={props.pageToolCount} onOpen={props.onOpenPageTools} />
        <button
          className="icon"
          onClick={() => active?.url && props.onRemember({ title: active.title, url: active.url })}
          disabled={!active?.url}
          aria-label="Remember this page"
          title="Remember this page"
        >
          <MemoryIcon />
        </button>
        <button
          className="icon"
          onClick={() => api.openInBrowser(project.id)}
          disabled={!active?.url || onPage}
          aria-label="Open in browser"
          title="Open in your browser"
        >
          <ExternalIcon />
        </button>
      </div>
      <SignInBlockedBanner url={active?.url} />
      <div className="web-view-slot" ref={slotRef} />
    </section>
  )
}

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)

/** Name a new project, or rename one. */
export function ProjectModal(props: {
  project?: Project
  /** Called with the new project's id, or nothing after a rename. */
  onSaved: (openId?: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { project } = props
  const [name, setName] = useState(project?.name ?? '')
  const [error, setError] = useState<string>()

  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    try {
      if (project) {
        await window.api.projects.rename(project.id, name)
        props.onSaved()
      } else {
        props.onSaved(await window.api.projects.create(name))
      }
      props.onClose()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <Modal title={project ? `Rename ${project.name}` : 'New project'} onClose={props.onClose}>
      <form className="server-form" onSubmit={save}>
        <label className="field">
          <span>Name</span>
          <input autoFocus value={name} placeholder="Trip planning" onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="muted small">
          A project keeps a set of tabs and its own chats together, and they're still there next time you open the
          app. Links from the chat and from pinned sites open in the project you used last.
        </p>
        {error && <div className="server-error">{error}</div>}
        <div className="row end">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!name.trim()}>
            {project ? 'Rename' : 'Create project'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
