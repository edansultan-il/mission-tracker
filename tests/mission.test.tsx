import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { applyItemOps, newMission, normalizeDue, progress, renderText } from '../hooks/tree'

const TOOL = 'mcp__mission-tracker__mission'
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const
const PANE = {
  plugin: 'mission-tracker',
  component: 'Pane',
  requestId: 'mission',
  props: {
    title: 'Mission',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// What the engine answers beneath the plugin in a real session. `chat.id` stands for the session's id.
function world(on: On, chat: { id: string }, opens: string[] = []) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: chat.id }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__mission-tracker__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    opens.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.compose', () => ({ sections: [] }))
}

const call = (ops: unknown[]) => ({ tool: TOOL, ops }) as never

test('item ops build a nested tree with refs, dates and owners', () => {
  const { mission, added, errors } = applyItemOps(
    newMission('m1', 'Pixo stage A', 0),
    [
      { op: 'add', title: 'Collect documents', ref: 's1' },
      { op: 'add', title: 'Energy report', parent: 's1', due: '13/10/2026', owner: '@Gal' },
      { op: 'add', title: 'Daylight sim', parent: 's1', due: 'soon' },
      { op: 'update', id: 2, status: 'done' },
      { op: 'update', id: 99, status: 'done' },
    ],
    1000,
  )
  expect(errors).toHaveLength(2)
  expect(added).toBe(3)
  expect(progress(mission)).toEqual({ done: 1, total: 2 })
  expect(renderText(mission)).toContain('[x] #2 Energy report  (due 13/10, @Gal)')
  expect(normalizeDue('2026-10-13', 0)).toBe('2026-10-13')
})

test('chats keep their own missions, and a finished sub-mission ticks its item in the parent', async ($, on) => {
  const chat = { id: 'package' }
  mock.store(on)
  mock.clock(on, { now: 1_000_000 })
  world(on, chat)

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.tool.call(
    call([
      { op: 'start', title: 'Package E' },
      { op: 'add', title: 'E1' },
      { op: 'add', title: 'E4' },
    ]),
  )

  chat.id = 'e1'
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const started = await $.tool.call(
    call([
      { op: 'start', title: 'E1 build', parentMission: 'Package E', parentItem: 'E1' },
      { op: 'add', title: 'Scanner', status: 'done' },
      { op: 'update', id: 'E4', mission: 'Package E', status: 'done' },
    ]),
  )
  expect(String(started.result)).toContain('sub-mission for #1 "E1"')
  expect(String(started.result)).toContain('[x] #2 E4')

  chat.id = 'package'
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const composed = await $.prompt.compose(COMPOSE)
  const text = composed.sections.find(s => s.id === 'mission-tracker:mission')?.text ?? ''
  expect(text).toContain('Package E (2/2 done)')
  expect(text).toContain('[x] #1 E1  (sub-mission "E1 build" 1/1)')
})

test('missions from earlier versions come over, and an archived one can be restored', async ($, on) => {
  const chat = { id: 'chat' }
  const legacy = (title: string, startedAt: number) => ({
    title,
    startedAt,
    seenAt: startedAt,
    nextId: 2,
    items: [{ id: 1, parent: null, title: 'Open item', status: 'todo', addedAt: startedAt }],
  })
  mock.store(on, { 'mission:/work': legacy('Backups 10/10', 20), 'archive:/work': [legacy('Package E', 10)] })
  mock.clock(on, { now: 100 })
  world(on, chat)

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const listed = await $.command.run({ command: 'mission', args: 'list' } as never)
  expect(String(listed.text)).toContain('Backups 10/10')
  expect(String(listed.text)).toContain('Archived:')

  await $.command.run({ command: 'mission', args: 'restore package' } as never)
  const shown = await $.command.run({ command: 'mission', args: 'show' } as never)
  expect(String(shown.text)).toContain('Package E')
})

test('the pane draws the tree right-to-left, and the list view attaches another mission', async ($, on) => {
  const chat = { id: 'a' }
  mock.store(on)
  mock.clock(on, { now: Date.UTC(2026, 9, 12) })
  world(on, chat)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.tool.call(call([{ op: 'start', title: 'גיבויים' }]))
  await $.tool.call(
    call([
      { op: 'start', title: 'חבילה E' },
      { op: 'add', title: 'שלב א', ref: 'a' },
      { op: 'add', title: 'משימה', parent: 'a', status: 'done' },
      { op: 'add', title: 'כיבוי גיבוי', due: '2026-10-11', owner: 'עידן' },
    ]),
  )

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'לביצוע' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '◷ 11/10' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^משימה$/ })).toBeUndefined()
    await ui.press({ key: 'toggle-done' })
    expect(await ui.find({ type: 'Text', text: /^משימה$/ })).toBeDefined()
    await ui.press({ key: 'toggle-done' })

    await ui.press({ key: 'all-missions' })
    expect(await ui.find({ type: 'Text', text: 'המשימות בתיקייה' })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'all-missions' })
  const other = (await ui.findAll({ type: 'Button' })).find(button => String(button.key).startsWith('join-'))
  expect(other).toBeDefined()
  await ui.press({ key: String(other!.key) })
  await ui.unmount()
  const shown = await $.command.run({ command: 'mission', args: 'show' } as never)
  expect(String(shown.text)).toContain('גיבויים')
})

test('the pane reopens for an unfinished mission until the person closes it, and /mission brings it back', async ($, on) => {
  const chat = { id: 'chat' }
  const opens: string[] = []
  mock.store(on, {
    'index:/work': [{ id: 'm1', title: 'Open work', status: 'active', done: 0, total: 1, updatedAt: 1 }],
    'm:/work:m1': {
      id: 'm1',
      title: 'Open work',
      status: 'active',
      startedAt: 1,
      updatedAt: 1,
      nextId: 2,
      items: [{ id: 1, parent: null, title: 'Task', status: 'todo', addedAt: 1 }],
    },
    'bind:chat': { mission: 'm1', seenAt: 1, paneDismissed: true },
  })
  mock.clock(on, { now: 5 })
  world(on, chat, opens)

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  expect(opens).toHaveLength(0)

  await $.command.run({ command: 'mission', args: '' } as never)
  const afterCommand = opens.length
  expect(afterCommand).toBeGreaterThan(0)

  await $.tool.call(call([{ op: 'add', title: 'Another' }]))
  expect(opens.length).toBeGreaterThan(afterCommand)

  const beforeDone = opens.length
  await $.tool.call(
    call([
      { op: 'update', id: 1, status: 'done' },
      { op: 'update', id: 2, status: 'done' },
    ]),
  )
  expect(opens.length).toBe(beforeDone)
})

test('the report groups work by state', async ($, on) => {
  const chat = { id: 'chat' }
  mock.store(on)
  mock.clock(on, { now: 5 })
  world(on, chat)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.tool.call(
    call([
      { op: 'start', title: 'Quote pipeline' },
      { op: 'add', title: 'Extractor', status: 'done' },
      { op: 'add', title: 'Sheets row', status: 'blocked', note: 'waiting for access' },
      { op: 'add', title: 'Draft reply', owner: 'Dana' },
    ]),
  )
  const reported = String((await $.command.run({ command: 'mission', args: 'report' } as never)).text)
  expect(reported).toContain('Quote pipeline: 1/3 (33%)')
  expect(reported).toContain('Blocked:\n  - Sheets row · waiting for access')
  expect(reported).toContain('Next up:\n  - Draft reply @Dana')
})
