import type { EngineInterface } from 'claude-code'

import type { Item, ItemStatus, Mission, MissionMeta, View } from '../types'
import {
  STATUSES,
  childrenOf,
  currentFocus,
  effectiveStatus,
  formatDue,
  progress,
  subtreeProgress,
  todayOf,
  walk,
} from './tree'

type $ = EngineInterface
type Elements = ReturnType<$['ui']['resolve']>

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
    allMissions: 'All missions',
    missionsHere: 'Missions in this folder',
    pickHint: 'Pick a mission for this chat, or ask Claude to start one.',
    none: 'No active missions yet.',
    thisChat: 'this chat',
    join: 'Open here',
    restore: 'Restore',
    archived: 'Archived',
    back: '‹ Back',
    now: 'Now',
    new: 'NEW',
    empty: 'No tasks yet.',
  },
  he: {
    legend: { todo: 'לביצוע', doing: 'בתהליך', done: 'הושלם', blocked: 'חסום', cancelled: 'בוטל' },
    next: { todo: 'התחל', doing: 'סמן כבוצע', done: 'פתח מחדש', blocked: 'שחרר', cancelled: 'שחזר' },
    hint: 'מעבר עם העכבר על משימה משנה סטטוס',
    showDone: 'הצג שהושלמו',
    collapseDone: 'קפל שהושלמו',
    allMissions: 'כל המשימות',
    missionsHere: 'המשימות בתיקייה',
    pickHint: 'בחר משימה לצ׳אט הזה, או בקש מ-Claude לפתוח אחת.',
    none: 'אין עדיין משימות פעילות.',
    thisChat: 'הצ׳אט הזה',
    join: 'פתח כאן',
    restore: 'שחזר',
    archived: 'בארכיון',
    back: 'חזרה ›',
    now: 'עכשיו',
    new: 'חדש',
    empty: 'אין משימות עדיין.',
  },
} as const

export type PaneActions = {
  advance: (missionId: string, itemId: number) => Promise<unknown>
  join: (missionId: string) => Promise<unknown>
  restore: (missionId: string) => Promise<unknown>
  toggleFold: () => Promise<unknown>
  showList: (isOn: boolean) => Promise<unknown>
}

type Layout = { columns: number; now: number; expandDone: boolean }

const HEBREW = /[֐-׿]/

function wordsFor(isRtl: boolean) {
  return isRtl ? WORDS.he : WORDS.en
}

function flow(isRtl: boolean) {
  return { dir: isRtl ? ('row-reverse' as const) : ('row' as const), align: isRtl ? ('flex-end' as const) : ('flex-start' as const) }
}

function missionMark(meta: MissionMeta): ItemStatus {
  if (meta.total > 0 && meta.done === meta.total) return 'done'
  return meta.done > 0 ? 'doing' : 'todo'
}

function Bar(els: Elements, done: number, total: number, width: number, isRtl: boolean) {
  const { Box, Text } = els
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  return (
    <Box flexDirection={flow(isRtl).dir}>
      <Text color="success">{'━'.repeat(filled)}</Text>
      <Text dimColor>{'━'.repeat(width - filled)}</Text>
    </Box>
  )
}

function Legend(els: Elements, isRtl: boolean) {
  const { Box, Text } = els
  const t = wordsFor(isRtl)
  const { dir } = flow(isRtl)
  return (
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
  )
}

export function drawTree(els: Elements, view: View, m: Mission, layout: Layout, actions: PaneActions) {
  const { Box, Text, Button } = els
  const isRtl = HEBREW.test(m.title)
  const t = wordsFor(isRtl)
  const { dir, align } = flow(isRtl)
  const p = progress(m)
  const percent = p.total === 0 ? 0 : Math.round((p.done / p.total) * 100)
  const width = Math.max(8, Math.min(28, layout.columns - 18))
  const focus = currentFocus(m)
  const today = todayOf(layout.now)
  const seenAt = view.binding.seenAt
  const childByItem = new Map(view.children.flatMap(child => (child.parent ? [[child.parent.item, child] as const] : [])))

  // Finished groups fold to one line unless the person expands them.
  const rows: { item: Item; depth: number; isFolded: boolean }[] = []
  let canFold = false
  walk(m, (item, depth) => {
    const hasKids = childrenOf(m, item.id).length > 0
    const isDoneGroup = hasKids && effectiveStatus(m, item) === 'done'
    if (isDoneGroup) canFold = true
    const isFolded = isDoneGroup && !layout.expandDone
    rows.push({ item, depth, isFolded })
    return !isFolded
  })

  return (
    <Box flexDirection="column" alignItems={align}>
      {view.parent && (
        <Box flexDirection={dir} gap={1}>
          <Text dimColor>{view.parent.title}</Text>
          <Text dimColor>{isRtl ? '‹' : '›'}</Text>
        </Box>
      )}
      <Box flexDirection={dir} gap={1}>
        <Text>🎯</Text>
        <Text bold>{m.title}</Text>
      </Box>
      <Box flexDirection={dir} gap={1} marginTop={1}>
        {Bar(els, p.done, p.total, width, isRtl)}
        <Text bold>{percent}%</Text>
        <Text dimColor>
          {p.done}/{p.total}
        </Text>
      </Box>
      {focus && (
        <Box flexDirection={dir} gap={1}>
          <Text color="suggestion" bold>
            {t.now}
          </Text>
          <Text>{focus.title}</Text>
        </Box>
      )}

      <Box flexDirection="column" marginTop={1} alignItems={align}>
        {m.items.length === 0 && <Text dimColor>{t.empty}</Text>}
        {rows.map(({ item, depth, isFolded }, index) => {
          const shown = effectiveStatus(m, item)
          const hasKids = childrenOf(m, item.id).length > 0
          const sub = hasKids ? subtreeProgress(m, item.id) : null
          const child = childByItem.get(item.id)
          const childP = child ? progress(child) : null
          const isOpen = shown !== 'done' && shown !== 'cancelled'
          const dueTone = item.due && isOpen ? (item.due < today ? 'error' : item.due === today ? 'warning' : undefined) : undefined
          const isStage = depth === 0
          return (
            <Box
              key={`row-${item.id}`}
              flexDirection={dir}
              gap={1}
              paddingLeft={isRtl ? 0 : depth * 2}
              paddingRight={isRtl ? depth * 2 : 0}
              marginTop={isStage && index > 0 ? 1 : 0}
            >
              <Text color={MARK_COLOR[shown]} bold>
                {MARK[shown]}
              </Text>
              <Box flexDirection="column" flexShrink={1} alignItems={align}>
                <Box flexDirection={dir} gap={1} flexWrap="wrap">
                  <Text
                    bold={isStage}
                    color={TEXT_COLOR[shown]}
                    dimColor={!isOpen}
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
                  {child && childP && (
                    <Text color="suggestion">
                      ↳ {child.title} {childP.done}/{childP.total}
                    </Text>
                  )}
                  {item.due && (
                    <Text color={dueTone} dimColor={dueTone === undefined}>
                      ◷ {formatDue(item.due)}
                    </Text>
                  )}
                  {item.owner && <Text dimColor>@{item.owner}</Text>}
                  {item.addedAt > seenAt && (
                    <Text color="claude" bold>
                      {t.new}
                    </Text>
                  )}
                  {!hasKids && (
                    <Box display="none" hover={{ display: 'flex' }}>
                      <Button
                        key={`next-${item.id}`}
                        plain
                        dimColor
                        label={`› ${t.next[item.status]}`}
                        onPress={() => actions.advance(m.id, item.id)}
                      />
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

      {Legend(els, isRtl)}
      <Box flexDirection={dir} gap={2} flexWrap="wrap">
        <Text dimColor italic>
          {t.hint}
        </Text>
        {canFold && (
          <Button
            key="toggle-done"
            plain
            dimColor
            label={layout.expandDone ? t.collapseDone : t.showDone}
            onPress={() => actions.toggleFold()}
          />
        )}
        <Button key="all-missions" plain dimColor label={t.allMissions} onPress={() => actions.showList(true)} />
      </Box>
    </Box>
  )
}

export function drawList(els: Elements, view: View, layout: Layout, actions: PaneActions) {
  const { Box, Text, Button } = els
  const active = view.index.filter(meta => meta.status === 'active').sort((a, b) => b.updatedAt - a.updatedAt)
  const archived = view.index
    .filter(meta => meta.status === 'archived')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)
  const hebrewTitles = view.index.filter(meta => HEBREW.test(meta.title)).length
  const isRtl = view.index.length > 0 && hebrewTitles * 2 >= view.index.length
  const t = wordsFor(isRtl)
  const { dir, align } = flow(isRtl)
  const mine = view.binding.mission

  // Sub-missions sit under their parent; one whose parent is gone stands on its own.
  const activeIds = new Set(active.map(meta => meta.id))
  const roots = active.filter(meta => !meta.parent || !activeIds.has(meta.parent.mission))
  const ordered: { meta: MissionMeta; depth: number }[] = []
  const place = (meta: MissionMeta, depth: number) => {
    ordered.push({ meta, depth })
    for (const kid of active.filter(other => other.parent?.mission === meta.id)) place(kid, depth + 1)
  }
  roots.forEach(meta => place(meta, 0))

  const width = Math.max(6, Math.min(12, layout.columns - 40))

  return (
    <Box flexDirection="column" alignItems={align}>
      <Text bold>{t.missionsHere}</Text>
      {!mine && <Text dimColor>{t.pickHint}</Text>}
      <Box flexDirection="column" marginTop={1} alignItems={align}>
        {ordered.length === 0 && <Text dimColor>{t.none}</Text>}
        {ordered.map(({ meta, depth }) => {
          const mark = missionMark(meta)
          const isMine = meta.id === mine
          return (
            <Box
              key={`mission-${meta.id}`}
              flexDirection={dir}
              gap={1}
              paddingLeft={isRtl ? 0 : depth * 2}
              paddingRight={isRtl ? depth * 2 : 0}
            >
              <Text color={MARK_COLOR[mark]} bold>
                {MARK[mark]}
              </Text>
              <Text bold={isMine}>{meta.title}</Text>
              {Bar(els, meta.done, meta.total, width, isRtl)}
              <Text dimColor>
                {meta.done}/{meta.total}
              </Text>
              {isMine ? (
                <Text color="claude">{t.thisChat}</Text>
              ) : (
                <Button key={`join-${meta.id}`} plain dimColor label={t.join} onPress={() => actions.join(meta.id)} />
              )}
            </Box>
          )
        })}
      </Box>

      {archived.length > 0 && (
        <Box flexDirection="column" marginTop={1} alignItems={align}>
          <Text dimColor bold>
            {t.archived}
          </Text>
          {archived.map(meta => (
            <Box key={`archived-${meta.id}`} flexDirection={dir} gap={1}>
              <Text dimColor>{meta.title}</Text>
              <Text dimColor>
                {meta.done}/{meta.total}
              </Text>
              <Button key={`restore-${meta.id}`} plain dimColor label={t.restore} onPress={() => actions.restore(meta.id)} />
            </Box>
          ))}
        </Box>
      )}

      {mine && (
        <Box marginTop={1}>
          <Button key="back" plain dimColor label={t.back} onPress={() => actions.showList(false)} />
        </Box>
      )}
    </Box>
  )
}
