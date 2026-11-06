import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpeechEvent } from '@shared/types'

export type VoiceState = 'idle' | 'starting' | 'listening' | 'finishing'

export interface VoiceProblem {
  code: string
  message: string
}

interface VoiceOptions {
  /** Current composer text. What the user says is appended to it. */
  getDraft: () => string
  setDraft: (text: string) => void
  /** The user finished speaking. Hands-free: this sends it. */
  onUtterance: (text: string) => void
}

export interface Voice {
  available: boolean
  state: VoiceState
  /** Input level 0...1, for the meter. */
  level: number
  /** What's been heard so far in this utterance. */
  heard: string
  problem: VoiceProblem | null
  notice: string | null
  toggle: () => void
  cancel: () => void
  dismissProblem: () => void
}

const append = (base: string, heard: string): string =>
  base.trim() && heard ? `${base.trimEnd()} ${heard}` : base.trim() ? base : heard

/**
 * Hands-free voice input. The words appear in the composer as they're recognized, and the
 * message goes out by itself when the user pauses (the helper decides when that is).
 */
export function useVoice(options: VoiceOptions): Voice {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const [available, setAvailable] = useState(false)
  const [state, setState] = useState<VoiceState>('idle')
  const [level, setLevel] = useState(0)
  const [heard, setHeard] = useState('')
  // Kept outside state too, for the final event to fall back on.
  const heardRef = useRef('')
  const [problem, setProblem] = useState<VoiceProblem | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // The composer text from before the user started talking.
  const baseRef = useRef('')

  useEffect(() => {
    void window.api.speech.available().then(setAvailable)
  }, [])

  useEffect(
    () =>
      window.api.speech.onEvent((event: SpeechEvent) => {
        const { setDraft, onUtterance } = optionsRef.current
        switch (event.type) {
          case 'listening':
            setState('listening')
            break
          case 'level':
            setLevel(event.value)
            break
          case 'partial':
            heardRef.current = event.text
            setHeard(event.text)
            setDraft(append(baseRef.current, event.text))
            break
          case 'final': {
            // An empty final after words were heard means the recognizer lost them at the end;
            // what was on screen is still what the user said.
            const text = event.text.trim() || heardRef.current.trim()
            if (text) {
              onUtterance(append(baseRef.current, text))
            } else {
              setDraft(baseRef.current)
              setNotice("Didn't catch that. Try again?")
            }
            break
          }
          case 'cancelled':
            setDraft(baseRef.current)
            break
          case 'error':
            setDraft(baseRef.current)
            setProblem({ code: event.code, message: event.message })
            break
          case 'ended':
            setState('idle')
            setLevel(0)
            setHeard('')
            heardRef.current = ''
            break
        }
      }),
    []
  )

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  const toggle = useCallback(() => {
    if (state === 'idle') {
      setProblem(null)
      setNotice(null)
      baseRef.current = optionsRef.current.getDraft()
      heardRef.current = ''
      setHeard('')
      setState('starting')
      void window.api.speech.start()
    } else if (state === 'listening') {
      // Done talking: send what's been heard without waiting for the pause.
      setState('finishing')
      void window.api.speech.stop()
    }
  }, [state])

  const cancel = useCallback(() => void window.api.speech.cancel(), [])
  const dismissProblem = useCallback(() => setProblem(null), [])

  return { available, state, level, heard, problem, notice, toggle, cancel, dismissProblem }
}
