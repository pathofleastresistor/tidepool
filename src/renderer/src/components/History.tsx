import { useEffect, useRef, useState } from 'react'
import { DEFAULT_PROJECT_ID, type HistoryEntry, type Project } from '@shared/types'
import { CloseIcon } from './Icons'

const PAGE = 100

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** "Today", "Yesterday", or the date, for grouping visits by day. */
function dayLabel(ms: number): string {
  const day = new Date(ms)
  const today = new Date()
  const startOf = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((startOf(today) - startOf(day)) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return day.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: day.getFullYear() === today.getFullYear() ? undefined : 'numeric'
  })
}

const timeOf = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/**
 * Browsing history: every page opened in a project tab or pinned site, newest first and grouped
 * by day. Searching matches words in the title or address. Picking one opens it in a tab.
 */
export function HistoryPanel(props: {
  projects: Project[]
  /** The project the chat is in, offered as a filter. */
  projectId: string
  onOpen: (entry: HistoryEntry) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'all' | 'project'>('all')
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const request = useRef(0)
  // Visits outside a project aren't labelled with one.
  const names = new Map(props.projects.filter((p) => p.id !== DEFAULT_PROJECT_ID).map((p) => [p.id, p.name]))
  const projectName = names.get(props.projectId)

  const load = async (before?: number): Promise<void> => {
    const id = ++request.current
    setLoading(true)
    const page = await window.api.history.search({
      query: query.trim() || undefined,
      projectId: scope === 'project' ? props.projectId : undefined,
      before,
      limit: PAGE
    })
    if (id !== request.current) return
    setEntries((prev) => (before ? [...prev, ...page] : page))
    setMore(page.length === PAGE)
    setLoading(false)
  }

  // Typing searches as it goes, once the typing pauses.
  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 150 : 0)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, scope])

  const remove = async (id: number): Promise<void> => {
    await window.api.history.remove(id)
    setEntries((prev) => prev.filter((e) => e.id !== id))
  }

  const clear = async (): Promise<void> => {
    if (!window.confirm('Clear all browsing history? This can’t be undone. Sign-ins and open tabs stay as they are.')) return
    await window.api.history.clear()
    setEntries([])
    setMore(false)
  }

  let lastDay = ''
  return (
    <div className="library-panel" role="tabpanel" aria-label="History">
      <div className="history-controls">
        <input
          type="search"
          autoFocus
          aria-label="Search history"
          placeholder="Search by title or address"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {projectName && (
          <div className="segmented" role="radiogroup" aria-label="Which history">
            <button role="radio" aria-checked={scope === 'all'} className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>
              All
            </button>
            <button
              role="radio"
              aria-checked={scope === 'project'}
              className={scope === 'project' ? 'active' : ''}
              onClick={() => setScope('project')}
              title={`Only pages opened in ${projectName}`}
            >
              {projectName}
            </button>
          </div>
        )}
      </div>
      <div className="history-list" role="list" aria-label="Visits">
        {entries.map((entry) => {
          const day = dayLabel(entry.visitedAt)
          const header = day !== lastDay
          lastDay = day
          const where = entry.siteName ?? (entry.projectId ? names.get(entry.projectId) : undefined)
          return (
            <div key={entry.id} role="listitem">
              {header && <div className="history-day">{day}</div>}
              <div className="history-row">
                <span className="history-time">{timeOf(entry.visitedAt)}</span>
                <button className="history-open" onClick={() => props.onOpen(entry)} title={entry.url}>
                  <span className="history-title">{entry.title || hostOf(entry.url)}</span>
                  <span className="history-host">{hostOf(entry.url)}</span>
                </button>
                {scope === 'all' && where && <span className="history-where">{where}</span>}
                <button className="tab-x history-remove" onClick={() => void remove(entry.id)} aria-label={`Remove ${entry.title || entry.url} from history`}>
                  <CloseIcon />
                </button>
              </div>
            </div>
          )
        })}
        {!loading && entries.length === 0 && (
          <p className="muted history-empty">
            {query.trim() ? 'No pages match.' : 'Pages you open in projects and pinned sites show up here.'}
          </p>
        )}
        {more && (
          <button className="show-more" onClick={() => void load(entries.at(-1)?.visitedAt)} disabled={loading}>
            Show older
          </button>
        )}
      </div>
      <div className="row end">
        <button className="danger" onClick={() => void clear()}>
          Clear history…
        </button>
      </div>
    </div>
  )
}
