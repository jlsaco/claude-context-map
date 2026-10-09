/** One section of the system prompt, as `$.prompt.compose()` answered it. */
export type SectionRec = {
  id: string
  scope: 'shared' | 'session'
  chars: number
  preview: string
}

/** The system prompt composed for the session's own model and tools. */
export type SystemSnap = { model: string; sections: SectionRec[] }

/** One instruction file behind the `claudeMd` block (CLAUDE.md, rules, memory). */
export type FileRec = { path: string; kind: string; chars: number; parent?: string }

/** The context blocks the first user message carries. */
export type ContextSnap = {
  blocks: { name: string; chars: number }[]
  files: FileRec[]
}

/** One message the engine injected on its own (reminder, listing, nested memory...). */
export type AttachmentRec = {
  key: string
  type: string
  origin: string
  chars: number
  probe: string
}

/** What the engine said about one tool when it rendered its schema. */
export type ToolRec = { name: string; chars: number; isDeferred: boolean }

/** One row of the messages zone, in the order the next request carries it. */
export type MessageRow = {
  id: string
  label: string
  kind: 'context' | 'instruction' | 'skill' | 'skill-file' | 'mcp' | 'agent' | 'memory' | 'attachment' | 'conversation'
  /** For an `mcp` row the tool as the model called it; for an `agent` row `agent:<type>`. */
  tool?: string
  /** For an `agent` row: the subagent's id, and what its own window holds. */
  agentId?: string
  ownChars?: number
  chars: number
  note?: string
  /** The turn it belongs to: 0 before the first prompt, then one per prompt. */
  turn: number
  children?: { id: string; label: string; chars: number; note?: string }[]
}

/** One turn: what the person sent to open it (0: what came before any). */
export type TurnInfo = { index: number; label: string }

/** The snapshot the pane draws from, taken at the last refresh. */
export type Snapshot = {
  at: number
  tools: { name: string; chars: number; mcp: boolean; isDeferred: boolean; isGuess: boolean }[]
  messages: MessageRow[]
  turns: TurnInfo[]
  usage?: Usage
  /** Whether the session's theme is a light one, read from /config. */
  isLight?: boolean
}

/** The window as the API last measured it: real tokens, not estimates. */
export type Usage = {
  tokens?: number
  window: number
  percent?: number
  threshold?: number
  /** Tokens by zone from the engine's own breakdown (as /context counts them), when it gave one. */
  real?: { tools: number; system: number; total: number; isCounted: boolean }
}

/** How bars and percentages scale: within each group, or against the window. */
export type Scale = 'relative' | 'absolute'

/** The pane's look: Claude's warm dark palette, or the session's own theme. */
export type ThemeName = 'auto' | 'claude' | 'system'

/** What the Ajustes tab configures; kept in `$.store` across sessions. */
export type MapSettings = {
  theme: ThemeName
  /** The filter bar; hidden, no filter applies. */
  showFilters: boolean
  /** The strip, its legend and the line of totals. */
  showStrip: boolean
  /** Growth per turn and the room left before compaction. */
  showGrowth: boolean
  /** A row's note (arguments, paths, previews): on wide panes, always, or never. */
  showNotes: 'wide' | 'always' | 'never'
  /** Tools and system prompt start closed, on one line. */
  compactFixed: boolean
  showRanking: boolean
  animate: boolean
  /** With the pane up, count each zone with the token-count API. */
  countWithApi: boolean
}

/** Which tab the pane shows. */
export type MapTab = 'map' | 'settings'

declare module 'claude-code' {
  interface PluginState {
    'context-map': {
      system: SystemSnap | null
      context: ContextSnap | null
      attachments: AttachmentRec[]
      described: ToolRec[]
      snapshot: Snapshot | null
      open: Record<string, boolean>
      scale: Scale
      settings: MapSettings
      tab: MapTab
      /** The kinds of message rows shown (empty: all), and one tool or agent type ('': any). */
      filterKinds: string[]
      filterTool: string
    }
  }
}
