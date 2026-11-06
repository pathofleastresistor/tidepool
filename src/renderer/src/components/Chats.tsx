import { useEffect, useState } from 'react'
import { DEFAULT_PROJECT_ID, type ConversationSummary, type Project } from '@shared/types'
import { ChatIcon, CloseIcon } from './Icons'

const dateOf = (ms: number): string => {
  const d = new Date(ms)
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric'
  })
}

/**
 * Every chat, newest first: the sidebar only lists a few. Searching matches words in the title.
 * Picking one opens it in the chat window.
 */
export function ChatsPanel(props: {
  projects: Project[]
  /** The project the chat is in, offered as a filter. */
  projectId: string
  onOpen: (chat: ConversationSummary) => void
  onDelete: (chat: ConversationSummary) => Promise<boolean>
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'all' | 'project'>('all')
  const [chats, setChats] = useState<ConversationSummary[] | null>(null)
  // Chats outside a project aren't labelled with one.
  const names = new Map(props.projects.filter((p) => p.id !== DEFAULT_PROJECT_ID).map((p) => [p.id, p.name]))
  const projectName = names.get(props.projectId)
  const projectIds = props.projects.map((p) => p.id).join(' ')

  useEffect(() => {
    let current = true
    const load = (): void =>
      void Promise.all(projectIds.split(' ').map((id) => window.api.chat.list(id))).then((lists) => {
        if (current) setChats(lists.flat().sort((a, b) => b.updatedAt - a.updatedAt))
      })
    load()
    const off = window.api.chat.onListChanged(load)
    return () => {
      current = false
      off()
    }
  }, [projectIds])

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const shown = (chats ?? []).filter(
    (c) =>
      (scope === 'all' || c.projectId === props.projectId) &&
      words.every((w) => (c.title || 'New chat').toLowerCase().includes(w))
  )

  return (
    <div className="library-panel" role="tabpanel" aria-label="Chats">
      <div className="history-controls">
        <input
          type="search"
          autoFocus
          aria-label="Search chats"
          placeholder="Search by title"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {projectName && (
          <div className="segmented" role="radiogroup" aria-label="Which chats">
            <button role="radio" aria-checked={scope === 'all'} className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>
              All
            </button>
            <button
              role="radio"
              aria-checked={scope === 'project'}
              className={scope === 'project' ? 'active' : ''}
              onClick={() => setScope('project')}
              title={`Only chats in ${projectName}`}
            >
              {projectName}
            </button>
          </div>
        )}
      </div>
      <div className="history-list" role="list" aria-label="Chats">
        {shown.map((c) => {
          const name = c.title || 'New chat'
          const where = names.get(c.projectId)
          return (
            <div key={c.id} role="listitem" className="history-row">
              {c.busy ? <span className="tab-spinner" aria-label="Answering" /> : <ChatIcon />}
              <button className="history-open" onClick={() => props.onOpen(c)} title={name}>
                <span className="history-title">{name}</span>
                <span className="history-host">{dateOf(c.updatedAt)}</span>
              </button>
              {scope === 'all' && where && <span className="history-where">{where}</span>}
              <button
                className="tab-x history-remove"
                onClick={() => void props.onDelete(c).then((gone) => gone && setChats((list) => list?.filter((x) => x.id !== c.id) ?? null))}
                aria-label={`Delete ${name}`}
                title="Delete chat"
              >
                <CloseIcon />
              </button>
            </div>
          )
        })}
        {chats && shown.length === 0 && (
          <p className="muted history-empty">{words.length ? 'No chats match.' : 'Your chats show up here.'}</p>
        )}
      </div>
    </div>
  )
}
