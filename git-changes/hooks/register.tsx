import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChangedFile, Snapshot } from '../types'

const PANE = 'git-changes'
const TITLE = 'Changes'
const POLL_MS = 4000
// Untracked files are counted one `git diff --no-index` each; past this many they show as "new".
const MAX_UNTRACKED_COUNTED = 40
const MAX_ROWS = 500
// git's well-known empty tree: the diff base before the first commit.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
// Polling must never take index.lock out from under the person's own git commands.
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' }

const STATUS_COLOR: Record<string, string> = {
  M: 'warning',
  A: 'success',
  D: 'error',
  R: 'suggestion',
  C: 'suggestion',
  T: 'warning',
  U: 'error',
  '?': 'subtle',
}

const snapshot = atom({ plugin: 'git-changes', key: 'snapshot' } as const, null)

type Stat = { added: number | null; deleted: number | null; isBinary: boolean }

const git = ($: EngineInterface, args: string[], cwd?: string) =>
  $.process.run(['git', ...args], { cwd, env: GIT_ENV, timeoutMs: 10_000 })

// `--numstat -z`: "added\tdeleted\tpath\0", or "added\tdeleted\t\0old\0new\0" for a
// rename; a binary file counts "-".
export function parseNumstat(out: string): Map<string, Stat> {
  const tokens = out.split('\0')
  const stats = new Map<string, Stat>()
  for (let i = 0; i < tokens.length; i++) {
    const head = tokens[i]
    if (head === undefined || head === '') continue
    const firstTab = head.indexOf('\t')
    const secondTab = head.indexOf('\t', firstTab + 1)
    const added = head.slice(0, firstTab)
    const deleted = head.slice(firstTab + 1, secondTab)
    let path = head.slice(secondTab + 1)
    if (path === '') {
      i += 2
      path = tokens[i] ?? ''
    }
    const isBinary = added === '-'
    stats.set(path, {
      added: isBinary ? null : Number(added),
      deleted: isBinary ? null : Number(deleted),
      isBinary,
    })
  }
  return stats
}

// `--name-status -z`: "M\0path\0", or "R100\0old\0new\0" for a rename or copy.
export function parseNameStatus(out: string): Map<string, string> {
  const tokens = out.split('\0')
  const statuses = new Map<string, string>()
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i]
    if (code === undefined || code === '') continue
    const letter = code.charAt(0)
    if (letter === 'R' || letter === 'C') i++
    i++
    statuses.set(tokens[i] ?? '', letter)
  }
  return statuses
}

async function countUntracked($: EngineInterface, root: string, path: string): Promise<Stat> {
  // Exits 1 when the file differs from /dev/null, which it always does.
  const { stdout } = await git($, ['diff', '--no-index', '--numstat', '-z', '--', '/dev/null', path], root)
  const [stat] = parseNumstat(stdout).values()
  return stat ?? { added: null, deleted: null, isBinary: false }
}

async function scan($: EngineInterface): Promise<Omit<Snapshot, 'fresh' | 'changedAt'>> {
  const top = await git($, ['rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) {
    return { root: '', branch: '', files: [], error: 'Not a git repository' }
  }
  const root = top.stdout.trim()

  const [symbolic, head] = await Promise.all([
    git($, ['symbolic-ref', '--short', '-q', 'HEAD'], root),
    git($, ['rev-parse', '--short', '-q', '--verify', 'HEAD'], root),
  ])
  const branch = symbolic.exitCode === 0 ? symbolic.stdout.trim() : `detached ${head.stdout.trim()}`
  const base = head.exitCode === 0 ? 'HEAD' : EMPTY_TREE

  const [numstat, nameStatus, others] = await Promise.all([
    git($, ['diff', '-M', '--numstat', '-z', base], root),
    git($, ['diff', '-M', '--name-status', '-z', base], root),
    git($, ['ls-files', '--others', '--exclude-standard', '-z'], root),
  ])
  if (numstat.exitCode !== 0) {
    return { root, branch, files: [], error: numstat.stderr.trim() || 'git diff failed' }
  }

  const stats = parseNumstat(numstat.stdout)
  const statuses = parseNameStatus(nameStatus.stdout)
  const files: ChangedFile[] = [...stats]
    .map(([path, stat]) => ({ path, status: statuses.get(path) ?? 'M', ...stat }))
    .sort((a, b) => a.path.localeCompare(b.path))

  const untracked = others.stdout.split('\0').filter(Boolean).sort()
  const counted = await Promise.all(
    untracked
      .slice(0, MAX_UNTRACKED_COUNTED)
      .map(path => countUntracked($, root, path).catch(() => null)),
  )
  untracked.forEach((path, i) => {
    const stat = counted[i] ?? { added: null, deleted: null, isBinary: false }
    files.push({ path, status: '?', ...stat })
  })

  return { root, branch, files, error: null }
}

// Opens a file in its default app: `open` on macOS, `xdg-open` where there is none.
async function openFile($: EngineInterface, root: string, path: string) {
  const abs = `${root}/${path}`
  try {
    const ran = await $.process.run(['open', abs], { timeoutMs: 10_000 })
    if (ran.exitCode === 0) return
  } catch {
    // no `open` here: try the freedesktop one
  }
  await $.process.run(['xdg-open', abs], { timeoutMs: 10_000 }).catch(() => undefined)
}

const signature = (file: ChangedFile) => `${file.status}|${file.added}|${file.deleted}`

async function scanAndStore($: EngineInterface) {
  let next: Omit<Snapshot, 'fresh' | 'changedAt'>
  try {
    next = await scan($)
  } catch (error) {
    next = { root: '', branch: '', files: [], error: error instanceof Error ? error.message : String(error) }
  }
  const prev = await read($, snapshot)
  const prevByPath = new Map(prev?.files.map(file => [file.path, signature(file)]))
  const isSame =
    prev !== null &&
    prev.root === next.root &&
    prev.branch === next.branch &&
    prev.error === next.error &&
    prev.files.length === next.files.length &&
    next.files.every(file => prevByPath.get(file.path) === signature(file))
  if (isSame) return

  // The first scan highlights nothing; later ones mark what moved since the last.
  const fresh =
    prev === null ? [] : next.files.filter(file => prevByPath.get(file.path) !== signature(file)).map(file => file.path)
  const changedAt = await $.clock.now()
  await update($, snapshot, () => ({ ...next, fresh, changedAt }))
}

// One scan at a time; a call that lands mid-scan queues one more pass after it.
let running: Promise<void> | undefined
let isQueued = false

function refresh($: EngineInterface): Promise<void> {
  if (running !== undefined) {
    isQueued = true
    return running
  }
  running = (async () => {
    try {
      do {
        isQueued = false
        await scanAndStore($)
      } while (isQueued)
    } finally {
      running = undefined
    }
  })()
  return running
}

async function isPaneUp($: EngineInterface) {
  const panes = await $.ui.panes()
  return panes.some(pane => pane.id === PANE && pane.isPlaced)
}

const clock = (ms: number) => {
  const at = new Date(ms)
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'changes',
      description: 'Show changed files with git diff stats in a side pane',
    })
    if (e.isInteractive) {
      await refresh($)
      void $.ui.open({ id: PANE, title: TITLE })
      $.clock.every(POLL_MS, () => {
        void isPaneUp($)
          .then(isUp => (isUp ? refresh($) : undefined))
          .catch(() => undefined)
      })
    }

    return next(e)
  })

  on('command.run', { command: 'changes' }, async ($, e) => {
    await refresh($)
    await $.ui.open({ id: PANE, title: TITLE })
    const snap = await read($, snapshot)
    const tip = e.presentation.isFullscreen
      ? ''
      : ' It docks to the right in the fullscreen layout; on the main screen it sits above the prompt.'
    if (snap === null || snap.error !== null) {
      return { text: `Changes pane opened${snap?.error ? ` (${snap.error})` : ''}.${tip}` }
    }
    const added = snap.files.reduce((sum, file) => sum + (file.added ?? 0), 0)
    const deleted = snap.files.reduce((sum, file) => sum + (file.deleted ?? 0), 0)

    return {
      text: `Changes pane opened: ${plural(snap.files.length, 'file')} changed, +${added} -${deleted}.${tip}`,
    }
  })

  // Rescan right after a tool that may have touched files, so the pane keeps up with each edit.
  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit', 'Bash'] }, async ($, e, next) => {
    const ran = await next(e)
    if (await isPaneUp($)) await refresh($)

    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const width = e.props.bodyColumns

    if (snap === null) {
      return <Text dimColor>Scanning…</Text>
    }
    if (snap.error !== null) {
      return (
        <Box flexDirection="column">
          <Text color="error">{snap.error}</Text>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refresh($)} />
        </Box>
      )
    }

    const fresh = new Set(snap.fresh)
    const totalAdded = snap.files.reduce((sum, file) => sum + (file.added ?? 0), 0)
    const totalDeleted = snap.files.reduce((sum, file) => sum + (file.deleted ?? 0), 0)

    // Columns: marker, status, path, +added, -deleted, then a git --stat style bar.
    const addedText = (file: ChangedFile) => (file.isBinary ? 'bin' : file.added === null ? 'new' : `+${file.added}`)
    const deletedText = (file: ChangedFile) => (file.deleted === null ? '' : `-${file.deleted}`)
    const addedWidth = Math.max(0, ...snap.files.map(file => addedText(file).length))
    const deletedWidth = Math.max(0, ...snap.files.map(file => deletedText(file).length))
    const barWidth = width >= 60 ? 12 : width >= 44 ? 6 : 0
    const pathWidth = Math.max(8, width - 4 - (1 + addedWidth + 1 + deletedWidth) - (barWidth > 0 ? 1 + barWidth : 0))
    const largest = Math.max(1, ...snap.files.map(file => (file.added ?? 0) + (file.deleted ?? 0)))
    const scale = largest <= barWidth ? 1 : barWidth / largest

    const bar = (file: ChangedFile) => {
      const added = file.added ?? 0
      const deleted = file.deleted ?? 0
      let plus = added > 0 ? Math.max(1, Math.round(added * scale)) : 0
      let minus = deleted > 0 ? Math.max(1, Math.round(deleted * scale)) : 0
      while (plus + minus > barWidth) {
        if (plus >= minus) plus--
        else minus--
      }
      return (
        <Text>
          {' '}
          <Text color="success">{'█'.repeat(plus)}</Text>
          <Text color="error">{'█'.repeat(minus)}</Text>
          {' '.repeat(barWidth - plus - minus)}
        </Text>
      )
    }

    const row = (file: ChangedFile) => {
      const isFresh = fresh.has(file.path)
      const slash = file.path.lastIndexOf('/')
      const dir = file.path.slice(0, slash + 1)
      const name = file.path.slice(slash + 1)
      const label = (
        <Text wrap="truncate-start" bold={isFresh}>
          <Text dimColor>{dir}</Text>
          {name}
        </Text>
      )
      return (
        <Box flexDirection="row">
          <Text color="claude">{isFresh ? '●' : ' '}</Text>
          <Text color={STATUS_COLOR[file.status] ?? 'text'} bold>
            {(file.status === '?' ? '??' : file.status).padEnd(2)}{' '}
          </Text>
          <Box width={pathWidth}>
            {/* A deleted file has nothing left on disk to open. */}
            {file.status === 'D' ? (
              label
            ) : (
              <Button key={`open:${file.path}`} plain onPress={() => openFile($, snap.root, file.path)}>
                {label}
              </Button>
            )}
          </Box>
          <Text> </Text>
          <Text color={file.added === null ? 'subtle' : 'success'} bold={isFresh}>
            {addedText(file).padStart(addedWidth)}
          </Text>
          <Text> </Text>
          <Text color="error" bold={isFresh}>
            {deletedText(file).padStart(deletedWidth)}
          </Text>
          {barWidth > 0 && bar(file)}
        </Box>
      )
    }

    const shown = snap.files.slice(0, MAX_ROWS)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text dimColor>on </Text>
          <Text color="suggestion" bold wrap="truncate-end">
            {snap.branch}
          </Text>
        </Box>
        {snap.files.length === 0 ? (
          <Text color="success">Working tree clean</Text>
        ) : (
          <Text>
            <Text bold>{plural(snap.files.length, 'file')} changed</Text>
            {'  '}
            <Text color="success" bold>
              +{totalAdded}
            </Text>
            {'  '}
            <Text color="error" bold>
              -{totalDeleted}
            </Text>
          </Text>
        )}
        <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>
        {shown.map(row)}
        {snap.files.length > shown.length && (
          <Text dimColor>…and {snap.files.length - shown.length} more</Text>
        )}
        <Text> </Text>
        <Box flexDirection="row">
          <Text dimColor>
            {fresh.size > 0 && <Text color="claude">● </Text>}
            {fresh.size > 0 ? 'just changed · ' : ''}updated {clock(snap.changedAt)}{' '}
          </Text>
          <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refresh($)} />
        </Box>
      </Box>
    )
  })
}
