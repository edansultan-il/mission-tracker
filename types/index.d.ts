export type ItemStatus = 'todo' | 'doing' | 'done' | 'blocked' | 'cancelled'

export type Item = {
  id: number
  parent: number | null
  title: string
  // The person's own numbering ("E1", "4.1"); shown before the title and accepted wherever an id is.
  code?: string
  status: ItemStatus
  note?: string
  // YYYY-MM-DD
  due?: string
  owner?: string
  addedAt: number
}

// Where a sub-mission hangs in its parent: the parent's id and the item it delivers.
export type ParentLink = { mission: string; item: number }

export type Mission = {
  id: string
  title: string
  status: 'active' | 'archived'
  startedAt: number
  updatedAt: number
  nextId: number
  items: Item[]
  parent?: ParentLink
  // The repository (or folder) it was started in, for grouping; missions themselves are account-wide.
  project?: string
}

// The index row the "All missions" view and the model's overview read.
export type MissionMeta = {
  id: string
  title: string
  status: 'active' | 'archived'
  parent?: ParentLink
  project?: string
  done: number
  total: number
  updatedAt: number
}

// What one chat remembers: its mission, when the person last wrote, and whether they closed the pane.
export type Binding = {
  mission: string | null
  seenAt: number
  paneDismissed?: boolean
}

export type View = {
  // This chat's repository root (or folder), to group the list and rank nearby missions first.
  project: string
  binding: Binding
  mission: Mission | null
  parent: Mission | null
  children: Mission[]
  index: MissionMeta[]
}

declare module 'claude-code' {
  interface PluginState {
    'mission-tracker': { view: View | null; expandDone: boolean; listMode: boolean }
  }
}
