import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Mission } from '../types'
import {
  GLYPH,
  STATUSES,
  applyOps,
  currentFocus,
  cycleStatus,
  effectiveStatus,
  isComplete,
  newMission,
  progress,
  renderText,
  walk,
} from './tree'
import type { Op } from './tree'

const PANE = 'mission'
const TOOL = 'mcp__mission-tracker__mission'
const ARCHIVE_SIZE = 20

const missionAtom = atom({ plugin: 'mission-tracker', key: 'mission' } as const, null)
const hideDoneAtom = atom({ plugin: 'mission-tracker', key: 'hideDone' } as const, false)

const COLOR = {
  todo: undefined,
  doing: 'suggestion',
  done: 'success',
  blocked: 'warning',
  cancelled: 'inactive',
} as const

const GUIDANCE = `# Mission tracker

The person tracks multi-step work in a live mission tree (stages, tasks, subtasks) shown in a side pane. Keeping it accurate is part of your job: they rely on it so nothing gets lost while plans change.

Update it with the \`${TOOL}\` tool, batching several ops in one call:
- When the person starts work with roughly three or more steps and no mission is active, start one and add the stages and tasks you already know about.
- The moment new work appears (a new stage, a subtask you discover, a follow-up the person mentions), add it under the right parent. Don't wait for the end of the turn.
- Set an item to "doing" when you start it, "done" when it's finished and checked, "blocked" with a note saying why when it can't move.
- When scope changes, set dropped items to "cancelled" instead of removing them, so the person sees what changed. Use "remove" only to undo a mistake.
- Nest instead of making long flat lists: stage, then task, then subtask. Keep titles short and in the person's language.
- While a mission is active, use this tree instead of the built-in todo or task tools for the same work.

The person can tick items in the pane themselves. The tree below is always the current state.`

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      description: 'Applied in order.',
      items: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['start', 'add', 'update', 'remove'],
            description: 'start: begin a new mission (archives the current one). add: new item. update: change an item. remove: delete an item and its subtree (mistakes only).',
          },
          title: { type: 'string', description: 'start, add: the title. update: a new title.' },
          id: { type: ['integer', 'string'], description: 'update, remove: the item id (#7 → 7), or a ref from an earlier add in this call.' },
          parent: {
            type: ['integer', 'string', 'null'],
            description: 'add, update: the parent item id or a ref from an earlier add in this call; omit (or null on update) for top level.',
          },
          ref: { type: 'string', description: 'add: a temporary name later ops in this call can use as parent or id.' },
          status: { type: 'string', enum: [...STATUSES] },
          note: { type: 'string', description: 'A short note (why blocked, what is left). Empty string clears it.' },
        },
        required: ['op'],
      },
    },
  },
  required: ['ops'],
}

type $ = EngineInterface

// Missions are kept per project folder. session.start hands us the folder, and fires again on every reload.
let projectDir: string | undefined

async function storeKey($: $, prefix: string): Promise<string> {
  projectDir ??= await $.session.cwd()
  return `${prefix}:${projectDir}`
}

function statusLine(m: Mission | null): string | undefined {
  if (m === null) return undefined
  const p = progress(m)
  const focus = currentFocus(m)
  const now = focus ? ` · now: ${focus.title.slice(0, 40)}` : ''
  return `🎯 ${m.title.slice(0, 40)} · ${p.done}/${p.total}${now}`
}

async function archive($: $, m: Mission | null): Promise<void> {
  if (m === null || m.items.length === 0) return
  const key = await storeKey($, 'archive')
  const list = ((await $.store.get(key)) as Mission[] | undefined) ?? []
  await $.store.set(key, [...list, m].slice(-ARCHIVE_SIZE))
}

// Every change goes through here: state for the pane, the store for the next session, the status line.
async function mutate($: $, change: (m: Mission | null) => Mission | null): Promise<Mission | null> {
  const before = await read($, missionAtom)
  await update($, missionAtom, m => change(m ?? null))
  const after = await read($, missionAtom)
  const key = await storeKey($, 'mission')
  if (after === null) await $.store.delete(key)
  else await $.store.set(key, after)
  void $.ui.status(statusLine(after))
  if (after !== null && isComplete(after) && !isComplete(before) && before?.title === after.title) {
    void $.ui.toast(`Mission complete: ${after.title} 🎉`)
  }
  return after
}

function bar(done: number, total: number, width: number): string {
  if (total === 0) return ''
  const filled = Math.round((done / total) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export const register: Register = on => {
  let addedThisTurn = 0

  on('session.start', async ($, e, next) => {
    projectDir = e.cwd
    let m = await read($, missionAtom)
    if (m === null) {
      const stored = (await $.store.get(await storeKey($, 'mission'))) as Mission | undefined
      if (stored) {
        await update($, missionAtom, () => stored)
        m = stored
      }
    }

    await $.tool.register({
      name: 'mission',
      description:
        'Keep the mission tree (stages, tasks, subtasks) the person watches in their side pane up to date. Start a mission, add items as work appears, and set statuses as you go. Returns the updated tree.',
      inputSchema: INPUT_SCHEMA,
      isDeferred: false,
    })
    await $.command.register({
      name: 'mission',
      description: 'Show the mission pane, or: new <title> · add <task> · show · archive',
      argumentHint: '[new <title> | add <task> | show | archive]',
    })

    void $.ui.status(statusLine(m))
    if (m !== null && e.isInteractive) void $.ui.open({ id: PANE, title: 'Mission' })

    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { ops?: Op[] }
    const ops = Array.isArray(input.ops) ? input.ops : []
    if (ops.length === 0) return { result: 'No ops given. Pass { ops: [...] }.' }

    const now = await $.clock.now()
    const before = await read($, missionAtom)
    let outcome = { added: 0, errors: [] as string[] }
    const after = await mutate($, m => {
      const result = applyOps(m, ops, now)
      outcome = result
      return result.mission
    })
    if (before !== null && after !== null && before.startedAt !== after.startedAt) await archive($, before)

    addedThisTurn += outcome.added
    if (after !== null) void $.ui.open({ id: PANE, title: 'Mission' })

    const problems = outcome.errors.length ? `\n\nNot applied:\n- ${outcome.errors.join('\n- ')}` : ''
    return { result: renderText(after) + problems }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const m = await read($, missionAtom)
    const text = `${GUIDANCE}\n\nCurrent mission (ids are stable; [ ] todo, [~] doing, [x] done, [!] blocked, [-] cancelled):\n${renderText(m)}`
    return { sections: [...composed.sections, { id: 'mission-tracker:mission', text, scope: 'session' as const }] }
  })

  on('prompt.submit', async ($, e, next) => {
    addedThisTurn = 0
    const now = await $.clock.now()
    if ((await read($, missionAtom)) !== null) await mutate($, m => (m ? { ...m, seenAt: now } : m))
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (addedThisTurn > 0) {
      void $.ui.toast(`Mission: ${addedThisTurn} new item${addedThisTurn === 1 ? '' : 's'} added`)
      addedThisTurn = 0
    }
    return next(e)
  })

  on('command.run', { command: 'mission' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ').trim()
    const now = await $.clock.now()

    if (verb === 'new') {
      if (!arg) return { text: 'Usage: /mission new <title>' }
      const before = await read($, missionAtom)
      await archive($, before)
      await mutate($, () => newMission(arg, now))
      await $.ui.open({ id: PANE, title: 'Mission' })
      return { text: `Started mission: ${arg}`, context: [`The person started a new mission "${arg}". Help break it down into stages and tasks in the mission tree when you next work on it.`] }
    }
    if (verb === 'add') {
      if (!arg) return { text: 'Usage: /mission add <task>' }
      const m = await mutate($, current => applyOps(current, [{ op: 'add', title: arg }], now).mission)
      if (m === null) return { text: 'No active mission. Start one with /mission new <title>.' }
      return { text: `Added: ${arg}` }
    }
    if (verb === 'show') {
      return { text: renderText(await read($, missionAtom)) }
    }
    if (verb === 'archive') {
      const m = await read($, missionAtom)
      if (m === null) return { text: 'No active mission.' }
      await archive($, m)
      await mutate($, () => null)
      await $.ui.close({ id: PANE })
      return { text: `Archived mission: ${m.title}` }
    }

    await $.ui.open({ id: PANE, title: 'Mission' })
    const m = await read($, missionAtom)
    return { text: m ? 'Mission pane opened.' : 'No active mission. Start one with /mission new <title>, or ask Claude to track your work.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await read($, missionAtom)
    const hideDone = await read($, hideDoneAtom)

    if (m === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No active mission.</Text>
          <Text dimColor>Type /mission new {'<title>'} or ask Claude to track the work.</Text>
        </Box>
      )
    }

    const p = progress(m)
    const width = Math.max(8, Math.min(24, e.props.bodyColumns - 12))
    const rows: { item: Item; depth: number }[] = []
    walk(m, (item, depth) => {
      const shown = effectiveStatus(m, item)
      if (hideDone && (shown === 'done' || shown === 'cancelled')) return false
      rows.push({ item, depth })
    })

    const cycle = (id: number) =>
      mutate($, current =>
        current === null
          ? current
          : { ...current, items: current.items.map(one => (one.id === id ? { ...one, status: cycleStatus(one.status) } : one)) },
      )

    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate-end">🎯 {m.title}</Text>
        <Box flexDirection="row" gap={1}>
          <Text color="success">{bar(p.done, p.total, width)}</Text>
          <Text>{p.done}/{p.total}</Text>
        </Box>
        <Box flexDirection="row" marginBottom={1}>
          <Button
            key="toggle-done"
            plain
            dimColor
            label={hideDone ? 'Show done' : 'Hide done'}
            onPress={() => update($, hideDoneAtom, v => !v)}
          />
        </Box>
        {m.items.length === 0 && <Text dimColor>No tasks yet.</Text>}
        {rows.map(({ item, depth }) => {
          const shown = effectiveStatus(m, item)
          const isNew = item.addedAt > m.seenAt
          return (
            <Box key={`row-${item.id}`} flexDirection="row" paddingLeft={depth * 2} gap={1}>
              <Button key={`tick-${item.id}`} plain label={GLYPH[shown]} onPress={() => cycle(item.id)} />
              <Box flexDirection="column" flexShrink={1}>
                <Text
                  color={COLOR[shown]}
                  dimColor={shown === 'cancelled'}
                  strikethrough={shown === 'cancelled'}
                  bold={depth === 0}
                >
                  {item.title}
                  {isNew ? ' ' : ''}
                  {isNew && <Text color="claude">NEW</Text>}
                </Text>
                {item.note && <Text dimColor>{item.note}</Text>}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
