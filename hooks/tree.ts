import type { Item, ItemStatus, Mission } from '../types'

export const STATUSES: readonly ItemStatus[] = ['todo', 'doing', 'done', 'blocked', 'cancelled']

export const GLYPH: Record<ItemStatus, string> = {
  todo: '[ ]',
  doing: '[~]',
  done: '[x]',
  blocked: '[!]',
  cancelled: '[-]',
}

export type Op =
  | { op: 'start'; title: string }
  | { op: 'add'; title: string; parent?: number | string; ref?: string; status?: ItemStatus; note?: string }
  | { op: 'update'; id: number | string; title?: string; status?: ItemStatus; note?: string; parent?: number | string | null }
  | { op: 'remove'; id: number | string }

export type Outcome = {
  mission: Mission | null
  added: number
  errors: string[]
}

export function newMission(title: string, now: number): Mission {
  return { title: title.trim(), startedAt: now, seenAt: now, nextId: 1, items: [] }
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

// Progress counts leaves only, so a stage with five subtasks weighs five.
export function progress(m: Mission): { done: number; total: number } {
  const live = m.items.filter(item => item.status !== 'cancelled')
  const leaves = live.filter(item => !live.some(other => other.parent === item.id))
  return { done: leaves.filter(item => item.status === 'done').length, total: leaves.length }
}

export function subtreeProgress(m: Mission, id: number): { done: number; total: number } {
  const ids = descendantIds(m, id)
  ids.delete(id)
  const live = m.items.filter(item => ids.has(item.id) && item.status !== 'cancelled')
  const leaves = live.filter(item => !live.some(other => other.parent === item.id))
  return { done: leaves.filter(item => item.status === 'done').length, total: leaves.length }
}

export function isComplete(m: Mission | null): boolean {
  if (m === null) return false
  const p = progress(m)
  return p.total > 0 && p.done === p.total
}

export function currentFocus(m: Mission): Item | undefined {
  return m.items.find(item => item.status === 'doing' && childrenOf(m, item.id).every(kid => kid.status !== 'doing'))
    ?? m.items.find(item => item.status === 'doing')
}

export function walk(m: Mission, visit: (item: Item, depth: number) => boolean | void): void {
  const go = (parent: number | null, depth: number) => {
    for (const item of childrenOf(m, parent)) {
      if (visit(item, depth) !== false) go(item.id, depth + 1)
    }
  }
  go(null, 0)
}

export function renderText(m: Mission | null): string {
  if (m === null) return 'No mission is active.'
  const p = progress(m)
  const lines = [`Mission: ${m.title} (${p.done}/${p.total} done)`]
  walk(m, (item, depth) => {
    const note = item.note ? `  // ${item.note}` : ''
    lines.push(`${'  '.repeat(depth)}${GLYPH[effectiveStatus(m, item)]} #${item.id} ${item.title}${note}`)
  })
  if (m.items.length === 0) lines.push('(no tasks yet)')
  return lines.join('\n')
}

export function cycleStatus(status: ItemStatus): ItemStatus {
  return status === 'todo' ? 'doing' : status === 'doing' ? 'done' : 'todo'
}

export function applyOps(start: Mission | null, ops: readonly Op[], now: number): Outcome {
  let m = start === null ? null : { ...start, items: start.items.map(item => ({ ...item })) }
  const refs = new Map<string, number>()
  const errors: string[] = []
  let added = 0

  const resolve = (key: number | string | undefined | null): number | null | undefined => {
    if (key === undefined || key === null || key === '') return null
    if (typeof key === 'number') return m?.items.some(item => item.id === key) ? key : undefined
    const fromRef = refs.get(key)
    if (fromRef !== undefined) return fromRef
    const asNumber = Number(String(key).replace(/^#/, ''))
    return Number.isInteger(asNumber) && m?.items.some(item => item.id === asNumber) ? asNumber : undefined
  }

  ops.forEach((op, index) => {
    const where = `op ${index + 1} (${op.op})`
    if (op.op === 'start') {
      if (!op.title?.trim()) return void errors.push(`${where}: a title is required`)
      m = newMission(op.title, now)
      refs.clear()
      return
    }
    if (m === null) return void errors.push(`${where}: no mission is active; start one first`)
    const mission = m

    if (op.op === 'add') {
      if (!op.title?.trim()) return void errors.push(`${where}: a title is required`)
      const parent = resolve(op.parent)
      if (parent === undefined) return void errors.push(`${where}: no item ${String(op.parent)}`)
      if (op.status !== undefined && !STATUSES.includes(op.status)) return void errors.push(`${where}: unknown status ${op.status}`)
      const id = mission.nextId
      mission.nextId += 1
      mission.items.push({
        id,
        parent,
        title: op.title.trim(),
        status: op.status ?? 'todo',
        ...(op.note ? { note: op.note } : {}),
        addedAt: now,
      })
      if (op.ref) refs.set(op.ref, id)
      added += 1
      return
    }

    const id = resolve(op.id)
    if (id === undefined || id === null) return void errors.push(`${where}: no item ${String(op.id)}`)

    if (op.op === 'remove') {
      const gone = descendantIds(mission, id)
      mission.items = mission.items.filter(item => !gone.has(item.id))
      return
    }

    const item = mission.items.find(one => one.id === id)!
    if (op.status !== undefined) {
      if (!STATUSES.includes(op.status)) return void errors.push(`${where}: unknown status ${op.status}`)
      item.status = op.status
    }
    if (op.title?.trim()) item.title = op.title.trim()
    if (op.note !== undefined) {
      if (op.note === '') delete item.note
      else item.note = op.note
    }
    if (op.parent !== undefined) {
      const parent = resolve(op.parent)
      if (parent === undefined) return void errors.push(`${where}: no item ${String(op.parent)}`)
      if (parent !== null && descendantIds(mission, id).has(parent)) {
        return void errors.push(`${where}: #${id} cannot move under its own subtree`)
      }
      item.parent = parent
    }
  })

  return { mission: m, added, errors }
}
