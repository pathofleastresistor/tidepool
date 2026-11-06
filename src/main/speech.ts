import { app, shell } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { SpeechEvent } from '@shared/types'

/** Where the on-device speech helper lives; TIDEPOOL_SPEECH_HELPER overrides it for tests. */
function helperPath(): string | undefined {
  const override = process.env.TIDEPOOL_SPEECH_HELPER
  if (override) return override
  if (process.platform !== 'darwin') return undefined
  const path = app.isPackaged
    ? join(process.resourcesPath, 'bin', 'speech-helper')
    : join(__dirname, '../../resources/bin/speech-helper')
  return existsSync(path) ? path : undefined
}

const PRIVACY_PANES = {
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  speech: 'x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition'
} as const

/**
 * Runs the speech helper for one utterance at a time and relays what it hears. The helper
 * decides when the user has finished speaking; this just starts, stops and reports.
 */
export class SpeechService {
  private child?: ChildProcessWithoutNullStreams

  constructor(private emit: (event: SpeechEvent) => void) {}

  available(): boolean {
    return helperPath() !== undefined
  }

  start(): void {
    // A renderer reload can leave a session running; a new start replaces it, silently.
    this.discard()
    const path = helperPath()
    if (!path) {
      this.emit({ type: 'error', code: 'unavailable', message: 'Voice input needs macOS.' })
      this.emit({ type: 'ended' })
      return
    }

    const child = spawn(path, [], { stdio: 'pipe' })
    this.child = child
    // Only the current session may speak; a replaced one's late events would confuse the UI.
    const current = (): boolean => this.child === child
    let reported = false
    let stderr = ''
    // Writing to a helper that has just exited must not take the main process down with it.
    child.stdin.on('error', () => {})
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!current()) return
      let event: SpeechEvent
      try {
        event = JSON.parse(line) as SpeechEvent
      } catch {
        return
      }
      if (event.type === 'final' || event.type === 'error' || event.type === 'cancelled') reported = true
      this.emit(event)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000)
    })
    child.on('error', (err) => {
      if (!current()) return
      reported = true
      this.emit({ type: 'error', code: 'spawn', message: `Couldn't start voice input: ${err.message}` })
    })
    child.on('close', (code, signal) => {
      if (!current()) return
      this.child = undefined
      // A helper that dies without saying why (macOS kills it outright over a privacy
      // violation, for instance) still owes the user an explanation.
      if (!reported) {
        const how = signal ? `was stopped (${signal})` : `exited with code ${code}`
        this.emit({
          type: 'error',
          code: 'crashed',
          message: `Voice input ${how}.${stderr.trim() ? ` ${stderr.trim().split('\n').pop()}` : ''}`
        })
      }
      this.emit({ type: 'ended' })
    })
  }

  stop(): void {
    this.child?.stdin.write('stop\n')
  }

  /** Discard the utterance; the UI still hears "cancelled" and "ended". */
  cancel(): void {
    const child = this.child
    if (!child) return
    child.stdin.write('cancel\n')
    // If it doesn't go quietly, make it.
    setTimeout(() => child.exitCode === null && child.kill(), 1000).unref()
  }

  /** Stop the current session without telling anyone, e.g. when it's being replaced or on quit. */
  discard(): void {
    const child = this.child
    if (!child) return
    this.child = undefined
    child.stdin.write('cancel\n')
    setTimeout(() => child.exitCode === null && child.kill(), 1000).unref()
  }

  openPrivacySettings(pane: 'microphone' | 'speech'): void {
    void shell.openExternal(PRIVACY_PANES[pane])
  }
}
