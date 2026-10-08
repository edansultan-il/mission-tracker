import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Mission } from '../types'
import {
  STATUSES,
  applyOps,
  childrenOf,
  currentFocus,
  cycleStatus,
  effectiveStatus,
  isComplete,
  newMission,
  progress,
  renderText,
  subtreeProgress,
  walk,
} from './tree'
import type { Op } from './tree'

const PANE = 'mission'
const TOOL = 'mcp__mission-tracker__mission'
const ARCHIVE_SIZE = 20

const missionAtom = atom({ plugin: 'mission-tracker', key: 'mission' } as const, null)
const expandDoneAtom = atom({ plugin: 'mission-tracker', key: 'expandDone' } as const, false)

// What the pane draws. The model still reads the ASCII marks from renderText.
const MARK = { todo: '○', doing: '◐', done: '✓', blocked: '!', cancelled: '✕' } as const
const MARK_COLOR = { todo: 'inactive', doing: 'suggestion', done: 'success', blocked: 'warning', cancelled: 'inactive' } as const
const TEXT_COLOR = { todo: undefined, doing: 'suggestion', done: undefined, blocked: 'warning', cancelled: undefined } as const

const WORDS = {
  en: {
    legend: { todo: 'to do', doing: 'in progress', done: 'done', blocked: 'blocked', cancelled: 'dropped' },
    next: { todo: 'start', doing: 'mark done', done: 'reopen', blocked: 'unblock', cancelled: 'restore' },
    hint: 'Hover a task to change it',
    showDone: 'Show finished',
    collapseDone: 'Fold finished',
    new: 'NEW',
    empty: 'No tasks yet.',
  },
  he: {
    legend: { todo: 'לביצוע', doing: 'בתהליך', done: 'הושלם', blocked: 'חסום', cancelled: 'בוטל' },
    next: { todo: 'התחל', doing: 'סמן כבוצע', done: 'פתח מחדש', blocked: 'שחרר', cancelled: 'שחזר' },
    hint: 'מעבר עם העכבר על משימה משנה סטטוס',
    showDone: 'הצג שהושלמו',
    collapseDone: 'קפל שהושלמו',
    new: 'חדש',
    empty: 'אין משימות עדיין.',
  },
} as const

// A Hebrew title turns the whole pane right-to-left.
const isRtl = (m: Mission) => /[\u0590-\u05FF]/.test(m.title)

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
    const expandDone = await read($, expandDoneAtom)

    if (m === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No active mission.</Text>
          <Text dimColor>Type /mission new {'<title>'} or ask Claude to track the work.</Text>
        </Box>
      )
    }

    const rtl = isRtl(m)
    const t = rtl ? WORDS.he : WORDS.en
    const dir = rtl ? 'row-reverse' : 'row'
    const align = rtl ? 'flex-end' : 'flex-start'
    const p = progress(m)
    const percent = p.total === 0 ? 0 : Math.round((p.done / p.total) * 100)
    const width = Math.max(8, Math.min(28, e.props.bodyColumns - 16))
    const filled = p.total === 0 ? 0 : Math.round((p.done / p.total) * width)

    // Finished groups fold to one line unless the person expands them.
    const rows: { item: Item; depth: number; isFolded: boolean }[] = []
    let canFold = false
    walk(m, (item, depth) => {
      const shown = effectiveStatus(m, item)
      const hasKids = childrenOf(m, item.id).length > 0
      const isFolded = hasKids && shown === 'done' && !expandDone
      if (hasKids && shown === 'done') canFold = true
      rows.push({ item, depth, isFolded })
      return !isFolded
    })

    const advance = (id: number) =>
      mutate($, current =>
        current === null
          ? current
          : { ...current, items: current.items.map(one => (one.id === id ? { ...one, status: cycleStatus(one.status) } : one)) },
      )

    return (
      <Box flexDirection="column" alignItems={align}>
        <Box flexDirection={dir} gap={1}>
          <Text>🎯</Text>
          <Text bold>{m.title}</Text>
        </Box>
        <Box flexDirection={dir} gap={1} marginTop={1}>
          <Box flexDirection={dir}>
            <Text color="success">{'━'.repeat(filled)}</Text>
            <Text dimColor>{'━'.repeat(width - filled)}</Text>
          </Box>
          <Text bold>{percent}%</Text>
          <Text dimColor>
            {p.done}/{p.total}
          </Text>
        </Box>

        <Box flexDirection="column" marginTop={1} alignItems={align}>
          {m.items.length === 0 && <Text dimColor>{t.empty}</Text>}
          {rows.map(({ item, depth, isFolded }, index) => {
            const shown = effectiveStatus(m, item)
            const kids = childrenOf(m, item.id).length > 0
            const sub = kids ? subtreeProgress(m, item.id) : null
            const isNew = item.addedAt > m.seenAt
            const isStage = depth === 0
            return (
              <Box
                key={`row-${item.id}`}
                flexDirection={dir}
                gap={1}
                paddingLeft={rtl ? 0 : depth * 2}
                paddingRight={rtl ? depth * 2 : 0}
                marginTop={isStage && index > 0 ? 1 : 0}
              >
                <Text color={MARK_COLOR[shown]} bold>
                  {MARK[shown]}
                </Text>
                <Box flexDirection="column" flexShrink={1} alignItems={align}>
                  <Box flexDirection={dir} gap={1}>
                    <Text
                      bold={isStage}
                      color={TEXT_COLOR[shown]}
                      dimColor={shown === 'done' || shown === 'cancelled'}
                      strikethrough={shown === 'cancelled'}
                    >
                      {item.title}
                    </Text>
                    {sub && (
                      <Text dimColor>
                        {sub.done}/{sub.total}
                        {isFolded ? ' ▸' : ''}
                      </Text>
                    )}
                    {isNew && (
                      <Text color="claude" bold>
                        {t.new}
                      </Text>
                    )}
                    {!kids && (
                      <Box display="none" hover={{ display: 'flex' }}>
                        <Button key={`next-${item.id}`} plain dimColor label={`› ${t.next[item.status]}`} onPress={() => advance(item.id)} />
                      </Box>
                    )}
                  </Box>
                  {item.note && (
                    <Text dimColor italic>
                      {item.note}
                    </Text>
                  )}
                </Box>
              </Box>
            )
          })}
        </Box>

        <Box flexDirection={dir} flexWrap="wrap" columnGap={2} marginTop={1}>
          {STATUSES.map(status => (
            <Box key={`legend-${status}`} flexDirection={dir} gap={1}>
              <Text color={MARK_COLOR[status]} bold>
                {MARK[status]}
              </Text>
              <Text dimColor>{t.legend[status]}</Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection={dir} gap={2}>
          <Text dimColor italic>
            {t.hint}
          </Text>
          {canFold && (
            <Button
              key="toggle-done"
              plain
              dimColor
              label={expandDone ? t.collapseDone : t.showDone}
              onPress={() => update($, expandDoneAtom, v => !v)}
            />
          )}
        </Box>
      </Box>
    )
  })
}
