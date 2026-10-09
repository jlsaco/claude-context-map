import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const CLAUDE_MD = [
  'Contents of /repo/CLAUDE.md (project instructions, checked into the codebase):',
  'Usa pnpm.',
  'Contents of /repo/.claude/rules/tests.md (project instructions, checked into the codebase):',
  'Escribe tests.',
].join('\n')

const SKILL_DIR = '/home/ana/.claude/skills/diseno'

const MESSAGES = [
  { role: 'user', content: [{ type: 'text', text: '¿Puedes cargar la skill de diseño?' }] },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu1', name: 'Skill', input: { skill: 'diseno' } }],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tu1', content: 'Launching skill: diseno' },
      { type: 'text', text: `Base directory for this skill: ${SKILL_DIR}\n\n# Diseño\nUsa Geist.` },
    ],
  },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: `${SKILL_DIR}/reference.md` } }],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'Paleta: zinc.' }] },
]

const PANE = {
  plugin: 'context-map',
  component: 'Pane',
  requestId: 'context-map',
  props: {
    title: 'Mapa de contexto',
    isFocused: false,
    bodyColumns: 110,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
  } as never,
} as const

// What sits beneath the plugin: the engine's answers for the calls it makes.
const engine = (
  on: On,
  messages: readonly unknown[] = MESSAGES,
  theme = 'dark',
  breakdown: object = { autoCompactThreshold: 167_000 },
  stored: Readonly<Record<string, unknown>> = {},
) => {
  mock.store(on, stored)
  on('prompt.context', (_, e) => ({ blocks: e.blocks, instructionFiles: e.instructionFiles }))
  on('prompt.compose', () => ({
    sections: [
      { id: 'intro', text: 'You are Claude Code.', scope: 'shared' },
      { id: 'memory', text: '# Memory\nrecuerdos', scope: 'session' },
    ],
  }))
  on('session.messages', () => ({ value: messages }) as never)
  on('session.usage', () =>
    ({
      value: {
        startedAt: 0,
        rateLimits: [],
        context: { tokens: 50_000, window: 200_000, percent: 25, breakdown },
      },
    }) as never,
  )
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('config.list', () => ({ value: [{ key: 'theme', value: theme }] }) as never)
  on('tool.list', () => ({ value: [{ name: 'Bash', description: 'Runs a shell command.', mcp: false }] }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', (_, e) => e as never)
  mock.clock(on)
}

const loadContext = ($: Engine) =>
  $.prompt.context({
    blocks: [
      { name: 'claudeMd', text: CLAUDE_MD },
      { name: 'currentDate', text: '2026-10-09' },
    ],
    instructionFiles: [
      { path: '/repo/CLAUDE.md', kind: 'project', content: 'Usa pnpm.' },
      { path: '/repo/.claude/rules/tests.md', kind: 'project', content: 'Escribe tests.' },
    ],
  })

test('lists CLAUDE.md, rules, skills and skill files as rows of their own', async ($, on) => {
  engine(on)
  await loadContext($)
  await $.command.run({ command: 'context-map', args: '' } as never)

  // Tools and system prompt start as one closed line; opening one is kept.
  const first = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await first.find({ type: 'Text', text: /Memoria \(MEMORY\.md\)/ })).toBeUndefined()
  await first.press({ key: 't:z:system' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = surface === 'terminal' ? first : await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /System prompt/ })).toBeDefined()
    expect(await ui.find({ text: /Memoria \(MEMORY\.md\)/ })).toBeDefined()
    expect(await ui.find({ text: /límite de caché/ })).toBeDefined()
    expect(await ui.find({ text: /Contexto inicial/ })).toBeDefined()

    const files = await ui.findAll({ type: 'Text', text: /^(CLAUDE\.md|Rule) \(/ })
    expect(files.map(file => file.text)).toEqual([
      'CLAUDE.md (proyecto): /repo/CLAUDE.md',
      'Rule (proyecto): …/.claude/rules/tests.md',
    ])
    expect(await ui.find({ type: 'Text', text: /^Turno 1 · ¿Puedes cargar la skill de diseño\?/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Skill: diseno/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Archivo de skill: diseno\/reference\.md/ })).toBeDefined()
  }
})

test('the scale switch measures against the context window', async ($, on) => {
  engine(on)
  await loadContext($)
  await $.command.run({ command: 'context-map', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ text: /relativas a su grupo/ })).toBeDefined()

  await ui.press({ key: 'scale:absolute' })
  expect(await ui.find({ text: /Real \(API\): 50\.0k \/ 200\.0k \(25%\)/ })).toBeDefined()
  expect(await ui.find({ text: /autocompactado/ })).toBeDefined()
})

test('groups messages by turn, the newest open and the earlier ones closed', async ($, on) => {
  engine(on, [...MESSAGES, { role: 'user', content: [{ type: 'text', text: 'Gracias, ahora agrúpalo' }] }])
  await loadContext($)
  await $.command.run({ command: 'context-map', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Antes de tu primer mensaje/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Turno 2 · Gracias, ahora agrúpalo/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Skill: diseno/ })).toBeUndefined()

  await ui.press({ key: 't:turn:1' })
  expect(await ui.find({ type: 'Text', text: /^Skill: diseno/ })).toBeDefined()

  await ui.press({ key: 'turns:close' })
  expect(await ui.find({ type: 'Text', text: /^Conversación/ })).toBeUndefined()
})

test('shows each MCP call in order and ranks the tools by what they return', async ($, on) => {
  const call = (id: string, name: string, input: unknown) => ({
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
  })
  const result = (id: string, content: string) => ({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content }],
  })
  engine(on, [
    { role: 'user', content: [{ type: 'text', text: 'Lista los proyectos de Linear' }] },
    call('s1', 'ToolSearch', { query: 'select:mcp__claude_ai_Linear__list_projects' }),
    result('s1', 'schemas'),
    call('l1', 'mcp__claude_ai_Linear__list_projects', {}),
    result('l1', 'x'.repeat(400)),
    call('l2', 'mcp__claude_ai_Linear__get_project', { query: 'P-COPE-6' }),
    result('l2', 'y'.repeat(4000)),
  ])
  await loadContext($)
  await $.command.run({ command: 'context-map', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const calls = await ui.findAll({ type: 'Text', text: /^MCP #\d/ })
  expect(calls.map(one => one.text.split('  ')[0])).toEqual([
    'MCP #1 · ToolSearch · carga de esquemas',
    'MCP #2 · Linear · list_projects',
    'MCP #3 · Linear · get_project',
  ])

  expect(await ui.find({ type: 'Text', text: /^Ranking MCP · 3 herramientas/ })).toBeDefined()
  const ranked = await ui.findAll({ type: 'Text', text: /^(Linear|ToolSearch) · [a-z_]+  ×/ })
  expect(ranked.map(one => one.text)).toEqual([
    'Linear · get_project  ×1',
    'Linear · list_projects  ×1',
    'ToolSearch · esquemas  ×1',
  ])
})

test('a subagent shows its brief, its report where it arrived, and its own window', async ($, on) => {
  engine(on, [
    { role: 'user', content: [{ type: 'text', text: 'Lanza un subagente que investigue mods' }] },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'ag1',
          name: 'Agent',
          input: { description: 'Investigar mods', subagent_type: 'claude-code-guide', prompt: 'p'.repeat(1600) },
        },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'ag1', content: 'Async agent launched successfully.\nagentId: a23aa29' }],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Lanzado en background.' }] },
    {
      role: 'user',
      content: [
        { type: 'text', text: `<system-reminder>\n<agent-message from="a23aa29">\n${'r'.repeat(8000)}\n</agent-message>\n</system-reminder>` },
        {
          type: 'text',
          text: '<task-notification>\n<task-id>a23aa29</task-id>\n<tool-use-id>ag1</tool-use-id>\n<summary>Agent "Investigar mods" finished</summary>\n<usage><subagent_tokens>170368</subagent_tokens></usage>\n</task-notification>',
        },
      ],
    },
  ])
  await loadContext($)
  await $.command.run({ command: 'context-map', args: '' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'turns:open' })
  const rows = await ui.findAll({ type: 'Text', text: /^Agente #1/ })
  const texts = rows.map(one => one.text)
  expect(texts[0]).toMatch(/^Agente #1 · claude-code-guide · Investigar mods  encargo · en background · su contexto ~170\.4k/)
  expect(texts.some(text => text.startsWith('Agente #1 · informe'))).toBe(true)
  expect(texts.some(text => text.startsWith('Agente #1 · aviso de fin'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^Turno 2 · Aviso de subagente · Agent "Investigar mods" finished/ })).toBeDefined()
})

const MIXED = [
  { role: 'user', content: [{ type: 'text', text: 'Primero busca en Linear' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'l1', name: 'mcp__claude_ai_Linear__list_issues', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'l1', content: 'i'.repeat(4000) }] },
  { role: 'user', content: [{ type: 'text', text: 'Ahora lanza un agente' }] },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'Buscar', subagent_type: 'Explore' } }],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'informe' }] },
  { role: 'user', content: [{ type: 'text', text: 'Y lee GitBook' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'g1', name: 'mcp__gitbook-mcp__get_page_content', input: {} }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'g1', content: 'g'.repeat(800) }] },
]

test('filters message rows by kind and by one tool, keeping their real place', async ($, on) => {
  engine(on, MIXED)
  await loadContext($)
  await $.command.run({ command: 'context-map', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const labels = async () => (await ui.findAll({ type: 'Text', text: /^(MCP|Agente) #\d/ })).map(one => one.text.split('  ')[0])

  await ui.press({ key: 'chip:mcp' })
  expect(await labels()).toEqual(['MCP #1 · Linear · list_issues', 'MCP #2 · gitbook-mcp · get_page_content'])
  expect(await ui.find({ type: 'Text', text: /^2 filas · 1\.2k tokens/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Turno 2 · / })).toBeUndefined()

  await ui.press({ key: 'chip:agents' })
  expect(await labels()).toHaveLength(3)

  await ui.press({ key: 'filter:tool' })
  await ui.press({ key: 'tool:agent:Explore' })
  expect(await labels()).toEqual(['Agente #1 · Explore · Buscar'])
  // The pick closes the list; the pill opens and closes it again.
  expect(await ui.find({ key: 'tool:all' })).toBeUndefined()
  await ui.press({ key: 'filter:tool' })
  expect(await ui.find({ key: 'tool:all' })).toBeDefined()
  await ui.press({ key: 'filter:tool' })
  expect(await ui.find({ key: 'tool:all' })).toBeUndefined()

  // A filtered turn closes too, and opens again.
  await ui.press({ key: 't:fturn:2' })
  expect(await labels()).toEqual([])
  await ui.press({ key: 'turns:open' })
  expect(await labels()).toEqual(['Agente #1 · Explore · Buscar'])

  await ui.press({ key: 'filter:clear' })
  expect(await ui.find({ type: 'Text', text: /filas · / })).toBeUndefined()
  expect(await ui.find({ key: 'turns:open' })).toBeDefined()
})

test('draws in Claude dark by default and switches to the session theme', async ($, on) => {
  engine(on)
  await loadContext($)
  await $.command.run({ command: 'context-map', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  const root = async () => (await ui.drawn()) as unknown as { props: { backgroundColor?: string } }
  expect((await root()).props.backgroundColor).toBe('#1F1E1D')
  expect(await ui.find({ type: 'Text', text: /Mapa de contexto/ })).toBeDefined()

  await ui.press({ key: 'tab:settings' })
  await ui.press({ key: 'set:theme:system' })
  expect((await root()).props.backgroundColor).toBeUndefined()
})

const memoryDir = '/Users/ana/.claude/projects/-repo/memory'

test('memory: what is saved, edited, read and recalled gets its own rows and chip', async ($, on) => {
  engine(on, [
    { role: 'user', content: [{ type: 'text', text: 'Recuerda que uso pnpm' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: `${memoryDir}/pnpm.md`, content: 'x'.repeat(400) } }],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'File created' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'w2', name: 'Edit', input: { file_path: `${memoryDir}/MEMORY.md`, old_string: 'a', new_string: 'b' } }],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w2', content: 'ok' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'w3', name: 'Edit', input: { file_path: '/repo/CLAUDE.md', old_string: 'a', new_string: 'b' } }],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w3', content: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: `<system-reminder>\nRecalled: ${memoryDir}/pnpm.md\nUsa pnpm.\n</system-reminder>` }] },
  ])
  await loadContext($)
  await $.command.run({ command: 'context-map', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'chip:memory' })
  const rows = await ui.findAll({ type: 'Text', text: /^(Memoria|Editado|Recuerdo)/ })
  expect(rows.map(one => one.text.split('  ')[0])).toEqual([
    'Memoria guardada: pnpm.md',
    'Memoria editada: MEMORY.md',
    'Editado: CLAUDE.md (instrucciones): /repo/CLAUDE.md',
    'Recuerdo cargado: pnpm.md',
  ])
})

test('the header shows growth per turn and the room before compaction', async ($, on) => {
  const turn = (n: number, size: number) => [
    { role: 'user', content: [{ type: 'text', text: `Pregunta ${n}` }] },
    { role: 'assistant', content: [{ type: 'text', text: 'r'.repeat(size) }] },
  ]
  engine(on, [...turn(1, 4000), ...turn(2, 40_000), ...turn(3, 8000)])
  await loadContext($)
  await $.command.run({ command: 'context-map', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /^Por turno [▁-█]{3}/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Autocompactado en 117\.0k \(~\d+ turnos al ritmo actual\)/ })).toBeDefined()
})

test('zones take the engine\'s own counts, rows keep their proportions', async ($, on) => {
  engine(on, MESSAGES, 'dark', {
    autoCompactThreshold: 167_000,
    totalTokens: 30_000,
    categories: [
      { name: 'System prompt', tokens: 3000, kind: 'used' },
      { name: 'System tools', tokens: 12_000, kind: 'used' },
      { name: 'MCP tools', tokens: 900, kind: 'deferred' },
      { name: 'Messages', tokens: 15_000, kind: 'used' },
      { name: 'Free space', tokens: 170_000, kind: 'free' },
    ],
  })
  await loadContext($)
  await $.command.run({ command: 'context-map', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /^30\.0k tokens estimados por el motor/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /System prompt 3\.0k/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Herramientas 12\.0k/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /que el mapa no atribuye/ })).toBeUndefined()
})

test('auto theme follows a light session theme with its own colours', async ($, on) => {
  engine(on, MESSAGES, 'light')
  await loadContext($)
  await $.command.run({ command: 'context-map', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  const root = async () => (await ui.drawn()) as unknown as { props: { backgroundColor?: string } }
  expect((await root()).props.backgroundColor).toBeUndefined()
  await ui.press({ key: 'tab:settings' })
  await ui.press({ key: 'set:theme:claude' })
  expect((await root()).props.backgroundColor).toBe('#1F1E1D')
})

test('Ajustes: hides the filters and the summaries', async ($, on) => {
  engine(on, MIXED)
  await loadContext($)
  await $.command.run({ command: 'context-map', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ key: 'chip:mcp' })).toBeDefined()
  expect(await ui.find({ key: 'tab:map' })).toBeDefined()
  await ui.press({ key: 'chip:mcp' })

  await ui.press({ key: 'tab:settings' })
  expect(await ui.find({ type: 'Text', text: /^Apariencia/ })).toBeDefined()
  expect(await ui.find({ key: 'chip:mcp' })).toBeUndefined()
  await ui.press({ key: 'set:showFilters:off' })
  await ui.press({ key: 'set:showStrip:off' })

  await ui.press({ key: 'tab:map' })
  expect(await ui.find({ key: 'chip:mcp' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /barras: relativas a su grupo/ })).toBeUndefined()
  // Hidden, the filter applies nothing: every turn is back.
  expect(await ui.find({ type: 'Text', text: /^Turno 2 · / })).toBeDefined()

  await ui.press({ key: 'tab:settings' })
  await ui.press({ key: 'set:reset' })
  await ui.press({ key: 'tab:map' })
  expect(await ui.find({ key: 'chip:mcp' })).toBeDefined()
})

test('settings stored by an earlier session load when the session starts', async ($, on) => {
  engine(on, MIXED, 'dark', { autoCompactThreshold: 167_000 }, { settings: { showFilters: false, theme: 'system' } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
  await loadContext($)
  await $.command.run({ command: 'context-map', args: '' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ key: 'chip:mcp' })).toBeUndefined()
  const root = (await ui.drawn()) as unknown as { props: { backgroundColor?: string } }
  expect(root.props.backgroundColor).toBeUndefined()
})
