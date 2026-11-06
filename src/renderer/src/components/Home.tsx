import { useEffect, useRef, useState } from 'react'
import { useCommand } from '../commands'
import { useInlineCompletion } from '../use-inline-completion'
import { DEFAULT_PROJECT_ID, type ConversationSummary, type PageSummary, type ShoppingIdea, type Skill } from '@shared/types'
import { ChatIcon, CloseIcon, PageIcon, SearchIcon, SkillIcon, SparkleIcon } from './Icons'
import { skillSite } from './Skills'

const RECENT = 5

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 5) return 'Up late'
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

/** One section of Home: a card with a title, maybe an action, and its rows under it. */
export function Card(props: { title: string; action?: { label: string; onSelect: () => void }; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="home-card" aria-label={props.title}>
      <header className="home-card-head">
        <h2>{props.title}</h2>
        {props.action && (
          <button className="quiet small" onClick={props.action.onSelect}>
            {props.action.label}
          </button>
        )}
      </header>
      <div className="home-list">{props.children}</div>
    </section>
  )
}

/** A row in a card: an icon, a name, and a detail after it. */
export function Row(props: {
  icon: React.ReactNode
  name: string
  detail?: React.ReactNode
  title?: string
  onClick: () => void
  busy?: boolean
}): React.JSX.Element {
  return (
    <button className="home-row" onClick={props.onClick} title={props.title ?? props.name}>
      {props.busy ? <span className="tab-spinner" aria-label="Answering" /> : props.icon}
      <span className="home-row-name">{props.name}</span>
      {props.detail !== undefined && <span className="home-row-detail">{props.detail}</span>}
    </button>
  )
}

/** A project's pages, kept up to date as Claude saves them. */
function useProjectPages(projectId: string): PageSummary[] {
  const [pages, setPages] = useState<PageSummary[]>([])
  useEffect(() => {
    let live = true
    const load = (): void => void window.api.pages.list(projectId).then((list) => live && setPages(list))
    load()
    const off = window.api.pages.onChanged((id) => id === projectId && load())
    return () => {
      live = false
      off()
    }
  }, [projectId])
  return pages
}

const shortDate = (ms: number): string => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

/**
 * The pages Claude made in a project (main/pages.ts): a tap opens one in a tab. Nothing shows
 * until there's one, unless `emptyText` says what to show.
 */
export function PagesCard(props: { projectId: string; emptyText?: string }): React.JSX.Element | null {
  const pages = useProjectPages(props.projectId)
  if (pages.length === 0 && !props.emptyText) return null
  return (
    <Card title="Pages">
      {pages.map((page) => (
        <div key={page.name} className="home-removable">
          <Row
            icon={<PageIcon />}
            name={page.title}
            detail={shortDate(page.updatedAt)}
            title={`Open ${page.title}`}
            onClick={() => void window.api.pages.open(props.projectId, page.name)}
          />
          <button
            className="icon home-remove"
            aria-label={`Delete ${page.title}`}
            title="Delete page"
            onClick={() => {
              if (window.confirm(`Delete “${page.title}”? This can't be undone.`)) void window.api.pages.remove(props.projectId, page.name)
            }}
          >
            <CloseIcon />
          </button>
        </div>
      ))}
      {pages.length === 0 && <p className="muted small project-home-empty">{props.emptyText}</p>}
    </Card>
  )
}

/**
 * What's on screen when no site, tab or app is open, and in a new tab until it has a page: a
 * search box, and ways back into what you were doing that the sidebar doesn't show, each in its
 * own card. Asking goes through the bar below (talk, or open the
 * chat), so there's no chat here.
 */
export function Home(props: {
  /** Standing in for a tab with no page yet: the search box is its address bar. */
  inTab: boolean
  /** The project a page opened from here goes in, whose history counts for more. */
  projectId?: string
  hasApiKey: boolean
  conversations: ConversationSummary[]
  /** The project the chat is in; undefined when it isn't in one. */
  chatProjectName: string | undefined
  onOpenSettings: () => void
  /** Searches Google for what was typed, or goes to it if it's an address: in the tab, or a new one. */
  onSearch: (text: string) => void
  onOpenConversation: (id: string) => void
  /** Things the user taught Tidepool to do again; a tap runs one. */
  skills: Skill[]
  onRunSkill: (skill: Skill) => void
  /** Interests from memory paired with stores good for them. */
  ideas: ShoppingIdea[]
  onOpenIdea: (id: number) => void
  onDismissIdea: (id: number) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const completion = useInlineCompletion({ ref: searchRef, setValue: setQuery, projectId: props.projectId })
  // ⌘L, in a tab. The app gives its page the keyboard first; a website may have had it.
  useCommand('tab.address', () => {
    if (props.inTab) searchRef.current?.focus()
  })
  const recent = props.conversations.slice(0, RECENT)
  return (
    <section className="home" aria-label="Home">
      <div className="home-drag" />
      <div className="home-inner">
        <h1>{greeting()}</h1>
        <p className="home-lede">
          {props.hasApiKey ? 'Tap the mic and say what you need, or pick up where you left off.' : 'Add your API key to get started.'}
        </p>
        {!props.hasApiKey && (
          <button className="primary" onClick={props.onOpenSettings}>
            Open Settings
          </button>
        )}

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
            autoFocus={props.inTab}
            aria-label={props.inTab ? 'Address' : 'Search Google or type an address'}
            placeholder="Search Google or type an address"
            spellCheck={false}
            value={query}
            onChange={completion.onChange}
            onKeyDown={completion.onKeyDown}
          />
        </form>

        <div className="home-cards">
          {recent.length > 0 && (
            <Card title={props.chatProjectName ? `Recent in ${props.chatProjectName}` : 'Recent chats'}>
              {recent.map((c) => (
                <Row
                  key={c.id}
                  icon={<ChatIcon />}
                  busy={c.busy}
                  name={c.title || 'New chat'}
                  detail={new Date(c.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  onClick={() => props.onOpenConversation(c.id)}
                />
              ))}
            </Card>
          )}

          {/* Everyday has no Home of its own, so its pages are here. */}
          {(!props.projectId || props.projectId === DEFAULT_PROJECT_ID) && <PagesCard projectId={DEFAULT_PROJECT_ID} />}

          {props.skills.length > 0 && (
            <Card title="Skills">
              {props.skills.map((skill) => (
                <Row
                  key={skill.id}
                  icon={<SkillIcon />}
                  name={skill.name}
                  detail={skillSite(skill.startUrl)}
                  title={skill.whenToUse ? `Run it: ${skill.whenToUse}` : 'Run it'}
                  onClick={() => props.onRunSkill(skill)}
                />
              ))}
            </Card>
          )}

          {props.ideas.length > 0 && (
            <Card title="Shopping ideas">
              {props.ideas.map((idea) => (
                <div key={idea.id} className="home-idea">
                  <Row
                    icon={<SparkleIcon />}
                    name={idea.interest}
                    detail={
                      <>
                        {idea.isNew && <span className="home-idea-new">New</span>}
                        {idea.host}
                      </>
                    }
                    title={`Search ${idea.host} for “${idea.term}”${idea.isNew ? '. You haven’t shopped there before.' : ''}`}
                    onClick={() => props.onOpenIdea(idea.id)}
                  />
                  <button className="icon home-idea-dismiss" aria-label={`Dismiss ${idea.interest}`} title="Not interested" onClick={() => props.onDismissIdea(idea.id)}>
                    <CloseIcon />
                  </button>
                </div>
              ))}
            </Card>
          )}
        </div>
      </div>
    </section>
  )
}
