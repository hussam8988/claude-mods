import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ReportRange } from '../types'

// Today's Report — /report
// Counts the tasks Claude finished for you, estimates the hours it saved you
// and what that time is worth, by day, week, month and year. Kept across
// sessions on this computer.
//   /report            open the report
//   /report rate 45    set your hourly value (default 40)

type Day = { tasks: number; tools: number; edits: number; activeSec: number; savedMin: number }
const ZERO: Day = { tasks: 0, tools: 0, edits: 0, activeSec: 0, savedMin: 0 }

const PANE = 'todays-report'
const range = atom({ plugin: 'todays-report', key: 'range' } as const, 'day' as ReportRange)
const tick = atom({ plugin: 'todays-report', key: 'tick' } as const, 0)

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const LABELS: Record<ReportRange, string> = { day: 'Today', week: 'This week', month: 'This month', year: 'This year' }

function dayKey(ms: number): string {
  // YYYY-MM-DD in the computer's own time zone
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return y + '-' + m + '-' + day
}

// A conservative estimate of how long the same work would take a person by hand.
function minutesSaved(tools: number, edits: number): number {
  if (tools === 0) return 3
  const other = Math.max(0, tools - edits)
  return Math.min(180, 5 + 2 * Math.min(other, 30) + 6 * edits)
}

function inRange(key: string, r: ReportRange, now: number): boolean {
  const today = dayKey(now)
  if (r === 'day') return key === today
  if (r === 'month') return key.slice(0, 7) === today.slice(0, 7)
  if (r === 'year') return key.slice(0, 4) === today.slice(0, 4)
  const weekAgo = dayKey(now - 6 * 86400000)
  return key >= weekAgo && key <= today
}

async function loadRange($: any, r: ReportRange): Promise<{ sum: Day; days: number }> {
  const now = await $.clock.now()
  const keys: string[] = await $.store.keys()
  const sum: Day = { ...ZERO }
  let days = 0
  for (const k of keys) {
    if (!k.startsWith('d:')) continue
    const key = k.slice(2)
    if (!inRange(key, r, now)) continue
    const d = ((await $.store.get(k)) as Day | undefined) ?? ZERO
    sum.tasks += d.tasks
    sum.tools += d.tools
    sum.edits += d.edits
    sum.activeSec += d.activeSec
    sum.savedMin += d.savedMin
    if (d.tasks > 0) days += 1
  }
  return { sum, days }
}

async function lastSevenDays($: any): Promise<{ label: string; tasks: number; savedMin: number }[]> {
  const now = await $.clock.now()
  const out: { label: string; tasks: number; savedMin: number }[] = []
  for (let i = 6; i >= 0; i--) {
    const ms = now - i * 86400000
    const k = dayKey(ms)
    const d = ((await $.store.get('d:' + k)) as Day | undefined) ?? ZERO
    const label = new Date(ms).toLocaleDateString('en-CA', { weekday: 'short' })
    out.push({ label, tasks: d.tasks, savedMin: d.savedMin })
  }
  return out
}

async function getRate($: any): Promise<number> {
  const v = await $.store.get('rate')
  return typeof v === 'number' && v > 0 ? v : 40
}

function hours(min: number): string {
  if (min < 60) return Math.round(min) + ' min'
  return (min / 60).toFixed(1) + ' h'
}

function money(n: number): string {
  return '$' + n.toLocaleString('en-CA', { maximumFractionDigits: 0 })
}

async function summaryText($: any, r: ReportRange): Promise<string> {
  const { sum } = await loadRange($, r)
  const rate = await getRate($)
  return (
    LABELS[r] + ': ' + sum.tasks + ' tasks, ' + sum.edits + ' file edits. Saved about ' + hours(sum.savedMin) +
    ' (worth ~' + money((sum.savedMin / 60) * rate) + ' at $' + rate + '/h). Claude worked ' + hours(sum.activeSec / 60) + '.'
  )
}

export const register: Register = on => {
  let startedAt = 0
  let tools = 0
  let edits = 0

  on('session.start', async ($, e, next) => {
    const out = await next(e)
    try {
      await $.command.register({
        name: 'report',
        description: "Today's Report: tasks done, hours saved and what it's worth",
        argumentHint: '[rate <dollars per hour>]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('todays-report: could not add /report (' + String(err) + ')')
    }
    return out
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      startedAt = await $.clock.now()
      tools = 0
      edits = 0
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // Subagents' tool calls count too: they are part of the same task
    tools += 1
    if (EDIT_TOOLS.has(String(e.tool))) edits += 1
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    if ((e as any).agentId !== undefined || e.reason !== 'answer' || startedAt === 0) return out
    const now = await $.clock.now()
    const key = 'd:' + dayKey(now)
    const d = ((await $.store.get(key)) as Day | undefined) ?? ZERO
    const updated: Day = {
      tasks: d.tasks + 1,
      tools: d.tools + tools,
      edits: d.edits + edits,
      activeSec: d.activeSec + Math.max(0, Math.round((now - startedAt) / 1000)),
      savedMin: d.savedMin + minutesSaved(tools, edits),
    }
    await $.store.set(key, updated)
    startedAt = 0
    await update($, tick, n => n + 1)
    return out
  })

  on('command.run', { command: 'report' }, async ($, e) => {
    const args = (e.args || '').trim().split(/\s+/)
    if (args[0] === 'rate') {
      const n = Number((args[1] || '').replace(/[$,]/g, ''))
      if (!(n > 0)) return { text: 'Usage: /report rate 45  (your hourly value in dollars)' }
      await $.store.set('rate', n)
      await update($, tick, x => x + 1)
      return { text: 'Hourly value set to $' + n + '/h.' }
    }
    const opened = await $.ui.open({ id: PANE, title: "Today's Report" })
    if (!opened.isPlaced) {
      const lines = [
        await summaryText($, 'day'),
        await summaryText($, 'week'),
        await summaryText($, 'month'),
        await summaryText($, 'year'),
      ]
      return { text: lines.join('\n') }
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e) as any
    const r = await read($, range)
    await read($, tick)
    const { sum, days } = await loadRange($, r)
    const rate = await getRate($)
    const value = (sum.savedMin / 60) * rate
    const week = await lastSevenDays($)
    const most = Math.max(1, ...week.map(d => d.savedMin))
    const barWidth = 18

    const tab = (key: ReportRange) => (
      <Button
        key={'tab-' + key}
        label={LABELS[key]}
        variant={key === r ? 'primary' : 'secondary'}
        onPress={() => update($, range, () => key)}
      />
    )

    return (
      <Box flexDirection="column">
        <Text bold>Today's Report</Text>
        <Box marginTop={1}>
          {tab('day')}
          <Text> </Text>
          {tab('week')}
          <Text> </Text>
          {tab('month')}
          <Text> </Text>
          {tab('year')}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text bold>{sum.tasks}</Text> tasks done{r !== 'day' && days > 0 ? ' over ' + days + ' active day' + (days === 1 ? '' : 's') : ''}
          </Text>
          <Text>
            <Text bold>{hours(sum.savedMin)}</Text> of your time saved (estimate)
          </Text>
          <Text>
            <Text bold color="green">{money(value)}</Text> worth of time at ${rate}/h
          </Text>
          <Text dimColor>
            {sum.edits} file edits · {sum.tools} tool actions · Claude worked {hours(sum.activeSec / 60)}
          </Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Last 7 days — time saved</Text>
          {week.map(d => (
            <Text>
              {d.label.padEnd(4)} {'█'.repeat(Math.round((d.savedMin / most) * barWidth)) || '·'} {d.savedMin > 0 ? hours(d.savedMin) : ''}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Change your hourly value: /report rate 45</Text>
        </Box>
      </Box>
    )
  })
}
