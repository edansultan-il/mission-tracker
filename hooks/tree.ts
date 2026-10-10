import type { Item, ItemStatus, Mission, MissionMeta } from '../types'

export const STATUSES: readonly ItemStatus[] = ['todo', 'doing', 'done', 'blocked', 'cancelled']

// The marks the model reads; the pane draws its own.
export const GLYPH: Record<ItemStatus, string> = {
  todo: '[ ]',
  doing: '[~]',
  done: '[x]',
  blocked: '[!]',
  cancelled: '[-]',
}

export type ItemOp =
  | {
      op: 'add'
      title: string
      parent?: number | string
      ref?: string
      status?: ItemStatus
      note?: string
      due?: string
      owner?: string
      mission?: string
    }
  | {
      op: 'update'
      id: number | string
      title?: string
      status?: ItemStatus
      note?: string
      due?: string
      owner?: string
      parent?: number | string | null
      mission?: string
    }
  | { op: 'remove'; id: number | string; mission?: string }

export type MissionOp =
  | { op: 'start'; title: string; parentMission?: string; parentItem?: number | string }
  | { op: 'join'; mission: string }
  | { op: 'link'; parentMission: string; parentItem: number | string; mission?: string }
  | { op: 'archive'; mission?: string }
  | { op: 'restore'; mission: string }

export type Op = ItemOp | MissionOp

export const ITEM_OPS = new Set(['add', 'update', 'remove'])

export function newMission(id: string, title: string, now: number): Mission {
  return { id, title: title.trim(), status: 'active', startedAt: now, updatedAt: now, nextId: 1, items: [] }
}

export function childrenOf(m: Mission, parent: number | null): Item[] {
  return m.items.filter(item => item.parent === parent)
}

function descendantIds(m: Mission, id: number): Set<number> {
  const ids = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const item of m.items) {
      if (item.parent !== null && ids.has(item.parent) && !ids.has(item.id)) {
        ids.add(item.id)
        grew = true
      }
    }
  }
  return ids
}

// A parent's shown status follows its children: all done reads done, any started reads doing.
export function effectiveStatus(m: Mission, item: Item): ItemStatus {
  if (item.status === 'cancelled' || item.status === 'blocked') return item.status
  const kids = childrenOf(m, item.id).filter(kid => kid.status !== 'cancelled')
  if (kids.length === 0) return item.status
  const states = kids.map(kid => effectiveStatus(m, kid))
  if (states.every(s => s === 'done')) return 'done'
  if (item.status === 'todo' && states.some(s => s === 'doing' || s === 'done')) return 'doing'
  return item.status === 'done' ? 'doing' : item.status
}

function leafProgress(items: Item[]): { done: number; total: number } {
  const live = items.filter(item => item.status !== 'cancelled')
  const leaves = live.filter(item => !live.some(other => other.parent === item.id))
  return { done: leaves.filter(item => item.status === 'done').length, total: leaves.length }
}

// Progress counts leaves only, so a stage with five subtasks weighs five.
export function progress(m: Mission): { done: number; total: number } {
  return leafProgress(m.items)
}

export function subtreeProgress(m: Mission, id: number): { done: number; total: number } {
  const ids = descendantIds(m, id)
  ids.delete(id)
  return leafProgress(m.items.filter(item => ids.has(item.id)))
}

export function isComplete(m: Mission | null): boolean {
  if (m === null) return false
  const p = progress(m)
  return p.total > 0 && p.done === p.total
}

export function hasStarted(m: Mission): boolean {
  return m.items.some(item => item.status === 'doing' || item.status === 'done')
}

export function currentFocus(m: Mission): Item | undefined {
  return (
    m.items.find(item => item.status === 'doing' && childrenOf(m, item.id).every(kid => kid.status !== 'doing')) ??
    m.items.find(item => item.status === 'doing')
  )
}

export function walk(m: Mission, visit: (item: Item, depth: number) => boolean | void): void {
  const go = (parent: number | null, depth: number) => {
    for (const item of childrenOf(m, parent)) {
      if (visit(item, depth) !== false) go(item.id, depth + 1)
    }
  }
  go(null, 0)
}

export function toMeta(m: Mission): MissionMeta {
  const p = progress(m)
  return {
    id: m.id,
    title: m.title,
    status: m.status,
    ...(m.parent ? { parent: m.parent } : {}),
    done: p.done,
    total: p.total,
    updatedAt: m.updatedAt,
  }
}

// An id, an exact title, then a title that contains the query; active missions first.
export function findMission(index: readonly MissionMeta[], query: string): MissionMeta | undefined {
  const q = query.trim().toLowerCase()
  if (!q) return undefined
  const ranked = [...index].sort((a, b) => (a.status === b.status ? b.updatedAt - a.updatedAt : a.status === 'active' ? -1 : 1))
  return (
    ranked.find(meta => meta.id.toLowerCase() === q) ??
    ranked.find(meta => meta.title.toLowerCase() === q) ??
    ranked.find(meta => meta.title.toLowerCase().includes(q))
  )
}

export function formatDue(due: string): string {
  const [, month, day] = due.split('-')
  return `${day}/${month}`
}

export function todayOf(now: number): string {
  const d = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Takes 2026-10-13, 13/10/2026 or 13/10 (this year); undefined when it reads as none of them.
export function normalizeDue(input: string, now: number): string | undefined {
  const text = input.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  const dm = text.match(/^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/)
  if (!dm) return undefined
  const [, day = '', month = '', rawYear] = dm
  const year = rawYear ? (rawYear.length === 2 ? `20${rawYear}` : rawYear) : String(new Date(now).getFullYear())
  const pad = (s: string) => s.padStart(2, '0')
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return undefined
  return `${year}-${pad(month)}-${pad(day)}`
}

export type ChildBadge = { title: string; done: number; total: number }

export function renderText(m: Mission | null, childByItem: ReadonlyMap<number, ChildBadge> = new Map()): string {
  if (m === null) return 'No mission is attached to this chat.'
  const p = progress(m)
  const lines = [`Mission ${m.id}: ${m.title} (${p.done}/${p.total} done)`]
  walk(m, (item, depth) => {
    const extras = [
      item.due ? `due ${formatDue(item.due)}` : '',
      item.owner ? `@${item.owner}` : '',
      childByItem.has(item.id) ? `sub-mission "${childByItem.get(item.id)!.title}" ${childByItem.get(item.id)!.done}/${childByItem.get(item.id)!.total}` : '',
    ].filter(Boolean)
    const tail = extras.length ? `  (${extras.join(', ')})` : ''
    const note = item.note ? `  // ${item.note}` : ''
    lines.push(`${'  '.repeat(depth)}${GLYPH[effectiveStatus(m, item)]} #${item.id} ${item.title}${tail}${note}`)
  })
  if (m.items.length === 0) lines.push('(no tasks yet)')
  return lines.join('\n')
}

export function cycleStatus(status: ItemStatus): ItemStatus {
  return status === 'todo' ? 'doing' : status === 'doing' ? 'done' : 'todo'
}

// Applies item ops to one mission. `refs` carries names from earlier adds across a whole call.
export function applyItemOps(
  start: Mission,
  ops: readonly ItemOp[],
  now: number,
  refs: Map<string, number> = new Map(),
): { mission: Mission; added: number; errors: string[] } {
  const m: Mission = { ...start, items: start.items.map(item => ({ ...item })) }
  const errors: string[] = []
  let added = 0

  const resolve = (key: number | string | undefined | null): number | null | undefined => {
    if (key === undefined || key === null || key === '') return null
    if (typeof key === 'number') return m.items.some(item => item.id === key) ? key : undefined
    const fromRef = refs.get(key)
    if (fromRef !== undefined) return fromRef
    const asNumber = Number(String(key).replace(/^#/, ''))
    if (Number.isInteger(asNumber)) return m.items.some(item => item.id === asNumber) ? asNumber : undefined
    // A title works too ("E4"): an exact match first, then the one title that contains it.
    const q = key.trim().toLowerCase()
    const exact = m.items.find(item => item.title.toLowerCase() === q)
    const partial = m.items.filter(item => item.title.toLowerCase().includes(q))
    return exact?.id ?? (partial.length === 1 ? partial[0]?.id : undefined)
  }

  const setExtras = (item: Item, op: { note?: string; due?: string; owner?: string }, where: string) => {
    if (op.note !== undefined) {
      if (op.note === '') delete item.note
      else item.note = op.note
    }
    if (op.owner !== undefined) {
      if (op.owner === '') delete item.owner
      else item.owner = op.owner.replace(/^@/, '').trim()
    }
    if (op.due !== undefined) {
      if (op.due === '') delete item.due
      else {
        const due = normalizeDue(op.due, now)
        if (due) item.due = due
        else errors.push(`${where}: "${op.due}" is not a date (use YYYY-MM-DD)`)
      }
    }
  }

  ops.forEach((op, index) => {
    const where = `op ${index + 1} (${op.op})`

    if (op.op === 'add') {
      if (!op.title?.trim()) return void errors.push(`${where}: a title is required`)
      const parent = resolve(op.parent)
      if (parent === undefined) return void errors.push(`${where}: no item ${String(op.parent)} in ${m.id}`)
      if (op.status !== undefined && !STATUSES.includes(op.status)) return void errors.push(`${where}: unknown status ${op.status}`)
      const item: Item = { id: m.nextId, parent, title: op.title.trim(), status: op.status ?? 'todo', addedAt: now }
      m.nextId += 1
      setExtras(item, op, where)
      m.items.push(item)
      if (op.ref) refs.set(op.ref, item.id)
      added += 1
      return
    }

    const id = resolve(op.id)
    if (id === undefined || id === null) return void errors.push(`${where}: no item ${String(op.id)} in ${m.id}`)

    if (op.op === 'remove') {
      const gone = descendantIds(m, id)
      m.items = m.items.filter(item => !gone.has(item.id))
      return
    }

    const item = m.items.find(one => one.id === id)!
    if (op.status !== undefined) {
      if (!STATUSES.includes(op.status)) return void errors.push(`${where}: unknown status ${op.status}`)
      item.status = op.status
    }
    if (op.title?.trim()) item.title = op.title.trim()
    setExtras(item, op, where)
    if (op.parent !== undefined) {
      const parent = resolve(op.parent)
      if (parent === undefined) return void errors.push(`${where}: no item ${String(op.parent)} in ${m.id}`)
      if (parent !== null && descendantIds(m, id).has(parent)) {
        return void errors.push(`${where}: #${id} cannot move under its own subtree`)
      }
      item.parent = parent
    }
  })

  m.updatedAt = now
  return { mission: m, added, errors }
}
