import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { applyOps, progress, renderText } from '../hooks/tree'

const TOOL = 'mcp__mission-tracker__mission'
const PANE = {
  plugin: 'mission-tracker',
  component: 'Pane',
  requestId: 'mission',
  props: {
    title: 'Mission',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// What the engine answers beneath the plugin in a real session.
function world(on: On, opens: string[] = []) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
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

test('applyOps builds a nested tree with refs and keeps ids stable', () => {
  const { mission, added, errors } = applyOps(
    null,
    [
      { op: 'start', title: 'Pixo stage A' },
      { op: 'add', title: 'Collect documents', ref: 's1' },
      { op: 'add', title: 'Energy report', parent: 's1' },
      { op: 'add', title: 'Daylight sim', parent: 's1' },
      { op: 'add', title: 'Submit', status: 'todo' },
      { op: 'update', id: 2, status: 'done' },
      { op: 'update', id: 99, status: 'done' },
    ],
    1000,
  )
  expect(errors).toHaveLength(1)
  expect(added).toBe(4)
  expect(mission?.items.map(item => item.id)).toEqual([1, 2, 3, 4])
  expect(progress(mission!)).toEqual({ done: 1, total: 3 })
  expect(renderText(mission)).toContain('[~] #1 Collect documents')
})

test('cancelled items leave the count and remove drops a subtree', () => {
  const first = applyOps(
    null,
    [
      { op: 'start', title: 'M' },
      { op: 'add', title: 'A', ref: 'a' },
      { op: 'add', title: 'A1', parent: 'a' },
      { op: 'add', title: 'B' },
    ],
    1,
  ).mission
  const next = applyOps(first, [{ op: 'update', id: 3, status: 'cancelled' }, { op: 'remove', id: 1 }], 2).mission!
  expect(next.items).toHaveLength(1)
  expect(progress(next)).toEqual({ done: 0, total: 0 })
})

test('the tool updates the pane and a press ticks an item', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 10_000 })
  world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  const ran = await $.tool.call({
    tool: TOOL,
    ops: [
      { op: 'start', title: 'Ship the tracker' },
      { op: 'add', title: 'Stage 1', ref: 's1' },
      { op: 'add', title: 'Write code', parent: 's1' },
      { op: 'add', title: 'Test it', parent: 's1' },
    ],
  } as never)
  expect(String(ran.result)).toContain('#3 Test it')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /0\/2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'to do' })).toBeDefined()
    await ui.press({ key: 'next-2' })
    await ui.press({ key: 'next-2' })
    expect(await ui.find({ type: 'Text', text: '50%' })).toBeDefined()
    await ui.press({ key: 'next-2' })
    await ui.unmount()
  }
})

test('the system prompt carries the current tree', async ($, on) => {
  mock.store(on, {
    'mission:/work': {
      title: 'Stored mission',
      startedAt: 1,
      seenAt: 1,
      nextId: 2,
      items: [{ id: 1, parent: null, title: 'Carry over', status: 'doing', addedAt: 1 }],
    },
  })
  mock.clock(on, { now: 5 })
  world(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  const composed = await $.prompt.compose({ model: 'claude-sonnet-5-5', promptModel: 'claude-sonnet-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  const section = composed.sections.find(s => s.id === 'mission-tracker:mission')
  expect(section?.text).toContain('[~] #1 Carry over')
})

test('a Hebrew mission draws right-to-left with a Hebrew legend and folds finished stages', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 10_000 })
  world(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.tool.call({
    tool: TOOL,
    ops: [
      { op: 'start', title: 'חבילה E' },
      { op: 'add', title: 'שלב א', ref: 'a' },
      { op: 'add', title: 'משימה', parent: 'a', status: 'done' },
      { op: 'add', title: 'שלב ב' },
    ],
  } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'לביצוע' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^משימה$/ })).toBeUndefined()
  await ui.press({ key: 'toggle-done' })
  expect(await ui.find({ type: 'Text', text: /^משימה$/ })).toBeDefined()
  await ui.unmount()
})

test('the pane reopens for an unfinished mission until the person closes it, and /mission brings it back', async ($, on) => {
  const opens: string[] = []
  mock.store(on, {
    'mission:/work': {
      title: 'Open work',
      startedAt: 1,
      seenAt: 1,
      nextId: 2,
      items: [{ id: 1, parent: null, title: 'Task', status: 'todo', addedAt: 1 }],
      paneDismissed: true,
    },
  })
  mock.clock(on, { now: 5 })
  world(on, opens)

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  expect(opens).toHaveLength(0)

  await $.command.run({ command: 'mission', args: '' } as never)
  const afterCommand = opens.length
  expect(afterCommand).toBeGreaterThan(0)

  await $.tool.call({ tool: TOOL, ops: [{ op: 'add', title: 'Another' }] } as never)
  expect(opens.length).toBeGreaterThan(afterCommand)

  const beforeDone = opens.length
  await $.tool.call({ tool: TOOL, ops: [{ op: 'update', id: 1, status: 'done' }, { op: 'update', id: 2, status: 'done' }] } as never)
  expect(opens.length).toBe(beforeDone)
})
