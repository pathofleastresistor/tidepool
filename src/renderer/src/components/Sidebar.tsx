import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_PROJECT_ID, type ConversationSummary, type Project, type ProjectTab, type WebApp, type WebViewState } from '@shared/types'
import { withShortcut } from '../commands'
import { useEscape } from '../escape'
import { useDragOrder } from '../use-drag-order'
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN } from '../use-sidebar-width'
import { ChatIcon, ChevronIcon, CloseIcon, FolderIcon, GearIcon, HomeIcon, LibraryIcon, MoreIcon, PlusIcon, SearchIcon } from './Icons'
import { TabIcon } from './Projects'
import { SiteIcon } from './Web'

/** What fills the stage beside the sidebar: Home (null), a pinned site, or a project's active tab. */
export type View = { kind: 'site' | 'project'; id: string } | null

interface SidebarProps {
  /** How wide it is; its handle on the right edge changes it. */
  width: number
  onResize: (width: number) => void
  /** A drag of the handle started or ended. */
  onResizing: (resizing: boolean) => void
  websites: WebApp[]
  /** Sites whose page is loaded, keyed by id; the rest haven't been opened (or were closed). */
  webStates: Record<string, WebViewState>
  projects: Project[]
  /** What's being shown, or null for Home. */
  view: View
  /** Home is on screen (nothing open, and no fullscreen app). */
  homeActive: boolean
  onOpenHome: () => void
  /** ⌘K: go to anything, or run a command. */
  onQuickOpen: () => void
  /** The chat window is open, so the chat on screen is the one it shows. */
  chatOpen: boolean
  /** The chats of the project the chat is in, most recent first. */
  conversations: ConversationSummary[]
  /** The project the chat is in, whose chats the sidebar lists. */
  chatProjectId: string
  /** The chat on screen; null for a new one. */
  conversationId: string | null
  /** The project the chat is in; undefined when it isn't in one. */
  chatProjectName: string | undefined
  /** Opens a chat, moving the chat to its project if it's another one. */
  onOpenConversation: (id: string, projectId: string) => void
  onDeleteConversation: (id: string) => void
  /** Every chat, in the Library: the sidebar only lists the latest few. */
  onOpenAllChats: () => void
  onOpenWebsite: (id: string) => void
  onCloseWebsite: (id: string) => void
  onReorderWebsites: (ids: string[]) => void
  onAddWebsite: () => void
  onEditWebsite: (id: string) => void
  onUnpinWebsite: (id: string) => void
  onOpenProject: (id: string) => void
  /** Shows a tab, bringing the chat into its project. */
  onOpenTab: (projectId: string, tabId: string) => void
  /** A tab in a project (or Everyday), waiting for an address. */
  onNewTabIn: (projectId: string) => void
  /** Moves a tab to another project (or Everyday): before another tab, or first. */
  onMoveTab: (tabId: string, toProjectId: string, beforeTabId?: string) => void
  onRenameProject: (id: string) => void
  onDeleteProject: (id: string) => void
  onReorderProjects: (ids: string[]) => void
  onNewProject: () => void
  /** A new chat in a project, or outside them all for the default project. */
  onNewChatIn: (projectId: string) => void
  onOpenSettings: () => void
  /** Something in Settings needs a look, such as an MCP server that failed to connect. */
  settingsAttention: boolean
  /** History, memory and skills, in one window. */
  onOpenLibrary: () => void
  /** Opens memory scrolled to a project, or to the chat's project without one. */
  onOpenMemory: (projectId?: string) => void
  /** Memory notes suggested from browsing, waiting for review. */
  memorySuggestionCount: number
}

/** Which row's menu is open ("site:<id>", "project:<id>" or "chat:<id>"), shared so only one is open at a time. */
interface MenuState {
  open: string | null
  setOpen: (key: string | null) => void
  close: () => void
}

interface MenuItem {
  label: string
  danger?: boolean
  onSelect: () => void
}

/** A row's ⋯ menu. It closes on a pick, Escape, a click elsewhere, or the app losing focus. */
function RowMenu(props: { label: string; items: MenuItem[]; onClose: () => void; className?: string }): React.JSX.Element {
  const { onClose } = props
  const ref = useRef<HTMLDivElement>(null)
  useEscape(onClose)
  useEffect(() => {
    ref.current?.querySelector('button')?.focus()
    const down = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', down)
    // Clicking into a page (a native view) doesn't reach the document; it does blur the window.
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', down)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  return (
    <div className={`row-menu ${props.className ?? ''}`} role="menu" aria-label={props.label} ref={ref}>
      {props.items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          className={item.danger ? 'danger' : ''}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

/** The ⋯ button that opens a row's menu. Right-clicking the row opens it too. */
function MoreButton(props: { menuKey: string; name: string; menu: MenuState }): React.JSX.Element {
  const { menuKey, menu } = props
  const open = menu.open === menuKey
  return (
    <button
      className={`tab-x row-more ${open ? 'open' : ''}`}
      aria-label={`More for ${props.name}`}
      aria-haspopup="menu"
      aria-expanded={open}
      title="Edit or remove"
      // Keeps the menu's click-outside handler from closing it just before this toggles it.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => menu.setOpen(open ? null : menuKey)}
    >
      <MoreIcon />
    </button>
  )
}

/** Tiles to a row; the menu of a tile in the right half opens leftward, to stay in the sidebar. */
const TILE_COLUMNS = 4

/**
 * Pinned sites are tiles at the top, the same whatever else is open: click to switch, drag to
 * reorder, and close to unload the page. Closing never removes the site; Unpin in its menu does.
 * The name is in the tooltip, and in the menu a right-click opens.
 */
function PinnedSites(props: SidebarProps & { menu: MenuState }): React.JSX.Element {
  const { websites, webStates, view, menu } = props
  const byId = new Map(websites.map((w) => [w.id, w]))
  const drag = useDragOrder(
    websites.map((w) => w.id),
    props.onReorderWebsites
  )

  return (
    <div className="pinned">
      <div className="pin-grid" role="tablist" aria-label="Pinned sites">
        {drag.order.map((id, i) => {
          const site = byId.get(id)
          if (!site) return null
          const state = webStates[id]
          const active = view?.kind === 'site' && view.id === id
          const menuOpen = menu.open === `site:${id}`
          return (
            <div
              key={id}
              className={`pin-tile ${active ? 'active' : ''} ${state ? '' : 'asleep'} ${drag.isDragging(id) ? 'dragging' : ''} ${menuOpen ? 'menu-open' : ''}`}
              {...drag.dragProps(id, site.url)}
              onContextMenu={(e) => {
                e.preventDefault()
                menu.setOpen(`site:${id}`)
              }}
              onAuxClick={(e) => e.button === 1 && state && props.onCloseWebsite(id)}
            >
              <button
                className="pin-main"
                role="tab"
                aria-selected={active}
                aria-label={site.name}
                onClick={() => props.onOpenWebsite(id)}
                title={state?.title ? `${site.name}\n${state.title}` : `${site.name}\n${site.url}`}
              >
                {state?.loading ? <span className="tab-spinner" aria-label="Loading" /> : <SiteIcon site={site} />}
              </button>
              {state && (
                <button
                  className="pin-close"
                  onClick={() => props.onCloseWebsite(id)}
                  aria-label={`Close ${site.name}`}
                  title="Close (the site stays pinned)"
                >
                  <CloseIcon />
                </button>
              )}
              {menuOpen && (
                <RowMenu
                  label={site.name}
                  className={i % TILE_COLUMNS < TILE_COLUMNS / 2 ? 'from-left' : ''}
                  onClose={menu.close}
                  items={[
                    ...(state ? [{ label: 'Close', onSelect: () => props.onCloseWebsite(id) }] : []),
                    { label: 'Edit…', onSelect: () => props.onEditWebsite(id) },
                    { label: 'Unpin', danger: true, onSelect: () => props.onUnpinWebsite(id) }
                  ]}
                />
              )}
            </div>
          )
        })}
        <button className="pin-tile pin-add" onClick={props.onAddWebsite} aria-label="Pin a site" title="Pin a site">
          <PlusIcon />
        </button>
      </div>
      {websites.length === 0 && <p className="sidebar-empty">Pin sites you use every day, like mail or chat.</p>}
    </div>
  )
}

/** How many chats a list shows; the rest are in the Library. */
const RECENT_CHATS = 3

/**
 * The chats in the project the chat is in (or outside them all). The one on screen is highlighted;
 * a spinner marks any still answering.
 */
function ChatList(
  props: SidebarProps & {
    menu: MenuState
    chats: ConversationSummary[]
    /** The project these chats are in, which opening one moves the chat to. */
    projectId: string
    label: string
    /** What to say when there are none; nothing when left out. */
    empty?: string
  }
): React.JSX.Element {
  const { chats, conversationId, chatOpen } = props
  const shown = chats.slice(0, RECENT_CHATS)
  // The one on screen stays listed even when it's older than the rest.
  const current = chats.find((c) => c.id === conversationId)
  if (current && !shown.includes(current)) shown.push(current)
  return (
    <div className="tab-list chat-list" aria-label={props.label}>
      {shown.map((c) => {
        const name = c.title || 'New chat'
        const onScreen = c.id === conversationId
        return (
          <div
            key={c.id}
            className={`website-row chat-row ${onScreen && chatOpen ? 'active' : ''} ${onScreen && !chatOpen ? 'current' : ''} ${props.menu.open === `chat:${c.id}` ? 'menu-open' : ''}`}
            onContextMenu={(e) => {
              e.preventDefault()
              props.menu.setOpen(`chat:${c.id}`)
            }}
          >
            <button
              className="tab-main"
              onClick={() => props.onOpenConversation(c.id, props.projectId)}
              aria-current={onScreen ? 'page' : undefined}
              title={name}
            >
              {c.busy ? <span className="tab-spinner" aria-label="Answering" /> : <ChatIcon />}
              <span className="tab-name">{name}</span>
            </button>
            <MoreButton menuKey={`chat:${c.id}`} name={name} menu={props.menu} />
            {props.menu.open === `chat:${c.id}` && (
              <RowMenu
                label={name}
                onClose={props.menu.close}
                items={[{ label: 'Delete chat', danger: true, onSelect: () => props.onDeleteConversation(c.id) }]}
              />
            )}
          </div>
        )
      })}
      {chats.length > shown.length && (
        <button className="show-more" onClick={props.onOpenAllChats}>
          All chats
        </button>
      )}
      {chats.length === 0 && props.empty && <p className="sidebar-empty">{props.empty}</p>}
    </div>
  )
}

/** What the tabs and chats outside every project are called, where they need a name (⌘K). */
export const DEFAULT_SPACE_NAME = 'Everyday'

export const tabLabel = (tab: ProjectTab): string => {
  if (tab.title) return tab.title
  if (!tab.url) return 'New tab'
  try {
    return new URL(tab.url).host
  } catch {
    return tab.url
  }
}

/** A sidebar preference kept for next time, such as which projects are open. */
function useStored<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key)
      return saved === null ? initial : (JSON.parse(saved) as T)
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (next: T) => {
      setValue(next)
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // Remembering it is a convenience; it's fine if storage is unavailable.
      }
    },
    [key]
  )
  return [value, set]
}

/**
 * A tab being dragged to another list: Everyday's, a project's tabs, or a project's row. Within its
 * own list, a drag reorders (useDragOrder); dropped anywhere else that takes tabs, it moves there.
 */
interface TabDrag {
  /** A tab from another list is being dragged, so this list can take it. */
  foreign: (projectId: string) => boolean
  /** Where a drop would land, highlighted: "tab:<id>" (before it), "project:<id>" or "everyday". */
  target: string | null
  start: (projectId: string, tabId: string) => void
  end: () => void
  /** Drag-over and drop handlers for something that takes tabs into `projectId`, before `beforeTabId` or first. */
  dropProps: (target: string, projectId: string, beforeTabId?: string) => React.HTMLAttributes<HTMLElement>
}

/**
 * The tab being dragged, from the sidebar or a project's tab strip, so either can drop it on the
 * other. Not state: dragover comes right after dragstart, before a render would land.
 */
const from: { current: { projectId: string; tabId: string } | null } = { current: null }

/** A project's tab strip starts and ends its drags here, so its tabs can be dropped in the sidebar. */
export const tabDragSource = {
  start: (projectId: string, tabId: string): void => {
    from.current = { projectId, tabId }
  },
  end: (): void => {
    from.current = null
  }
}

function useTabDrag(onMoveTab: SidebarProps['onMoveTab']): TabDrag {
  const [target, setTarget] = useState<string | null>(null)
  const foreign = (projectId: string): boolean => from.current !== null && from.current.projectId !== projectId
  return {
    foreign,
    target,
    start: (projectId, tabId) => {
      from.current = { projectId, tabId }
    },
    end: () => {
      from.current = null
      setTarget(null)
    },
    dropProps: (key, projectId, beforeTabId) => ({
      onDragOver: (e) => {
        if (!foreign(projectId)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'move'
        if (target !== key) setTarget(key)
      },
      onDrop: (e) => {
        const tab = from.current
        if (!tab || !foreign(projectId)) return
        e.preventDefault()
        e.stopPropagation()
        from.current = null
        setTarget(null)
        onMoveTab(tab.tabId, projectId, beforeTabId)
      }
    })
  }
}

/**
 * A project's tabs (or Everyday's), like a browser's vertical tabs: click to show one, drag to
 * reorder, middle-click or × to close.
 */
function TabList(props: SidebarProps & { projectId: string; label: string; menu: MenuState; tabDrag: TabDrag }): React.JSX.Element {
  const { menu, tabDrag } = props
  const api = window.api.projects
  const { projectId } = props
  const project = props.projects.find((p) => p.id === projectId)
  const tabs = project?.tabs ?? []
  const byId = new Map(tabs.map((t) => [t.id, t]))
  const drag = useDragOrder(
    tabs.map((t) => t.id),
    (ids) => void api.reorderTabs(projectId, ids)
  )
  const onScreen = props.view?.kind === 'project' && props.view.id === projectId
  // Where else a tab can go: Everyday, then the projects in their order.
  const elsewhere = props.projects.filter((p) => p.id !== projectId)
  return (
    <div className="tab-list" role="tablist" aria-orientation="vertical" aria-label={props.label}>
      {drag.order.map((id) => {
        const tab = byId.get(id)
        if (!tab) return null
        const active = onScreen && tab.id === project?.activeTabId
        const name = tabLabel(tab)
        const menuKey = `tab:${id}`
        const reorder = drag.dragProps(id, tab.url || undefined)
        const move = tabDrag.dropProps(`tab:${id}`, projectId, id)
        return (
          <div
            key={id}
            className={`website-row tab-row ${active ? 'active' : ''} ${drag.isDragging(id) ? 'dragging' : ''} ${tabDrag.target === `tab:${id}` ? 'drop-before' : ''} ${menu.open === menuKey ? 'menu-open' : ''}`}
            data-tab-id={tab.id}
            {...reorder}
            onDragStart={(e) => {
              reorder.onDragStart?.(e)
              tabDrag.start(projectId, id)
            }}
            onDragEnd={(e) => {
              reorder.onDragEnd?.(e)
              tabDrag.end()
            }}
            onDragOver={(e) => (tabDrag.foreign(projectId) ? move.onDragOver?.(e) : reorder.onDragOver?.(e))}
            onDrop={(e) => (tabDrag.foreign(projectId) ? move.onDrop?.(e) : reorder.onDrop?.(e))}
            onAuxClick={(e) => e.button === 1 && void api.closeTab(projectId, tab.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              menu.setOpen(menuKey)
            }}
          >
            <button
              className="tab-main"
              role="tab"
              aria-selected={active}
              onClick={() => props.onOpenTab(projectId, tab.id)}
              title={tab.url ? `${name}\n${tab.url}` : name}
            >
              <TabIcon tab={tab} />
              <span className="tab-name">{name}</span>
            </button>
            <button
              className="tab-x"
              aria-label={`Close ${name}`}
              title={withShortcut('Close tab', 'tab.close')}
              onClick={() => void api.closeTab(projectId, tab.id)}
            >
              <CloseIcon />
            </button>
            {menu.open === menuKey && (
              <RowMenu
                label={name}
                onClose={menu.close}
                items={[
                  ...elsewhere.map((p) => ({
                    label: `Move to ${p.id === DEFAULT_PROJECT_ID ? DEFAULT_SPACE_NAME : p.name}`,
                    onSelect: () => props.onMoveTab(id, p.id)
                  })),
                  { label: 'Close tab', onSelect: () => void api.closeTab(projectId, tab.id) }
                ]}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Tabs outside every project, first in the sidebar and always there. */
function EverydayTabs(props: SidebarProps & { menu: MenuState; tabDrag: TabDrag }): React.JSX.Element {
  return (
    <div
      className={`everyday ${props.tabDrag.target === 'everyday' ? 'drop-into' : ''}`}
      {...props.tabDrag.dropProps('everyday', DEFAULT_PROJECT_ID)}
    >
      <button
        className="nav-row subtle new-tab-row"
        onClick={() => props.onNewTabIn(DEFAULT_PROJECT_ID)}
        title={withShortcut('New tab', 'tab.new')}
      >
        <PlusIcon />
        <span>New tab</span>
      </button>
      <TabList {...props} projectId={DEFAULT_PROJECT_ID} label="Tabs" />
    </div>
  )
}

/**
 * Projects, under Everyday's tabs: a section that folds away, and a row per project. A project's
 * tabs run across the top of its page, after its Home, so a row just opens it (and brings the chat
 * into it). Drop a tab on a row to move it there.
 */
function ProjectsSection(props: SidebarProps & { menu: MenuState; tabDrag: TabDrag }): React.JSX.Element {
  const { menu, view, tabDrag } = props
  const [collapsed, setCollapsed] = useStored('sidebar.projectsCollapsed', false)
  const projects = props.projects.filter((p) => p.id !== DEFAULT_PROJECT_ID)
  const byId = new Map(projects.map((p) => [p.id, p]))
  const drag = useDragOrder(
    projects.map((p) => p.id),
    // The default project keeps its place at the front, out of sight.
    (ids) => props.onReorderProjects([DEFAULT_PROJECT_ID, ...ids])
  )
  const onScreen = view?.kind === 'project' && view.id !== DEFAULT_PROJECT_ID ? view.id : null
  useEffect(() => {
    if (onScreen && collapsed) setCollapsed(false)
    // Only when what's on screen changes; folding it away again afterwards is up to the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScreen])

  return (
    <section className="projects" aria-label="Projects">
      <div className="sidebar-label">
        <button className="section-toggle" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
          <span>Projects</span>
          <ChevronIcon />
        </button>
        <button className="section-add" onClick={props.onNewProject} aria-label="New project" title="New project">
          <PlusIcon />
        </button>
      </div>
      {!collapsed && (
        <div className="project-list">
          {drag.order.map((id) => {
            const project = byId.get(id)
            if (!project) return null
            const menuKey = `project:${id}`
            const tabs = project.tabs.length
            const active = onScreen === id
            return (
              <div
                key={id}
                className={`project ${tabDrag.target === `project:${id}` ? 'drop-into' : ''}`}
                {...tabDrag.dropProps(`project:${id}`, id)}
              >
                <div
                  className={`website-row project-row ${active ? 'active' : ''} ${drag.isDragging(id) ? 'dragging' : ''} ${menu.open === menuKey ? 'menu-open' : ''}`}
                  {...drag.dragProps(id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    menu.setOpen(menuKey)
                  }}
                >
                  <button className="tab-main" aria-current={active ? 'page' : undefined} onClick={() => props.onOpenProject(id)}>
                    {project.tabs.some((t) => t.loading) ? <span className="tab-spinner" aria-label="Loading" /> : <FolderIcon />}
                    <span className="tab-name">{project.name}</span>
                    {tabs > 0 && (
                      <span className="tab-count" aria-label={`${tabs} tab${tabs === 1 ? '' : 's'}`}>
                        {tabs}
                      </span>
                    )}
                  </button>
                  <MoreButton menuKey={menuKey} name={project.name} menu={menu} />
                  {menu.open === menuKey && (
                    <RowMenu
                      label={project.name}
                      onClose={menu.close}
                      items={[
                        { label: 'New tab', onSelect: () => props.onNewTabIn(id) },
                        { label: 'New chat', onSelect: () => props.onNewChatIn(id) },
                        { label: 'Rename…', onSelect: () => props.onRenameProject(id) },
                        { label: 'Memory…', onSelect: () => props.onOpenMemory(id) },
                        { label: 'Delete project', danger: true, onSelect: () => props.onDeleteProject(id) }
                      ]}
                    />
                  )}
                </div>
              </div>
            )
          })}
          {projects.length === 0 && <p className="sidebar-empty">Keep tabs, chats and memory for a topic together.</p>}
        </div>
      )}
    </section>
  )
}

function SectionLabel(props: { label: string; action: string; onAction: () => void }): React.JSX.Element {
  return (
    <div className="sidebar-label">
      <span>{props.label}</span>
      <button className="section-add" onClick={props.onAction} aria-label={props.action} title={props.action}>
        <PlusIcon />
      </button>
    </div>
  )
}

/** Beside the window's buttons: Home, and ⌘K to go anywhere. The rest of the strip drags the window. */
function Titlebar(props: SidebarProps): React.JSX.Element {
  return (
    <div className="titlebar-spacer sidebar-titlebar">
      <button
        className={`titlebar-button ${props.homeActive ? 'active' : ''}`}
        onClick={props.onOpenHome}
        aria-label="Home"
        aria-current={props.homeActive ? 'page' : undefined}
        title={withShortcut('Home', 'app.home')}
      >
        <HomeIcon />
      </button>
      <button className="titlebar-button" onClick={props.onQuickOpen} aria-label="Quick Open" title={withShortcut('Go to…', 'app.quickOpen')}>
        <SearchIcon />
      </button>
    </div>
  )
}

/**
 * The sidebar's right edge: drag it to resize, double-click to go back to the usual width, or use
 * the arrow keys once it has focus.
 */
function ResizeHandle(props: SidebarProps): React.JSX.Element {
  const start = useRef<{ x: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const end = (e: React.PointerEvent): void => {
    if (!start.current) return
    start.current = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
    props.onResizing(false)
  }
  return (
    <div
      className={`sidebar-resize ${dragging ? 'dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={props.width}
      aria-valuemin={SIDEBAR_MIN}
      aria-valuemax={SIDEBAR_MAX}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, width: props.width }
        setDragging(true)
        props.onResizing(true)
      }}
      onPointerMove={(e) => {
        if (start.current) props.onResize(start.current.width + e.clientX - start.current.x)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => props.onResize(SIDEBAR_DEFAULT)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 32 : 8
        if (e.key === 'ArrowLeft') props.onResize(props.width - step)
        else if (e.key === 'ArrowRight') props.onResize(props.width + step)
        else return
        e.preventDefault()
      }}
    />
  )
}

export function Sidebar(props: SidebarProps): React.JSX.Element {
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const close = useCallback(() => setOpenMenu(null), [])
  const menu: MenuState = { open: openMenu, setOpen: setOpenMenu, close }
  const tabDrag = useTabDrag(props.onMoveTab)
  return (
    <aside className="sidebar" style={{ width: props.width }}>
      <Titlebar {...props} />
      <PinnedSites {...props} menu={menu} />
      <nav className="sidebar-lists">
        <EverydayTabs {...props} menu={menu} tabDrag={tabDrag} />
        <ProjectsSection {...props} menu={menu} tabDrag={tabDrag} />
        <SectionLabel
          label={props.chatProjectName ? `Chats in ${props.chatProjectName}` : 'Chats'}
          action="New chat"
          onAction={() => props.onNewChatIn(props.chatProjectId)}
        />
        <ChatList
          {...props}
          menu={menu}
          chats={props.conversations}
          projectId={props.chatProjectId}
          label={props.chatProjectName ? `Chats in ${props.chatProjectName}` : 'Chats'}
          empty={props.chatProjectName ? `Chats in ${props.chatProjectName} show up here.` : 'Your chats show up here.'}
        />
      </nav>
      <div className="sidebar-footer">
        <button
          className="nav-row"
          onClick={props.onOpenLibrary}
          aria-label={`Library${props.memorySuggestionCount > 0 ? ` (${props.memorySuggestionCount} to review)` : ''}`}
          title={
            props.memorySuggestionCount > 0
              ? `Library: ${props.memorySuggestionCount} memory note${props.memorySuggestionCount === 1 ? '' : 's'} suggested from browsing, to review`
              : 'Library: chats, history, memory and skills'
          }
        >
          <LibraryIcon />
          <span>Library</span>
          {props.memorySuggestionCount > 0 && <span className="nav-badge">{props.memorySuggestionCount}</span>}
        </button>
        <button className="nav-row" onClick={props.onOpenSettings} title={withShortcut('Settings', 'app.settings')}>
          <GearIcon />
          <span>Settings</span>
          {props.settingsAttention && <span className="attention-dot" title="An MCP server needs attention" />}
        </button>
      </div>
      <ResizeHandle {...props} />
    </aside>
  )
}
