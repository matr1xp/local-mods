import { atom, read, update } from 'claude-code'
import type { Register, SessionMeasureInput, SessionUsage } from 'claude-code'

import type { LastRequest, Snapshot, Totals } from '../types'

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
    const { Box, Text } = $.ui.resolve(e)
    const t = await read($, totals)
    const l = await read($, last)
    const s = await read($, snapshot)
    // Context row is "<bar> 100%"; limit rows add a 6-cell label and a reset time.
    const width = Math.max(8, Math.min(24, e.props.bodyColumns - 6))
    const limitWidth = Math.max(6, Math.min(12, e.props.bodyColumns - 19))

    const percent = s?.contextPercent
    const hasContext = s !== null && percent !== undefined

    return (
      <Box flexDirection="column">
        <Text bold>Context</Text>
        {hasContext ? (
          <Box flexDirection="column">
            <Text color={levelColor(percent)}>
              {bar(percent, width)} {percent}%
            </Text>
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
        {s?.costUsd !== undefined && <Text>cost ${s.costUsd.toFixed(2)}</Text>}

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
