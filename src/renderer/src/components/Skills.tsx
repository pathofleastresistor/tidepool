import { useState } from 'react'
import type { Skill, SkillDraft, SkillProposal } from '@shared/types'
import { Modal } from './Modals'

const EMPTY: SkillDraft = { name: '', whenToUse: '', startUrl: '', steps: '' }

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)

/** The site a skill starts on, to show beside its name. */
export const skillSite = (url: string): string | undefined => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : undefined
  } catch {
    return undefined
  }
}

const same = (a: SkillDraft, b: SkillDraft): boolean =>
  a.name === b.name && a.whenToUse === b.whenToUse && a.startUrl === b.startUrl && a.steps === b.steps

/** A skill's parts, for writing a new one, changing one, or reviewing one Claude drafted. */
function SkillFields(props: { draft: SkillDraft; onChange: (draft: SkillDraft) => void; autoFocus?: boolean }): React.JSX.Element {
  const { draft, onChange } = props
  return (
    <>
      <label className="field">
        <span>Name</span>
        <input
          autoFocus={props.autoFocus}
          value={draft.name}
          placeholder="Check the sprint board"
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </label>
      <label className="field">
        <span>When to use it</span>
        <input
          value={draft.whenToUse}
          placeholder="When I ask what’s left in the sprint"
          onChange={(e) => onChange({ ...draft, whenToUse: e.target.value })}
        />
      </label>
      <label className="field">
        <span>Starts on</span>
        <input
          value={draft.startUrl}
          placeholder="example.com/board (optional)"
          onChange={(e) => onChange({ ...draft, startUrl: e.target.value })}
        />
      </label>
      <label className="field">
        <span>Steps</span>
        <textarea
          rows={Math.min(14, Math.max(5, draft.steps.split('\n').length + 1))}
          value={draft.steps}
          placeholder={'1. Read the board.\n2. Tell me which cards are overdue, and who has them.'}
          onChange={(e) => onChange({ ...draft, steps: e.target.value })}
        />
      </label>
    </>
  )
}

/**
 * The user's skills: things they taught Tidepool to do again. Each can be run, changed or
 * deleted, and new ones written by hand, though most start as a chat: do it once, then say
 * "save that as a skill".
 */
export function SkillsPanel(props: { skills: Skill[]; onRun: (skill: Skill) => void }): React.JSX.Element {
  /** The skill being changed, or 'new' for one being written. */
  const [open, setOpen] = useState<string | null>(null)
  const [draft, setDraft] = useState<SkillDraft>(EMPTY)
  const [error, setError] = useState<string>()

  const select = (skill: Skill): void => {
    setOpen(open === skill.id ? null : skill.id)
    setDraft({ name: skill.name, whenToUse: skill.whenToUse, startUrl: skill.startUrl, steps: skill.steps })
    setError(undefined)
  }

  const save = async (id?: string): Promise<void> => {
    try {
      const next = await window.api.skills.save(draft, id)
      setOpen(id ?? next.find((s) => s.name.toLowerCase() === draft.name.trim().toLowerCase())?.id ?? null)
      setError(undefined)
    } catch (err) {
      setError(errorText(err))
    }
  }

  const remove = async (skill: Skill): Promise<void> => {
    if (!window.confirm(`Delete the skill “${skill.name}”?`)) return
    await window.api.skills.remove(skill.id)
    if (open === skill.id) setOpen(null)
  }

  return (
    <div className="library-panel skills-panel" role="tabpanel" aria-label="Skills">
      <p className="muted small">
        Things you taught Tidepool to do again. Do something once, like opening a site and asking about it, then say “save
        that as a skill”. After that, just ask, or tap it here or on its site.
      </p>
      <div className="row end">
        <button
          className="quiet small"
          onClick={() => {
            setOpen('new')
            setDraft(EMPTY)
            setError(undefined)
          }}
        >
          New skill
        </button>
      </div>
      <div className="memory-list">
        {open === 'new' && (
          <form
            className="memory-editor"
            aria-label="New skill"
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <SkillFields draft={draft} onChange={setDraft} autoFocus />
            <div className="row end">
              <button type="button" onClick={() => setOpen(null)}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={!draft.name.trim() || !draft.steps.trim()}>
                Save skill
              </button>
            </div>
          </form>
        )}
        <div className="memory-files" role="list">
          {props.skills.map((skill) => {
            const site = skillSite(skill.startUrl)
            const isOpen = open === skill.id
            return (
              <div key={skill.id} role="listitem" className={`memory-file skill ${isOpen ? 'open' : ''}`}>
                <div className="skill-head">
                  <button className="memory-file-head" onClick={() => select(skill)} aria-expanded={isOpen}>
                    <span className="memory-file-name">
                      <span className="memory-path">{skill.name}</span>
                      {!isOpen && (skill.whenToUse || site) && (
                        <span className="memory-preview muted small">{[skill.whenToUse, site].filter(Boolean).join(' · ')}</span>
                      )}
                    </span>
                  </button>
                  <button className="quiet small" onClick={() => props.onRun(skill)} title={`Run “${skill.name}” now`}>
                    Run
                  </button>
                </div>
                {isOpen && (
                  <form
                    className="memory-editor"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void save(skill.id)
                    }}
                  >
                    <SkillFields draft={draft} onChange={setDraft} />
                    <div className="row end">
                      <button type="button" className="danger" onClick={() => void remove(skill)}>
                        Delete
                      </button>
                      <span className="grow" />
                      <button type="submit" className="primary" disabled={same(draft, skill)}>
                        Save
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )
          })}
          {props.skills.length === 0 && open !== 'new' && <p className="muted small memory-empty">No skills yet.</p>}
        </div>
      </div>
      {error && <div className="server-error">{error}</div>}
    </div>
  )
}

/**
 * A skill Claude drafted from the chat, waiting to be saved. Nothing is saved until the user says
 * so here, after reading (and changing, if they like) every part: the steps are followed as the
 * user's own instructions from then on.
 */
export function SkillReviewModal(props: { proposal: SkillProposal; onDone: () => void }): React.JSX.Element {
  const { proposal } = props
  const [draft, setDraft] = useState(proposal.draft)
  const [error, setError] = useState<string>()
  const answer = async (saved: SkillDraft | null): Promise<void> => {
    // No always closes, even when the chat already stopped waiting.
    if (!saved) {
      void window.api.skills.answerProposal(proposal.requestId, null).catch(() => {})
      return props.onDone()
    }
    try {
      await window.api.skills.answerProposal(proposal.requestId, saved)
      props.onDone()
    } catch (err) {
      setError(errorText(err))
    }
  }
  return (
    <Modal
      title={proposal.replaces ? `Update “${proposal.replaces}”?` : 'Save this skill?'}
      onClose={() => void answer(null)}
      className="skill-review"
    >
      <form
        className="memory-editor"
        onSubmit={(e) => {
          e.preventDefault()
          void answer(draft)
        }}
      >
        <p className="muted small">
          Claude drafted this from your chat. When you ask for it, Claude follows these steps as your own instructions, so make
          sure they say only what you want.
          {proposal.replaces && ' It replaces the skill you have with this name.'}
        </p>
        <SkillFields draft={draft} onChange={setDraft} />
        <div className="row end">
          <button type="button" onClick={() => void answer(null)}>
            Don’t save
          </button>
          <button type="submit" className="primary" disabled={!draft.name.trim() || !draft.steps.trim()}>
            Save skill
          </button>
        </div>
        {error && <div className="server-error">{error}</div>}
      </form>
    </Modal>
  )
}
