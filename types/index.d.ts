export type ItemStatus = 'todo' | 'doing' | 'done' | 'blocked' | 'cancelled'

export type Item = {
  id: number
  parent: number | null
  title: string
  status: ItemStatus
  note?: string
  addedAt: number
}

export type Mission = {
  title: string
  startedAt: number
  seenAt: number
  nextId: number
  items: Item[]
  // Set when the person closes the pane themselves; /mission clears it.
  paneDismissed?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'mission-tracker': { mission: Mission | null; expandDone: boolean }
  }
}
