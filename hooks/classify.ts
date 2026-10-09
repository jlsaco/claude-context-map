import type { AttachmentRec, ContextSnap, MessageRow, TurnInfo } from '../types'

import { ATTACHMENT_LABELS, BLOCK_LABELS, KIND_LABELS, preview, shortPath, tokens, sizeOf } from './labels'

export const isContextBlock = (text: string) =>
  /^# (claudeMd|userEmail|currentDate)\s*$/m.test(text) ||
  text.includes("As you answer the user's questions, you can use the following context")

export const guessReminder = (text: string) => {
  if (/skills are available|Skill tool/i.test(text)) return 'Listado de skills'
  if (/deferred tools/i.test(text)) return 'Herramientas diferidas (nombres)'
  if (/MCP Server Instructions/i.test(text)) return 'Instrucciones MCP'
  if (/Contents of .*(CLAUDE\.md|\.claude\/rules)/.test(text)) return 'CLAUDE.md / rule anidada'
  if (/auto mode/i.test(text)) return 'Modo auto'

  return 'Recordatorio del sistema'
}

// --- what the messages zone holds --------------------------------------------

export type ApiBlock = { type: string; [field: string]: unknown }
export type ApiMsg = { role: string; content: ApiBlock[] }

// What a loaded instruction file is, named so a rule reads apart from a CLAUDE.md.
export const fileLabel = (path: string, kind: string) => {
  const where = KIND_LABELS[kind] ?? kind
  if (/\/rules\//.test(path)) return `Rule (${where}): ${shortPath(path)}`
  if (/CLAUDE(\.local)?\.md$/.test(path)) return `CLAUDE.md (${where}): ${shortPath(path)}`
  if (kind === 'memory' || /MEMORY\.md$/.test(path)) return `Memoria: ${shortPath(path)}`

  return `Instrucciones (${where}): ${shortPath(path)}`
}

export const INSTRUCTION_FILE = /(CLAUDE(\.local)?\.md|AGENTS\.md|MEMORY\.md|\/\.claude\/rules\/.+\.md)$/
export const AGENT_TOOLS = new Set(['Agent', 'Task'])
export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])
// Claude's own memory: one file per fact under the project's memory folder.
export const MEMORY_PATH = /\/\.claude\/projects\/[^/]+\/memory\//
export const SKILL_BASE = /^Base directory for this skill: (.+)$/m

// `mcp__claude_ai_Linear__get_project` → Linear · get_project.
export const mcpName = (name: string) => {
  const [, raw = '', ...rest] = name.split('__')
  const server = raw.replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '')

  return { server, tool: rest.join('__') || name }
}

export const basename = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path

// The person's own words in a user message, or null when it holds none (tool
// results, reminders, a command's output): a slash command reads as its name.
export const promptOf = (msg: ApiMsg) => {
  if (msg.role !== 'user' || msg.content.some(block => block.type === 'tool_result')) return null
  for (const block of msg.content) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    const text = block.text.trim()
    if (text.length === 0 || text.includes('<system-reminder>') || isContextBlock(text)) continue
    if (SKILL_BASE.test(text) || /^<local-command-|^Caveat:/.test(text)) continue
    if (text.includes('<task-notification>') || text.includes('<agent-message from="')) {
      const summary = text.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]

      return `Aviso de subagente${summary ? ` · ${preview(summary, 60)}` : ''}`
    }
    const command = text.match(/<command-name>(.+?)<\/command-name>/)?.[1]
    const args = text.match(/<command-args>(.*?)<\/command-args>/s)?.[1]?.trim()

    return command ? `${command}${args ? ` ${args}` : ''}` : preview(text, 70)
  }

  return null
}

export const contextRow = (id: string, text: string | null, ctx: ContextSnap | null): Omit<MessageRow, 'turn'> => {
  const children: NonNullable<MessageRow['children']> = []

  if (ctx) {
    for (const block of ctx.blocks) {
      if (block.name === 'claudeMd' && ctx.files.length > 0) {
        for (const file of ctx.files) {
          children.push({
            id: `${id}:${file.path}`,
            label: fileLabel(file.path, file.kind),
            chars: file.chars,
            note: file.parent ? `importado por ${shortPath(file.parent)}` : undefined,
          })
        }
      } else {
        children.push({
          id: `${id}:${block.name}`,
          label: BLOCK_LABELS[block.name] ?? block.name,
          chars: block.chars,
        })
      }
    }
  } else if (text) {
    // No `prompt.context` seen yet: split the text on the engine's file headers.
    const heads = [...text.matchAll(/Contents of (.+?) \(([^)]*)\):/g)]
    heads.forEach((head, i) => {
      const end = i + 1 < heads.length ? (heads[i + 1]?.index ?? text.length) : text.length
      const path = head[1] ?? ''
      children.push({
        id: `${id}:${path || i}`,
        label: fileLabel(path, /user/i.test(head[2] ?? '') ? 'user' : 'project'),
        chars: end - (head.index ?? 0),
      })
    })
  }

  const listed = children.reduce((sum, child) => sum + child.chars, 0)

  return {
    id,
    kind: 'context',
    label: 'Contexto inicial',
    chars: Math.max(text?.length ?? 0, listed),
    note: text ? undefined : 'se antepone al primer mensaje',
    children,
  }
}

// A reminder that carries an instruction file names it: label it by that file.
export const reminderLabel = (text: string, fallback: string) => {
  const path = text.match(/Contents of (.+?) \(/)?.[1]

  return path ? fileLabel(path, 'anidado') : fallback
}

export const classify = (msgs: ApiMsg[], atts: AttachmentRec[], ctx: ContextSnap | null) => {
  const rows: MessageRow[] = []
  let run: { id: string; msgs: Set<number>; chars: number; tools: number } | null = null

  // Every tool call by its id, so a result is read against what was asked.
  const uses = new Map<string, { name: string; input: unknown }>()
  for (const msg of msgs) {
    for (const block of msg.content) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        uses.set(block.id, { name: String(block.name), input: block.input })
      }
    }
  }
  const skills: { dir: string; name: string }[] = []
  let mcpCalls = 0
  // Each Agent call: its row, so the result folds into it and a later notice finds it.
  const agents = new Map<string, MessageRow>()
  let agentCalls = 0
  // Each write to memory or to an instruction file: its row, so the result folds in.
  const writes = new Map<string, MessageRow>()
  const turns: TurnInfo[] = [{ index: 0, label: 'Antes de tu primer mensaje' }]
  let turn = 0

  const flush = () => {
    if (!run) return
    const n = run.msgs.size
    rows.push({
      id: run.id,
      kind: 'conversation',
      label: `Conversación · ${n} mensaje${n === 1 ? '' : 's'}${run.tools ? `, ${run.tools} llamadas` : ''}`,
      chars: run.chars,
      turn,
    })
    run = null
  }
  const push = (row: Omit<MessageRow, 'turn'>) => {
    flush()
    rows.push({ ...row, turn })
  }

  msgs.forEach((msg, mi) => {
    // A message the person sent opens a turn, with everything injected beside it.
    const prompt = promptOf(msg)
    if (prompt !== null) {
      flush()
      turn += 1
      turns.push({ index: turn, label: prompt })
    }

    msg.content.forEach((block, bi) => {
      const id = `m${mi}.${bi}`
      const text = block.type === 'text' && typeof block.text === 'string' ? block.text : null

      // A subagent's brief: the call itself, out of the conversation run.
      if (block.type === 'tool_use' && AGENT_TOOLS.has(String(block.name)) && typeof block.id === 'string') {
        agentCalls += 1
        const input = (block.input ?? {}) as { description?: unknown; subagent_type?: unknown }
        const kind = typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose'
        const what = typeof input.description === 'string' ? ` · ${input.description}` : ''
        push({ id, kind: 'agent', tool: `agent:${kind}`, label: `Agente #${agentCalls} · ${kind}${what}`, chars: sizeOf(block), note: 'encargo' })
        const row = rows.at(-1)
        if (row) agents.set(block.id, row)

        return
      }

      // Its result folds into that row: the report itself, or a background launch's receipt.
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && agents.has(block.tool_use_id)) {
        const row = agents.get(block.tool_use_id)
        if (row) {
          const size = sizeOf(block)
          const body = JSON.stringify(block.content ?? '')
          const agentId = body.match(/agentId: ([A-Za-z0-9_-]+)/)?.[1]
          const isBackground = /Async agent launched|running in the background/i.test(body)
          row.chars += size
          row.agentId = agentId ?? row.agentId
          row.note = isBackground ? 'encargo · en background' : `encargo + informe ${tokens(size)}`
        }

        return
      }

      // A background agent comes back twice: its report (`<agent-message from=…>`)
      // and a notice that it ended (`<task-notification>`, with what it spent).
      if (text !== null && (text.includes('<task-notification>') || text.includes('<agent-message from="'))) {
        const callId = text.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1]
        const agentId =
          text.match(/<agent-message from="([^"]+)"/)?.[1] ?? text.match(/<task-id>([^<]+)<\/task-id>/)?.[1]
        const owner =
          (callId ? agents.get(callId) : undefined) ??
          [...agents.values()].find(row => agentId !== undefined && row.agentId === agentId)
        const spent = text.match(/<subagent_tokens>(\d+)<\/subagent_tokens>/)?.[1]
        if (owner && spent) owner.ownChars = Number(spent) * 4
        const name = owner ? owner.label.replace(/^(Agente #\d+).*$/, '$1') : 'Subagente'
        const isReport = text.includes('<agent-message from="')
        push({
          id,
          kind: 'agent',
          label: `${name} · ${isReport ? 'informe' : 'aviso de fin'}`,
          chars: text.length,
          agentId: owner?.agentId ?? agentId,
          tool: owner?.tool,
          note: owner?.label.replace(/^Agente #\d+ · /, ''),
        })

        return
      }

      // Saving to memory, or editing a CLAUDE.md or a rule: the write itself.
      const target = (block.input as { file_path?: unknown } | undefined)?.file_path
      if (block.type === 'tool_use' && WRITE_TOOLS.has(String(block.name)) && typeof block.id === 'string' && typeof target === 'string' && (MEMORY_PATH.test(target) || INSTRUCTION_FILE.test(target))) {
        const isWrite = block.name === 'Write'
        const label =
          MEMORY_PATH.test(target) || /MEMORY\.md$/.test(target)
            ? `Memoria ${isWrite ? 'guardada' : 'editada'}: ${basename(target)}`
            : `${isWrite ? 'Escrito' : 'Editado'}: ${fileLabel(target, 'instrucciones')}`
        push({ id, kind: 'memory', label, chars: sizeOf(block), note: String(block.name) })
        const row = rows.at(-1)
        if (row) writes.set(block.id, row)

        return
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string' && writes.has(block.tool_use_id)) {
        const row = writes.get(block.tool_use_id)
        if (row) row.chars += sizeOf(block)

        return
      }

      if (text !== null && isContextBlock(text)) {
        push(contextRow(id, text, ctx))

        return
      }

      // A skill's body: the harness sends it as a user message naming its folder.
      const base = msg.role === 'user' && text !== null ? text.match(SKILL_BASE)?.[1]?.trim() : undefined
      if (base && text !== null) {
        const name = basename(base)
        skills.push({ dir: base, name })
        push({ id, kind: 'skill', label: `Skill: ${name}`, chars: text.length, note: shortPath(base) })

        return
      }

      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const use = uses.get(block.tool_use_id)
        const input = JSON.stringify(use?.input ?? '')
        const owner = skills.find(skill => input.includes(skill.dir))
        if (use && owner) {
          const path = (use.input as { file_path?: unknown } | undefined)?.file_path
          const file = typeof path === 'string' ? path.slice(owner.dir.length).replace(/^\/+/, '') : ''
          push({
            id,
            kind: 'skill-file',
            label: `Archivo de skill: ${owner.name}${file ? `/${file}` : ''}`,
            chars: sizeOf(block),
            note: file ? undefined : `vía ${use.name}`,
          })

          return
        }
        if (use && (use.name.startsWith('mcp__') || use.name === 'ToolSearch')) {
          mcpCalls += 1
          const isSearch = use.name === 'ToolSearch'
          const { server, tool } = mcpName(use.name)
          push({
            id,
            kind: 'mcp',
            tool: use.name,
            label: isSearch
              ? `MCP #${mcpCalls} · ToolSearch · carga de esquemas`
              : `MCP #${mcpCalls} · ${server} · ${tool}`,
            chars: sizeOf(block),
            note: `${block.is_error === true ? 'error · ' : ''}${preview(JSON.stringify(use.input ?? {}), 60)}`,
          })

          return
        }
        const read = (use?.input as { file_path?: unknown } | undefined)?.file_path
        if (use?.name === 'Read' && typeof read === 'string' && MEMORY_PATH.test(read)) {
          push({ id, kind: 'memory', label: `Recuerdo leído: ${basename(read)}`, chars: sizeOf(block) })

          return
        }
        if (use?.name === 'Read' && typeof read === 'string' && INSTRUCTION_FILE.test(read)) {
          push({ id, kind: 'instruction', label: `Leído: ${fileLabel(read, 'leído')}`, chars: sizeOf(block) })

          return
        }
      }

      const seen =
        text !== null ? atts.find(a => a.probe.length >= 20 && text.includes(a.probe)) : undefined
      if (text !== null && (seen || text.includes('<system-reminder>'))) {
        const label = seen ? (ATTACHMENT_LABELS[seen.type] ?? seen.type) : guessReminder(text)
        const isRecall = seen ? seen.type !== 'nested_memory' && /memor/i.test(seen.type) : MEMORY_PATH.test(text)
        if (isRecall) {
          const name = text.match(/memory\/([\w.-]+\.md)/)?.[1] ?? 'memoria'
          push({ id, kind: 'memory', label: `Recuerdo cargado: ${name}`, chars: text.length, note: seen?.type })

          return
        }
        const isInstruction = seen?.type === 'nested_memory' || /Contents of .+? \(/.test(text)
        push({
          id,
          kind: isInstruction ? 'instruction' : 'attachment',
          label: isInstruction ? reminderLabel(text, label) : label,
          chars: text.length,
          note: seen ? (seen.origin === 'engine' ? seen.type : seen.origin) : preview(text, 50),
        })

        return
      }

      run ??= { id, msgs: new Set(), chars: 0, tools: 0 }
      run.msgs.add(mi)
      run.chars += sizeOf(block)
      if (block.type === 'tool_use') run.tools += 1
    })
  })
  flush()

  if (ctx && !rows.some(row => row.kind === 'context')) rows.unshift({ ...contextRow('ctx', null, ctx), turn: 0 })

  return { rows, turns }
}

// What a turn brought besides conversation, counted: `1 skill · 2 rules`.
export const turnSummary = (rows: MessageRow[]) => {
  const count = (kinds: MessageRow['kind'][]) => rows.filter(row => kinds.includes(row.kind)).length
  const parts = [
    [count(['context', 'instruction']), 'CLAUDE.md/rules'],
    [count(['skill']), 'skill'],
    [count(['skill-file']), 'arch. skill'],
    [count(['mcp']), 'MCP'],
    [count(['agent']), 'agente'],
    [count(['memory']), 'memoria'],
    [count(['attachment']), 'recordat.'],
  ] as const

  return parts
    .filter(([n]) => n > 0)
    .map(([n, what]) => `${n} ${what}`)
    .join(' · ')
}

// What each turn added, oldest first: the turn before any prompt left out.
export const growthByTurn = (rows: readonly MessageRow[], turns: readonly TurnInfo[]) =>
  turns
    .filter(info => info.index > 0)
    .map(info => ({ index: info.index, chars: rows.filter(row => row.turn === info.index).reduce((n, row) => n + row.chars, 0) }))

// How many more turns fit before compaction, at the pace of the last few.
export const turnsLeft = (remaining: number, growth: readonly { chars: number }[], last = 3) => {
  const recent = growth.slice(-last).filter(one => one.chars > 0)
  if (recent.length === 0 || remaining <= 0) return undefined
  const pace = recent.reduce((n, one) => n + one.chars, 0) / recent.length / 4

  return Math.max(0, Math.floor(remaining / pace))
}

// Scales a zone's estimated chars to the engine's own count: rows keep their
// proportions, the zone its real total. 1 when there is nothing to scale by.
export const factor = (realTokens: number | undefined, estimatedChars: number) =>
  realTokens === undefined || estimatedChars <= 0 ? 1 : (realTokens * 4) / estimatedChars
