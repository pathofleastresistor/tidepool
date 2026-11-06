import { useState } from 'react'
import {
  bindingFromEvent,
  bindingsFor,
  commandUsing,
  COMMANDS,
  formatBinding,
  type Command,
  type CommandGroup
} from '@shared/commands'
import type { PublicSettings } from '@shared/types'
import { Modal } from './Modals'

const GROUPS: CommandGroup[] = ['Chat', 'Tabs', 'Page', 'Go', 'App', 'Developer']

/** ⌘2 to ⌘8 are folded into ⌘1's row, as "Sidebar items 1–8". */
const folded = (c: Command): boolean => /^go\.item[2-8]$/.test(c.id)

function Keys(props: { bindings: string[] }): React.JSX.Element {
  const platform = window.api.platform
  if (!props.bindings.length) return <span className="muted small">None</span>
  return (
    <span className="keys">
      {props.bindings.map((b, i) => (
        <span key={b}>
          {i > 0 && <span className="muted small"> or </span>}
          <kbd>{formatBinding(b, platform)}</kbd>
        </span>
      ))}
    </span>
  )
}

/** Keys that aren't commands, but are worth knowing. */
const EXTRAS: Array<[label: string, keys: string]> = [
  ['Send a message', 'Enter'],
  ['New line in a message', 'Shift+Enter'],
  ['Stop the reply, from the message box', 'Esc'],
  ['Close a dialog, menu, find bar or fullscreen app', 'Esc']
]

/** ⌘/: every shortcut, grouped the way the menu bar is. */
export function ShortcutsModal(props: {
  bindings: Record<string, string>
  onOpenSettings: () => void
  onClose: () => void
}): React.JSX.Element {
  const platform = window.api.platform
  return (
    <Modal title="Keyboard shortcuts" onClose={props.onClose} className="shortcuts-modal">
      <div className="shortcut-groups">
        {GROUPS.map((group) => (
          <section key={group} className="shortcut-group">
            <h3>{group}</h3>
            {COMMANDS.filter((c) => c.group === group && !folded(c)).map((c) => {
              const bindings = bindingsFor(c, platform, props.bindings)
              if (!bindings.length) return null
              return (
                <div key={c.id} className="shortcut-row">
                  <span>{c.id === 'go.item1' ? 'Sidebar items 1–8' : c.label}</span>
                  {c.id === 'go.item1' ? (
                    <kbd>{formatBinding(bindings[0], platform).replace(/1$/, '1–8')}</kbd>
                  ) : (
                    <Keys bindings={bindings} />
                  )}
                </div>
              )
            })}
            {group === 'Chat' &&
              EXTRAS.map(([label, keys]) => (
                <div key={label} className="shortcut-row">
                  <span>{label}</span>
                  <kbd>{keys}</kbd>
                </div>
              ))}
          </section>
        ))}
      </div>
      <p className="muted small flush">
        Shortcuts marked for the page (like Quick Open) go to a website instead while you're typing in it.{' '}
        <button className="link" onClick={props.onOpenSettings}>
          Change shortcuts in Settings
        </button>
      </p>
    </Modal>
  )
}

/**
 * A button that records the next key combination pressed on it. Escape cancels, and Backspace
 * or Delete clears the shortcut.
 */
function KeyRecorder(props: {
  label: string
  bindings: string[]
  onRecord: (binding: string) => string | undefined
}): React.JSX.Element {
  const platform = window.api.platform
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string>()
  return (
    <span className="key-recorder">
      <button
        className={`key-button ${recording ? 'recording' : ''}`}
        aria-label={`Change the shortcut for ${props.label}`}
        onClick={() => {
          setError(undefined)
          setRecording(true)
        }}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return
          // Nothing else (the dialog's Escape, the app's shortcuts) sees keys while recording.
          e.preventDefault()
          e.stopPropagation()
          const bare = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
          if (bare && e.key === 'Escape') return setRecording(false)
          if (bare && (e.key === 'Backspace' || e.key === 'Delete')) {
            setRecording(false)
            setError(props.onRecord(''))
            return
          }
          const binding = bindingFromEvent(e.nativeEvent, platform)
          if (!binding) return // just a modifier so far, or a key that needs one
          setRecording(false)
          setError(props.onRecord(binding))
        }}
      >
        {recording ? (
          <span className="muted">Press keys…</span>
        ) : props.bindings.length ? (
          props.bindings.map((b) => <kbd key={b}>{formatBinding(b, platform)}</kbd>)
        ) : (
          <span className="muted">None</span>
        )}
      </button>
      {error && <span className="key-error small">{error}</span>}
    </span>
  )
}

/** Settings › Keyboard: change any shortcut, and the one that works from other apps. */
export function KeyboardSettings(props: {
  settings: PublicSettings
  onChange: (s: PublicSettings) => void
}): React.JSX.Element {
  const platform = window.api.platform
  const overrides = props.settings.keyBindings ?? {}

  const save = async (patch: Partial<PublicSettings>): Promise<void> => {
    props.onChange(await window.api.settings.update(patch))
  }

  const setBinding = (cmd: Command, binding: string): string | undefined => {
    if (binding) {
      const clash = commandUsing(binding, platform, overrides, cmd.id)
      if (clash) return `${formatBinding(binding, platform)} is already ${clash.label}`
    }
    const next = { ...overrides, [cmd.id]: binding }
    // Back to the default: forget the change.
    const defaults = platform === 'darwin' ? cmd.keys.mac : cmd.keys.other
    if (binding && defaults[0] === binding) delete next[cmd.id]
    void save({ keyBindings: next })
    return undefined
  }

  const reset = (id: string): void => {
    const next = { ...overrides }
    delete next[id]
    void save({ keyBindings: next })
  }

  return (
    <div className="settings-section keyboard-settings">
      <div className="field">
        <span>Talk from anywhere</span>
        <div className="row between">
          <span className="muted small">
            Brings Tidepool forward and starts listening, even while you're in another app.
          </span>
          <KeyRecorder
            label="Talk from anywhere"
            bindings={props.settings.talkShortcut ? [props.settings.talkShortcut] : []}
            onRecord={(binding) => {
              const clash = binding && commandUsing(binding, platform, overrides)
              if (clash) return `${formatBinding(binding, platform)} is already ${clash.label}`
              void save({ talkShortcut: binding })
              return undefined
            }}
          />
        </div>
      </div>
      <p className="muted small flush">
        Click a shortcut and press the keys you want. Backspace turns one off; Escape leaves it as it was.
      </p>
      {GROUPS.map((group) => (
        <section key={group} className="shortcut-group">
          <h3>{group}</h3>
          {COMMANDS.filter((c) => c.group === group).map((c) => (
            <div key={c.id} className="shortcut-row">
              <span>
                {c.label}
                {c.yieldsToPage && <span className="muted small"> · page first</span>}
              </span>
              <span className="row">
                {c.id in overrides && (
                  <button className="quiet small" onClick={() => reset(c.id)}>
                    Reset
                  </button>
                )}
                <KeyRecorder label={c.label} bindings={bindingsFor(c, platform, overrides)} onRecord={(b) => setBinding(c, b)} />
              </span>
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}
