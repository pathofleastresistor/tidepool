import { useRef, type RefObject } from 'react'
import { flushSync } from 'react-dom'

/**
 * Inline completion for an address box, the way a browser's address bar does it: as you type,
 * the rest of the site you most likely mean (from history) is filled in after the caret and
 * selected, so Enter goes there, typing on replaces it, and Backspace takes it away. Tab or →
 * keeps it and carries on; Escape drops it.
 *
 * The box stays controlled by its owner: `setValue` is how the fill goes in, and the value it
 * submits already has it.
 */
export function useInlineCompletion(opts: {
  ref: RefObject<HTMLInputElement | null>
  setValue: (value: string) => void
  /** The project being typed in, whose history counts for more. */
  projectId?: string
}): {
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  /** True when it handled the key, so the box shouldn't too. */
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => boolean
} {
  // The whole text, fill included, while a fill is showing.
  const filled = useRef<string | undefined>(undefined)
  // Answers can arrive out of order; only the latest request's counts.
  const request = useRef(0)
  const { ref, setValue, projectId } = opts

  const fill = (typed: string, full: string): void => {
    filled.current = full
    // Straight into the box, selection too: when the text is what the state already holds, React
    // won't render, and would put the caret at the end after this keystroke.
    const input = ref.current
    if (input) {
      input.value = full
      input.setSelectionRange(typed.length, full.length)
    }
    setValue(full)
  }

  const onChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const input = e.target
    const typed = input.value
    request.current++
    // Only while typing forwards at the end: not deleting, pasting, composing or editing mid-way.
    const typing =
      (e.nativeEvent as InputEvent).inputType === 'insertText' && input.selectionStart === typed.length && input.selectionEnd === typed.length
    const previous = filled.current
    filled.current = undefined
    if (!typing) return setValue(typed)
    // Still on the way to what's filled in: keep it up meanwhile, so it doesn't flicker, but ask
    // again, since what you've typed now may be somewhere you've been itself.
    const shown =
      previous && previous.length > typed.length && previous.toLowerCase().startsWith(typed.toLowerCase()) ? typed + previous.slice(typed.length) : typed
    if (shown === typed) setValue(typed)
    else fill(typed, shown)
    const id = request.current
    void window.api.history.complete(typed, projectId).then((full) => {
      const now = ref.current
      if (id !== request.current || !now || now.ownerDocument.activeElement !== now) return
      // Unless you've moved the caret or changed the text meanwhile.
      if (now.value !== shown || now.selectionStart !== typed.length || full === shown) return
      // Now, not on React's next render: Enter pressed in between submits the state.
      flushSync(() => {
        if (full) return fill(typed, full)
        filled.current = undefined
        setValue(typed)
      })
    })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): boolean => {
    const input = e.currentTarget
    const showing = filled.current === input.value && input.selectionEnd === input.value.length && input.selectionStart! < input.value.length
    if (!showing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false
    if (e.key === 'Tab') {
      e.preventDefault()
      filled.current = undefined
      input.setSelectionRange(input.value.length, input.value.length)
      return true
    }
    if (e.key === 'Escape') {
      // Handled here: Escape shouldn't also close whatever else is open.
      e.preventDefault()
      request.current++
      filled.current = undefined
      setValue(input.value.slice(0, input.selectionStart!))
      return true
    }
    return false
  }

  return { onChange, onKeyDown }
}
