import type { ConversationSummary, HistoryEntry, Project, Skill } from '@shared/types'
import { withShortcut } from '../commands'
import { ChatsPanel } from './Chats'
import { HistoryPanel } from './History'
import { ChatIcon, HistoryIcon, MemoryIcon, SkillIcon } from './Icons'
import { MemoryPanel } from './Memory'
import { Modal } from './Modals'
import { SkillsPanel } from './Skills'

export type LibraryTab = 'chats' | 'history' | 'memory' | 'skills'

const TABS: { id: LibraryTab; label: string; icon: () => React.JSX.Element; command?: string }[] = [
  { id: 'chats', label: 'Chats', icon: ChatIcon },
  { id: 'history', label: 'History', icon: HistoryIcon, command: 'app.history' },
  { id: 'memory', label: 'Memory', icon: MemoryIcon, command: 'app.memory' },
  { id: 'skills', label: 'Skills', icon: SkillIcon, command: 'app.skills' }
]

/**
 * What Tidepool has kept for you, in one place: what you've asked (Chats), where you've been
 * (History), what it knows about you (Memory) and what you've taught it to do (Skills). Settings is for how the app works; this
 * is for what's in it.
 */
export function LibraryModal(props: {
  tab: LibraryTab
  onTab: (tab: LibraryTab) => void
  projects: Project[]
  /** The chat's project: History offers it as a filter, and Memory opens scrolled to it. */
  chatProjectId: string
  /** The project Memory opens scrolled to, when it isn't the chat's. */
  memoryProjectId: string
  browsingMemory: boolean
  /** Memory notes suggested from browsing, waiting for review. */
  memorySuggestionCount: number
  skills: Skill[]
  onOpenChat: (chat: ConversationSummary) => void
  /** Resolves true once it's deleted, false if the user thought better of it. */
  onDeleteChat: (chat: ConversationSummary) => Promise<boolean>
  onOpenHistoryEntry: (entry: HistoryEntry) => void
  onRunSkill: (skill: Skill) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <Modal title="Library" onClose={props.onClose} className="library-modal">
      <div className="library-tabs" role="tablist" aria-label="Library">
        {TABS.map(({ id, label, icon: Icon, command }) => (
          <button
            key={id}
            role="tab"
            aria-selected={props.tab === id}
            className={props.tab === id ? 'active' : ''}
            onClick={() => props.onTab(id)}
            title={command ? withShortcut(label, command) : label}
          >
            <Icon />
            <span>{label}</span>
            {id === 'memory' && props.memorySuggestionCount > 0 && (
              <span className="library-badge" title={`${props.memorySuggestionCount} suggested from browsing, to review`}>
                {props.memorySuggestionCount}
              </span>
            )}
          </button>
        ))}
      </div>
      {props.tab === 'chats' ? (
        <ChatsPanel projects={props.projects} projectId={props.chatProjectId} onOpen={props.onOpenChat} onDelete={props.onDeleteChat} />
      ) : props.tab === 'history' ? (
        <HistoryPanel projects={props.projects} projectId={props.chatProjectId} onOpen={props.onOpenHistoryEntry} />
      ) : props.tab === 'memory' ? (
        <MemoryPanel projects={props.projects} projectId={props.memoryProjectId} browsingMemory={props.browsingMemory} />
      ) : (
        <SkillsPanel skills={props.skills} onRun={props.onRunSkill} />
      )}
    </Modal>
  )
}
