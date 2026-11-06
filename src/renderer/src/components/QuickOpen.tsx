import { useEffect, useMemo, useRef, useState } from 'react'
import { focusInOverlay } from '../commands'
import { useEscape } from '../escape'

export interface QuickOpenItem {
  key: string
  label: string
  /** What it is, shown after the label: "Project", "Chat in General", a shortcut. */
  detail?: string
  /** Shown at the right, for commands. */
  shortcut?: string
  icon?: React.ReactNode
  run: () => void
}

const MAX_SHOWN = 50

/** Items with every word typed, labels that start with the text first. */
function filter(items: QuickOpenItem[], query: string): QuickOpenItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items.slice(0, MAX_SHOWN)
  const words = q.split(/\s+/)
  const hits = items.filter((item) => {
    const text = `${item.label} ${item.detail ?? ''}`.toLowerCase()
    return words.every((w) => text.includes(w))
  })
  const rank = (item: QuickOpenItem): number => {
    const label = item.label.toLowerCase()
    return label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2
  }
  return hits.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_SHOWN)
}

/**
 * ⌘K: type to go to a site, project, tab or chat, or to run any command. It's drawn in an
 * overlay, over whatever is open.
 */
export function QuickOpen(props: { overlay: string; items: QuickOpenItem[]; onClose: () => void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const shown = useMemo(() => filter(props.items, query), [props.items, query])

  useEscape(props.onClose)
  useEffect(() => focusInOverlay(props.overlay, () => inputRef.current), [props.overlay])
  useEffect(() => setSelected(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const choose = (item: QuickOpenItem | undefined): void => {
    if (!item) return
    props.onClose()
    item.run()
  }

  return (
    <div className="quick-open" role="dialog" aria-label="Quick Open">
      <input
        ref={inputRef}
        className="quick-open-input"
        value={query}
        placeholder="Go to a site, project, tab or chat, or run a command"
        aria-label="Search"
        aria-controls="quick-open-list"
        aria-activedescendant={shown[selected] ? `quick-open-${shown[selected].key}` : undefined}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onBlur={(e) => {
          // Clicking anywhere else (a page, the app) closes it, as a menu would.
          if (!e.relatedTarget) setTimeout(() => !inputRef.current?.ownerDocument.hasFocus() && props.onClose(), 100)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
            e.preventDefault()
            setSelected((i) => Math.min(i + 1, shown.length - 1))
          } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
            e.preventDefault()
            setSelected((i) => Math.max(i - 1, 0))
          } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            choose(shown[selected])
          }
        }}
      />
      <div className="quick-open-list" id="quick-open-list" role="listbox" ref={listRef}>
        {shown.map((item, i) => (
          <div
            key={item.key}
            id={`quick-open-${item.key}`}
            role="option"
            aria-selected={i === selected}
            className="quick-open-item"
            onMouseMove={() => setSelected(i)}
            // Keeps the input's focus, so the choice runs before anything closes.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(item)}
          >
            <span className="quick-open-icon">{item.icon}</span>
            <span className="quick-open-label">{item.label}</span>
            {item.detail && <span className="quick-open-detail">{item.detail}</span>}
            {item.shortcut && <kbd>{item.shortcut}</kbd>}
          </div>
        ))}
        {shown.length === 0 && <div className="quick-open-empty">Nothing matches “{query}”</div>}
      </div>
    </div>
  )
}
