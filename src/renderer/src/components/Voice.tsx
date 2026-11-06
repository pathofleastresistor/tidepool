import { useLayoutEffect, useRef, useState } from 'react'
import { withShortcut } from '../commands'
import type { Voice } from '../use-voice'

export function MicIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  )
}

const PRIVACY_PANE: Record<string, 'microphone' | 'speech' | undefined> = {
  'microphone-denied': 'microphone',
  'speech-denied': 'speech'
}

const MIC_LABELS = {
  idle: 'Talk to Tidepool',
  starting: 'Starting microphone…',
  listening: 'Send what you said',
  finishing: 'Sending…'
} as const

/** The newest lines of what's being heard; older ones scroll away above. */
function Transcript({ text }: { text: string }): React.JSX.Element {
  const ref = useRef<HTMLParagraphElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setOverflowing(el.scrollHeight > el.clientHeight + 1)
  }, [text])
  return (
    <p ref={ref} className={`voice-transcript ${text ? '' : 'empty'} ${overflowing ? 'overflowing' : ''}`}>
      {text || 'Go ahead, I’m listening…'}
    </p>
  )
}

/**
 * What voice input has to say: what it's hearing while you talk, or why it can't. Null when
 * there's nothing. It sends by itself when you pause; the mic sends right away.
 */
export function VoiceCard({ voice, compact = false }: { voice: Voice; /** Leaves out the transcript, for where it shows already (the chat's message box). */ compact?: boolean }): React.JSX.Element | null {
  if (voice.problem) {
    const pane = PRIVACY_PANE[voice.problem.code]
    return (
      <div className="voice-card problem" role="alert">
        <p className="voice-message">{voice.problem.message}</p>
        <div className="voice-card-actions">
          {pane && (
            <button className="link" onClick={() => void window.api.speech.openPrivacySettings(pane)}>
              Open {pane === 'microphone' ? 'Microphone' : 'Speech Recognition'} settings
            </button>
          )}
          <button className="link muted" onClick={voice.dismissProblem}>
            Dismiss
          </button>
        </div>
      </div>
    )
  }
  if (voice.state !== 'idle') {
    const status =
      voice.state === 'starting' ? 'Starting microphone…' : voice.state === 'finishing' ? 'Sending…' : 'Listening. Pause to send.'
    return (
      <div className={`voice-card ${compact ? 'compact' : ''}`} role="status">
        <div className="voice-card-head">
          <span className="voice-dot" aria-hidden="true" />
          <span className="voice-card-status">{status}</span>
          {voice.state !== 'finishing' && (
            <button className="link muted" onClick={voice.cancel}>
              Cancel
            </button>
          )}
        </div>
        {!compact && <Transcript text={voice.heard.trim()} />}
      </div>
    )
  }
  if (voice.notice) {
    return (
      <div className="voice-card notice" role="status">
        <p className="voice-message">{voice.notice}</p>
      </div>
    )
  }
  return null
}

/** The mic: talk, and it sends when you pause. Pressed again, it sends right away. */
export function MicButton({ voice, className = '' }: { voice: Voice; className?: string }): React.JSX.Element {
  return (
    <button
      type="button"
      className={`talk ${voice.state} ${className}`}
      onClick={voice.toggle}
      disabled={voice.state === 'starting' || voice.state === 'finishing'}
      aria-label={MIC_LABELS[voice.state]}
      aria-pressed={voice.state !== 'idle'}
      title={voice.state === 'idle' ? withShortcut('Talk to Tidepool. It sends when you pause.', 'voice.toggle') : MIC_LABELS[voice.state]}
      style={{ '--level': voice.level } as React.CSSProperties}
    >
      <MicIcon />
    </button>
  )
}
