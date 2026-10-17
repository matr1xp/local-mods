import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMeasureInput, SessionUsage } from 'claude-code'

import type { LastRequest, Shown, Snapshot, Totals } from '../types'
import { FIRE_ROWS, fireCells, tween } from './fire'

const PANE = 'token-usage'
const TITLE = 'Token usage'
// Widest line is the rate-limit row: "5h    ████████████ 23.5% ↻14:00".
const COLUMNS = 34
const OPEN = { id: PANE, title: TITLE, columns: COLUMNS } as const

const EMPTY: Totals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  requests: 0,
  subagentRequests: 0,
}

const totals = atom({ plugin: 'token-usage', key: 'totals' } as const, EMPTY)
const last = atom({ plugin: 'token-usage', key: 'last' } as const, null)
const snapshot = atom({ plugin: 'token-usage', key: 'snapshot' } as const, null)
// What the pane shows while it eases toward the snapshot, odometer style.
const shown = atom({ plugin: 'token-usage', key: 'shown' } as const, { context: 0, cost: 0 } as Shown)

let tweenTimer: { cancel: () => void } | null = null
let fireTimer: { cancel: () => void } | null = null
let fireColumns = 0

/** Eases `shown` toward the snapshot, 20 frames a second, and stops once it lands. */
const startTween = ($: EngineInterface) => {
  if (tweenTimer) return
  const timer = $.clock.every(50, () => {
    void Promise.all([read($, shown), read($, snapshot)]).then(async ([now, s]) => {
      const context = s?.contextPercent ?? 0
      const cost = s?.costUsd ?? 0
      if (now.context === context && now.cost === cost) {
        timer.cancel()
        if (tweenTimer === timer) tweenTimer = null
        return
      }
      await update($, shown, x => ({ context: tween(x.context, context), cost: tween(x.cost, cost) }))
    })
  })
  tweenTimer = timer
}

/** Animates the context flame while the pane is mounted; stops once a blit is refused. */
const startFire = ($: EngineInterface, columns: number) => {
  if (fireTimer && fireColumns === columns) return
  fireTimer?.cancel()
  fireColumns = columns
  const timer = $.clock.every(80, () => {
    void Promise.all([read($, shown), $.clock.now()]).then(([now, ms]) =>
      $.ui
        .blit({ requestId: PANE, key: 'fire', cells: fireCells(columns, now.context, ms / 1000) })
        .then(r => {
          if (r.deny && fireTimer === timer) {
            timer.cancel()
            fireTimer = null
          }
        }),
    )
  })
  fireTimer = timer
}

const toSnapshot = (u: SessionUsage | SessionMeasureInput): Snapshot => ({
  contextTokens: u.context.tokens,
  contextWindow: u.context.window,
  contextPercent: u.context.percent,
  rateLimits: u.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({
    kind,
    percentUsed,
    resetsAt,
  })),
  costUsd: u.cost?.usd,
})

const fmt =(n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

const bar = (percent: number, width: number): string => {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const LIMIT_NAMES: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7d',
  spend_limit: 'spend',
}

const resetTime = (iso?: string): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return ` ↻${hh}:${mm}`
}

const levelColor = (percent: number) =>
  percent >= 85 ? 'error' : percent >= 60 ? 'warning' : 'success'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'token-usage',
      description: 'Show token usage, cost and rate limits in a pane',
    })
    const usage = await $.session.usage()
    await update($, snapshot, () => toSnapshot(usage))
    startTween($)
    void $.ui.open(OPEN)

    return next(e)
  })

  on('command.run', { command: 'token-usage' }, async $ => {
    await $.ui.open(OPEN)

    return { text: 'Token usage pane opened.' }
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const usage = result?.usage
    if (usage) {
      const isSubagent = e.agentId !== undefined
      await update($, totals, t => ({
        input: t.input + usage.input_tokens,
        output: t.output + usage.output_tokens,
        cacheRead: t.cacheRead + usage.cache_read_input_tokens,
        cacheWrite: t.cacheWrite + usage.cache_creation_input_tokens,
        requests: t.requests + 1,
        subagentRequests: t.subagentRequests + (isSubagent ? 1 : 0),
      }))
      const request: LastRequest = {
        model: usage.model,
        isSubagent,
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
      }
      await update($, last, () => request)
    }

    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, snapshot, () => toSnapshot(e))
    startTween($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, totals, () => EMPTY)
      await update($, last, () => null)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const Raster = 'Raster' in elements ? elements.Raster : null
    const hasFire = Raster !== null && e.surface === 'terminal'
    const t = await read($, totals)
    const l = await read($, last)
    const s = await read($, snapshot)
    const sh = await read($, shown)
    // Context row is "<bar> 100%"; limit rows add a 6-cell label and a reset time.
    const width = Math.max(8, Math.min(24, e.props.bodyColumns - 6))
    const limitWidth = Math.max(6, Math.min(12, e.props.bodyColumns - 19))

    const percent = s?.contextPercent
    const hasContext = s !== null && percent !== undefined
    const isRolling = s?.costUsd !== undefined && sh.cost !== s.costUsd
    const isBurning = hasFire && hasContext
    const now = isBurning ? await $.clock.now() : 0

    if (isBurning) startFire($, width)

    return (
      <Box flexDirection="column">
        <Text bold>Context</Text>
        {hasContext ? (
          <Box flexDirection="column">
            {Raster !== null && isBurning ? (
              <Box gap={1} alignItems="flex-end">
                <Raster key="fire" columns={width} rows={FIRE_ROWS} cells={fireCells(width, sh.context, now / 1000)} />
                <Text color={levelColor(percent)}>{percent}%</Text>
              </Box>
            ) : (
              <Text color={levelColor(percent)}>
                {bar(percent, width)} {percent}%
              </Text>
            )}
            <Text dimColor>
              {fmt(s.contextTokens ?? 0)} / {fmt(s.contextWindow)} tokens
            </Text>
          </Box>
        ) : (
          <Text dimColor>No reading yet</Text>
        )}

        <Text> </Text>
        <Text bold>Session</Text>
        <Text>
          in {fmt(t.input)} · out {fmt(t.output)}
        </Text>
        <Text dimColor>
          cache read {fmt(t.cacheRead)} · write {fmt(t.cacheWrite)}
        </Text>
        <Text dimColor>
          {t.requests} requests
          {t.subagentRequests > 0 ? ` (${t.subagentRequests} subagent)` : ''}
        </Text>
        {s?.costUsd !== undefined && <Text bold={isRolling}>cost ${sh.cost.toFixed(2)}</Text>}

        {l !== null && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text bold>Last request{l.isSubagent ? ' (subagent)' : ''}</Text>
            <Text dimColor>{l.model}</Text>
            <Text>
              in {fmt(l.input)} · out {fmt(l.output)} · cached {fmt(l.cacheRead)}
            </Text>
          </Box>
        )}

        {s !== null && s.rateLimits.length > 0 && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text bold>Rate limits</Text>
            {s.rateLimits.map(r => (
              <Text color={levelColor(r.percentUsed)}>
                {(LIMIT_NAMES[r.kind] ?? r.kind).padEnd(5)} {bar(r.percentUsed, limitWidth)}{' '}
                {r.percentUsed}%{resetTime(r.resetsAt)}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
