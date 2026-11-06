import { useEffect, useRef, useState } from 'react'
import type { FindResult, FindTarget } from '@shared/types'
import { focusInOverlay, useCommand } from '../commands'
import { useEscape } from '../escape'
import { ChevronIcon, CloseIcon } from './Icons'

/**
 * ⌘F: find in the page on screen, or in the chat. The page is a native view, so the bar is drawn
 * in an overlay above it, as Chrome hangs its bar under the toolbar. `focusToken` changes when ⌘F
 * is pressed again, which puts the keyboard back in the box.
 */
export function FindBar(props: { overlay: string; target: FindTarget; focusToken: number; onClose: () => void }): React.JSX.Element {
  const { target, overlay } = props
  const [text, setText] = useState('')
  const [result, setResult] = useState<FindResult>({ active: 0, matches: 0 })
  const inputRef = useRef<HTMLInputElement>(null)
  const textRef = useRef(text)
  textRef.current = text

  useEffect(() => window.api.find.onResult(setResult), [])
  useEffect(() => focusInOverlay(overlay, () => inputRef.current), [overlay, props.focusToken])
  // A new place to look starts a new search there.
  useEffect(() => {
    if (textRef.current) void window.api.find.start(target, textRef.current, { forward: true, newSearch: true })
    return () => void window.api.find.stop(target)
  }, [target])

  const step = (forward: boolean): void => {
    if (textRef.current) void window.api.find.start(target, textRef.current, { forward, newSearch: false })
  }
  useCommand('page.findNext', () => step(true))
  useCommand('page.findPrevious', () => step(false))
  useEscape(props.onClose)

  return (
    <div className="find-bar" role="search" aria-label={target === 'chat' ? 'Find in chat' : 'Find in page'}>
      <input
        ref={inputRef}
        value={text}
        placeholder={target === 'chat' ? 'Find in chat' : 'Find in page'}
        aria-label="Find"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value)
          void window.api.find.start(target, e.target.value, { forward: true, newSearch: true })
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            step(!e.shiftKey)
          }
        }}
      />
      <span className="find-count" aria-live="polite">
        {text ? `${result.active}/${result.matches}` : ''}
      </span>
      <button className="icon find-prev" onClick={() => step(false)} disabled={!result.matches} aria-label="Previous match" title="Previous match (Shift+Enter)">
        <ChevronIcon />
      </button>
      <button className="icon find-next" onClick={() => step(true)} disabled={!result.matches} aria-label="Next match" title="Next match (Enter)">
        <ChevronIcon />
      </button>
      <button className="icon" onClick={props.onClose} aria-label="Close find" title="Close (Esc)">
        <CloseIcon />
      </button>
    </div>
  )
}
