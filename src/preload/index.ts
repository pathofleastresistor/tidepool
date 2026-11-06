import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ConversationEvent,
  ElectronApi,
  FindResult,
  PageSuggestions,
  Project,
  ServerStatus,
  Skill,
  SkillProposal,
  SpeechEvent,
  WebApp,
  WebMcpSource,
  WebViewState
} from '@shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: ElectronApi = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch) => ipcRenderer.invoke('settings:update', patch),
    setApiKey: (key) => ipcRenderer.invoke('settings:setApiKey', key),
    setJevKey: (key) => ipcRenderer.invoke('settings:setJevKey', key)
  },
  mcp: {
    getStatus: () => ipcRenderer.invoke('mcp:getStatus'),
    reload: () => ipcRenderer.invoke('mcp:reload'),
    readConfig: () => ipcRenderer.invoke('mcp:readConfig'),
    writeConfig: (json) => ipcRenderer.invoke('mcp:writeConfig', json),
    openConfigFile: () => ipcRenderer.invoke('mcp:openConfigFile'),
    callTool: (server, name, args) => ipcRenderer.invoke('mcp:callTool', server, name, args),
    readUiResource: (server, uri) => ipcRenderer.invoke('mcp:readUiResource', server, uri),
    readResource: (server, uri) => ipcRenderer.invoke('mcp:readResource', server, uri),
    listResources: (server) => ipcRenderer.invoke('mcp:listResources', server),
    signIn: (server) => ipcRenderer.invoke('mcp:signIn', server),
    cancelSignIn: (server) => ipcRenderer.invoke('mcp:cancelSignIn', server),
    signOut: (server) => ipcRenderer.invoke('mcp:signOut', server),
    setClientSecret: (server, secret) => ipcRenderer.invoke('mcp:setClientSecret', server, secret),
    onStatus: (cb) => subscribe<ServerStatus[]>('mcp:status', cb)
  },
  chat: {
    list: (projectId) => ipcRenderer.invoke('chat:list', projectId),
    create: (projectId) => ipcRenderer.invoke('chat:create', projectId),
    open: (id) => ipcRenderer.invoke('chat:open', id),
    send: (id, text, fromApp) => ipcRenderer.invoke('chat:send', id, text, fromApp),
    stop: (id) => ipcRenderer.invoke('chat:stop', id),
    remove: (id) => ipcRenderer.invoke('chat:remove', id),
    setAppContext: (id, ctx, appId) => ipcRenderer.invoke('chat:setAppContext', id, ctx, appId),
    answerApproval: (callId, answer) => ipcRenderer.invoke('chat:answerApproval', callId, answer),
    onEvent: (cb) => subscribe<ConversationEvent>('chat:event', cb),
    onListChanged: (cb) => subscribe<string>('chat:listChanged', cb)
  },
  speech: {
    available: () => ipcRenderer.invoke('speech:available'),
    start: () => ipcRenderer.invoke('speech:start'),
    stop: () => ipcRenderer.invoke('speech:stop'),
    cancel: () => ipcRenderer.invoke('speech:cancel'),
    openPrivacySettings: (pane) => ipcRenderer.invoke('speech:openPrivacySettings', pane),
    onEvent: (cb) => subscribe<SpeechEvent>('speech:event', cb)
  },
  web: {
    list: () => ipcRenderer.invoke('web:list'),
    add: (input) => ipcRenderer.invoke('web:add', input),
    update: (id, input) => ipcRenderer.invoke('web:update', id, input),
    remove: (id) => ipcRenderer.invoke('web:remove', id),
    reorder: (ids) => ipcRenderer.invoke('web:reorder', ids),
    close: (id) => ipcRenderer.invoke('web:close', id),
    show: (id, bounds) => ipcRenderer.invoke('web:show', id, bounds),
    setBounds: (bounds) => ipcRenderer.invoke('web:setBounds', bounds),
    hide: () => ipcRenderer.invoke('web:hide'),
    back: (id) => ipcRenderer.invoke('web:back', id),
    forward: (id) => ipcRenderer.invoke('web:forward', id),
    reload: (id) => ipcRenderer.invoke('web:reload', id),
    openInBrowser: (id) => ipcRenderer.invoke('web:openInBrowser', id),
    clearData: (what) => ipcRenderer.invoke('web:clearData', what),
    listSites: () => ipcRenderer.invoke('web:listSites'),
    clearSite: (site) => ipcRenderer.invoke('web:clearSite', site),
    onState: (cb) => subscribe<WebViewState>('web:state', cb),
    onAppsChanged: (cb) => subscribe<WebApp[]>('web:apps', cb),
    onClosed: (cb) => subscribe<string>('web:closed', cb),
    onReveal: (cb) => subscribe<string>('web:reveal', cb)
  },
  platform: process.platform,
  overlay: {
    setBounds: (name, bounds) => ipcRenderer.invoke('overlay:setBounds', name, bounds),
    focus: (name) => ipcRenderer.invoke('overlay:focus', name)
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (name) => ipcRenderer.invoke('projects:create', name),
    rename: (id, name) => ipcRenderer.invoke('projects:rename', id, name),
    remove: (id) => ipcRenderer.invoke('projects:remove', id),
    reorder: (ids) => ipcRenderer.invoke('projects:reorder', ids),
    newTab: (id, url) => ipcRenderer.invoke('projects:newTab', id, url),
    closeTab: (id, tabId) => ipcRenderer.invoke('projects:closeTab', id, tabId),
    activateTab: (id, tabId) => ipcRenderer.invoke('projects:activateTab', id, tabId),
    setHomeShown: (id) => ipcRenderer.invoke('projects:setHomeShown', id),
    reorderTabs: (id, tabIds) => ipcRenderer.invoke('projects:reorderTabs', id, tabIds),
    pinTab: (id, tabId) => ipcRenderer.invoke('projects:pinTab', id, tabId),
    moveTab: (tabId, toId, beforeTabId) => ipcRenderer.invoke('projects:moveTab', tabId, toId, beforeTabId),
    tabMenu: (id, tabId) => ipcRenderer.invoke('projects:tabMenu', id, tabId),
    insights: (id, tabId) => ipcRenderer.invoke('projects:insights', id, tabId),
    searchHere: (id, tabId, term) => ipcRenderer.invoke('projects:searchHere', id, tabId, term),
    navigate: (id, input) => ipcRenderer.invoke('projects:navigate', id, input),
    back: (id) => ipcRenderer.invoke('projects:back', id),
    forward: (id) => ipcRenderer.invoke('projects:forward', id),
    reload: (id) => ipcRenderer.invoke('projects:reload', id),
    stop: (id) => ipcRenderer.invoke('projects:stop', id),
    openInBrowser: (id) => ipcRenderer.invoke('projects:openInBrowser', id),
    show: (id, bounds) => ipcRenderer.invoke('projects:show', id, bounds),
    setBounds: (bounds) => ipcRenderer.invoke('projects:setBounds', bounds),
    hide: () => ipcRenderer.invoke('projects:hide'),
    onChanged: (cb) => subscribe<Project[]>('projects:changed', cb),
    onReveal: (cb) => subscribe<string>('projects:reveal', cb),
    onHome: (cb) => subscribe<[string, boolean]>('projects:home', ([id, home]) => cb(id, home))
  },
  webmcp: {
    getSources: () => ipcRenderer.invoke('webmcp:getSources'),
    onSources: (cb) => subscribe<WebMcpSource[]>('webmcp:sources', cb),
    setCurrentSite: (siteId) => ipcRenderer.invoke('webmcp:setCurrentSite', siteId),
    setAutoApprove: (siteId, on) => ipcRenderer.invoke('webmcp:setAutoApprove', siteId, on),
    getSuggestions: () => ipcRenderer.invoke('webmcp:getSuggestions'),
    onSuggestions: (cb) => subscribe<PageSuggestions>('webmcp:suggestions', cb)
  },
  history: {
    search: (opts) => ipcRenderer.invoke('history:search', opts),
    complete: (typed, projectId) => ipcRenderer.invoke('history:complete', typed, projectId),
    remove: (id) => ipcRenderer.invoke('history:remove', id),
    clear: () => ipcRenderer.invoke('history:clear')
  },
  browserImport: {
    detect: () => ipcRenderer.invoke('browserImport:detect'),
    run: (browserId, profile, kinds) => ipcRenderer.invoke('browserImport:run', browserId, profile, kinds)
  },
  addresses: {
    list: () => ipcRenderer.invoke('addresses:list'),
    remove: (id) => ipcRenderer.invoke('addresses:remove', id),
    clear: () => ipcRenderer.invoke('addresses:clear')
  },
  cards: {
    list: () => ipcRenderer.invoke('cards:list'),
    remove: (id) => ipcRenderer.invoke('cards:remove', id),
    clear: () => ipcRenderer.invoke('cards:clear')
  },
  passwords: {
    list: () => ipcRenderer.invoke('passwords:list'),
    remove: (id) => ipcRenderer.invoke('passwords:remove', id),
    clear: () => ipcRenderer.invoke('passwords:clear')
  },
  memory: {
    list: (projectId) => ipcRenderer.invoke('memory:list', projectId),
    write: (projectId, path, content) => ipcRenderer.invoke('memory:write', projectId, path, content),
    remove: (projectId, path) => ipcRenderer.invoke('memory:remove', projectId, path),
    append: (projectId, path, line) => ipcRenderer.invoke('memory:append', projectId, path, line),
    suggestions: () => ipcRenderer.invoke('memory:suggestions'),
    suggest: (projectId) => ipcRenderer.invoke('memory:suggest', projectId),
    accept: (id, text) => ipcRenderer.invoke('memory:accept', id, text),
    dismiss: (id) => ipcRenderer.invoke('memory:dismiss', id),
    onSuggestionsChanged: (cb) => subscribe<null>('memory:suggestionsChanged', () => cb())
  },
  pages: {
    list: (projectId) => ipcRenderer.invoke('pages:list', projectId),
    open: (projectId, name) => ipcRenderer.invoke('pages:open', projectId, name),
    remove: (projectId, name) => ipcRenderer.invoke('pages:remove', projectId, name),
    onChanged: (cb) => subscribe<string>('pages:changed', cb)
  },
  ideas: {
    list: (projectId) => ipcRenderer.invoke('ideas:list', projectId),
    open: (id) => ipcRenderer.invoke('ideas:open', id),
    dismiss: (id) => ipcRenderer.invoke('ideas:dismiss', id),
    onChanged: (cb) => subscribe<string>('ideas:changed', cb)
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    save: (draft, id) => ipcRenderer.invoke('skills:save', draft, id),
    remove: (id) => ipcRenderer.invoke('skills:remove', id),
    onChanged: (cb) => subscribe<Skill[]>('skills:changed', cb),
    onProposal: (cb) => subscribe<SkillProposal>('skills:proposal', cb),
    onProposalClosed: (cb) => subscribe<string>('skills:proposalClosed', cb),
    answerProposal: (requestId, draft) => ipcRenderer.invoke('skills:answerProposal', requestId, draft)
  },
  commands: {
    setContext: (ctx) => ipcRenderer.invoke('commands:setContext', ctx),
    run: (id) => ipcRenderer.invoke('commands:run', id),
    onCommand: (cb) => subscribe<{ id: string; byKey: boolean }>('commands:run', ({ id, byKey }) => cb(id, byKey))
  },
  find: {
    start: (target, text, opts) => ipcRenderer.invoke('find:start', target, text, opts),
    stop: (target) => ipcRenderer.invoke('find:stop', target),
    onResult: (cb) => subscribe<FindResult>('find:result', cb)
  },
  focusApp: () => ipcRenderer.invoke('app:focus'),
  copyText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  openLink: (url) => ipcRenderer.invoke('openLink', url),
  openExternal: (url) => ipcRenderer.invoke('openExternal', url)
}

contextBridge.exposeInMainWorld('api', api)
