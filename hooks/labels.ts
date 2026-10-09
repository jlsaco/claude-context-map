import type { MessageRow, MapSettings, ThemeName } from '../types'

export const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

// Two looks: Claude's own warm dark palette in exact colours, or the session's theme.
export type Tone =
  | 'tools' | 'system' | 'messages' | 'rules' | 'skills' | 'mcp' | 'agent' | 'memory' | 'reminder' | 'conversation'
  | 'accent' | 'warning'
export type Palette = Record<Tone, string> & { bg?: string; text?: string; muted?: string; faint?: string; border: string }

// `auto` is not a palette: it picks one of these from the session's theme.
export const THEMES: Record<Exclude<ThemeName, 'auto'>, Palette> = {
  claude: {
    bg: '#1F1E1D',
    text: '#ECE9E0',
    muted: '#9C9889',
    faint: '#4A4741',
    border: '#3E3C38',
    accent: '#D97757',
    warning: '#E8B04A',
    tools: '#6A9BCC',
    system: '#D97757',
    messages: '#C9A96E',
    rules: '#8DB38B',
    skills: '#B78DBB',
    mcp: '#5FAFA6',
    agent: '#E2A65A',
    memory: '#C98FA8',
    reminder: '#8E9DB4',
    conversation: '#77736A',
  },
  system: {
    border: 'subtle',
    accent: 'claude',
    warning: 'warning',
    tools: 'suggestion',
    system: 'claude',
    messages: 'remember',
    rules: 'success',
    skills: 'permission',
    mcp: 'planMode',
    agent: 'ide',
    memory: 'autoAccept',
    reminder: 'remember',
    conversation: 'subtle',
  },
}

export const KIND_TONE: Record<MessageRow['kind'], Tone> = {
  context: 'rules',
  instruction: 'rules',
  skill: 'skills',
  'skill-file': 'skills',
  mcp: 'mcp',
  agent: 'agent',
  memory: 'memory',
  attachment: 'reminder',
  conversation: 'conversation',
}

// Claude's spinner, for the newest turn while the map is fresh.
export const SPINNER = ['✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳']
export const GROW_MS = 700
export const PULSE_MS = 4000

// The filter's chips: each a kind of message row, coloured as its rows are.
export const FILTERS: readonly { id: string; label: string; tone: Tone; kinds: readonly MessageRow['kind'][] }[] = [
  { id: 'rules', label: 'CLAUDE.md/rules', tone: 'rules', kinds: ['context', 'instruction'] },
  { id: 'skills', label: 'Skills', tone: 'skills', kinds: ['skill', 'skill-file'] },
  { id: 'mcp', label: 'MCP', tone: 'mcp', kinds: ['mcp'] },
  { id: 'agents', label: 'Agentes', tone: 'agent', kinds: ['agent'] },
  { id: 'memory', label: 'Memoria', tone: 'memory', kinds: ['memory'] },
  { id: 'reminders', label: 'Recordatorios', tone: 'reminder', kinds: ['attachment'] },
  { id: 'conversation', label: 'Conversación', tone: 'conversation', kinds: ['conversation'] },
]

export const ANY_TOOL = 'all'

// Rows that start collapsed; a press records its own choice in `open`.
// The tools and the system prompt barely change: they start as one line.
export const CLOSED_BY_DEFAULT = new Set(['toolpick', 'zone:tools', 'zone:system', 'tools:builtin', 'tools:mcp', 'tools:deferred'])

export const DEFAULT_SETTINGS: MapSettings = {
  theme: 'auto',
  showFilters: true,
  showStrip: true,
  showGrowth: true,
  showNotes: 'wide',
  compactFixed: true,
  showRanking: true,
  animate: true,
  countWithApi: true,
}

// A stored value merged over the defaults: a key a later version adds is filled in.
export const withDefaults = (stored: unknown): MapSettings => {
  const given = stored && typeof stored === 'object' ? (stored as Partial<MapSettings>) : {}
  const out = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof MapSettings)[]) {
    if (typeof given[key] === typeof DEFAULT_SETTINGS[key]) Object.assign(out, { [key]: given[key] })
  }

  return out
}

export const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

export const SECTION_LABELS: Record<string, string> = {
  intro: 'Intro / identidad',
  system: 'Sistema y harness',
  doing_tasks: 'Cómo hacer tareas',
  actions: 'Acciones con cuidado',
  tools: 'Uso de herramientas',
  tone: 'Tono y estilo',
  lean_body: 'Cuerpo (prompt corto)',
  bare: 'Prompt mínimo (--bare)',
  memory: 'Memoria (MEMORY.md)',
  communication: 'Comunicación',
  pronouns: 'Pronombres',
  env_info: 'Entorno',
  env_info_simple: 'Entorno',
  mcp_instructions: 'Instrucciones de servidores MCP',
  output_style: 'Estilo de salida',
  language: 'Idioma',
  scratchpad: 'Scratchpad',
  summarize_tool_results: 'Resultados de herramientas',
  action_caution: 'Acciones con cuidado',
  session_guidance: 'Guía de la sesión',
  context_management: 'Gestión del contexto',
  act_dont_rederive: 'Actuar sin re-derivar',
  endconv_deferred_hint: 'Pista de EndConversation',
  total_tokens: 'Presupuesto de tokens',
}

export const ATTACHMENT_LABELS: Record<string, string> = {
  skill_listing: 'Listado de skills',
  deferred_tools_delta: 'Herramientas diferidas (nombres)',
  nested_memory: 'CLAUDE.md / rule anidada',
  instructions: 'Instrucciones',
  todo_reminder: 'Recordatorio de tareas',
  auto_mode: 'Modo auto',
  auto_mode_exit: 'Salida de modo auto',
  file: 'Archivo mencionado',
  edited_text_file: 'Archivo editado',
  queued_command: 'Comando en cola',
  plan_mode: 'Modo plan',
  plan_mode_exit: 'Salida de modo plan',
  plan_mode_reentry: 'Reentrada a modo plan',
  mcp_instructions_delta: 'Instrucciones MCP',
}

export const BLOCK_LABELS: Record<string, string> = {
  claudeMd: 'CLAUDE.md y rules',
  userEmail: 'Email del usuario',
  currentDate: 'Fecha',
  attachedProject: 'Proyecto adjunto',
}

export const KIND_LABELS: Record<string, string> = {
  managed: 'política',
  user: 'usuario',
  project: 'proyecto',
  local: 'local',
  memory: 'memoria',
}

// --- small helpers -----------------------------------------------------------

export const hash = (text: string) => {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0

  return (h >>> 0).toString(36)
}

export const firstLine = (text: string) =>
  text
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0) ?? ''

export const preview = (text: string, max = 80) => {
  const line = firstLine(text)

  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export const shortPath = (path: string) => {
  const parts = path.split('/').filter(Boolean)

  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path
}

export const prettify = (id: string) => {
  const words = id.replace(/[_-]+/g, ' ').trim()

  return words.charAt(0).toUpperCase() + words.slice(1)
}

export const tokens = (chars: number) => {
  const n = Math.round(chars / 4)

  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`
}

export const kTokens = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`)

export const share = (part: number, total: number) => {
  const value = total === 0 ? 0 : (part / total) * 100

  return `${value > 0 && value < 1 ? '<1' : Math.round(value)}%`.padStart(4)
}

export const pct = (part: number, total: number) =>
  `${total === 0 ? 0 : Math.round((part / total) * 100)}%`.padStart(4)

export const sizeOf = (block: { type: string; [field: string]: unknown }) => {
  if (block.type === 'text' && typeof block.text === 'string') return block.text.length
  // An image costs roughly 1.5k tokens whatever its base64 weighs.
  if (block.type === 'image') return 6000

  return JSON.stringify(block).length
}
