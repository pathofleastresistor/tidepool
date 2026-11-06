import { createContext, useContext } from 'react'

/**
 * Window-level state shared between the layout and every MCP App frame. Only one app can be
 * fullscreen at a time.
 */
export interface AppHostState {
  /** callId of the app currently in fullscreen, if any. */
  fullscreenCallId: string | null
  setDisplayMode: (callId: string, mode: 'inline' | 'fullscreen') => void
  /** The conversation on screen, which its apps' model context goes to. */
  conversationId: string | null
}

export const AppHostContext = createContext<AppHostState>({
  fullscreenCallId: null,
  setDisplayMode: () => {},
  conversationId: null
})

export const useAppHost = (): AppHostState => useContext(AppHostContext)
