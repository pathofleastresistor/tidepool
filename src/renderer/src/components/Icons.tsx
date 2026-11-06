/** Small stroke icons for the sidebar and settings, drawn at 16px in the current text colour. */
function Icon({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      className="ico"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const ComposeIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M7.5 2.5h-4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-4" />
    <path d="M11.8 1.9a1.3 1.3 0 0 1 1.9 1.9L8 9.5l-2.5.5.5-2.5z" />
  </Icon>
)

export const ChatIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v6a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5v-2.5a1.5 1.5 0 0 1-1.5-1.5z" />
  </Icon>
)

export const PlusIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M8 3v10M3 8h10" />
  </Icon>
)

export const CloseIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </Icon>
)

export const GearIcon = (): React.JSX.Element => (
  <Icon>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3" />
  </Icon>
)

export const ToolsIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M9.8 2.7a3 3 0 0 0-3.9 3.9L2.4 10.1a1.4 1.4 0 0 0 2 2l3.5-3.5a3 3 0 0 0 3.9-3.9L10 6.5 8.6 6.1 8.2 4.7z" />
  </Icon>
)

export const LogIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M3 4h10M3 8h10M3 12h6" />
  </Icon>
)

export const ServerIcon = (): React.JSX.Element => (
  <Icon>
    <rect x="2.5" y="2.5" width="11" height="4.5" rx="1" />
    <rect x="2.5" y="9" width="11" height="4.5" rx="1" />
    <path d="M5 4.75h.01M5 11.25h.01" />
  </Icon>
)

export const SlidersIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M3 4h6M12 4h1M3 12h1M7 12h6M3 8h2M8 8h5" />
    <circle cx="10.5" cy="4" r="1.5" />
    <circle cx="5.5" cy="12" r="1.5" />
    <circle cx="6.5" cy="8" r="1.5" />
  </Icon>
)

export const FolderIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
  </Icon>
)

export const PinIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5" />
  </Icon>
)

export const MoreIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.2" />
  </Icon>
)

export const BackIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M13 8H3.5M7.5 4 3.5 8l4 4" />
  </Icon>
)

export const ForwardIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M3 8h9.5M8.5 4l4 4-4 4" />
  </Icon>
)

export const ReloadIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M13 8a5 5 0 1 1-1.5-3.6" />
    <path d="M13 2.5v2.5h-2.5" />
  </Icon>
)

export const ExternalIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" />
    <path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
  </Icon>
)

export const ChevronIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M6 4l4 4-4 4" />
  </Icon>
)

export const CheckIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M3.5 8.5l3 3 6-7" />
  </Icon>
)

export const ShieldIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M8 1.8 13 3.6v4c0 3.1-2.1 5.4-5 6.6-2.9-1.2-5-3.5-5-6.6v-4z" />
    <path d="M5.8 8l1.6 1.6 2.9-3" />
  </Icon>
)

export const SendIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M8 13V3.5M4 7.5l4-4 4 4" />
  </Icon>
)

export const StopIcon = (): React.JSX.Element => (
  <svg className="ico" viewBox="0 0 16 16" aria-hidden="true">
    <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
  </svg>
)

export const SidebarIcon = (): React.JSX.Element => (
  <Icon>
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M9.5 3v10" />
  </Icon>
)

export const SparkleIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M8 2.5 9.2 6.8 13.5 8 9.2 9.2 8 13.5 6.8 9.2 2.5 8 6.8 6.8z" />
  </Icon>
)

export const SearchIcon = (): React.JSX.Element => (
  <Icon>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.3 10.3 3.2 3.2" />
  </Icon>
)

/** The library: history, memory and skills, like books on a shelf. */
export const LibraryIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M3 2.5v11M6 2.5v11M9.2 3.2l2.8 10" />
  </Icon>
)

/** A skill: something taught once and repeated on request. */
export const SkillIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M9 1.8 3.8 9h4l-1 5.2L12.2 7h-4z" />
  </Icon>
)

export const HistoryIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M2.8 8a5.2 5.2 0 1 0 1.5-3.7" />
    <path d="M2.5 2.5v2.3h2.3" />
    <path d="M8 5.2V8l2 1.3" />
  </Icon>
)

export const ImportIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M8 2v7.5" />
    <path d="M5 6.8 8 9.8l3-3" />
    <path d="M2.8 11.5v1.2a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-1.2" />
  </Icon>
)

export const MemoryIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M4 2.5h6l2.5 2.5v8.5H4z" />
    <path d="M6 7h4.5M6 9.5h4.5M6 12h2.5" />
  </Icon>
)

/** A page Claude made: a sheet with a tag on it. */
export const PageIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M4 1.5h5.5L12.5 4.5v10H4z" />
    <path d="M9.5 1.5v3h3" />
    <path d="M7 8 5.8 9.5 7 11M9.5 8l1.2 1.5L9.5 11" />
  </Icon>
)

export const TabsIcon = (): React.JSX.Element => (
  <Icon>
    <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
    <path d="M2.5 6.5h11M5.5 3.5v3" />
  </Icon>
)

export const HomeIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M2.5 7.2 8 2.5l5.5 4.7" />
    <path d="M4 6v7.5h8V6" />
    <path d="M6.7 13.5V10h2.6v3.5" />
  </Icon>
)

export const MinimizeIcon = (): React.JSX.Element => (
  <Icon>
    <path d="M4 6.5 8 10.5l4-4" />
  </Icon>
)

export const KeyboardIcon = (): React.JSX.Element => (
  <Icon>
    <rect x="1.5" y="4" width="13" height="8.5" rx="1.5" />
    <path d="M4 6.75h.01M6.5 6.75h.01M9 6.75h.01M11.5 6.75h.01M4.5 10h7" />
  </Icon>
)
