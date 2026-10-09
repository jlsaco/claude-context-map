import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type {
  AttachmentRec,
  ContextSnap,
  MessageRow,
  Scale,
  MapSettings,
  TurnInfo,
  SectionRec,
  Snapshot,
  SystemSnap,
  ToolRec,
} from '../types'

import { mcpName, classify, turnSummary, growthByTurn, turnsLeft, factor } from './classify'
import type { ApiMsg } from './classify'
import { DEFAULT_SETTINGS, withDefaults, SPARK, EIGHTHS, THEMES, KIND_TONE, SPINNER, GROW_MS, PULSE_MS, FILTERS, ANY_TOOL, CLOSED_BY_DEFAULT, SECTION_LABELS, hash, firstLine, preview, prettify, tokens, kTokens, share, pct, sizeOf } from './labels'

const PANE = 'context-map'
const TITLE = 'Mapa de contexto'

const system = atom({ plugin: 'context-map', key: 'system' } as const, null)
const context = atom({ plugin: 'context-map', key: 'context' } as const, null)
const attachments = atom({ plugin: 'context-map', key: 'attachments' } as const, [])
const described = atom({ plugin: 'context-map', key: 'described' } as const, [])
const snapshot = atom({ plugin: 'context-map', key: 'snapshot' } as const, null)
const openState = atom({ plugin: 'context-map', key: 'open' } as const, {})
const scale = atom({ plugin: 'context-map', key: 'scale' } as const, 'relative')
const settings = atom({ plugin: 'context-map', key: 'settings' } as const, DEFAULT_SETTINGS)
const tabAtom = atom({ plugin: 'context-map', key: 'tab' } as const, 'map')
const filterKinds = atom({ plugin: 'context-map', key: 'filterKinds' } as const, [])
const filterTool = atom({ plugin: 'context-map', key: 'filterTool' } as const, '')

// --- refreshing the snapshot -------------------------------------------------

const refresh = async ($: EngineInterface) => {
  // With the pane up, count every zone with the token-count API as /context does;
  // without it, the engine's local estimate is enough for the status line.
  const prefs = await read($, settings)
  const isShown = (await $.ui.panes().catch(() => [])).some(pane => pane.id === PANE)
  const [composed, listed, msgs, used, config] = await Promise.all([
    $.prompt.compose().catch(() => null),
    $.tool.list().catch(() => []),
    $.session.messages({ as: 'api' }).catch(() => []),
    $.session.usage({ breakdown: isShown && prefs.countWithApi ? 'full' : 'summary' }).catch(() => null),
    $.config.list().catch(() => []),
  ])

  if (composed) {
    const sections: SectionRec[] = composed.sections.map(s => ({
      id: s.id,
      scope: s.scope,
      chars: s.text.length,
      preview: preview(s.text, 60),
    }))
    const model = await $.session.model().catch(() => '')
    const next: SystemSnap = { model, sections }
    await update($, system, () => next)
  }

  const known = await read($, described)
  const tools = listed.map(tool => {
    const seen = known.find(one => one.name === tool.name)

    return {
      name: tool.name,
      mcp: tool.mcp,
      // Without a `tool.describe` answer, assume the engine's rule: MCP tools wait.
      chars: seen?.chars ?? tool.name.length + tool.description.length,
      isDeferred: seen ? seen.isDeferred : tool.mcp,
      isGuess: !seen,
    }
  })

  const { rows, turns } = classify(
    Array.isArray(msgs) ? (msgs as ApiMsg[]) : [],
    await read($, attachments),
    await read($, context),
  )
  // What each subagent holds in its own window: it never reaches this one.
  const own = new Map<string, number>()
  for (const id of new Set(rows.flatMap(row => (row.agentId && row.ownChars === undefined ? [row.agentId] : [])))) {
    const theirs = await $.session.messages({ agentId: id, as: 'api' }).catch(() => null)
    if (Array.isArray(theirs)) own.set(id, (theirs as ApiMsg[]).reduce((n, msg) => n + msg.content.reduce((m, b) => m + sizeOf(b), 0), 0))
  }
  for (const row of rows) {
    // The notice's own count when it came; else what its transcript measures.
    const chars = row.ownChars ?? (row.agentId ? own.get(row.agentId) : undefined)
    if (row.kind === 'agent' && chars !== undefined && row.note?.startsWith('encargo')) {
      row.ownChars = chars
      row.note = `${row.note ?? ''} · su contexto ~${tokens(chars)} (no ocupa tu ventana)`
    }
  }

  // The breakdown's rows by zone: tool schemas, the system prompt, and all the rest.
  const breakdown = used?.context.breakdown
  const categories = Array.isArray(breakdown?.categories) ? breakdown.categories : []
  const inUse = categories.filter(one => one.kind === 'used')
  const real = breakdown && inUse.length > 0
    ? {
        tools: inUse.filter(one => /tool/i.test(one.name)).reduce((n, one) => n + one.tokens, 0),
        system: inUse.filter(one => /system prompt/i.test(one.name)).reduce((n, one) => n + one.tokens, 0),
        total: breakdown.totalTokens,
        isCounted: isShown && prefs.countWithApi,
      }
    : undefined
  const usage = used
    ? {
        tokens: used.context.tokens,
        window: used.context.window,
        percent: used.context.percent,
        threshold: breakdown?.autoCompactThreshold,
        real,
      }
    : undefined
  const themeRow = config.find(row => row.key === 'theme')
  const isLight = typeof themeRow?.value === 'string' && /light/i.test(themeRow.value)
  const next: Snapshot = { at: await $.clock.now(), tools, messages: rows, turns, usage, isLight }
  await update($, snapshot, () => next)
  if (prefs.animate) animate($)
}


// Redraws the pane while its bars grow in and the newest turn's mark spins.
const animate = ($: EngineInterface) => {
  for (let ms = 40; ms <= GROW_MS + 40; ms += 40) $.clock.after(ms, () => $.ui.invalidate('ui.render'))
  for (let ms = GROW_MS + 120; ms <= PULSE_MS + 120; ms += 120) $.clock.after(ms, () => $.ui.invalidate('ui.render'))
}

// Cached answers the engine gave before this module loaded are asked again
// on the next request, so the hooks below see every one of them.
const reask = ($: EngineInterface) => {
  $.ui.invalidate('prompt.context')
  $.ui.invalidate('prompt.attachment')
  $.ui.invalidate('tool.describe')
}

// `tool.describe` and `prompt.attachment` fire in bursts: batch their writes.
let pendingTools: ToolRec[] = []
let pendingAtts: AttachmentRec[] = []
let isFlushing = false

const flushPending = ($: EngineInterface) => {
  isFlushing = false
  const tools = pendingTools
  const atts = pendingAtts
  pendingTools = []
  pendingAtts = []
  if (tools.length > 0) {
    void update($, described, list => {
      const byName = new Map(list.map(one => [one.name, one]))
      for (const tool of tools) byName.set(tool.name, tool)

      return [...byName.values()]
    })
  }
  if (atts.length > 0) {
    void update($, attachments, list => {
      const keys = new Set(list.map(one => one.key))
      const added = atts.filter(one => !keys.has(one.key) && (keys.add(one.key), true))

      return added.length === 0 ? list : [...list, ...added].slice(-300)
    })
  }
}

const schedule = ($: EngineInterface) => {
  if (isFlushing) return
  isFlushing = true
  $.clock.after(300, () => flushPending($))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.ui.status(undefined)
    const stored = await $.store.get('settings').catch(() => undefined)
    if (stored !== undefined) await update($, settings, () => withDefaults(stored))
    await $.command.register({
      name: 'context-map',
      description: 'Muestra en qué orden y posición están cargados CLAUDE.md, rules, skills, memoria y demás',
    })
    reask($)
    void refresh($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'context-map' }, async $ => {
    reask($)
    await refresh($).catch(() => undefined)
    const opened = await $.ui.open({ id: PANE, title: TITLE })

    return {
      text: opened.isPlaced
        ? 'Mapa de contexto abierto. Se completa con el próximo request (los adjuntos y CLAUDE.md se releen entonces).'
        : 'Mapa de contexto abierto; ensancha la terminal para verlo.',
    }
  })

  on('prompt.context', async ($, e, next) => {
    const answer = await next(e)
    const files = answer.instructionFiles ?? e.instructionFiles ?? []
    const snap: ContextSnap = {
      blocks: answer.blocks.map(block => ({ name: block.name, chars: block.text.length })),
      files: files.map(file => ({
        path: file.path,
        kind: file.kind,
        chars: file.content.length,
        parent: file.parent,
      })),
    }
    void update($, context, () => snap)

    return answer
  })

  on('prompt.attachment', async ($, e, next) => {
    const answer = await next(e)
    if (e.agentId === undefined && answer.text) {
      const origin =
        e.origin.kind === 'engine' ? 'engine' : `${e.origin.kind}:${e.origin.event}`
      pendingAtts.push({
        key: `${e.type}:${hash(answer.text)}`,
        type: e.type,
        origin,
        chars: answer.text.length,
        probe: firstLine(answer.text).slice(0, 60),
      })
      schedule($)
    }

    return answer
  })

  on('tool.describe', async ($, e, next) => {
    const answer = await next(e)
    pendingTools.push({
      name: e.tool,
      chars: e.tool.length + answer.description.length,
      isDeferred: answer.isDeferred ?? e.isDeferred === true,
    })
    schedule($)

    return answer
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) void refresh($).catch(() => undefined)

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const snap = await read($, snapshot)
    const sys = await read($, system)
    const mode = await read($, scale)
    const prefs = await read($, settings)
    const tab = await read($, tabAtom)
    const themeName = prefs.theme
    // A hidden filter bar applies no filter; what it held waits for its return.
    const kindsOn = prefs.showFilters ? await read($, filterKinds) : []
    const toolOn = prefs.showFilters ? await read($, filterTool) : ''
    const chosen = await read($, openState)
    const now = await $.clock.now().catch(() => 0)

    // Auto: Claude's dark palette on a dark theme; on a light one, the theme's own colours.
    const look = themeName === 'auto' ? (snap?.isLight ? 'system' : 'claude') : themeName
    const P = THEMES[look] ?? THEMES.claude
    const dim = P.muted ? { color: P.muted } : { dimColor: true as const }
    const ink = P.text ? { color: P.text } : {}
    const faint = P.faint ? { color: P.faint } : { dimColor: true as const }
    const tone = (kind: MessageRow['kind']) => P[KIND_TONE[kind]]

    // What came before the first prompt and the newest turn start open, the rest
    // closed; a press is kept as chosen.
    const lastTurn = snap?.turns.at(-1)?.index ?? 0
    const byDefault = (id: string) =>
      id.startsWith('fturn:')
        ? true
        : id.startsWith('turn:')
        ? id === 'turn:0' || id === `turn:${lastTurn}`
        : id === 'zone:tools' || id === 'zone:system'
          ? !prefs.compactFixed
          : !CLOSED_BY_DEFAULT.has(id)
    const isOpen = (id: string) => chosen[id] ?? byDefault(id)
    const flip = (id: string) => () => update($, openState, all => ({ ...all, [id]: !(all[id] ?? byDefault(id)) }))
    const setTurns = (to: boolean, prefix = 'turn') => () =>
      update($, openState, all => {
        const next: Record<string, boolean> = { ...all }
        for (const one of snap?.turns ?? []) next[`${prefix}:${one.index}`] = to

        return next
      })

    // A pill: filled in its colour when on, quiet when off.
    const pill = (key: string, isOn: boolean, label: string, color: string, onPress: () => unknown) => (
      <Button key={key} plain onPress={onPress}>
        {isOn ? (
          <Text backgroundColor={color} color={P.bg ?? 'inverseText'} bold>
            {` ${label} `}
          </Text>
        ) : (
          <Text {...dim}>{` ${label} `}</Text>
        )}
      </Button>
    )

    const card = (key: string, children: RenderChildren[]) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor={P.border} paddingX={1}>
        {children}
      </Box>
    )

    // The frame both tabs draw in: Claude's dark ground when that palette is on.
    const frame = (children: RenderChildren[]) => (
      <Box flexDirection="column" {...(P.bg ? { backgroundColor: P.bg, minHeight: e.props.scroll.bodyRows } : {})}>
        {children}
      </Box>
    )
    const tabs = (
      <Box key="tabs" flexDirection="row" columnGap={1}>
        {pill('tab:map', tab === 'map', 'Mapa', P.accent, () => update($, tabAtom, () => 'map'))}
        {pill('tab:settings', tab === 'settings', 'Ajustes', P.accent, () => update($, tabAtom, () => 'settings'))}
      </Box>
    )

    // --- the Ajustes tab: what the map shows, kept across sessions -------------
    if (tab === 'settings') {
      const save = (patch: Partial<MapSettings>) => async () => {
        const next = { ...prefs, ...patch }
        await update($, settings, () => next)
        // A store that fails costs the next session the choice, never this one.
        await $.store.set('settings', next).catch(() => undefined)
      }
      type Choice = { id: string; label: string; isOn: boolean; patch: Partial<MapSettings> }
      const setting = (key: string, title: string, help: string, choices: Choice[]) => (
        <Box key={`set:${key}`} flexDirection="column" marginTop={1}>
          <Box flexDirection="row">
            <Box flexGrow={1} flexShrink={1}>
              <Text {...ink} bold wrap="truncate-end">
                {title}
              </Text>
            </Box>
            <Box flexDirection="row" columnGap={1} flexShrink={0}>
              {choices.map(one => pill(`set:${key}:${one.id}`, one.isOn, one.label, P.accent, save(one.patch)))}
            </Box>
          </Box>
          <Text {...dim} wrap="truncate-end">
            {help}
          </Text>
        </Box>
      )
      type Flag = { [K in keyof MapSettings]: MapSettings[K] extends boolean ? K : never }[keyof MapSettings]
      const yesNo = (key: Flag, title: string, help: string) =>
        setting(key, title, help, [
          { id: 'on', label: 'Sí', isOn: prefs[key], patch: { [key]: true } },
          { id: 'off', label: 'No', isOn: !prefs[key], patch: { [key]: false } },
        ])
      const group = (key: string, title: string, children: RenderChildren[]) =>
        card(`card:set:${key}`, [
          <Text key={`h:${key}`} bold color={P.accent}>
            {title}
          </Text>,
          ...children,
        ])

      return frame([
        tabs,
        group('look', 'Apariencia', [
          setting('theme', 'Tema', 'Auto sigue el tema de la sesión: oscuro, la paleta Claude; claro, sus propios colores.', [
            { id: 'auto', label: 'Auto', isOn: prefs.theme === 'auto', patch: { theme: 'auto' } },
            { id: 'claude', label: 'Claude', isOn: prefs.theme === 'claude', patch: { theme: 'claude' } },
            { id: 'system', label: 'Sistema', isOn: prefs.theme === 'system', patch: { theme: 'system' } },
          ]),
          yesNo('animate', 'Animaciones', 'Las barras crecen al actualizarse y el turno más reciente gira un momento.'),
        ]),
        group('map', 'Mapa', [
          yesNo('showStrip', 'Resumen de zonas', 'La franja de arriba, su leyenda y la línea de totales.'),
          yesNo('showGrowth', 'Crecimiento por turno', 'Cuánto añadió cada turno y cuánto falta para el autocompactado.'),
          yesNo('showFilters', 'Filtros', 'Los chips por tipo y el selector de tool. Ocultos, no se aplica ningún filtro.'),
          setting('showNotes', 'Detalle de las filas', 'Argumentos, rutas y vistas previas junto a cada fila.', [
            { id: 'wide', label: 'Si cabe', isOn: prefs.showNotes === 'wide', patch: { showNotes: 'wide' } },
            { id: 'always', label: 'Siempre', isOn: prefs.showNotes === 'always', patch: { showNotes: 'always' } },
            { id: 'never', label: 'Nunca', isOn: prefs.showNotes === 'never', patch: { showNotes: 'never' } },
          ]),
          yesNo('compactFixed', 'Herramientas y System prompt compactos', 'Empiezan cerrados, en una sola línea.'),
          yesNo('showRanking', 'Ranking MCP', 'Las herramientas MCP ordenadas por los tokens que devuelven.'),
        ]),
        group('data', 'Datos', [
          yesNo('countWithApi', 'Contar con la API', 'Con el panel abierto, cada zona se cuenta como en /context. Si no, se usa la estimación local del motor.'),
        ]),
        <Box key="set:footer" flexDirection="row" columnGap={1} paddingLeft={1}>
          {pill('set:reset', false, '↺ restablecer', P.accent, save(DEFAULT_SETTINGS))}
          <Text {...dim}>Los ajustes se guardan entre sesiones.</Text>
        </Box>,
      ])
    }

    // A snapshot an earlier version stored has no turns: wait for the next refresh.
    if (!snap || !Array.isArray(snap.turns)) {
      return frame([tabs, <Text key="loading" {...dim}>Leyendo el contexto… (o usa /context-map)</Text>])
    }

    // Bars grow into place after each refresh; the newest turn's mark spins a while.
    const age = Math.max(0, now - snap.at)
    const grow = prefs.animate ? 1 - Math.pow(1 - Math.min(1, age / GROW_MS), 3) : 1
    const spin = prefs.animate && age < PULSE_MS ? (SPINNER[Math.floor(age / 120) % SPINNER.length] ?? '✻') : '✻'

    const columns = Math.max(30, e.props.bodyColumns)
    // Inside a card: its border and padding take four columns.
    const inner = Math.max(26, columns - 4)
    const showNote = prefs.showNotes === 'always' || (prefs.showNotes === 'wide' && inner >= 100)
    const barWidth = inner >= 70 ? 12 : 8

    const sum = (list: readonly { chars: number }[]) => list.reduce((n, one) => n + one.chars, 0)
    const most = (list: readonly { chars: number }[]) => list.reduce((n, one) => Math.max(n, one.chars), 0)

    // Each zone at the engine's own count when it gave one, its rows scaled to
    // match: the estimate (chars/4) only says how a zone splits between rows.
    const real = snap.usage?.real
    const rawTools = snap.tools.filter(tool => !tool.isDeferred)
    const rawSections = sys?.sections ?? []
    const restTokens = real ? real.total - real.tools - real.system : 0
    const byTools = factor(real?.tools || undefined, sum(rawTools))
    const bySystem = factor(real?.system || undefined, sum(rawSections))
    const byMessages = factor(restTokens > 0 ? restTokens : undefined, sum(snap.messages))
    const isReal = real !== undefined && (byTools !== 1 || bySystem !== 1 || byMessages !== 1)
    const loaded = rawTools.map(tool => ({ ...tool, chars: tool.chars * byTools }))
    const sections = rawSections.map(section => ({ ...section, chars: section.chars * bySystem }))
    const messages = snap.messages.map(row => ({
      ...row,
      chars: row.chars * byMessages,
      children: row.children?.map(child => ({ ...child, chars: child.chars * byMessages })),
    }))
    const builtin = loaded.filter(tool => !tool.mcp)
    const mcp = loaded.filter(tool => tool.mcp)
    const deferred = snap.tools.filter(tool => tool.isDeferred)

    const zones = [
      { id: 'tools', title: 'Herramientas', color: P.tools, chars: sum(loaded) },
      { id: 'system', title: 'System prompt', color: P.system, chars: sum(sections) },
      { id: 'messages', title: 'Mensajes', color: P.messages, chars: sum(messages) },
    ] as const
    const total = zones.reduce((n, zone) => n + zone.chars, 0)

    // Absolute: everything over the window (in chars, as rows are); relative: over the total.
    const windowChars = (snap.usage?.window ?? 0) * 4
    const isAbsolute = mode === 'absolute' && windowChars > 0
    const base = isAbsolute ? windowChars : total

    // A bar in eighths of a cell over a faint track, so a small share still shows.
    const bar = (chars: number, max: number, color: string, width: number) => {
      const eighths = max === 0 ? 0 : Math.round((Math.min(chars, max) / max) * width * 8 * grow)
      const shown = chars > 0 && grow > 0 ? Math.max(1, eighths) : 0
      const full = Math.floor(shown / 8)
      const part = shown % 8 === 0 ? '' : (EIGHTHS[shown % 8] ?? '')
      const used = full + (part ? 1 : 0)

      return (
        <Text>
          <Text color={color}>{'█'.repeat(full) + part}</Text>
          <Text {...faint}>{'·'.repeat(Math.max(0, width - used))}</Text>
        </Text>
      )
    }

    type Line = {
      key: string
      start?: number
      chars: number
      max: number
      color: string
      depth: number
      label: string
      note?: string
      toggle?: string
      mark?: string
    }

    // Fixed columns: position, indent + chevron, label (truncates), bar, share, tokens.
    const line = ({ key, start, chars, max, color, depth, label, note, toggle, mark }: Line) => (
      <Box key={key} flexDirection="row">
        <Box width={5} flexShrink={0}>
          <Text {...dim}>{start === undefined ? '' : pct(start, base)}</Text>
        </Box>
        <Box width={depth * 2 + 2} flexShrink={0} justifyContent="flex-end">
          {toggle ? (
            <Button key={`t:${key}`} plain onPress={flip(toggle)}>
              <Text color={color}>{isOpen(toggle) ? '▾' : '▸'}</Text>
            </Button>
          ) : (
            <Text color={color}>•</Text>
          )}
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={4} paddingLeft={1} flexDirection="row">
          {mark ? <Text color={P.accent}>{mark} </Text> : ''}
          <Text {...ink} wrap="truncate-end">
            {label}
            {note ? <Text {...dim}>{`  ${note}`}</Text> : ''}
          </Text>
        </Box>
        <Box width={barWidth + 1} flexShrink={0} paddingLeft={1}>
          {bar(chars, isAbsolute ? windowChars : max, color, barWidth)}
        </Box>
        <Box width={6} flexShrink={0} justifyContent="flex-end">
          <Text {...dim}>{share(chars, base)}</Text>
        </Box>
        <Box width={7} flexShrink={0} justifyContent="flex-end">
          <Text {...ink}>{tokens(chars)}</Text>
        </Box>
      </Box>
    )

    const out: RenderChildren[] = []

    // --- the header card: title, switches, the strip and its legend ---------
    const head: RenderChildren[] = []
    const when = new Date(snap.at)
    const clock = [when.getHours(), when.getMinutes(), when.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
    head.push(
      <Box key="title" flexDirection="row">
        <Box flexGrow={1}>
          <Text color={P.accent} bold>
            {spin} Mapa de contexto
          </Text>
        </Box>
        <Text {...dim}>act. {clock}</Text>
      </Box>,
    )
    const pick = (to: Scale) => () => update($, scale, () => to)
    head.push(
      <Box key="switches" flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Text {...dim}>Escala</Text>
        {pill('scale:relative', mode === 'relative', 'Relativa', P.accent, pick('relative'))}
        {pill('scale:absolute', mode === 'absolute', 'Absoluta', P.accent, pick('absolute'))}
      </Box>,
    )

    const used = snap.usage?.tokens
    const windowTokens = snap.usage?.window
    const threshold = snap.usage?.threshold
    // The strip: each zone's cells, then (absolute) the free window and the compaction mark.
    if (prefs.showStrip) {
    const strip = Math.max(10, inner)
    const cells: { color?: string; ch: string }[] = []
    let seen = 0
    for (const zone of zones) {
      const from = Math.round((seen / base) * strip * grow)
      seen += zone.chars
      const to = Math.min(strip, Math.round((seen / base) * strip * grow))
      for (let i = from; i < to; i++) cells[i] = { color: zone.color, ch: '▀' }
    }
    for (let i = 0; i < strip; i++) cells[i] ??= { ch: '·' }
    if (isAbsolute && threshold) {
      const at = Math.min(strip - 1, Math.round(((threshold * 4) / base) * strip))
      cells[at] = { color: P.warning, ch: '┃' }
    }
    const runs: { color?: string; text: string }[] = []
    for (const cell of cells) {
      const last = runs.at(-1)
      if (last && last.color === cell.color) last.text += cell.ch
      else runs.push({ color: cell.color, text: cell.ch })
    }
    head.push(
      <Box key="strip" marginTop={1}>
        <Text>
          {runs.map((one, i) =>
            one.color ? (
              <Text key={`r:${i}`} color={one.color}>
                {one.text}
              </Text>
            ) : (
              <Text key={`r:${i}`} {...faint}>
                {one.text}
              </Text>
            ),
          )}
        </Text>
      </Box>,
    )
    head.push(
      <Box key="legend" flexDirection="row" flexWrap="wrap" columnGap={2}>
        {zones.map(zone => (
          <Text key={`l:${zone.id}`}>
            <Text color={zone.color}>●</Text>
            <Text {...ink}> {zone.title} </Text>
            <Text {...dim}>
              {tokens(zone.chars)} · {share(zone.chars, base).trim()}
            </Text>
          </Text>
        ))}
        {isAbsolute ? (
          <Text key="l:free">
            <Text {...faint}>·</Text>
            <Text {...dim}> libre</Text>
            {threshold ? <Text color={P.warning}> ┃ autocompactado</Text> : ''}
          </Text>
        ) : (
          ''
        )}
      </Box>,
    )

    const counted = isReal ? (real?.isCounted ? 'contados con la API (desglose de /context)' : 'estimados por el motor') : 'estimados (caracteres/4)'
    head.push(
      <Text key="explain" {...dim} wrap="truncate-end">
        {isAbsolute
          ? `Real (API): ${used ? `${kTokens(used)} / ` : ''}${kTokens(windowTokens ?? 0)}${used && windowTokens ? ` (${Math.round((used / windowTokens) * 100)}%)` : ''} · ${tokens(total)} ${counted} · barras y % sobre la ventana`
          : `${tokens(total)} tokens ${counted} · barras: relativas a su grupo · %: del total`}
      </Text>,
    )
    }

    // What each turn added, newest last, and the room left before compaction.
    const growth = growthByTurn(messages, snap.turns)
    const shownTurns = growth.slice(-Math.max(8, inner - 40))
    const peak = most(shownTurns)
    const lastGrowth = growth.at(-1)
    const pace = growth.slice(-3)
    if (prefs.showGrowth && shownTurns.length > 1 && lastGrowth) {
      head.push(
        <Text key="growth" wrap="truncate-end">
          <Text {...dim}>Por turno </Text>
          <Text color={P.messages}>
            {shownTurns.map(one => SPARK[peak === 0 ? 0 : Math.round((one.chars / peak) * (SPARK.length - 1))] ?? '▁').join('')}
          </Text>
          <Text {...dim}>
            {'  '}último +{tokens(lastGrowth.chars)} · media +{tokens(sum(pace) / Math.max(1, pace.length))}
          </Text>
        </Text>,
      )
    }
    const threshold0 = snap.usage?.threshold
    if (prefs.showGrowth && used && windowTokens) {
      const limit = threshold0 ?? windowTokens
      const remaining = limit - used
      const left = turnsLeft(remaining, growth)
      head.push(
        <Text key="room" color={left !== undefined && left <= 2 ? P.warning : undefined} {...(left !== undefined && left <= 2 ? {} : dim)} wrap="truncate-end">
          {threshold0 ? 'Autocompactado' : 'Límite de la ventana'} en {kTokens(Math.max(0, remaining))}
          {left === undefined ? '' : ` (~${left} turno${left === 1 ? '' : 's'} al ritmo actual)`}
        </Text>,
      )
    }
    if (prefs.showStrip && !isReal && isAbsolute && used && used * 4 > total) {
      head.push(
        <Text key="unseen" {...dim} wrap="truncate-end">
          {`+${kTokens(used - Math.round(total / 4))} que el mapa no atribuye (esquemas JSON de herramientas, formato)`}
        </Text>,
      )
    }
    if (mode === 'absolute' && !isAbsolute) {
      head.push(
        <Text key="nowindow" color={P.warning} wrap="truncate-end">
          Aún no hay medida de la ventana: se toma tras el próximo turno.
        </Text>,
      )
    }
    out.push(card('card:head', head))

    // --- one card per zone ---------------------------------------------------
    let cursor = 0
    const zoneHead = (zone: (typeof zones)[number], index: number, start: number, isCompact = false) => {
      const open = isOpen(`zone:${zone.id}`)

      return (
        <Box key={`z:${zone.id}`} flexDirection="row" flexGrow={1} width="50%">
          <Button key={`t:z:${zone.id}`} plain onPress={flip(`zone:${zone.id}`)}>
            <Text color={zone.color}>{open ? '▾' : '▸'}</Text>
          </Button>
          <Box flexGrow={1} flexShrink={1} paddingLeft={1}>
            <Text bold color={zone.color} wrap="truncate-end">
              {index + 1} · {zone.title}
            </Text>
          </Box>
          {isCompact ? '' : <Text {...dim}>{pct(start, base).trim()}–{pct(start + zone.chars, base).trim()} · </Text>}
          <Text bold {...ink}>
            {tokens(zone.chars)}
          </Text>
        </Box>
      )
    }

    // Tools and system prompt both closed: one card, one line.
    const isCompact = !isOpen('zone:tools') && !isOpen('zone:system')
    if (isCompact) {
      const [tools0, system0] = zones
      out.push(
        card('card:fixed', [
          <Box key="fixed" flexDirection="row" columnGap={3}>
            {zoneHead(tools0, 0, 0, true)}
            {zoneHead(system0, 1, tools0.chars, true)}
          </Box>,
        ]),
      )
    }

    zones.forEach((zone, index) => {
      const body: RenderChildren[] = []
      const open = isOpen(`zone:${zone.id}`)
      if (isCompact && zone.id !== 'messages') {
        cursor += zone.chars

        return
      }
      body.push(zoneHead(zone, index, cursor))
      const finish = () => out.push(card(`card:${zone.id}`, body))
      if (!open) {
        cursor += zone.chars
        finish()

        return
      }

      if (zone.id === 'tools') {
        const groups = [
          { id: 'tools:builtin', label: `Integradas (${builtin.length})`, list: builtin },
          { id: 'tools:mcp', label: `MCP con esquema (${mcp.length})`, list: mcp },
        ]
        const max = most(groups.map(group => ({ chars: sum(group.list) })))
        for (const group of groups) {
          const chars = sum(group.list)
          body.push(line({ key: group.id, start: cursor, chars, max, color: zone.color, depth: 0, label: group.label, toggle: group.id }))
          if (isOpen(group.id)) {
            let at = cursor
            const most1 = most(group.list)
            for (const tool of group.list) {
              body.push(
                line({ key: `tool:${tool.name}`, start: at, chars: tool.chars, max: most1, color: zone.color, depth: 1, label: tool.name, note: tool.isGuess ? 'estimado' : undefined }),
              )
              at += tool.chars
            }
          }
          cursor += chars
        }
        body.push(
          <Text key="tools:note" {...dim} wrap="truncate-end">
            {'       '}+{deferred.length} diferidas (solo el nombre, en Mensajes) · sin esquemas JSON
          </Text>,
        )
        finish()

        return
      }

      if (zone.id === 'system') {
        if (sections.length === 0) body.push(<Text key="sys:none" {...dim}>{'       '}(aún sin componer)</Text>)
        const max = most(sections)
        sections.forEach((section, i) => {
          if (i > 0 && sections[i - 1]?.scope === 'shared' && section.scope === 'session') {
            body.push(
              <Text key="boundary" color={P.warning} wrap="truncate-end">
                {'       '}┄┄ límite de caché · arriba compartido, abajo de la sesión
              </Text>,
            )
          }
          const label = SECTION_LABELS[section.id] ?? prettify(section.id)
          body.push(
            line({ key: `sec:${section.id}`, start: cursor, chars: section.chars, max, color: zone.color, depth: 0, label, note: showNote ? section.preview : undefined }),
          )
          cursor += section.chars
        })
        finish()

        return
      }

      // The filter: chips by kind (none on: every kind), then one tool or agent type.
      const shown = new Set(FILTERS.filter(one => kindsOn.includes(one.id)).flatMap(one => one.kinds))
      const isFiltering = shown.size > 0 || toolOn !== ''
      const matches = (row: MessageRow) =>
        (shown.size === 0 || shown.has(row.kind)) && (toolOn === '' || row.tool === toolOn)
      const chip = (id: string) => () =>
        update($, filterKinds, list => (list.includes(id) ? list.filter(one => one !== id) : [...list, id]))
      if (prefs.showFilters) body.push(
        <Box key="chips" flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={2} marginTop={1}>
          <Text {...dim}>Filtro</Text>
          {FILTERS.map(one => pill(`chip:${one.id}`, kindsOn.includes(one.id), one.label, P[one.tone], chip(one.id)))}
        </Box>,
      )

      const tools = [...new Set(messages.flatMap(row => (row.tool ? [row.tool] : [])))]
      if (toolOn !== '' && !tools.includes(toolOn)) tools.push(toolOn)
      const toolLabel = (name: string) => {
        if (name.startsWith('agent:')) return `Agente · ${name.slice('agent:'.length)}`
        if (name === 'ToolSearch') return 'ToolSearch'
        const { server, tool } = mcpName(name)

        return `${server} · ${tool}`
      }
      const toolOptions = [{ value: ANY_TOOL, label: 'todas' }, ...tools.map(name => ({ value: name, label: toolLabel(name) }))]
      // The tool picker: a pill that opens the list and closes it again, or on a pick.
      const isPicking = isOpen('toolpick')
      const choose = (value: string) => async () => {
        await update($, filterTool, () => (value === ANY_TOOL ? '' : value))
        await update($, openState, all => ({ ...all, toolpick: false }))
      }
      if (prefs.showFilters) body.push(
        <Box key="toolpick" flexDirection="row" columnGap={1} paddingLeft={2}>
          <Text {...dim}>Tool</Text>
          {pill('filter:tool', toolOn !== '', `${toolOn === '' ? 'todas' : toolLabel(toolOn)} ${isPicking ? '▴' : '▾'}`, P.mcp, flip('toolpick'))}
          {isFiltering
            ? pill('filter:clear', false, '✕ limpiar filtros', P.accent, async () => {
                await update($, filterKinds, () => [])
                await update($, filterTool, () => '')
              })
            : ''}
        </Box>,
      )
      if (prefs.showFilters && isPicking) body.push(
        <Box key="toolpick:list" flexDirection="row" flexWrap="wrap" columnGap={1} paddingLeft={7}>
          {toolOptions.map(one =>
            pill(`tool:${one.value}`, (toolOn === '' ? ANY_TOOL : toolOn) === one.value, one.label, P.mcp, choose(one.value)),
          )}
        </Box>,
      )

      // Every row's real place in the request, whatever the filter hides.
      const startOf = new Map<string, number>()
      let at = cursor
      for (const row of messages) {
        startOf.set(row.id, at)
        at += row.chars
      }
      cursor = at

      const groups = snap.turns
        .map(info => ({ info, rows: messages.filter(row => row.turn === info.index && matches(row)) }))
        .filter(group => group.rows.length > 0)

      if (isFiltering) {
        const picked = groups.flatMap(group => group.rows)
        const chars = sum(picked)
        body.push(
          <Text key="filter:total" wrap="truncate-end">
            {'  '}
            <Text bold color={P.accent}>
              {picked.length} fila{picked.length === 1 ? '' : 's'} · {tokens(chars)} tokens
            </Text>
            <Text {...dim}>
              {' '}· {share(chars, base).trim()} {isAbsolute ? 'de la ventana' : 'del contexto'} · en {groups.length} turno
              {groups.length === 1 ? '' : 's'}
            </Text>
          </Text>,
        )
        if (picked.length === 0) body.push(<Text key="filter:none" {...dim}>{'  '}Nada coincide con el filtro.</Text>)
      }
      // A filtered view opens and closes its turns apart from the full one.
      const turnKey = isFiltering ? 'fturn' : 'turn'
      body.push(
        <Box key="turns:all" flexDirection="row" columnGap={1} paddingLeft={2}>
          <Text {...dim}>Turnos</Text>
          {pill('turns:open', false, '▾ abrir todos', P.accent, setTurns(true, turnKey))}
          {pill('turns:close', false, '▸ cerrar todos', P.accent, setTurns(false, turnKey))}
        </Box>,
      )
      body.push(<Text key="turns:gap"> </Text>)

      const maxTurn = most(groups.map(group => ({ chars: sum(group.rows) })))
      for (const { info, rows } of groups) {
        const id = `${turnKey}:${info.index}`
        const chars = sum(rows)
        const first = rows[0]
        const label = info.index === 0 ? info.label : `Turno ${info.index} · ${info.label}`
        // A filtered turn starts open on what matched, and closes like any other.
        const open = isOpen(id)
        body.push(
          line({
            key: id,
            start: first ? startOf.get(first.id) : undefined,
            chars,
            max: maxTurn,
            color: zone.color,
            depth: 0,
            label,
            note: turnSummary(rows),
            toggle: id,
            mark: info.index === lastTurn && info.index > 0 ? spin : undefined,
          }),
        )
        if (!open) continue
        const max = most(rows)
        for (const row of rows) {
          const color = tone(row.kind)
          const hasKids = (row.children?.length ?? 0) > 0
          const rowStart = startOf.get(row.id) ?? 0
          body.push(
            line({ key: row.id, start: rowStart, chars: row.chars, max, color, depth: 1, label: row.label, note: showNote ? row.note : undefined, toggle: hasKids ? row.id : undefined }),
          )
          if (hasKids && isOpen(row.id)) {
            let kidAt = rowStart
            const kids = row.children ?? []
            const most2 = most(kids)
            for (const child of kids) {
              body.push(line({ key: child.id, start: kidAt, chars: child.chars, max: most2, color, depth: 2, label: child.label, note: showNote ? child.note : undefined }))
              kidAt += child.chars
            }
          }
        }
      }
      finish()

      // The ranking is about MCP: shown unfiltered, or while MCP rows are.
      if (!prefs.showRanking) return
      if (isFiltering && !(shown.has('mcp') || (toolOn !== '' && !toolOn.startsWith('agent:')))) return

      // Every MCP tool by what its results weigh, heaviest first: not a position.
      const byTool = new Map<string, { chars: number; calls: number }>()
      for (const row of messages) {
        if (row.kind !== 'mcp' || !row.tool) continue
        const seenTool = byTool.get(row.tool) ?? { chars: 0, calls: 0 }
        byTool.set(row.tool, { chars: seenTool.chars + row.chars, calls: seenTool.calls + 1 })
      }
      if (byTool.size > 0) {
        const rank: RenderChildren[] = []
        const ranked = [...byTool.entries()].sort((a, b) => b[1].chars - a[1].chars)
        const allMcp = ranked.reduce((n, [, one]) => n + one.chars, 0)
        rank.push(
          line({ key: 'mcp:rank', chars: allMcp, max: allMcp, color: P.mcp, depth: 0, label: `Ranking MCP · ${ranked.length} herramientas`, note: 'por tokens devueltos', toggle: 'mcp:rank' }),
        )
        if (isOpen('mcp:rank')) {
          const max = ranked[0]?.[1].chars ?? 0
          for (const [name, one] of ranked) {
            const { server, tool } = mcpName(name)
            const label = name === 'ToolSearch' ? 'ToolSearch · esquemas' : `${server} · ${tool}`
            rank.push(line({ key: `mcp:rank:${name}`, chars: one.chars, max, color: P.mcp, depth: 1, label, note: `×${one.calls}` }))
          }
        }
        out.push(card('card:rank', rank))
      }
    })

    return frame([tabs, ...out])
  })
}
