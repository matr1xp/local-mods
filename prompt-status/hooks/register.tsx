import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Git, Limit, Reading } from '../types'

const BAR_WIDTH = 10
const TICK_MS = 60_000

const COLOR = {
  model: 'cyan',
  dir: 'yellow',
  git: 'magenta',
  separator: 'gray',
  label: 'gray',
  context: 'green',
  usage: 'magenta',
  reset: 'gray',
} as const

const EMPTY: Reading = { model: null, contextWindow: null, contextPercent: null, limit: null }

const reading = atom({ plugin: 'prompt-status', key: 'reading' } as const, EMPTY)
const git = atom({ plugin: 'prompt-status', key: 'git' } as const, null)
const now = atom({ plugin: 'prompt-status', key: 'now' } as const, 0)

const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable']

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** `claude-opus-5-5` → `Opus 5.5`; an alias such as `opus[1m]` → `Opus`. */
export const modelName = (model: string): string => {
  const id = model.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/)
  if (id?.[1] && id[2]) return `${capitalize(id[1])} ${id[2]}${id[3] ? `.${id[3]}` : ''}`
  const alias = model.toLowerCase().match(/^([a-z]+)/)?.[1]
  if (alias && FAMILIES.includes(alias)) return capitalize(alias)
  return model
}

/** 1_000_000 → `1M`, 200_000 → `200k`. */
export const windowName = (tokens: number): string =>
  tokens >= 1_000_000
    ? `${+(tokens / 1_000_000).toFixed(1)}M`
    : `${Math.round(tokens / 1_000)}k`

/** Minutes until `resetsAt`: `36m`, `2h 5m`, `3d`; empty when unknown or past. */
export const untilReset = (resetsAt: string | undefined, nowMs: number): string => {
  if (!resetsAt) return ''
  const at = Date.parse(resetsAt)
  if (Number.isNaN(at)) return ''
  const minutes = Math.ceil((at - nowMs) / 60_000)
  if (minutes <= 0) return ''
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
  return `${Math.round(minutes / (24 * 60))}d`
}

/** The five-hour window when reported, otherwise the fullest one. */
const pickLimit = (limits: readonly SessionRateLimit[]): Limit | null => {
  const chosen =
    limits.find(l => l.kind === 'five_hour') ??
    [...limits].sort((a, b) => b.percentUsed - a.percentUsed)[0]
  return chosen ? { percentUsed: chosen.percentUsed, resetsAt: chosen.resetsAt } : null
}

const cells = (percent: number): number =>
  Math.round((Math.min(100, Math.max(0, percent)) / 100) * BAR_WIDTH)

/** Parses `git status --porcelain=v2 --branch`. */
export const parseStatus = (stdout: string): Omit<Git, 'dir'> => {
  let branch: string | null = null
  let oid: string | null = null
  let isDirty = false
  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) branch = line.slice('# branch.head '.length)
    else if (line.startsWith('# branch.oid ')) oid = line.slice('# branch.oid '.length)
    else if (line.length > 0 && !line.startsWith('#')) isDirty = true
  }
  if (branch === '(detached)') branch = oid && oid !== '(initial)' ? oid.slice(0, 7) : 'HEAD'
  return { branch, isDirty }
}

const refresh = async ($: EngineInterface): Promise<void> => {
  const cwd = await $.session.cwd()
  const dir = cwd.split('/').filter(Boolean).pop() ?? cwd
  let next: Git = { dir, branch: null, isDirty: false }
  try {
    const status = await $.process.run(['git', 'status', '--porcelain=v2', '--branch'], {
      cwd,
      timeoutMs: 5_000,
    })
    if (status.exitCode === 0) next = { dir, ...parseStatus(status.stdout) }
  } catch {
    // git missing or too slow: show the directory alone
  }
  const nowMs = await $.clock.now()
  await update($, git, () => next)
  await update($, now, () => nowMs)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const [usage, settings] = await Promise.all([$.session.usage(), $.settings.read()])
    const model = typeof settings.model === 'string' ? settings.model : null
    await update($, reading, r => ({
      model: r.model ?? model,
      contextWindow: usage.context.window,
      contextPercent: usage.context.percent ?? null,
      limit: pickLimit(usage.rateLimits),
    }))
    await refresh($)
    $.clock.every(TICK_MS, () => refresh($))

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      await update($, reading, r => (r.model === e.model ? r : { ...r, model: e.model }))
    }

    return yield* next(e)
  })

  on('session.measure', async ($, e, next) => {
    await update($, reading, r => ({
      ...r,
      contextWindow: e.context.window,
      contextPercent: e.context.percent ?? r.contextPercent,
      limit: pickLimit(e.rateLimits) ?? r.limit,
    }))
    const nowMs = await $.clock.now()
    await update($, now, () => nowMs)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await refresh($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const r = await read($, reading)
    const g = await read($, git)
    const nowMs = await read($, now)

    const window = r.contextWindow ? ` (${windowName(r.contextWindow)} context)` : ''
    const model = r.model ? `${modelName(r.model)}${window}` : 'Claude'
    const sep = <Text color={COLOR.separator}> │ </Text>

    const contextPercent = r.contextPercent === null ? null : Math.round(r.contextPercent)
    const usagePercent = r.limit === null ? null : Math.round(r.limit.percentUsed)
    const reset = r.limit ? untilReset(r.limit.resetsAt, nowMs || (await $.clock.now())) : ''

    const bar = (percent: number, color: string) => (
      <Box>
        <Text color={color}>{'█'.repeat(cells(percent))}</Text>
        <Text color={color} dimColor>
          {'░'.repeat(BAR_WIDTH - cells(percent))}
        </Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box>
          <Text color={COLOR.model}>[{model}]</Text>
          {g && sep}
          {g && <Text color={COLOR.dir}>{g.dir}</Text>}
          {g?.branch && (
            <Text color={COLOR.git}>
              {' '}git:({g.branch}
              {g.isDirty ? '*' : ''})
            </Text>
          )}
        </Box>
        <Box>
          <Text color={COLOR.label}>Context </Text>
          {contextPercent === null ? (
            <Text color={COLOR.label}>–</Text>
          ) : (
            <Box>
              {bar(contextPercent, COLOR.context)}
              <Text color={COLOR.context}> {contextPercent}%</Text>
            </Box>
          )}
          {usagePercent !== null && sep}
          {usagePercent !== null && (
            <Box>
              <Text color={COLOR.label}>Usage </Text>
              {bar(usagePercent, COLOR.usage)}
              <Text color={COLOR.usage}> {usagePercent}%</Text>
              {reset && <Text color={COLOR.reset}> (resets in {reset})</Text>}
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}
