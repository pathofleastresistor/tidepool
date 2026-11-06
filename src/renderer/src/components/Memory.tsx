import { useEffect, useRef, useState } from 'react'
import { DEFAULT_PROJECT_ID, type MemoryFile, type MemorySuggestion, type Project } from '@shared/types'
import { Modal } from './Modals'

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)

const shortPath = (path: string): string => path.replace(/^\/memories\//, '')

/** The first line with something on it, as a hint of what a closed file holds. */
const preview = (content: string): string =>
  content
    .split('\n')
    .map((line) => line.replace(/^[#>*\-\s]+/, '').trim())
    .find(Boolean) ?? ''

/** Whether a file has every word of the search in its name or contents. */
const matches = (file: MemoryFile, words: string[]): boolean => {
  const text = `${file.path}\n${file.content}`.toLowerCase()
  return words.every((w) => text.includes(w))
}

/**
 * What Claude has noted in each project's memory, grouped by project. Each file can be read,
 * corrected or deleted; Claude reads a project's files at the start of its chats, so what's here
 * shapes its answers there. Notes suggested from browsing wait at the top of their project until
 * they're added or dismissed. Opens scrolled to `projectId`.
 */
export function MemoryPanel(props: {
  projects: Project[]
  projectId: string
  /** Suggestions from browsing are on, so a project can be asked for some now. */
  browsingMemory: boolean
}): React.JSX.Element {
  const { projects } = props
  const [files, setFiles] = useState<Record<string, MemoryFile[]>>()
  const [query, setQuery] = useState('')
  /** The open file, as `projectId` and `path`. */
  const [open, setOpen] = useState<{ projectId: string; path: string } | null>(null)
  const [draft, setDraft] = useState('')
  /** A note being written, and which project it's for. */
  const [adding, setAdding] = useState<{ projectId: string; path: string } | null>(null)
  const [error, setError] = useState<string>()
  const [suggestions, setSuggestions] = useState<MemorySuggestion[]>([])
  /** The project whose browsing is being looked at now. */
  const [suggesting, setSuggesting] = useState<string | null>(null)
  /** What the last look found, by project: shown when it found nothing new. */
  const [looked, setLooked] = useState<Record<string, string>>({})
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const load = (): void => void window.api.memory.suggestions().then(setSuggestions)
    load()
    return window.api.memory.onSuggestionsChanged(load)
  }, [])

  const reloadFiles = async (projectId: string): Promise<void> => {
    const next = await window.api.memory.list(projectId)
    setFiles((prev) => ({ ...prev, [projectId]: next }))
  }

  const accept = async (s: MemorySuggestion, text: string): Promise<void> => {
    await window.api.memory.accept(s.id, text)
    setSuggestions((prev) => prev.filter((x) => x.id !== s.id))
    await reloadFiles(s.projectId)
  }

  const dismiss = async (s: MemorySuggestion): Promise<void> => {
    await window.api.memory.dismiss(s.id)
    setSuggestions((prev) => prev.filter((x) => x.id !== s.id))
  }

  const suggestNow = async (projectId: string): Promise<void> => {
    setSuggesting(projectId)
    setError(undefined)
    const before = suggestions.filter((s) => s.projectId === projectId).length
    try {
      const next = await window.api.memory.suggest(projectId)
      setSuggestions(next)
      const found = next.filter((s) => s.projectId === projectId).length - before
      setLooked((prev) => ({ ...prev, [projectId]: found > 0 ? '' : 'Nothing new to suggest from recent browsing.' }))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSuggesting(null)
    }
  }

  useEffect(() => {
    void Promise.all(projects.map(async (p) => [p.id, await window.api.memory.list(p.id)] as const)).then((pairs) =>
      setFiles(Object.fromEntries(pairs))
    )
    // Only on opening; edits below keep it current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Start at the project the memory was opened for.
  useEffect(() => {
    if (!files) return
    list.current?.querySelector(`[data-project="${CSS.escape(props.projectId)}"]`)?.scrollIntoView({ block: 'start' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files === undefined])

  const isOpen = (projectId: string, path: string): boolean => open?.projectId === projectId && open.path === path

  const select = (projectId: string, file: MemoryFile): void => {
    setOpen(isOpen(projectId, file.path) ? null : { projectId, path: file.path })
    setDraft(file.content)
    setAdding(null)
    setError(undefined)
  }

  const save = async (projectId: string, path: string, content: string): Promise<void> => {
    try {
      const next = await window.api.memory.write(projectId, path, content)
      setFiles((prev) => ({ ...prev, [projectId]: next }))
      setError(undefined)
      setAdding(null)
      setOpen({ projectId, path })
      setDraft(content)
    } catch (err) {
      setError(errorText(err))
    }
  }

  const remove = async (project: Project, path: string): Promise<void> => {
    const from = project.id === DEFAULT_PROJECT_ID ? 'memory' : `${project.name}'s memory`
    if (!window.confirm(`Delete ${shortPath(path)} from ${from}?`)) return
    const next = await window.api.memory.remove(project.id, path)
    setFiles((prev) => ({ ...prev, [project.id]: next }))
    if (isOpen(project.id, path)) setOpen(null)
  }

  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const total = files ? Object.values(files).reduce((n, f) => n + f.length, 0) : 0
  // Chats outside any project keep their notes in the default project, listed first without a
  // project's name. With no other projects there's nothing to group, so no headings either.
  const grouped = projects.some((p) => p.id !== DEFAULT_PROJECT_ID)
  const ordered = [...projects].sort((a, b) => Number(b.id === DEFAULT_PROJECT_ID) - Number(a.id === DEFAULT_PROJECT_ID))
  const groups = ordered
    .map((project) => ({
      project,
      files: (files?.[project.id] ?? []).filter((f) => matches(f, words)),
      suggested: suggestions.filter((s) => s.projectId === project.id && words.every((w) => s.text.toLowerCase().includes(w)))
    }))
    // Searching hides projects with nothing that matches; otherwise every project shows, empty or not.
    .filter((g) => !words.length || g.files.length > 0 || g.suggested.length > 0)
  const nameOf = (project: Project): string => (project.id === DEFAULT_PROJECT_ID ? 'Everyday' : project.name)

  return (
    <div className="library-panel" role="tabpanel" aria-label="Memory">
      <p className="muted small">
        Notes Tidepool keeps about you and your work. It reads them when a chat starts and updates them as it learns.
        {grouped && ' Each project has its own notes, and projects can’t see each other’s.'} Edit or delete anything that’s
        wrong.
      </p>
      {total > 0 && (
        <input
          type="search"
          autoFocus
          aria-label="Search memory"
          placeholder="Search notes"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      <div className="memory-list" ref={list}>
        {files &&
          groups.map(({ project, files: shown, suggested }) => (
            <section key={project.id} className="memory-group" data-project={project.id} aria-label={grouped ? nameOf(project) : 'Notes'}>
              <div className="memory-group-head">
                <span>{grouped ? nameOf(project) : ''}</span>
                {grouped && <span className="muted small">{files[project.id]?.length || ''}</span>}
                <span className="grow" />
                {props.browsingMemory && (
                  <button className="quiet small" disabled={suggesting !== null} onClick={() => void suggestNow(project.id)}>
                    {suggesting === project.id ? 'Looking…' : 'Suggest from browsing'}
                  </button>
                )}
                <button
                  className="quiet small"
                  onClick={() => {
                    setAdding({ projectId: project.id, path: 'notes.md' })
                    setDraft('')
                    setOpen(null)
                    setError(undefined)
                  }}
                >
                  New note
                </button>
              </div>
              {looked[project.id] && suggested.length === 0 && <p className="muted small memory-empty">{looked[project.id]}</p>}
              {suggested.length > 0 && (
                <div className="memory-suggestions" role="list" aria-label="Suggested from browsing">
                  {suggested.map((s) => (
                    <SuggestionRow key={s.id} suggestion={s} onAccept={(text) => void accept(s, text)} onDismiss={() => void dismiss(s)} />
                  ))}
                </div>
              )}
              <div className="memory-files" role="list">
                {shown.map((file) => (
                  <div key={file.path} role="listitem" className={`memory-file ${isOpen(project.id, file.path) ? 'open' : ''}`}>
                    <button
                      className="memory-file-head"
                      onClick={() => select(project.id, file)}
                      aria-expanded={isOpen(project.id, file.path)}
                    >
                      <span className="memory-file-name">
                        <span className="memory-path">{shortPath(file.path)}</span>
                        {!isOpen(project.id, file.path) && <span className="memory-preview muted small">{preview(file.content)}</span>}
                      </span>
                      <span className="muted small">{new Date(file.updatedAt).toLocaleString()}</span>
                    </button>
                    {isOpen(project.id, file.path) && (
                      <div className="memory-editor">
                        <textarea
                          aria-label={`Contents of ${file.path}`}
                          rows={Math.min(18, Math.max(5, draft.split('\n').length + 1))}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                        />
                        <div className="row end">
                          <button className="danger" onClick={() => void remove(project, file.path)}>
                            Delete
                          </button>
                          <span className="grow" />
                          <button
                            className="primary"
                            disabled={draft === file.content}
                            onClick={() => void save(project.id, file.path, draft)}
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {shown.length === 0 && suggested.length === 0 && adding?.projectId !== project.id && (
                  <p className="muted small memory-empty">No notes yet.</p>
                )}
              </div>
              {adding?.projectId === project.id && (
                <form
                  className="memory-editor"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void save(project.id, `/memories/${adding.path.replace(/^\/?(memories\/)?/, '')}`, draft)
                  }}
                >
                  <label className="field">
                    <span>File name</span>
                    <input autoFocus value={adding.path} onChange={(e) => setAdding({ ...adding, path: e.target.value })} />
                  </label>
                  <textarea aria-label="New note" rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} />
                  <div className="row end">
                    <button type="button" onClick={() => setAdding(null)}>
                      Cancel
                    </button>
                    <button type="submit" className="primary" disabled={!adding.path.trim()}>
                      Save note
                    </button>
                  </div>
                </form>
              )}
            </section>
          ))}
        {files && words.length > 0 && groups.length === 0 && <p className="muted memory-empty">No notes match.</p>}
      </div>
      {error && <div className="server-error">{error}</div>}
    </div>
  )
}

/** A note suggested from browsing: add it (after editing, if needed) or dismiss it. */
function SuggestionRow(props: {
  suggestion: MemorySuggestion
  onAccept: (text: string) => void
  onDismiss: () => void
}): React.JSX.Element {
  const { suggestion } = props
  const [text, setText] = useState(suggestion.text)
  const [editing, setEditing] = useState(false)
  return (
    <div className="memory-suggestion" role="listitem">
      <div className="memory-suggestion-body">
        <span className="memory-suggestion-tag">Suggested</span>
        {editing ? (
          <input autoFocus aria-label="Suggested note" value={text} onChange={(e) => setText(e.target.value)} />
        ) : (
          <span className="memory-suggestion-text">{text}</span>
        )}
        <span className="muted small">
          {suggestion.reason ? `${suggestion.reason} · ` : ''}adds to {shortPath(suggestion.path)}
        </span>
      </div>
      <div className="row end">
        <button className="quiet small" onClick={props.onDismiss}>
          Dismiss
        </button>
        {!editing && (
          <button className="quiet small" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        <button className="primary small" disabled={!text.trim()} onClick={() => props.onAccept(text)}>
          Add to memory
        </button>
      </div>
    </div>
  )
}

/**
 * "Remember this page": saves a line about the page, as the user words it, to the memory of the
 * project it's open in. It's the user's own note, so it goes in without review.
 */
export function RememberModal(props: {
  page: { projectId: string; title: string; url: string }
  /** The project it goes to; undefined outside projects. */
  projectName: string | undefined
  onClose: () => void
}): React.JSX.Element {
  const { page } = props
  const [text, setText] = useState(page.title ? `${page.title} (${page.url})` : page.url)
  const [error, setError] = useState<string>()
  const save = async (): Promise<void> => {
    try {
      const date = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      await window.api.memory.append(page.projectId, '/memories/saved-pages.md', `${text.trim()} (saved ${date})`)
      props.onClose()
    } catch (err) {
      setError(errorText(err))
    }
  }
  return (
    <Modal title="Remember this page" onClose={props.onClose}>
      <form
        className="memory-editor remember"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <p className="muted small">
          Saved to {props.projectName ? `${props.projectName}’s memory` : 'memory'}, so Tidepool can bring it up later. Add why
          it matters if that helps.
        </p>
        <textarea autoFocus aria-label="What to remember" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="row end">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!text.trim()}>
            Remember
          </button>
        </div>
        {error && <div className="server-error">{error}</div>}
      </form>
    </Modal>
  )
}
