import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { COMMANDS, isEnabled, type CommandContext } from '@shared/commands'
import {
  DEFAULT_PROJECT_ID,
  type ConversationSummary,
  type FindTarget,
  type PageInsights,
  type ShoppingIdea,
  type PageSuggestions,
  type Project,
  type ProjectTab,
  type PublicSettings,
  type ServerStatus,
  type Skill,
  type SkillProposal,
  type ViewBounds,
  type WebApp,
  type WebMcpSource,
  type WebViewState
} from '@shared/types'
import { AppHostContext, type AppHostState } from './app-host'
import { emitCommand, setKeyBindings, shortcutLabel, useCommands, withShortcut } from './commands'
import { emptyChat, reducer, type Item, type ToolCall } from '@shared/chat-state'
import { useStickToBottom } from './use-stick-to-bottom'
import { useSidebarWidth } from './use-sidebar-width'
import { useVoice } from './use-voice'
import { SettingsModal } from './components/Modals'
import { LibraryModal, type LibraryTab } from './components/Library'
import { RememberModal } from './components/Memory'
import { SkillReviewModal, skillSite } from './components/Skills'
import { ProjectHome, ProjectModal, ProjectPane, ProjectTabStrip, TabIcon } from './components/Projects'
import { DEFAULT_SPACE_NAME, Sidebar, type View } from './components/Sidebar'
import { Transcript, type ApprovalHandler } from './components/Transcript'
import { PageToolsModal, type OpenPage } from './components/PageTools'
import { Dock, replyPeek, type ContextAction } from './components/Dock'
import { Home } from './components/Home'
import { Overlay } from './components/Overlay'
import { MicButton, VoiceCard } from './components/Voice'
import { ChatIcon, ComposeIcon, FolderIcon, HomeIcon, TabsIcon, MinimizeIcon, SendIcon, SkillIcon, StopIcon } from './components/Icons'
import { FindBar } from './components/FindBar'
import { QuickOpen, type QuickOpenItem } from './components/QuickOpen'
import { ShortcutsModal } from './components/Shortcuts'
import { SiteIcon, WebPane, WebsiteModal } from './components/Web'

const MAX_LOG_LINES = 500
const CHAT_OPEN_KEY = 'chatOpen'

/** The chat window starts closed: talking and the buttons in the bar come first. */
function readChatOpen(): boolean {
  try {
    return localStorage.getItem(CHAT_OPEN_KEY) === 'true'
  } catch {
    return false
  }
}

/** An element's box in the window, kept up to date as it or the window changes size. */
function useElementRect(ref: React.RefObject<HTMLElement | null>): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => setRect(el.getBoundingClientRect())
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [ref])
  return rect
}

// Keep in step with --chat-width and --chat-gap in styles.css.
const CHAT_WIDTH = 400
const CHAT_GAP = 12
const CHAT_MAX_HEIGHT = 640
/** Room around the chat window inside its overlay, for its shadow. */
const CHAT_SHADOW = 8
// Keep in step with .dock-overlay .dock in styles.css.
const DOCK_BUTTON = 44
const DOCK_SHADOW = 8

/** The dock's overlay: just its content, at the stage's bottom right. */
function dockBounds(stage: DOMRect | null, size: { width: number; height: number }): ViewBounds | null {
  if (!stage) return null
  const width = size.width + DOCK_SHADOW * 2
  const height = size.height + DOCK_SHADOW * 2
  return { x: stage.right - CHAT_GAP + DOCK_SHADOW - width, y: stage.bottom - CHAT_GAP + DOCK_SHADOW - height, width, height }
}

/**
 * Where the chat's overlay goes. Open, it's just the chat window, floating at the bottom right of
 * the stage in the dock's place (the dock hides while it's open), over whatever is there, websites included. While an app is fullscreen the
 * overlay is the whole stage, since the app is part of the chat (moving its iframe out would
 * reload it). Otherwise it's hidden.
 */
function chatBounds(stage: DOMRect | null, state: { open: boolean; appFullscreen: boolean }): ViewBounds | null {
  if (!stage) return null
  if (state.appFullscreen) return { x: stage.left, y: stage.top, width: stage.width, height: stage.height }
  if (!state.open) return null
  const bottom = stage.bottom - CHAT_GAP
  const height = Math.min(CHAT_MAX_HEIGHT, bottom - stage.top - CHAT_GAP) + CHAT_SHADOW * 2
  const width = Math.min(CHAT_WIDTH, stage.width - CHAT_GAP * 2) + CHAT_SHADOW * 2
  return {
    x: stage.right - CHAT_GAP + CHAT_SHADOW - width,
    y: bottom + CHAT_SHADOW - height,
    width,
    height
  }
}

// Keep in step with .quick-open-overlay and .find-overlay in styles.css.
const QUICK_OPEN_WIDTH = 580
const FIND_WIDTH = 320
const FIND_HEIGHT = 40
/** Room around a floating box inside its overlay, for its shadow. */
const FLOAT_SHADOW = 12

/** Quick Open floats near the top of the stage, over whatever is there. */
function quickOpenBounds(stage: DOMRect | null, contentHeight: number): ViewBounds | null {
  if (!stage) return null
  const width = Math.min(QUICK_OPEN_WIDTH, stage.width - 32) + FLOAT_SHADOW * 2
  const height = Math.min(contentHeight, stage.height - 96) + FLOAT_SHADOW * 2
  return { x: stage.left + (stage.width + FLOAT_SHADOW * 2 - width) / 2 - FLOAT_SHADOW, y: stage.top + 56 - FLOAT_SHADOW, width, height }
}

/**
 * The find bar hangs at the top right of what it searches: under the page's toolbar, or under
 * the chat window's header.
 */
function findBounds(stage: DOMRect | null, target: FindTarget, chat: ViewBounds | null): ViewBounds | null {
  if (!stage) return null
  const width = FIND_WIDTH + FLOAT_SHADOW * 2
  const height = FIND_HEIGHT + FLOAT_SHADOW * 2
  if (target === 'chat' && chat) {
    return { x: chat.x + chat.width - CHAT_SHADOW - 8 - FIND_WIDTH - FLOAT_SHADOW, y: chat.y + CHAT_SHADOW + 56 - FLOAT_SHADOW, width, height }
  }
  const slot = document.querySelector('.web-view-slot')?.getBoundingClientRect()
  return { x: stage.right - CHAT_GAP - FIND_WIDTH - FLOAT_SHADOW, y: (slot?.top ?? stage.top) + 8 - FLOAT_SHADOW, width, height }
}

/** The text of the last reply, for Copy Last Reply. */
function lastReplyText(items: Item[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind !== 'assistant') continue
    const text = item.segments
      .map((seg) => (seg.kind === 'text' ? seg.text : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim()
    if (text) return text
  }
  return ''
}

/** A tool call in the chat on screen, such as the app that's fullscreen. */
function findCall(items: Item[], callId: string): ToolCall | undefined {
  for (const item of items)
    if (item.kind === 'assistant')
      for (const seg of item.segments) if (seg.kind === 'tool' && seg.call.callId === callId) return seg.call
  return undefined
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** How many things to do on a page the dock offers at once. */
const MAX_PAGE_ACTIONS = 4
const quoteTerm = (term: string): string => `“${term.length > 32 ? `${term.slice(0, 31)}…` : term}”`

export function App(): React.JSX.Element {
  const [chat, dispatch] = useReducer(reducer, undefined, emptyChat)
  /** The project whose chats the sidebar lists and new chats go to. It follows the project you open. */
  const [chatProjectId, setChatProjectId] = useState(DEFAULT_PROJECT_ID)
  const chatProjectRef = useRef(chatProjectId)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  /** A page being saved to memory with "Remember this page", and the project it goes to. */
  const [remembering, setRemembering] = useState<{ projectId: string; title: string; url: string } | null>(null)
  /** Memory notes suggested from browsing, waiting on the Memory page. */
  const [suggestionCount, setSuggestionCount] = useState(0)
  /** The Library's tab the user was last on, to open it there again. */
  const lastLibraryTab = useRef<LibraryTab>('history')
  /** Things the user taught Tidepool to do again. */
  const [skills, setSkills] = useState<Skill[]>([])
  /** Skills Claude drafted, waiting for the user to save them or not; the first is on screen. */
  const [proposals, setProposals] = useState<SkillProposal[]>([])
  /** Chats outside any project, which ⌘K offers whichever space you're in. */
  const [looseConversations, setLooseConversations] = useState<ConversationSummary[]>([])
  /** The chat on screen; null for a new one that hasn't been sent anything yet. */
  const [conversationId, setConversationId] = useState<string | null>(null)
  const conversationRef = useRef<string | null>(null)
  /** Which chat each project had open, to go back to it. */
  const lastChatByProject = useRef(new Map<string, string | null>())
  const [servers, setServers] = useState<ServerStatus[]>([])
  const [settings, setSettings] = useState<PublicSettings>()
  // Shortcuts changed in Settings apply to keys and to the hints on buttons.
  setKeyBindings(settings?.keyBindings)
  const [modal, setModal] = useState<
    | 'settings'
    | 'servers'
    | 'log'
    | 'page-tools'
    | 'add-website'
    | 'edit-website'
    | 'new-project'
    | 'edit-project'
    | 'chats'
    | 'history'
    | 'memory'
    | 'remember'
    | 'skills'
    | 'skill-review'
    | 'shortcuts'
    | 'keyboard'
    | null
  >(null)
  const [websites, setWebsites] = useState<WebApp[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [view, setView] = useState<View>(null)
  /** Projects showing their Home rather than a tab. Showing a tab (from anywhere) turns it off. */
  const [projectHome, setProjectHome] = useState<Record<string, boolean>>({})
  /** Each project's active tab and tabs as last seen, to tell a tab being switched to from one closing. */
  const lastTabsRef = useRef(new Map<string, { active: string | null; tabs: Set<string> }>())
  /** The pinned site or project being edited, picked from its sidebar menu. */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [webStates, setWebStates] = useState<Record<string, WebViewState>>({})
  const [pageTools, setPageTools] = useState<WebMcpSource[]>([])
  const [suggestions, setSuggestions] = useState<PageSuggestions>({ siteId: null, suggestions: [] })
  const [draft, setDraft] = useState('')
  const [logLines, setLogLines] = useState<string[]>([])
  const [fullscreenCallId, setFullscreenCallId] = useState<string | null>(null)
  const [chatOpen, setChatOpenState] = useState(readChatOpen)
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickOpenHeight, setQuickOpenHeight] = useState(360)
  /** The find bar, and what it searches. `token` changes when ⌘F is pressed again. */
  const [find, setFind] = useState<{ target: FindTarget; token: number } | null>(null)
  const sidebar = useSidebarWidth()
  const stageRef = useRef<HTMLDivElement>(null)
  const stageRect = useElementRect(stageRef)
  const [dockSize, setDockSize] = useState({ width: DOCK_BUTTON * 2 + 8, height: DOCK_BUTTON })
  /** A reply finished while the chat window was closed. */
  const [unread, setUnread] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const { scrollRef, contentRef, atBottom, scrollToBottom } = useStickToBottom()
  const busyRef = useRef(false)
  busyRef.current = chat.busy
  const draftRef = useRef(draft)
  draftRef.current = draft
  // A spoken message that arrived while Claude was still answering; it goes out next.
  const voiceQueuedRef = useRef(false)
  /** Tool calls that have already opened the chat window (or were there when a chat loaded). */
  const surfacedRef = useRef(new Set<string>())

  useEffect(() => {
    void window.api.settings.get().then((s) => {
      setSettings(s)
      if (!s.hasApiKey) setModal('settings')
    })
    void window.api.mcp.getStatus().then(setServers)
    const offStatus = window.api.mcp.onStatus(setServers)
    // Other chats can be answering too; only the one on screen is drawn.
    const offChat = window.api.chat.onEvent(({ conversationId: id, event }) => {
      if (id === conversationRef.current) dispatch({ type: 'event', event })
    })
    void window.api.web.list().then(setWebsites)
    const offWebApps = window.api.web.onAppsChanged(setWebsites)
    const offWebState = window.api.web.onState((state) => setWebStates((prev) => ({ ...prev, [state.id]: state })))
    // A closed site isn't loaded any more; its tab goes back to looking unopened.
    const offWebClosed = window.api.web.onClosed((id) =>
      setWebStates((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    )
    void window.api.webmcp.getSuggestions().then(setSuggestions)
    const offSuggestions = window.api.webmcp.onSuggestions(setSuggestions)
    void window.api.projects.list().then(setProjects)
    const offProjects = window.api.projects.onChanged(setProjects)
    // A link opened in a project (from the chat, an app or a pinned site): go and show it.
    // It's a tab being opened (a link, or Claude's open_page), so that's what shows, not the project's Home.
    const offReveal = window.api.projects.onReveal((id) => {
      setView({ kind: 'project', id })
      setProjectHome((prev) => ({ ...prev, [id]: false }))
      setFullscreenCallId(null)
    })
    // Ctrl+Tab goes round through a project's Home too; the main process does the going round.
    const offHome = window.api.projects.onHome((id, home) => setProjectHome((prev) => ({ ...prev, [id]: home })))
    // Claude is working in a pinned site: show it, so the user sees what it does.
    const offSiteReveal = window.api.web.onReveal((id) => {
      setView({ kind: 'site', id })
      setFullscreenCallId(null)
    })
    return () => {
      offStatus()
      offChat()
      offWebApps()
      offWebState()
      offWebClosed()
      offProjects()
      offReveal()
      offHome()
      offSiteReveal()
      offSuggestions()
    }
  }, [])

  useEffect(() => {
    let current = true
    const load = (): void =>
      void window.api.chat.list(chatProjectId).then((list) => {
        if (current) setConversations(list)
      })
    load()
    const off = window.api.chat.onListChanged((projectId) => {
      if (projectId === chatProjectId) load()
    })
    return () => {
      current = false
      off()
    }
  }, [chatProjectId])

  useEffect(() => {
    const load = (): void => void window.api.memory.suggestions().then((list) => setSuggestionCount(list.length))
    load()
    return window.api.memory.onSuggestionsChanged(load)
  }, [])

  useEffect(() => {
    void window.api.skills.list().then(setSkills)
    const offChanged = window.api.skills.onChanged(setSkills)
    const offProposal = window.api.skills.onProposal((proposal) => setProposals((list) => [...list, proposal]))
    const offClosed = window.api.skills.onProposalClosed((id) => setProposals((list) => list.filter((p) => p.requestId !== id)))
    return () => {
      offChanged()
      offProposal()
      offClosed()
    }
  }, [])

  useEffect(() => {
    if (modal === 'chats' || modal === 'history' || modal === 'memory' || modal === 'skills') lastLibraryTab.current = modal
  }, [modal])

  // A skill waiting to be saved is shown as soon as nothing else is, and the review goes away
  // once nothing is waiting.
  useEffect(() => {
    if (proposals.length > 0 && modal === null) setModal('skill-review')
    else if (proposals.length === 0 && modal === 'skill-review') setModal(null)
  }, [proposals.length, modal])

  useEffect(() => {
    const load = (): void => void window.api.chat.list(DEFAULT_PROJECT_ID).then(setLooseConversations)
    load()
    return window.api.chat.onListChanged((projectId) => {
      if (projectId === DEFAULT_PROJECT_ID) load()
    })
  }, [])

  /** Shows a chat, or a new empty one for null. One that's still answering picks up where it is. */
  const selectConversation = useCallback((id: string | null) => {
    conversationRef.current = id
    setConversationId(id)
    lastChatByProject.current.set(chatProjectRef.current, id)
    dispatch({ type: 'reset' })
    setFullscreenCallId(null)
    if (id) {
      void window.api.chat.open(id).then((state) => {
        if (conversationRef.current !== id) return
        for (const item of state.items)
          if (item.kind === 'assistant')
            for (const seg of item.segments) if (seg.kind === 'tool') surfacedRef.current.add(seg.call.callId)
        dispatch({ type: 'load', state })
      })
    }
  }, [])

  /** The chat moves to the project: back to the chat it had open, or a new one. */
  const switchChatProject = useCallback(
    (projectId: string) => {
      if (projectId === chatProjectRef.current) return
      chatProjectRef.current = projectId
      setChatProjectId(projectId)
      selectConversation(lastChatByProject.current.get(projectId) ?? null)
    },
    [selectConversation]
  )

  const log = useCallback((line: string) => {
    const stamped = `${new Date().toLocaleTimeString()} ${line}`
    setLogLines((prev) => [...prev.slice(-MAX_LOG_LINES + 1), stamped])
  }, [])

  // WebMCP tools from open pages. Changes go to the App log too, to follow them as they happen.
  useEffect(() => {
    let previous = new Map<number, string>()
    const apply = (sources: WebMcpSource[], logChanges: boolean): void => {
      const next = new Map(sources.map((s) => [s.webContentsId, s.tools.map((t) => t.name).join(', ')]))
      if (logChanges) {
        for (const s of sources) {
          const names = next.get(s.webContentsId)
          if (previous.get(s.webContentsId) !== names) log(`page tools: ${s.name} has ${s.tools.length} (${names})`)
        }
        for (const id of previous.keys()) if (!next.has(id)) log(`page tools: a website's tools went away`)
      }
      previous = next
      setPageTools(sources)
    }
    void window.api.webmcp.getSources().then((s) => apply(s, false))
    return window.api.webmcp.onSources((s) => apply(s, true))
  }, [log])

  const send = useCallback(
    (text: string, fromApp = false) => {
      const trimmed = text.trim()
      if (!trimmed) return
      if (busyRef.current) {
        log(`dropped message while busy: ${trimmed.slice(0, 80)}`)
        return
      }
      busyRef.current = true
      scrollToBottom()
      dispatch({ type: 'user', text: trimmed, fromApp })
      void (async () => {
        let id = conversationRef.current
        // A new chat is saved when its first message goes out.
        if (!id) {
          const created = await window.api.chat.create(chatProjectRef.current)
          id = created.id
          if (conversationRef.current === null) {
            conversationRef.current = id
            setConversationId(id)
            lastChatByProject.current.set(created.projectId, id)
          }
        }
        await window.api.chat.send(id, trimmed, fromApp)
      })().catch((err) => {
        busyRef.current = false
        dispatch({ type: 'event', event: { type: 'error', message: String(err) } })
      })
    },
    [log, scrollToBottom]
  )

  const onAppMessage = useCallback((text: string) => send(text, true), [send])

  /** Claude looks the skill up (use_skill) and follows it; the chat needn't be open. */
  const runSkill = useCallback((skill: Skill) => send(`Run my skill “${skill.name}”.`), [send])
  /** Claude drafts a skill from the chat, and the user saves it in the review that opens. */
  const saveAsSkill = useCallback(() => send('Save what we just did as a skill.'), [send])

  const onApproval: ApprovalHandler = useCallback((call, answer) => {
    if (!call.approval) return
    const { siteId } = call.approval
    dispatch({ type: 'approval-answered', callId: call.callId, siteId, always: answer === 'always' })
    void (async () => {
      // Remember the choice before letting the call through, so the next call doesn't ask again.
      if (answer === 'always' && call.approval?.kind !== 'navigate') await window.api.webmcp.setAutoApprove(siteId, true)
      await window.api.chat.answerApproval(call.callId, answer)
    })()
  }, [])

  const voice = useVoice({
    getDraft: () => draftRef.current,
    setDraft,
    onUtterance: (text) => {
      if (busyRef.current) {
        // Hands-free means nobody is there to press Send later, so hold it and send it next.
        setDraft(text)
        voiceQueuedRef.current = true
      } else {
        send(text)
        setDraft('')
      }
    }
  })

  useEffect(() => {
    if (chat.busy || !voiceQueuedRef.current) return
    voiceQueuedRef.current = false
    send(draftRef.current)
    setDraft('')
  }, [chat.busy, send])

  const submit = (): void => {
    // While listening, the box holds a partial transcript and the helper will send the final
    // one; sending here too would post the message twice. Send means "I'm done talking".
    if (voice.state === 'listening') return voice.toggle()
    if (voice.state !== 'idle' || chat.busy) return
    send(draft)
    setDraft('')
  }

  const setDisplayMode = useCallback((callId: string, mode: 'inline' | 'fullscreen') => {
    // Only one app is fullscreen at a time; a second request takes over from the first.
    setFullscreenCallId((current) => (mode === 'fullscreen' ? callId : current === callId ? null : current))
  }, [])

  const setChatOpen = useCallback((open: boolean, focus = open) => {
    setChatOpenState(open)
    if (open) setUnread(false)
    try {
      localStorage.setItem(CHAT_OPEN_KEY, String(open))
    } catch {
      // Remembering the choice is a convenience; it's fine if storage is unavailable.
    }
    // The chat is in an overlay (a view of its own) that shows once this render lands; it needs
    // the keyboard before anything in it can be focused.
    if (focus)
      setTimeout(() => {
        void window.api.overlay.focus('chat').then(() => inputRef.current?.focus())
      }, 50)
  }, [])
  const chatOpenRef = useRef(chatOpen)
  chatOpenRef.current = chatOpen

  const appHost: AppHostState = useMemo(
    () => ({ fullscreenCallId, setDisplayMode, conversationId }),
    [fullscreenCallId, setDisplayMode, conversationId]
  )

  // Some things can't wait in a closed window: a tool asking for the OK, or an app to use.
  useEffect(() => {
    const last = chat.items[chat.items.length - 1]
    if (last?.kind !== 'assistant') return
    for (const seg of last.segments) {
      if (seg.kind !== 'tool' || surfacedRef.current.has(seg.call.callId)) continue
      const needsUser = (seg.call.approval && !seg.call.approval.answered) || seg.call.uiResourceUri
      if (!needsUser) continue
      surfacedRef.current.add(seg.call.callId)
      if (!chatOpenRef.current) setChatOpen(true, false)
    }
  }, [chat.items, setChatOpen])

  // A reply that lands while the window is closed is flagged on the chat button.
  const wasBusyRef = useRef(false)
  useEffect(() => {
    if (wasBusyRef.current && !chat.busy && !chatOpenRef.current) setUnread(true)
    wasBusyRef.current = chat.busy
  }, [chat.busy])

  const newChat = (): void => {
    selectConversation(null)
    setChatOpen(true)
  }

  /** Moves the chat into a project (or out of them all) without picking up its last chat there. */
  const enterChatProject = (projectId: string): void => {
    chatProjectRef.current = projectId
    setChatProjectId(projectId)
  }

  /** A new chat in a project, or outside them all for the default project. */
  const newChatIn = (projectId: string): void => {
    if (projectId !== chatProjectRef.current) enterChatProject(projectId)
    newChat()
  }

  // Picking a chat opens it in the chat window, over whatever is on screen. One from another
  // project (or from outside projects) brings the chat along to it.
  const openConversation = (id: string, projectId = chatProjectRef.current): void => {
    if (projectId !== chatProjectRef.current) {
      enterChatProject(projectId)
      selectConversation(id)
    } else if (id !== conversationRef.current) selectConversation(id)
    setChatOpen(true)
  }

  // Home isn't in a project, so the chat comes back out of the one it was in.
  const openHome = (): void => {
    setView(null)
    setFullscreenCallId(null)
    switchChatProject(DEFAULT_PROJECT_ID)
  }

  /** Resolves true once it's deleted, false if the user thought better of it. */
  const deleteConversation = async (id: string, known?: ConversationSummary): Promise<boolean> => {
    const conversation = known ?? [...conversations, ...looseConversations].find((c) => c.id === id)
    if (!conversation || !window.confirm(`Delete “${conversation.title || 'New chat'}”? This can't be undone.`)) return false
    if (conversationRef.current === id) selectConversation(null)
    for (const [projectId, last] of lastChatByProject.current) if (last === id) lastChatByProject.current.delete(projectId)
    await window.api.chat.remove(id)
    return true
  }

  // Switching to a pinned site or a project takes over from a fullscreen app, as switching tabs would.
  const open = (next: View): void => {
    setView(next)
    setFullscreenCallId(null)
  }

  // Closing a pinned site unloads its page. Closing the one in view moves to the next open one, if any.
  const closeWebsite = (id: string): void => {
    if (view?.kind === 'site' && view.id === id) {
      const loaded = websites.filter((w) => w.id === id || webStates[w.id])
      const i = loaded.findIndex((w) => w.id === id)
      const next = (loaded[i + 1] ?? loaded[i - 1])?.id
      setView(next ? { kind: 'site', id: next } : null)
    }
    void window.api.web.close(id)
  }

  const unpinWebsite = async (id: string): Promise<void> => {
    const site = websites.find((w) => w.id === id)
    if (!site || !window.confirm(`Unpin ${site.name}? You'll stay signed in if you pin it again.`)) return
    if (view?.kind === 'site' && view.id === id) setView(null)
    setWebsites(await window.api.web.remove(id))
  }

  const deleteProject = async (id: string): Promise<void> => {
    const project = projects.find((p) => p.id === id)
    const tabs = project?.tabs.length ?? 0
    const closing = tabs ? `, and close its ${tabs} tab${tabs === 1 ? '' : 's'}` : ''
    if (!project || !window.confirm(`Delete ${project.name}? Its chats are deleted too${closing}.`)) return
    if (view?.kind === 'project' && view.id === id) setView(null)
    lastChatByProject.current.delete(id)
    if (chatProjectRef.current === id) switchChatProject(DEFAULT_PROJECT_ID)
    await window.api.projects.remove(id)
  }

  /** The tab moves to the pinned sites, page and all, and stays on screen there. */
  const pinTab = (tab: ProjectTab): void => {
    const project = projects.find((p) => p.tabs.some((t) => t.id === tab.id))
    if (!project) return
    void window.api.projects.pinTab(project.id, tab.id).then((id) => {
      if (id) open({ kind: 'site', id })
    })
  }

  // A tab switched to from elsewhere (⌘T, Ctrl+Tab, a new tab) takes over from the project's Home;
  // the active tab closing and handing over to its neighbour doesn't.
  useEffect(() => {
    const seen = lastTabsRef.current
    const leaveHome: string[] = []
    for (const p of projects) {
      const before = seen.get(p.id)
      const tabs = new Set(p.tabs.map((t) => t.id))
      if (before && p.activeTabId && p.activeTabId !== before.active) {
        const switched = before.active !== null && tabs.has(before.active)
        const added = !before.tabs.has(p.activeTabId)
        if (switched || added) leaveHome.push(p.id)
      }
      seen.set(p.id, { active: p.activeTabId ?? null, tabs })
    }
    if (leaveHome.length) setProjectHome((prev) => ({ ...prev, ...Object.fromEntries(leaveHome.map((id) => [id, false])) }))
  }, [projects])

  const activeWebsite = view?.kind === 'site' ? websites.find((w) => w.id === view.id) : undefined
  const activeProject = view?.kind === 'project' ? projects.find((p) => p.id === view.id) : undefined
  const editingWebsite = websites.find((w) => w.id === editingId)
  const editingProject = projects.find((p) => p.id === editingId)
  // A project (not Everyday) opens on its Home, its first tab, until a tab is picked, and goes back
  // to it when its last tab closes.
  const framedProject = activeProject && activeProject.id !== DEFAULT_PROJECT_ID ? activeProject : undefined
  const homeSelected = !!framedProject && (projectHome[framedProject.id] !== false || !framedProject.activeTabId)
  const activeTab = homeSelected ? undefined : activeProject?.tabs.find((t) => t.id === activeProject.activeTabId)
  // The main process goes round the tabs on Ctrl+Tab, so it needs to know when Home is where it starts.
  const homeShownId = homeSelected ? framedProject?.id ?? null : null
  useEffect(() => void window.api.projects.setHomeShown(homeShownId), [homeShownId])
  // The page on screen, whose WebMCP tools Claude is offered, and only while it's on screen.
  const page: OpenPage | undefined = activeWebsite
    ? { id: activeWebsite.id, name: activeWebsite.name, url: activeWebsite.url, autoApprove: activeWebsite.autoApproveTools === true }
    : activeTab?.url
      ? { id: `tab:${activeTab.id}`, name: hostOf(activeTab.url), url: activeTab.url, autoApprove: activeTab.autoApproveTools }
      : undefined
  const currentSiteId = page?.id ?? null
  useEffect(() => void window.api.webmcp.setCurrentSite(currentSiteId), [currentSiteId])
  // A pinned site or project tab is a native view drawn over the page, so it has to get out of
  // the way of anything else that needs its space: dialogs, and MCP apps in fullscreen.
  const paneVisible = modal === null && !fullscreenCallId
  // Pages step aside while the sidebar's handle is dragged, so they don't take the pointer.
  const viewsVisible = paneVisible && !sidebar.resizing
  // Websites are native views and fullscreen apps sit inside the chat window, so neither can be
  // drawn over. When the chat window is open beside one, it makes room instead of floating.
  const onPage = !fullscreenCallId && !!(activeWebsite || activeTab?.url)
  const layoutMode = [chatOpen && 'chat-open', fullscreenCallId && 'app-fullscreen', onPage && 'on-page']
    .filter(Boolean)
    .join(' ')
  // Not everything is in a project: tabs and chats outside one live in the default project, which
  // is never shown as a project. Names below are undefined for it.
  const userProjects = projects.filter((p) => p.id !== DEFAULT_PROJECT_ID)
  const projectName = (id: string | undefined): string | undefined =>
    id === DEFAULT_PROJECT_ID ? undefined : projects.find((p) => p.id === id)?.name
  const chatProjectName = projectName(chatProjectId)
  const openProject = (id: string): void => {
    open({ kind: 'project', id })
    switchChatProject(id)
  }
  /** Shows one of a project's tabs rather than its Home. */
  const showTab = (projectId: string, tabId: string): void => {
    setProjectHome((prev) => ({ ...prev, [projectId]: false }))
    void window.api.projects.activateTab(projectId, tabId)
    openProject(projectId)
  }
  const showProjectHome = (projectId: string): void => setProjectHome((prev) => ({ ...prev, [projectId]: true }))
  const connected = servers.filter((s) => s.status === 'connected')
  const toolCount = connected.reduce((n, s) => n + s.tools.length, 0)
  // Only the page on screen counts; others keep their tools registered in the background.
  const currentPageTools = page ? pageTools.find((s) => s.siteId === page.id) : undefined
  const pageToolCount = currentPageTools?.tools.length ?? 0

  // Shopping ideas for Home, in the chat's project, fetched whenever Home is shown: on its own,
  // or in a tab that has no page yet.
  const [ideas, setIdeas] = useState<ShoppingIdea[]>([])
  const homeShown = !fullscreenCallId && !activeWebsite && !activeTab?.url
  useEffect(() => {
    if (!homeShown) return
    const load = (): void => void window.api.ideas.list(chatProjectId).then(setIdeas)
    load()
    return window.api.ideas.onChanged((projectId) => projectId === chatProjectId && load())
  }, [homeShown, chatProjectId])

  // What Jev makes of the page on screen, once it has loaded (main/page-facts.ts).
  const insightsKey = activeProject && activeTab?.url && !activeTab.loading ? `${activeTab.id} ${activeTab.url}` : null
  const [insights, setInsights] = useState<{ key: string; value: PageInsights | null } | null>(null)
  useEffect(() => {
    if (!insightsKey || !activeProject || !activeTab || !settings?.jevProvider) return
    let current = true
    void window.api.projects.insights(activeProject.id, activeTab.id).then((value) => {
      if (current) setInsights({ key: insightsKey, value })
    })
    return () => {
      current = false
    }
  }, [insightsKey, settings?.jevProvider])
  const pageInsights = insights?.key === insightsKey ? insights.value : undefined
  // Without Jev (or when it couldn't tell) they're always offered; with it, only once it says yes.
  const offerSummary = settings?.jevProvider ? pageInsights !== undefined && pageInsights?.summarizable !== false : !!activeTab?.url
  const pageActions: ContextAction[] = [
    ...(offerSummary
      ? [
          { label: 'Summarize this page', prompt: 'Summarize the page I have open.' },
          { label: 'Key points', prompt: 'What are the key points on the page I have open?' }
        ]
      : []),
    // Straight to the search on the site: nothing goes through Claude.
    ...(activeProject && activeTab && pageInsights
      ? [
          ...pageInsights.searches.map((s) => ({
            label: `${quoteTerm(s.term)} again`,
            title: `Search ${hostOf(s.url)} for “${s.term}” again${s.times > 1 ? ` (searched on ${s.times} days)` : ''}`,
            onSelect: () => void window.api.projects.navigate(activeProject.id, s.url)
          })),
          ...pageInsights.elsewhere.map((s) => ({
            label: `${quoteTerm(s.term)} here`,
            title: s.interest
              ? `Search this store for “${s.term}”, for your interest in ${s.interest}`
              : `Search this store for “${s.term}”, like you did on ${s.from}`,
            onSelect: () => void window.api.projects.searchHere(activeProject.id, activeTab.id, s.term)
          }))
        ]
      : [])
  ].slice(0, MAX_PAGE_ACTIONS)

  // The user's own skills for the site on screen come before anything the site or Tidepool suggests.
  const pageSite = page ? skillSite(page.url) : undefined
  const skillActions: ContextAction[] = pageSite
    ? skills
        .filter((sk) => skillSite(sk.startUrl) === pageSite)
        .map((sk) => ({
          label: sk.name,
          prompt: `Run my skill “${sk.name}”.`,
          title: `Your skill${sk.whenToUse ? `: ${sk.whenToUse}` : ''}`
        }))
    : []
  const suggested = page && suggestions.siteId === page.id && !skillActions.length ? suggestions.suggestions : []
  const fullscreenApp = fullscreenCallId ? findCall(chat.items, fullscreenCallId) : undefined
  const context = fullscreenApp ? fullscreenApp.tool.replace(/_/g, ' ') : (page?.name ?? 'Home')
  const actions: ContextAction[] = suggested.length
    ? suggested.map((s) => ({ label: s.label, prompt: s.label, title: `Uses ${s.tool}` }))
    : fullscreenApp
      ? [{ label: 'Ask about this app', onSelect: () => setChatOpen(true) }]
      : [...skillActions, ...pageActions].slice(0, MAX_PAGE_ACTIONS)

  // MARK: Keyboard shortcuts (src/shared/commands.ts)

  const pinnedUrls = new Set(websites.map((w) => w.url))
  const pageOnScreen = paneVisible && !!(activeWebsite || activeTab?.url)
  const lastReply = lastReplyText(chat.items)
  /** What ⌘1 to ⌘9 go to, in sidebar order: the pinned sites, then the spaces. */
  const sidebarItems = [
    ...websites.map((w) => ({ name: w.name, open: () => open({ kind: 'site', id: w.id }) })),
    { name: DEFAULT_SPACE_NAME, open: () => openProject(DEFAULT_PROJECT_ID) },
    ...userProjects.map((p) => ({ name: p.name, open: () => openProject(p.id) }))
  ]
  const commandContext: CommandContext = {
    view: activeWebsite ? 'site' : activeProject ? 'project' : 'home',
    page: pageOnScreen,
    modal: modal !== null,
    chatOpen,
    busy: chat.busy,
    hasReply: lastReply !== '',
    fullscreenApp: !!fullscreenCallId,
    tabCount: activeProject?.tabs.length ?? 0,
    hasHome: !!framedProject,
    canPin: pageOnScreen && !!activeTab?.url && !pinnedUrls.has(activeTab.url),
    findOpen: find !== null,
    voice: voice.available,
    sidebar: sidebarItems.map((item) => item.name)
  }

  /** A tab waiting for an address: ⌘T's goes in the project on screen, or else the chat's. */
  const newTab = (target = activeProject?.id ?? chatProjectRef.current): void => {
    // The address bar needs the keyboard, which a website may have.
    void window.api
      .focusApp()
      .then(() => window.api.projects.newTab(target))
      .then(() => openProject(target))
  }

  /** ⌘W closes what's on top: a floating box, a dialog, a fullscreen app, then the tab. Never the window. */
  const closeCurrent = (): void => {
    if (quickOpen) setQuickOpen(false)
    else if (find) setFind(null)
    else if (modal) setModal(null)
    else if (fullscreenCallId) setFullscreenCallId(null)
    else if (activeWebsite) closeWebsite(activeWebsite.id)
    else if (activeProject && activeTab) void window.api.projects.closeTab(activeProject.id, activeTab.id)
  }

  /** ⌘F looks in the chat when you're in it (or there's no page), otherwise in the page. */
  const openFind = (): void => {
    const inChat = inputRef.current?.ownerDocument.hasFocus() ?? false
    const target: FindTarget | null =
      chatOpen && (inChat || !pageOnScreen) ? 'chat' : pageOnScreen ? 'page' : chatOpen ? 'chat' : null
    if (target) setFind((f) => ({ target, token: (f?.token ?? 0) + 1 }))
  }

  const toggleQuickOpen = (): void => {
    setModal(null)
    setQuickOpen((was) => !was)
  }

  const run = useCommands(commandContext, {
    'app.quickOpen': toggleQuickOpen,
    'app.home': openHome,
    'app.history': () => setModal('history'),
    'app.memory': () => {
      setEditingId(chatProjectRef.current)
      setModal('memory')
    },
    'app.skills': () => setModal('skills'),
    'app.settings': () => setModal('settings'),
    'app.shortcuts': () => setModal('shortcuts'),
    'chat.new': newChat,
    'chat.toggle': () => setChatOpen(!chatOpenRef.current),
    'chat.focus': () => setChatOpen(true),
    'voice.toggle': voice.toggle,
    'chat.stop': () => {
      if (conversationRef.current) void window.api.chat.stop(conversationRef.current)
    },
    'chat.saveSkill': saveAsSkill,
    'chat.copyReply': () => {
      if (lastReply) void window.api.copyText(lastReply)
    },
    'tab.new': () => newTab(),
    'tab.close': closeCurrent,
    'tab.address': () => {
      if (modal) return
      if (activeProject && !fullscreenCallId) void window.api.focusApp().then(() => emitCommand('tab.address'))
      else newTab()
    },
    'page.find': openFind,
    'page.pin': () => {
      if (activeTab) pinTab(activeTab)
    },
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`go.item${n}`, () => sidebarItems[n - 1]?.open()])),
    'go.last': () => sidebarItems[sidebarItems.length - 1]?.open()
  })

  // The find bar searches what's on screen; when that changes, it's done.
  const viewKey = view ? `${view.kind}:${view.id}` : 'home'
  useEffect(() => setFind(null), [viewKey, fullscreenCallId, modal])
  useEffect(() => {
    if (!chatOpen) setFind((f) => (f?.target === 'chat' ? null : f))
  }, [chatOpen])

  const quickOpenItems: QuickOpenItem[] = quickOpen
    ? [
        { key: 'home', label: 'Home', icon: <HomeIcon />, run: openHome },
        ...skills.map((sk) => ({
          key: `skill:${sk.id}`,
          label: sk.name,
          detail: 'Skill',
          icon: <SkillIcon />,
          run: () => runSkill(sk)
        })),
        ...websites.map((w) => ({
          key: `site:${w.id}`,
          label: w.name,
          detail: 'Pinned site',
          icon: <SiteIcon site={w} />,
          run: () => open({ kind: 'site', id: w.id })
        })),
        {
          key: `project:${DEFAULT_PROJECT_ID}`,
          label: DEFAULT_SPACE_NAME,
          detail: 'Tabs and chats outside projects',
          icon: <TabsIcon />,
          run: () => openProject(DEFAULT_PROJECT_ID)
        },
        ...userProjects.map((p) => ({
          key: `project:${p.id}`,
          label: p.name,
          detail: `Project · ${p.tabs.length} tab${p.tabs.length === 1 ? '' : 's'}`,
          icon: <FolderIcon />,
          run: () => openProject(p.id)
        })),
        ...projects.flatMap((p) =>
          p.tabs
            .filter((t) => t.url)
            .map((t) => ({
              key: `tab:${t.id}`,
              label: t.title || hostOf(t.url),
              detail: projectName(p.id) ? `Tab in ${p.name}` : 'Tab',
              icon: <TabIcon tab={t} />,
              run: () => showTab(p.id, t.id)
            }))
        ),
        ...conversations.map((c) => ({
          key: `chat:${c.id}`,
          label: c.title || 'New chat',
          detail: chatProjectName ? `Chat in ${chatProjectName}` : 'Chat',
          icon: <ChatIcon />,
          run: () => openConversation(c.id)
        })),
        // In a project, chats outside projects can still be picked.
        ...(chatProjectName
          ? looseConversations.map((c) => ({
              key: `chat:${c.id}`,
              label: c.title || 'New chat',
              detail: 'Chat',
              icon: <ChatIcon />,
              run: () => openConversation(c.id, DEFAULT_PROJECT_ID)
            }))
          : []),
        ...COMMANDS.filter((c) => !c.id.startsWith('go.') && c.id !== 'app.quickOpen' && isEnabled(c, commandContext)).map(
          (c) => ({
            key: `cmd:${c.id}`,
            label: c.label,
            detail: 'Command',
            shortcut: shortcutLabel(c.id),
            // After Quick Open has closed and given the keyboard back.
            run: () => setTimeout(() => run(c.id), 50)
          })
        )
      ]
    : []
  const chatBox = chatBounds(stageRect, { open: chatOpen && modal === null, appFullscreen: !!fullscreenCallId && modal === null })
  const dockMaxWidth = stageRect ? Math.max(DOCK_BUTTON * 2, stageRect.width - CHAT_GAP * 2) : 0
  const chatActions = chat.busy ? actions.filter((a) => !a.prompt) : actions

  return (
    <AppHostContext.Provider value={appHost}>
    <div className={`layout ${layoutMode}`}>
      <Sidebar
        width={sidebar.width}
        onResize={sidebar.setWidth}
        onResizing={sidebar.setResizing}
        homeActive={!view && !fullscreenCallId}
        onOpenHome={openHome}
        onQuickOpen={toggleQuickOpen}
        onOpenAllChats={() => setModal('chats')}
        chatOpen={chatOpen}
        onOpenSettings={() => setModal(servers.some((s) => s.status === 'error' || s.status === 'needs-auth') ? 'servers' : 'settings')}
        settingsAttention={servers.some((s) => s.status === 'error' || s.status === 'needs-auth')}
        // Notes waiting for review are what the badge is about, so they come first.
        onOpenLibrary={() => setModal(suggestionCount > 0 ? 'memory' : lastLibraryTab.current)}
        onOpenMemory={(id) => {
          setEditingId(id ?? chatProjectRef.current)
          setModal('memory')
        }}
        memorySuggestionCount={suggestionCount}
        websites={websites}
        webStates={webStates}
        projects={projects}
        view={fullscreenCallId ? null : view}
        conversations={conversations}
        conversationId={conversationId}
        chatProjectId={chatProjectId}
        chatProjectName={chatProjectName}
        onOpenConversation={openConversation}
        onNewChatIn={newChatIn}
        onDeleteConversation={(id) => void deleteConversation(id)}
        onOpenWebsite={(id) => open({ kind: 'site', id })}
        onCloseWebsite={closeWebsite}
        onReorderWebsites={(ids) => {
          setWebsites((prev) => ids.flatMap((id) => prev.filter((w) => w.id === id)))
          void window.api.web.reorder(ids).then(setWebsites)
        }}
        onAddWebsite={() => setModal('add-website')}
        onOpenProject={openProject}
        onOpenTab={showTab}
        onNewTabIn={newTab}
        onMoveTab={(tabId, toId, beforeTabId) =>
          // The tab on screen stays on screen, in its new project.
          void window.api.projects.moveTab(tabId, toId, beforeTabId).then((shown) => shown && openProject(toId))
        }
        onReorderProjects={(ids) => {
          setProjects((prev) => ids.flatMap((id) => prev.filter((p) => p.id === id)))
          void window.api.projects.reorder(ids)
        }}
        onNewProject={() => setModal('new-project')}
        onEditWebsite={(id) => {
          setEditingId(id)
          setModal('edit-website')
        }}
        onUnpinWebsite={(id) => void unpinWebsite(id)}
        onRenameProject={(id) => {
          setEditingId(id)
          setModal('edit-project')
        }}
        onDeleteProject={(id) => void deleteProject(id)}
      />
      <div className="stage">
        <div className="stage-body" ref={stageRef}>
          {activeWebsite ? (
            <WebPane
              site={activeWebsite}
              state={webStates[activeWebsite.id]}
              visible={viewsVisible}
              onClose={() => closeWebsite(activeWebsite.id)}
              pageToolCount={pageToolCount}
              onOpenPageTools={() => setModal('page-tools')}
              onRemember={(page) => {
                // Pinned sites aren't in a project, so what's remembered there is too.
                setRemembering({ projectId: DEFAULT_PROJECT_ID, ...page })
                setModal('remember')
              }}
            />
          ) : framedProject ? (
            <div className="project-frame">
              <ProjectTabStrip
                project={framedProject}
                homeSelected={homeSelected}
                onHome={() => showProjectHome(framedProject.id)}
                onSelectTab={(tabId) => showTab(framedProject.id, tabId)}
                onNewTab={() => newTab(framedProject.id)}
              />
              {homeSelected ? (
                <ProjectHome
                  project={framedProject}
                  conversations={conversations}
                  onOpenConversation={openConversation}
                  onNewChat={() => newChatIn(framedProject.id)}
                  onSearch={(text) => {
                    const target = framedProject.id
                    void window.api.projects.newTab(target).then(() => window.api.projects.navigate(target, text))
                  }}
                  onOpenMemory={() => {
                    setEditingId(framedProject.id)
                    setModal('memory')
                  }}
                />
              ) : activeTab?.url ? (
                <ProjectPane
                  project={framedProject}
                  visible={viewsVisible}
                  onPin={pinTab}
                  pinnedUrls={pinnedUrls}
                  pageToolCount={pageToolCount}
                  onOpenPageTools={() => setModal('page-tools')}
                  onRemember={(page) => {
                    setRemembering({ projectId: framedProject.id, ...page })
                    setModal('remember')
                  }}
                />
              ) : (
                <Home
                  // A fresh one for each empty tab, so it starts blank and takes the keyboard.
                  key={activeTab?.id ?? 'home'}
                  inTab={!!activeTab}
                  projectId={activeProject?.id}
                  hasApiKey={settings?.hasApiKey ?? true}
                  conversations={conversations}
                  chatProjectName={chatProjectName}
                  onOpenSettings={() => setModal('settings')}
                  onSearch={(text) => {
                    // The empty tab Home is standing in for; the main process decides address or search.
                    if (activeProject && activeTab) return void window.api.projects.navigate(activeProject.id, text)
                    // Otherwise a new tab in the chat's project.
                    const target = chatProjectRef.current
                    void window.api.projects
                      .newTab(target)
                      .then(() => window.api.projects.navigate(target, text))
                      .then(() => openProject(target))
                  }}
                  onOpenConversation={openConversation}
                  skills={skills}
                  onRunSkill={runSkill}
                  ideas={ideas}
                  onOpenIdea={(id) => void window.api.ideas.open(id)}
                  onDismissIdea={(id) => {
                    setIdeas((list) => list.filter((i) => i.id !== id))
                    void window.api.ideas.dismiss(id)
                  }}
                />
              )}
            </div>
          ) : activeProject && activeTab?.url ? (
            <ProjectPane
              project={activeProject}
              visible={viewsVisible}
              onPin={pinTab}
              pinnedUrls={pinnedUrls}
              pageToolCount={pageToolCount}
              onOpenPageTools={() => setModal('page-tools')}
              onRemember={(page) => {
                setRemembering({ projectId: activeProject.id, ...page })
                setModal('remember')
              }}
            />
          ) : (
            <Home
              // A fresh one for each empty tab, so it starts blank and takes the keyboard.
              key={activeTab?.id ?? 'home'}
              inTab={!!activeTab}
              projectId={activeProject?.id}
              hasApiKey={settings?.hasApiKey ?? true}
              conversations={conversations}
              chatProjectName={chatProjectName}
              onOpenSettings={() => setModal('settings')}
              onSearch={(text) => {
                // The empty tab Home is standing in for; the main process decides address or search.
                if (activeProject && activeTab) return void window.api.projects.navigate(activeProject.id, text)
                // Otherwise a new tab in the chat's project.
                const target = chatProjectRef.current
                void window.api.projects
                  .newTab(target)
                  .then(() => window.api.projects.navigate(target, text))
                  .then(() => openProject(target))
              }}
              onOpenConversation={openConversation}
              skills={skills}
              onRunSkill={runSkill}
              ideas={ideas}
              onOpenIdea={(id) => void window.api.ideas.open(id)}
              onDismissIdea={(id) => {
                setIdeas((list) => list.filter((i) => i.id !== id))
                void window.api.ideas.dismiss(id)
              }}
            />
          )}
        </div>
      </div>

      <Overlay
        name="chat"
        bounds={chatBox}
        className={`chat-overlay ${chatOpen ? 'chat-open' : ''} ${fullscreenCallId ? 'app-fullscreen' : ''}`}
      >
      <section className="chat-card" aria-label="Chat" aria-hidden={!chatOpen}>
        <header className="chat-card-header">
          <div
            className="chat-card-title"
            title={
              chat.usage
                ? `${settings?.model ?? ''} · last turn: ${chat.usage.inputTokens.toLocaleString()} in (${chat.usage.cacheReadTokens.toLocaleString()} cached) / ${chat.usage.outputTokens.toLocaleString()} out`
                : settings?.model
            }
          >
            <span className="chat-card-name">{conversations.find((c) => c.id === conversationId)?.title || 'New chat'}</span>
            <span className="chat-card-sub">
              {chatProjectName && `${chatProjectName} · `}
              <button className="link muted" onClick={() => setModal('servers')} title="MCP servers">
                {toolCount} tools
              </button>
            </span>
          </div>
          <button
            className="icon"
            onClick={saveAsSkill}
            disabled={!lastReply || chat.busy}
            aria-label="Save as skill"
            title="Save as skill: Tidepool learns what you just did, to do again when you ask"
          >
            <SkillIcon />
          </button>
          <button className="icon" onClick={newChat} aria-label="Start a new chat" title={withShortcut('New chat', 'chat.new')}>
            <ComposeIcon />
          </button>
          <button className="icon" onClick={() => setChatOpen(false)} aria-label="Minimize chat" title={withShortcut('Minimize', 'chat.toggle')}>
            <MinimizeIcon />
          </button>
        </header>
        <div className="scroll-area">
          <div className="scroll" ref={scrollRef}>
            <div ref={contentRef}>
              <Transcript
                items={chat.items}
                busy={chat.busy}
                onAppMessage={onAppMessage}
                onLog={log}
                onApproval={onApproval}
              />
            </div>
          </div>
          {!atBottom && (
            <button className="jump-to-latest" onClick={scrollToBottom}>
              ↓ Latest
            </button>
          )}
        </div>
        <div className="composer">
          {voice.available && <VoiceCard voice={voice} compact />}
          <div className="composer-box">
            <textarea
              ref={inputRef}
              rows={1}
              placeholder={
                !settings?.hasApiKey
                  ? 'Add your API key in Settings to start'
                  : fullscreenCallId
                    ? 'Ask about this app…'
                    : 'Message Tidepool…'
              }
              value={draft}
              // While listening, the box shows what's being heard; typing would fight it.
              readOnly={voice.state !== 'idle'}
              onChange={(e) => {
                voiceQueuedRef.current = false
                setDraft(e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  submit()
                } else if (e.key === 'Escape' && !e.shiftKey && chat.busy && conversationId) {
                  // Escape in the box stops the reply, as in other chat apps.
                  e.preventDefault()
                  void window.api.chat.stop(conversationId)
                }
              }}
            />
            <div className="composer-actions">
              {voice.available && <MicButton voice={voice} className="mic" />}
              {chat.busy ? (
                <button
                  className="send stop"
                  onClick={() => conversationId && void window.api.chat.stop(conversationId)}
                  aria-label="Stop"
                  title={withShortcut('Stop', 'chat.stop')}
                >
                  <StopIcon />
                </button>
              ) : (
                <button
                  className="send primary"
                  onClick={submit}
                  disabled={!draft.trim() || voice.state === 'starting' || voice.state === 'finishing'}
                  aria-label="Send"
                  title="Send (Enter)"
                >
                  <SendIcon />
                </button>
              )}
            </div>
          </div>
        </div>
      </section>
      </Overlay>
      {/* After the chat's overlay, so it stacks above it (over a fullscreen app, too). */}
      <Overlay
        name="dock"
        bounds={modal === null && !chatOpen ? dockBounds(stageRect, dockSize) : null}
        className="dock-overlay"
        onContentSize={setDockSize}
      >
        <Dock
          context={context}
          fromSite={suggested.length > 0}
          actions={chatActions}
          onPrompt={(text) => send(text)}
          onOpenChat={() => setChatOpen(true)}
          busy={chat.busy}
          peek={chat.busy || unread ? replyPeek(chat.items, chat.busy) : ''}
          unread={unread}
          voice={voice.available ? voice : null}
          maxWidth={dockMaxWidth}
        />
      </Overlay>

      {quickOpen && (
        <Overlay
          name="quick-open"
          bounds={quickOpenBounds(stageRect, quickOpenHeight)}
          className="quick-open-overlay"
          onContentSize={(size) => setQuickOpenHeight(size.height)}
        >
          <QuickOpen overlay="quick-open" items={quickOpenItems} onClose={() => setQuickOpen(false)} />
        </Overlay>
      )}
      {find && (
        <Overlay name="find" bounds={findBounds(stageRect, find.target, chatBox)} className="find-overlay">
          <FindBar overlay="find" target={find.target} focusToken={find.token} onClose={() => setFind(null)} />
        </Overlay>
      )}

      {(modal === 'settings' || modal === 'servers' || modal === 'keyboard' || modal === 'log') && settings && (
        <SettingsModal
          settings={settings}
          onChange={setSettings}
          servers={servers}
          onServersChange={setServers}
          initialSection={modal === 'servers' || modal === 'keyboard' || modal === 'log' ? modal : 'general'}
          logLines={logLines}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'shortcuts' && (
        <ShortcutsModal
          bindings={settings?.keyBindings ?? {}}
          onOpenSettings={() => setModal('keyboard')}
          onClose={() => setModal(null)}
        />
      )}
      {(modal === 'chats' || modal === 'history' || modal === 'memory' || modal === 'skills') && (
        <LibraryModal
          tab={modal}
          onTab={setModal}
          projects={projects}
          chatProjectId={chatProjectId}
          memoryProjectId={editingId ?? chatProjectId}
          browsingMemory={!!settings?.memory && !!settings.browsingMemory}
          memorySuggestionCount={suggestionCount}
          skills={skills}
          onOpenChat={(c) => {
            setModal(null)
            openConversation(c.id, c.projectId)
          }}
          onDeleteChat={(c) => deleteConversation(c.id, c)}
          onOpenHistoryEntry={(entry) => {
            // Back in the project it was visited in, if that's still around; otherwise the chat's.
            const target = projects.some((p) => p.id === entry.projectId) ? entry.projectId! : chatProjectId
            setModal(null)
            void window.api.projects.newTab(target, entry.url).then(() => open({ kind: 'project', id: target }))
          }}
          onRunSkill={(skill) => {
            setModal(null)
            runSkill(skill)
          }}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'remember' && remembering && (
        <RememberModal
          page={remembering}
          projectName={projectName(remembering.projectId)}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'skill-review' && proposals[0] && (
        <SkillReviewModal
          key={proposals[0].requestId}
          proposal={proposals[0]}
          onDone={() => setProposals((list) => list.slice(1))}
        />
      )}
      {modal === 'page-tools' && (
        <PageToolsModal page={page} source={currentPageTools} onClose={() => setModal(null)} />
      )}
      {(modal === 'add-website' || (modal === 'edit-website' && editingWebsite)) && (
        <WebsiteModal
          site={modal === 'edit-website' ? editingWebsite : undefined}
          servers={servers.map((s) => s.name)}
          onSaved={(apps, openId) => {
            setWebsites(apps)
            if (openId && apps.some((a) => a.id === openId)) open({ kind: 'site', id: openId })
          }}
          onClose={() => setModal(null)}
        />
      )}
      {(modal === 'new-project' || (modal === 'edit-project' && editingProject)) && (
        <ProjectModal
          project={modal === 'edit-project' ? editingProject : undefined}
          onSaved={(openId) => {
            if (openId) {
              open({ kind: 'project', id: openId })
              switchChatProject(openId)
            }
          }}
          onClose={() => setModal(null)}
        />
      )}
    </div>
    </AppHostContext.Provider>
  )
}

