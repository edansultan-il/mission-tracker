import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Binding, Item, Mission, MissionMeta, View } from '../types'
import { drawList, drawTree } from './pane'
import type { PaneActions } from './pane'
import {
  GLYPH,
  ITEM_OPS,
  STATUSES,
  applyItemOps,
  currentFocus,
  cycleStatus,
  effectiveStatus,
  findMission,
  formatDue,
  hasStarted,
  isComplete,
  newMission,
  progress,
  renderText,
  toMeta,
  walk,
} from './tree'
import type { ChildBadge, ItemOp, MissionOp, Op } from './tree'

const PANE = 'mission'
const TOOL = 'mcp__mission-tracker__mission'
const SYNC_MS = 4000

const viewAtom = atom({ plugin: 'mission-tracker', key: 'view' } as const, null)
const expandDoneAtom = atom({ plugin: 'mission-tracker', key: 'expandDone' } as const, false)
const listModeAtom = atom({ plugin: 'mission-tracker', key: 'listMode' } as const, false)

const GUIDANCE = `# Mission tracker

The person tracks multi-step work in live mission trees (stages, tasks, subtasks) shown in a side pane. Several missions run side by side in this folder, one per chat, and a mission can be a sub-mission that delivers one item of a bigger parent mission. Keeping them accurate is part of your job: the person relies on them so nothing gets lost while plans change.

Use the \`${TOOL}\` tool, batching several ops in one call:
- Before starting a mission, read "Other active missions" below. If this chat's work belongs to one of them, join it. If it is one part of a bigger mission (one item of a package, say), start a sub-mission with parentMission and parentItem so it hangs under that item. Starting a mission never touches anyone else's.
- When this chat has no mission and the work has roughly three or more steps, start or join one before doing the work.
- The moment new work appears (a new stage, a subtask you discover, a follow-up the person mentions), add it under the right parent. Don't wait for the end of the turn.
- Set an item to "doing" when you start it, "done" when it's finished and checked, "blocked" with a note saying why when it can't move.
- When scope changes, set dropped items to "cancelled" instead of removing them. Use "remove" only to undo a mistake.
- Give items a due date (YYYY-MM-DD) and an owner when the person mentions them.
- To change an item in another mission (the person says "E4 is done" and E4 lives in the parent), pass that mission's id or title as "mission" on the op.
- Nest instead of making long flat lists. Keep titles short and in the person's language.
- While a mission is attached, use it instead of the built-in todo or task tools for the same work.

The person can tick items in the pane, and other chats update their own missions while you work, so the state below is always the current one.`

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
            enum: ['start', 'join', 'link', 'archive', 'restore', 'add', 'update', 'remove'],
            description:
              'start: new mission for this chat (others are untouched). join: attach this chat to an existing mission. link: hang a mission under an item of a parent mission. archive / restore: put a mission away or bring it back. add / update / remove: items.',
          },
          title: { type: 'string', description: 'start, add: the title. update: a new title.' },
          mission: {
            type: 'string',
            description: "join, restore: the mission. archive, link, add, update, remove: a mission other than this chat's. An id or a title.",
          },
          parentMission: { type: 'string', description: 'start, link: the parent mission, by id or title.' },
          parentItem: { type: ['integer', 'string'], description: 'start, link: the item of the parent this mission delivers, by id or title.' },
          id: { type: ['integer', 'string'], description: 'update, remove: the item id (#7 → 7), or a ref from an earlier add in this call.' },
          parent: {
            type: ['integer', 'string', 'null'],
            description: 'add, update: the parent item id or a ref from an earlier add in this call; omit (or null on update) for top level.',
          },
          ref: { type: 'string', description: 'add: a temporary name later ops in this call can use as parent or id.' },
          status: { type: 'string', enum: [...STATUSES] },
          note: { type: 'string', description: 'A short note (why blocked, what is left). Empty string clears it.' },
          due: { type: 'string', description: 'Due date, YYYY-MM-DD. Empty string clears it.' },
          owner: { type: 'string', description: 'Who holds the item (a name). Empty string clears it.' },
        },
        required: ['op'],
      },
    },
  },
  required: ['ops'],
}

type $ = EngineInterface

// Each mission is its own record, so chats working on different missions never write the same key.
const key = {
  index: (cwd: string) => `index:${cwd}`,
  mission: (cwd: string, id: string) => `m:${cwd}:${id}`,
  binding: (sessionId: string) => `bind:${sessionId}`,
  legacyMission: (cwd: string) => `mission:${cwd}`,
  legacyArchive: (cwd: string) => `archive:${cwd}`,
}

async function getIndex($: $, cwd: string): Promise<MissionMeta[]> {
  return ((await $.store.get(key.index(cwd))) as MissionMeta[] | undefined) ?? []
}

async function getMission($: $, cwd: string, id: string): Promise<Mission | null> {
  return ((await $.store.get(key.mission(cwd, id))) as Mission | undefined) ?? null
}

async function putMission($: $, cwd: string, m: Mission): Promise<void> {
  await $.store.set(key.mission(cwd, m.id), m)
  const index = await getIndex($, cwd)
  const meta = toMeta(m)
  const at = index.findIndex(row => row.id === m.id)
  if (at === -1) index.push(meta)
  else index[at] = meta
  await $.store.set(key.index(cwd), index)
}

async function getBinding($: $, sessionId: string): Promise<Binding> {
  return ((await $.store.get(key.binding(sessionId))) as Binding | undefined) ?? { mission: null, seenAt: 0 }
}

async function putBinding($: $, sessionId: string, binding: Binding): Promise<void> {
  await $.store.set(key.binding(sessionId), binding)
}

function newMissionId(now: number, taken: readonly MissionMeta[]): string {
  let id = `m${now.toString(36)}`
  while (taken.some(meta => meta.id === id)) id += 'x'
  return id
}

type LegacyMission = Omit<Mission, 'id' | 'status' | 'updatedAt'> & { seenAt?: number; paneDismissed?: boolean }

// v0.1 to v0.3 kept one mission per folder plus an archive list; each becomes a mission of its own.
async function migrate($: $, cwd: string): Promise<void> {
  const current = (await $.store.get(key.legacyMission(cwd))) as LegacyMission | undefined
  const archived = ((await $.store.get(key.legacyArchive(cwd))) as LegacyMission[] | undefined) ?? []
  if (!current && archived.length === 0) return

  const index = await getIndex($, cwd)
  const adopt = async (old: LegacyMission, status: Mission['status'], n: number) => {
    const id = `m${old.startedAt.toString(36)}${n}`
    if (index.some(meta => meta.id === id)) return
    const { seenAt: _seen, paneDismissed: _dismissed, ...rest } = old
    const m: Mission = { ...rest, id, status, updatedAt: old.startedAt }
    await putMission($, cwd, m)
    index.push(toMeta(m))
  }
  for (const [n, old] of archived.entries()) await adopt(old, 'archived', n)
  if (current) await adopt(current, 'active', archived.length)

  await $.store.delete(key.legacyMission(cwd))
  await $.store.delete(key.legacyArchive(cwd))
}

// The folder and chat this copy serves; session.start sets both and fires again on every reload.
let projectDir: string | undefined
let sessionId: string | undefined

async function here($: $): Promise<{ cwd: string; sid: string }> {
  projectDir ??= await $.session.cwd()
  sessionId ??= await $.session.id()
  return { cwd: projectDir, sid: sessionId }
}

async function loadView($: $): Promise<View> {
  const { cwd, sid } = await here($)
  const binding = await getBinding($, sid)
  const index = await getIndex($, cwd)
  const bound = binding.mission ? await getMission($, cwd, binding.mission) : null
  const mission = bound?.status === 'active' ? bound : null
  const parent = mission?.parent ? await getMission($, cwd, mission.parent.mission) : null
  const kids = mission ? index.filter(meta => meta.status === 'active' && meta.parent?.mission === mission.id) : []
  const children = (await Promise.all(kids.map(meta => getMission($, cwd, meta.id)))).filter((m): m is Mission => m !== null)
  return { binding, mission, parent, children, index }
}

function statusLine(view: View): string | undefined {
  const m = view.mission
  if (m === null) return undefined
  const p = progress(m)
  const focus = currentFocus(m)
  const trail = view.parent ? `${view.parent.title.slice(0, 24)} › ` : ''
  const now = focus ? ` · now: ${focus.title.slice(0, 40)}` : ''
  return `🎯 ${trail}${m.title.slice(0, 40)} · ${p.done}/${p.total}${now}`
}

// Reads the store and redraws only when something changed, here or in another chat.
async function refresh($: $): Promise<View> {
  const view = await loadView($)
  const shown = await read($, viewAtom)
  if (JSON.stringify(shown) !== JSON.stringify(view)) {
    await update($, viewAtom, () => view)
    void $.ui.status(statusLine(view))
  }
  return view
}

// The pane stays up for an unfinished mission until the person closes it themselves.
async function keepOpen($: $): Promise<void> {
  const view = (await read($, viewAtom)) ?? (await refresh($))
  if (view.mission === null || view.binding.paneDismissed || isComplete(view.mission)) return
  await $.ui.open({ id: PANE, title: 'Mission' })
}

async function changeBinding($: $, change: Partial<View['binding']>): Promise<void> {
  const { sid } = await here($)
  await putBinding($, sid, { ...(await getBinding($, sid)), ...change })
}

// A sub-mission's progress shows on the item it delivers: started reads doing, finished ticks it.
async function syncParent($: $, cwd: string, child: Mission, now: number): Promise<void> {
  if (!child.parent) return
  const parent = await getMission($, cwd, child.parent.mission)
  const item = parent?.items.find(one => one.id === child.parent!.item)
  if (!parent || !item || item.status === 'cancelled') return
  const want = isComplete(child) ? 'done' : hasStarted(child) && item.status === 'todo' ? 'doing' : null
  if (want === null || item.status === want) return
  await putMission($, cwd, {
    ...parent,
    updatedAt: now,
    items: parent.items.map(one => (one.id === item.id ? { ...one, status: want } : one)),
  })
  if (want === 'done') void $.ui.toast(`${child.title} complete · ticked in ${parent.title}`)
}

async function changeMission($: $, id: string, change: (m: Mission) => Mission): Promise<Mission | null> {
  const { cwd } = await here($)
  const m = await getMission($, cwd, id)
  if (m === null) return null
  const now = await $.clock.now()
  const next = { ...change(m), updatedAt: now }
  await putMission($, cwd, next)
  await syncParent($, cwd, next, now)
  return next
}

function findItem(m: Mission, key: number | string | undefined): Item | undefined {
  if (key === undefined || key === '') return undefined
  const asNumber = Number(String(key).replace(/^#/, ''))
  if (Number.isInteger(asNumber)) return m.items.find(item => item.id === asNumber)
  const q = String(key).trim().toLowerCase()
  return m.items.find(item => item.title.toLowerCase() === q) ?? m.items.find(item => item.title.toLowerCase().includes(q))
}

function childBadges(view: View): Map<number, ChildBadge> {
  return new Map(
    view.children.flatMap(child => (child.parent ? [[child.parent.item, { title: child.title, ...progress(child) }] as const] : [])),
  )
}

function outline(m: Mission): string {
  const lines: string[] = []
  walk(m, (item, depth) => {
    lines.push(`${'  '.repeat(depth)}${GLYPH[effectiveStatus(m, item)]} #${item.id} ${item.title}`)
    return depth < 1
  })
  return lines.join('\n')
}

function context(view: View): string {
  const parts: string[] = []
  parts.push(`## This chat's mission\n${view.mission ? renderText(view.mission, childBadges(view)) : 'This chat has no mission yet.'}`)
  if (view.mission?.parent && view.parent) {
    const link = view.mission.parent
    const item = view.parent.items.find(one => one.id === link.item)
    parts.push(
      `## Parent mission\nThis mission delivers #${link.item} "${item?.title ?? '?'}" of ${view.parent.id} "${view.parent.title}". Its outline:\n${outline(view.parent)}`,
    )
  }
  if (view.children.length > 0) {
    const rows = view.children.map(child => {
      const p = progress(child)
      return `- ${child.id} "${child.title}" delivers #${child.parent?.item}: ${p.done}/${p.total}`
    })
    parts.push(`## Sub-missions\n${rows.join('\n')}`)
  }
  const others = view.index.filter(meta => meta.status === 'active' && meta.id !== view.mission?.id)
  const rows = others.map(
    meta => `- ${meta.id} "${meta.title}" ${meta.done}/${meta.total}${meta.parent ? ` (sub-mission of ${meta.parent.mission} #${meta.parent.item})` : ''}`,
  )
  parts.push(`## Other active missions in this folder\n${rows.length ? rows.join('\n') : '(none)'}`)
  return parts.join('\n\n')
}

function report(view: View): string {
  const m = view.mission
  if (m === null) return 'This chat has no mission. Use /mission list or /mission join <name>.'
  const label = /[֐-׿]/.test(m.title)
    ? { done: 'הושלם', doing: 'בתהליך', blocked: 'חסום', next: 'הבא בתור', none: 'אין' }
    : { done: 'Done', doing: 'In progress', blocked: 'Blocked', next: 'Next up', none: 'none' }
  const leaves = m.items.filter(item => !m.items.some(other => other.parent === item.id))
  const line = (item: Item) =>
    `  - ${item.title}${item.due ? ` (${formatDue(item.due)})` : ''}${item.owner ? ` @${item.owner}` : ''}${item.note ? ` · ${item.note}` : ''}`
  const group = (title: string, items: Item[]) => `${title}:\n${items.length ? items.map(line).join('\n') : `  ${label.none}`}`
  const p = progress(m)
  return [
    `${m.title}: ${p.done}/${p.total} (${p.total ? Math.round((p.done / p.total) * 100) : 0}%)`,
    group(label.done, leaves.filter(item => item.status === 'done')),
    group(label.doing, leaves.filter(item => item.status === 'doing')),
    group(label.blocked, leaves.filter(item => item.status === 'blocked')),
    group(label.next, leaves.filter(item => item.status === 'todo').slice(0, 6)),
  ].join('\n\n')
}

function listText(view: View): string {
  const row = (meta: View['index'][number]) =>
    `${meta.id === view.mission?.id ? '▸' : ' '} ${meta.title}  ${meta.done}/${meta.total}  [${meta.id}]${meta.parent ? `  ↳ under ${meta.parent.mission} #${meta.parent.item}` : ''}`
  const active = view.index.filter(meta => meta.status === 'active')
  const archived = view.index.filter(meta => meta.status === 'archived')
  return [
    'Active missions:',
    ...(active.length ? active.map(row) : ['  (none)']),
    ...(archived.length ? ['', 'Archived:', ...archived.map(row)] : []),
    '',
    'Use /mission join <name> or /mission restore <name>.',
  ].join('\n')
}

function paneActions($: $): PaneActions {
  return {
    advance: async (missionId, itemId) => {
      await changeMission($, missionId, m => ({
        ...m,
        items: m.items.map(item => (item.id === itemId ? { ...item, status: cycleStatus(item.status) } : item)),
      }))
      await refresh($)
    },
    join: async missionId => {
      await changeBinding($, { mission: missionId, paneDismissed: false })
      await update($, listModeAtom, () => false)
      await refresh($)
    },
    restore: async missionId => {
      await changeMission($, missionId, m => ({ ...m, status: 'active' }))
      await changeBinding($, { mission: missionId, paneDismissed: false })
      await update($, listModeAtom, () => false)
      await refresh($)
    },
    toggleFold: () => update($, expandDoneAtom, v => !v),
    showList: isOn => update($, listModeAtom, () => isOn),
  }
}

export const register: Register = on => {
  let addedThisTurn = 0

  on('session.start', async ($, e, next) => {
    projectDir = e.cwd
    sessionId = await $.session.id()
    await migrate($, e.cwd)

    await $.tool.register({
      name: 'mission',
      description:
        "Keep the mission trees the person watches in their side pane up to date: start or join this chat's mission (or a sub-mission under an item of a bigger one), add items as work appears, and set statuses, due dates and owners as you go. Returns the updated tree.",
      inputSchema: INPUT_SCHEMA,
      isDeferred: false,
    })
    await $.command.register({
      name: 'mission',
      description: 'Show the mission pane, or: new · join · list · report · add · show · archive · restore',
      argumentHint: '[new <title> | join <name> | list | report | add <task> | show | archive | restore <name>]',
    })

    await refresh($)
    if (e.isInteractive) void keepOpen($)
    // Other chats write their own missions; pick their changes up while this one is open.
    $.clock.every(SYNC_MS, () => void refresh($))

    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const ops = ((e as unknown as { ops?: Op[] }).ops ?? []).filter(op => op && typeof op.op === 'string')
    if (ops.length === 0) return { result: 'No ops given. Pass { ops: [...] }.' }

    const { cwd, sid } = await here($)
    const now = await $.clock.now()
    const notes: string[] = []
    const errors: string[] = []
    const touched = new Set<string>()
    const refs = new Map<string, Map<string, number>>()

    const resolveParent = async (missionQuery: string, itemKey: number | string | undefined, at: string) => {
      const meta = findMission(await getIndex($, cwd), missionQuery)
      const parent = meta ? await getMission($, cwd, meta.id) : null
      if (!parent) return void errors.push(`${at}: no mission matches "${missionQuery}"`)
      const item = findItem(parent, itemKey)
      if (!item) return void errors.push(`${at}: no item "${String(itemKey)}" in ${parent.title}`)
      return { parent, item }
    }

    for (const [n, op] of ops.entries()) {
      const at = `op ${n + 1} (${op.op})`
      const binding = await getBinding($, sid)

      if (ITEM_OPS.has(op.op)) {
        const itemOp = op as ItemOp
        const target = itemOp.mission ? findMission(await getIndex($, cwd), itemOp.mission)?.id : (binding.mission ?? undefined)
        const m = target ? await getMission($, cwd, target) : null
        if (!m) {
          errors.push(itemOp.mission ? `${at}: no mission matches "${itemOp.mission}"` : `${at}: this chat has no mission yet; start or join one first`)
          continue
        }
        const names = refs.get(m.id) ?? new Map<string, number>()
        refs.set(m.id, names)
        const result = applyItemOps(m, [itemOp], now, names)
        errors.push(...result.errors.map(err => err.replace(/^op 1 \(\w+\)/, at)))
        addedThisTurn += result.added
        await putMission($, cwd, result.mission)
        await syncParent($, cwd, result.mission, now)
        if (m.id !== binding.mission) touched.add(m.id)
        continue
      }

      const mop = op as MissionOp
      if (mop.op === 'start') {
        if (!mop.title?.trim()) {
          errors.push(`${at}: a title is required`)
          continue
        }
        const link = mop.parentMission ? await resolveParent(mop.parentMission, mop.parentItem, at) : undefined
        if (mop.parentMission && !link) continue
        const m = newMission(newMissionId(now, await getIndex($, cwd)), mop.title, now)
        if (link) m.parent = { mission: link.parent.id, item: link.item.id }
        await putMission($, cwd, m)
        await changeBinding($, { mission: m.id, paneDismissed: false })
        notes.push(
          `Started ${m.id} "${m.title}"${link ? ` as the sub-mission for #${link.item.id} "${link.item.title}" of "${link.parent.title}"` : ''}. Other missions are untouched.`,
        )
        continue
      }

      const meta = mop.op === 'archive' && !mop.mission ? undefined : findMission(await getIndex($, cwd), mop.mission ?? '')
      const targetId = meta?.id ?? (mop.op === 'archive' || mop.op === 'link' ? binding.mission : null)
      if (!targetId) {
        errors.push(`${at}: ${mop.op === 'join' || mop.op === 'restore' ? `no mission matches "${mop.mission ?? ''}"` : 'this chat has no mission'}`)
        continue
      }

      if (mop.op === 'join') {
        if (meta?.status === 'archived') {
          errors.push(`${at}: "${meta.title}" is archived; use restore`)
          continue
        }
        await changeBinding($, { mission: targetId, paneDismissed: false })
        notes.push(`This chat now works on ${targetId} "${meta?.title}".`)
      } else if (mop.op === 'restore') {
        await changeMission($, targetId, m => ({ ...m, status: 'active' }))
        await changeBinding($, { mission: targetId, paneDismissed: false })
        notes.push(`Restored ${targetId} "${meta?.title}" and attached it to this chat.`)
      } else if (mop.op === 'archive') {
        const m = await changeMission($, targetId, mission => ({ ...mission, status: 'archived' }))
        if (binding.mission === targetId) await changeBinding($, { mission: null })
        notes.push(`Archived ${targetId} "${m?.title}".`)
      } else if (mop.op === 'link') {
        const link = await resolveParent(mop.parentMission, mop.parentItem, at)
        if (!link) continue
        if (link.parent.id === targetId) {
          errors.push(`${at}: a mission cannot hang under itself`)
          continue
        }
        await changeMission($, targetId, m => ({ ...m, parent: { mission: link.parent.id, item: link.item.id } }))
        notes.push(`Linked ${targetId} under #${link.item.id} "${link.item.title}" of "${link.parent.title}".`)
      }
    }

    const view = await refresh($)
    void keepOpen($)

    const others = await Promise.all([...touched].filter(id => id !== view.mission?.id).map(id => getMission($, cwd, id)))
    const sections = [
      renderText(view.mission, childBadges(view)),
      ...others.flatMap(m => (m ? [`Also updated:\n${renderText(m)}`] : [])),
      ...(notes.length ? [notes.join('\n')] : []),
      ...(errors.length ? [`Not applied:\n- ${errors.join('\n- ')}`] : []),
    ]
    return { result: sections.join('\n\n') }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const view = await refresh($)
    const text = `${GUIDANCE}\n\nMarks: [ ] todo, [~] doing, [x] done, [!] blocked, [-] cancelled. Item ids are stable within a mission.\n\n${context(view)}`
    return { sections: [...composed.sections, { id: 'mission-tracker:mission', text, scope: 'session' as const }] }
  })

  on('prompt.submit', async ($, e, next) => {
    addedThisTurn = 0
    await changeBinding($, { seenAt: await $.clock.now() })
    await refresh($)
    void keepOpen($)
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (addedThisTurn > 0) {
      void $.ui.toast(`Mission: ${addedThisTurn} new item${addedThisTurn === 1 ? '' : 's'} added`)
      addedThisTurn = 0
    }
    void keepOpen($)
    return next(e)
  })

  // Closing the pane by hand is the one thing that keeps it closed in this chat.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      await changeBinding($, { paneDismissed: true })
      await refresh($)
    }
    return next(e)
  })

  on('command.run', { command: 'mission' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ').trim()
    const { cwd } = await here($)
    const now = await $.clock.now()
    const view = await refresh($)
    const open = async () => {
      await changeBinding($, { paneDismissed: false })
      await update($, listModeAtom, () => false)
      await refresh($)
      await $.ui.open({ id: PANE, title: 'Mission' })
    }

    switch (verb) {
      case 'new': {
        if (!arg) return { text: 'Usage: /mission new <title>' }
        const m = newMission(newMissionId(now, view.index), arg, now)
        await putMission($, cwd, m)
        await changeBinding($, { mission: m.id })
        await open()
        return {
          text: `Started mission: ${arg}`,
          context: [`The person started mission ${m.id} "${arg}" for this chat. Help break it down into stages and tasks when you next work on it.`],
        }
      }
      case 'join':
      case 'restore': {
        const meta = findMission(view.index, arg)
        if (!meta) return { text: `No mission matches "${arg}". Try /mission list.` }
        if (meta.status === 'archived') {
          if (verb === 'join') return { text: `"${meta.title}" is archived. Use /mission restore ${arg}.` }
          await changeMission($, meta.id, m => ({ ...m, status: 'active' }))
        }
        await changeBinding($, { mission: meta.id })
        await open()
        return { text: `This chat now works on: ${meta.title}` }
      }
      case 'archive': {
        const meta = arg ? findMission(view.index, arg) : view.index.find(row => row.id === view.mission?.id)
        if (!meta) return { text: arg ? `No mission matches "${arg}".` : 'This chat has no mission.' }
        await changeMission($, meta.id, m => ({ ...m, status: 'archived' }))
        if (meta.id === view.mission?.id) {
          await changeBinding($, { mission: null })
          await $.ui.close({ id: PANE })
        }
        await refresh($)
        return { text: `Archived mission: ${meta.title}` }
      }
      case 'add': {
        if (!arg) return { text: 'Usage: /mission add <task>' }
        if (!view.mission) return { text: 'This chat has no mission. Use /mission new <title> or /mission join <name>.' }
        await changeMission($, view.mission.id, m => applyItemOps(m, [{ op: 'add', title: arg }], now).mission)
        await refresh($)
        return { text: `Added: ${arg}` }
      }
      case 'list':
        return { text: listText(view) }
      case 'show':
        return { text: renderText(view.mission, childBadges(view)) }
      case 'report':
        return { text: report(view) }
      case '':
        await open()
        if (!view.mission) await update($, listModeAtom, () => true)
        return {
          text: view.mission
            ? 'Mission pane opened. It stays open until the mission is done or you close it.'
            : 'This chat has no mission yet: pick one in the pane, or ask Claude to start one.',
        }
      default:
        return { text: 'Usage: /mission [new <title> | join <name> | list | report | add <task> | show | archive [name] | restore <name>]' }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const view = await read($, viewAtom)
    if (view === null) return <els.Text dimColor>…</els.Text>
    const layout = { columns: e.props.bodyColumns, now: await $.clock.now(), expandDone: await read($, expandDoneAtom) }
    const actions = paneActions($)
    if ((await read($, listModeAtom)) || view.mission === null) return drawList(els, view, layout, actions)
    return drawTree(els, view, view.mission, layout, actions)
  })
}
