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

type Chat = { id: string; repo: string | null }

// What the engine answers beneath the plugin: the session's id and repository, a file system in
// memory shared by every "chat" of the test, and the UI calls. `chat` is switched to play another chat.
function world(on: On, chat: Chat, opens: string[] = []) {
  const files = new Map<string, { text: string; mtimeMs: number }>()
  let tick = 1
  mock.env(on, { HOME: '/home/edan' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: chat.id }))
  on('session.repo', () => ({ value: chat.repo ? { root: chat.repo, remote: null, internal: false, repository: null } : null }) as never)
  on('fs.read', ($, e) => {
    const file = files.get(e.path)
    return file ? { value: file.text } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.write', ($, e) => {
    files.set(e.path, { text: e.text, mtimeMs: (tick += 1) })
    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.list', ($, e) => ({
    value: [...files.entries()]
      .filter(([path]) => path.startsWith(`${e.path}/`) && !path.slice(e.path.length + 1).includes('/'))
      .map(([path, file]) => ({ name: path.slice(e.path.length + 1), kind: 'file' as const, size: file.text.length, mtimeMs: file.mtimeMs, isLink: false })),
  }))
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
  return files
}

const call = (ops: unknown[]) => ({ tool: TOOL, ops }) as never
const text = (ran: { result?: unknown }) => String(ran.result)

test('item ops build a nested tree with refs, codes, dates and owners, and move keeps ids', () => {
  const { mission, added, errors } = applyItemOps(
    newMission('m1', 'Pixo stage A', 0),
    [
      { op: 'add', title: 'Collect documents', ref: 's1', code: 'A' },
      { op: 'add', title: 'Energy report', parent: 's1', due: '13/10/2026', owner: '@Gal', code: 'A.2' },
      { op: 'add', title: 'Daylight sim', parent: 's1', due: 'soon', code: 'A.1' },
      { op: 'update', id: 'A.2', status: 'done' },
      { op: 'move', id: 'A.1', before: 'A.2' },
      { op: 'add', title: 'Duplicate code', code: 'a.1' },
      { op: 'update', id: 99, status: 'done' },
    ],
    1000,
  )
  expect(errors).toHaveLength(3)
  expect(added).toBe(4)
  expect(progress(mission)).toEqual({ done: 1, total: 3 })
  const tree = renderText(mission)
  expect(tree).toContain('[x] #2 [A.2] Energy report  (due 13/10, @Gal)')
  expect(tree.indexOf('[A.1]')).toBeLessThan(tree.indexOf('[A.2]'))
  expect(normalizeDue('2026-10-13', 0)).toBe('2026-10-13')
})

test('chats in different folders and worktrees list and join each other\'s missions by id or title', async ($, on) => {
  const chat: Chat = { id: 'chat-a', repo: '/repo' }
  mock.clock(on, { now: 1_000_000 })
  world(on, chat)

  await $.session.start({ cwd: '/repo/.claude/worktrees/a', surface: 'desktop', isInteractive: true })
  const a = text(await $.tool.call(call([{ op: 'start', title: 'Package E Development' }, { op: 'add', title: 'E4', code: 'E4' }])))
  const idA = a.match(/Mission (\S+):/)?.[1] ?? ''

  chat.id = 'chat-b'
  chat.repo = null
  await $.session.start({ cwd: '/elsewhere', surface: 'desktop', isInteractive: true })
  const b = text(await $.tool.call(call([{ op: 'start', title: 'Backups 10/10' }])))
  const idB = b.match(/Mission (\S+):/)?.[1] ?? ''
  expect(idB).not.toBe(idA)

  const listed = text(await $.tool.call(call([{ op: 'list' }])))
  expect(listed).toContain(idA)
  expect(listed).toContain(idB)

  const updated = text(await $.tool.call(call([{ op: 'update', mission: idA, id: 'E4', status: 'done' }])))
  expect(updated).toContain('[x] #1 [E4] E4')

  const joined = text(await $.tool.call(call([{ op: 'join', mission: idA }])))
  expect(joined).toContain('Package E Development (1/1 done)')

  chat.id = 'chat-a'
  chat.repo = '/repo'
  await $.session.start({ cwd: '/repo/.claude/worktrees/a', surface: 'desktop', isInteractive: true })
  const back = text(await $.tool.call(call([{ op: 'join', mission: 'Backups 10/10' }])))
  expect(back).toContain(`Mission ${idB}: Backups 10/10`)
})

test('a finished sub-mission ticks its item in the parent, seen from the parent chat', async ($, on) => {
  const chat: Chat = { id: 'package', repo: '/repo' }
  mock.clock(on, { now: 1_000_000 })
  world(on, chat)

  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.tool.call(call([{ op: 'start', title: 'Package E' }, { op: 'add', title: 'Scanner', code: 'E1' }, { op: 'add', title: 'Docs', code: 'E4' }]))

  chat.id = 'e1'
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const started = text(
    await $.tool.call(
      call([
        { op: 'start', title: 'E1 build', parentMission: 'Package E', parentItem: 'E1' },
        { op: 'add', title: 'Write it', status: 'done' },
        { op: 'update', id: 'E4', mission: 'Package E', status: 'done' },
      ]),
    ),
  )
  expect(started).toContain('sub-mission for #1 "Scanner"')

  chat.id = 'package'
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const composed = await $.prompt.compose(COMPOSE)
  const prompt = composed.sections.find(s => s.id === 'mission-tracker:mission')?.text ?? ''
  expect(prompt).toContain('Package E (2/2 done)')
  expect(prompt).toContain('[x] #1 [E1] Scanner  (sub-mission "E1 build" 1/1)')
})

test('missions kept by earlier versions move to the shared files, and an archived one can be restored', async ($, on) => {
  const chat: Chat = { id: 'chat', repo: null }
  const legacy = (title: string, startedAt: number) => ({
    title,
    startedAt,
    seenAt: startedAt,
    nextId: 2,
    items: [{ id: 1, parent: null, title: 'Open item', status: 'todo', addedAt: startedAt }],
  })
  mock.store(on, { 'mission:/work': legacy('Backups 10/10', 20), 'archive:/work': [legacy('Package E', 10)] })
  mock.clock(on, { now: 100 })
  const files = world(on, chat)

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  expect([...files.keys()].filter(path => path.startsWith('/home/edan/.claude/mission-tracker/missions/'))).toHaveLength(2)
  const listed = String((await $.command.run({ command: 'mission', args: 'list' } as never)).text)
  expect(listed).toContain('Backups 10/10')
  expect(listed).toContain('Archived:')

  await $.command.run({ command: 'mission', args: 'restore package' } as never)
  const shown = String((await $.command.run({ command: 'mission', args: 'show' } as never)).text)
  expect(shown).toContain('Package E')
})

test('the pane draws the tree right-to-left with codes, and the list view attaches another mission', async ($, on) => {
  const chat: Chat = { id: 'a', repo: null }
  mock.clock(on, { now: Date.UTC(2026, 9, 12) })
  world(on, chat)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.tool.call(call([{ op: 'start', title: 'גיבויים' }]))
  await $.tool.call(
    call([
      { op: 'start', title: 'חבילה E' },
      { op: 'add', title: 'שלב א', ref: 'a', code: 'E1' },
      { op: 'add', title: 'משימה', parent: 'a', status: 'done' },
      { op: 'add', title: 'כיבוי גיבוי', due: '2026-10-11', owner: 'עידן' },
    ]),
  )

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'לביצוע' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'E1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '◷ 11/10' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^משימה$/ })).toBeUndefined()
    await ui.press({ key: 'toggle-done' })
    expect(await ui.find({ type: 'Text', text: /^משימה$/ })).toBeDefined()
    await ui.press({ key: 'toggle-done' })

    await ui.press({ key: 'all-missions' })
    expect(await ui.find({ type: 'Text', text: 'כל המשימות' })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'all-missions' })
  const other = (await ui.findAll({ type: 'Button' })).find(button => String(button.key).startsWith('join-'))
  expect(other).toBeDefined()
  await ui.press({ key: String(other!.key) })
  await ui.unmount()
  const shown = String((await $.command.run({ command: 'mission', args: 'show' } as never)).text)
  expect(shown).toContain('גיבויים')
})

test('the pane reopens for an unfinished mission until the person closes it, and /mission brings it back', async ($, on) => {
  const chat: Chat = { id: 'chat', repo: null }
  const opens: string[] = []
  mock.clock(on, { now: 5 })
  const files = world(on, chat, opens)
  const mission = newMission('m1', 'Open work', 1)
  mission.items.push({ id: 1, parent: null, title: 'Task', status: 'todo', addedAt: 1 })
  mission.nextId = 2
  files.set('/home/edan/.claude/mission-tracker/missions/m1.json', { text: JSON.stringify(mission), mtimeMs: 1 })
  files.set('/home/edan/.claude/mission-tracker/chats/chat.json', { text: JSON.stringify({ mission: 'm1', seenAt: 1, paneDismissed: true }), mtimeMs: 1 })

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
  const chat: Chat = { id: 'chat', repo: null }
  mock.clock(on, { now: 5 })
  world(on, chat)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  await $.tool.call(
    call([
      { op: 'start', title: 'Quote pipeline' },
      { op: 'add', title: 'Extractor', status: 'done' },
      { op: 'add', title: 'Sheets row', status: 'blocked', note: 'waiting for access' },
      { op: 'add', title: 'Draft reply', owner: 'Dana', code: 'Q3' },
    ]),
  )
  const reported = String((await $.command.run({ command: 'mission', args: 'report' } as never)).text)
  expect(reported).toContain('Quote pipeline: 1/3 (33%)')
  expect(reported).toContain('Blocked:\n  - Sheets row · waiting for access')
  expect(reported).toContain('Next up:\n  - Q3 Draft reply @Dana')
})
