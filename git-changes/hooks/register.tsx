import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ChangedFile, FileDiff, Snapshot } from '../types'

const PANE = 'git-changes'
const TITLE = 'Changes'
const POLL_MS = 4000
// Untracked files are counted one `git diff --no-index` each; past this many they show as "new".
const MAX_UNTRACKED_COUNTED = 40
const MAX_ROWS = 500
// One drawing holds 100,000 characters of text in all; the diff leaves room for the
// header around it and is cut at a line past this.
const MAX_DIFF_CHARS = 90_000
// A diff longer than this is not reloaded by a poll while its file's counts hold still.
const LARGE_DIFF_CHARS = 20_000
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
// The file whose diff the pane shows in place of the list; null shows the list.
const diff = atom({ plugin: 'git-changes', key: 'diff' } as const, null)

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
export function parseNameStatus(out: string): Map<string, { status: string; from?: string }> {
  const tokens = out.split('\0')
  const statuses = new Map<string, { status: string; from?: string }>()
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i]
    if (code === undefined || code === '') continue
    const letter = code.charAt(0)
    if (letter === 'R' || letter === 'C') {
      const from = tokens[i + 1] ?? ''
      i += 2
      statuses.set(tokens[i] ?? '', { status: letter, from })
    } else {
      i++
      statuses.set(tokens[i] ?? '', { status: letter })
    }
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
    .map(([path, stat]) => ({ path, status: 'M', ...statuses.get(path), ...stat }))
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

// Drops git's file header (Code reads hunks alone) and cuts what is past MAX_DIFF_CHARS
// at a line, renumbering a hunk cut short so it still parses.
export function hunksOf(out: string): Pick<FileDiff, 'hunks' | 'isTruncated'> {
  const first = out.startsWith('@@') ? 0 : out.indexOf('\n@@') + 1
  if (first === 0 && !out.startsWith('@@')) return { hunks: '', isTruncated: false }
  const hunks = out.slice(first).replace(/\n$/, '')
  if (hunks.length <= MAX_DIFF_CHARS) return { hunks, isTruncated: false }

  let lines = hunks.slice(0, hunks.lastIndexOf('\n', MAX_DIFF_CHARS)).split('\n')
  let head = lines.findLastIndex(line => line.startsWith('@@'))
  if (head === lines.length - 1) {
    // The cut left the last hunk with a header and nothing under it.
    if (head > 0) return { hunks: lines.slice(0, head).join('\n'), isTruncated: true }
    // The only hunk starts with a line longer than a drawing (minified code): cut inside it.
    lines = hunks.slice(0, MAX_DIFF_CHARS).split('\n')
    head = 0
  }
  const body = lines.slice(head + 1)
  const old = body.filter(line => line.startsWith(' ') || line.startsWith('-')).length
  const now = body.filter(line => line.startsWith(' ') || line.startsWith('+')).length
  lines[head] = (lines[head] ?? '').replace(
    /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/,
    (_, a: string, c: string) => `@@ -${a},${old} +${c},${now} @@`,
  )
  return { hunks: lines.join('\n'), isTruncated: true }
}

async function diffFile($: EngineInterface, root: string, file: ChangedFile): Promise<Omit<FileDiff, 'path'>> {
  if (file.isBinary) return { hunks: '', isTruncated: false, error: null }
  const flags = ['diff', '--no-color', '--no-ext-diff']
  let ran
  if (file.status === '?') {
    ran = await git($, [...flags, '--no-index', '--', '/dev/null', file.path], root)
  } else {
    const head = await git($, ['rev-parse', '--short', '-q', '--verify', 'HEAD'], root)
    const base = head.exitCode === 0 ? 'HEAD' : EMPTY_TREE
    const paths = file.from === undefined ? [file.path] : [file.from, file.path]
    ran = await git($, [...flags, '-M', base, '--', ...paths], root)
  }
  // `--no-index` exits 1 when the files differ, which they do.
  if (ran.exitCode > 1) {
    return { hunks: '', isTruncated: false, error: ran.stderr.trim() || 'git diff failed' }
  }
  return { ...hunksOf(ran.stdout), error: null }
}

// Bumped each time the person opens a diff or leaves it. A load that began under an older
// generation is stale (Back, then the same file again) and must not write its result.
let diffGeneration = 0
// What the shown diff was last loaded from: a big diff is not re-run while this holds.
let loadedFrom: { path: string; source: string } | undefined

// What a file's diff is made from: its status, the commit it is diffed against, the rename
// source and the file's content in the work tree, so an edit that keeps the counts shows.
async function sourceOf($: EngineInterface, root: string, file: ChangedFile) {
  const [head, blob] = await Promise.all([
    git($, ['rev-parse', '-q', '--verify', 'HEAD'], root),
    git($, ['hash-object', '--', file.path], root),
  ])
  // A deleted file has no content to hash.
  const content = blob.exitCode === 0 ? blob.stdout.trim() : 'gone'
  return [file.status, head.stdout.trim(), file.from ?? '', content].join('|')
}

// One diff load at a time, in the order asked: opening a file can land while a poll's load
// is mid-way, and a later load reads later state, so it must also be the last to write.
let loading: Promise<void> = Promise.resolve()

function loadDiff($: EngineInterface): Promise<void> {
  const load = loading.then(() => loadDiffNow($))
  loading = load.catch(() => undefined)
  return load
}

// Reloads the diff on show: back to the list when its file no longer differs.
async function loadDiffNow($: EngineInterface) {
  // Taken before any await, so a view opened or left meanwhile makes this load stale.
  const generation = diffGeneration
  const [snap, shown] = await Promise.all([read($, snapshot), read($, diff)])
  if (snap === null || shown === null) return
  const file = snap.files.find(candidate => candidate.path === shown.path)
  if (file === undefined) {
    await update($, diff, current => (current?.path === shown.path && generation === diffGeneration ? null : current))
    return
  }
  // A poll skips re-running git on a large diff while what it is made from holds still.
  let source: string
  try {
    source = await sourceOf($, snap.root, file)
  } catch {
    source = ''
  }
  if (
    source !== '' &&
    shown.hunks !== null &&
    shown.hunks.length > LARGE_DIFF_CHARS &&
    loadedFrom?.path === file.path &&
    loadedFrom.source === source
  ) {
    return
  }
  let loaded: Omit<FileDiff, 'path'>
  try {
    loaded = await diffFile($, snap.root, file)
  } catch (error) {
    loaded = { hunks: '', isTruncated: false, error: error instanceof Error ? error.message : String(error) }
  }
  // Keep the same value when nothing moved, so a poll does not redraw; and drop a load
  // the person has since left (Back, or another file, or the same file reopened).
  await update($, diff, current => {
    if (generation !== diffGeneration || current?.path !== file.path) return current
    loadedFrom = { path: file.path, source }
    return current.hunks === loaded.hunks && current.isTruncated === loaded.isTruncated && current.error === loaded.error
      ? current
      : { path: file.path, ...loaded }
  })
}

async function showDiff($: EngineInterface, path: string) {
  diffGeneration++
  loadedFrom = undefined
  await update($, diff, () => ({ path, hunks: null, isTruncated: false, error: null }))
  await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)
  await loadDiff($)
}

async function showList($: EngineInterface, path: string) {
  diffGeneration++
  loadedFrom = undefined
  await update($, diff, () => null)
  await $.ui.scroll({ in: PANE, to: { key: `diff:${path}` } }).catch(() => undefined)
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
        await loadDiff($)
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
    diffGeneration++
    loadedFrom = undefined
    await update($, diff, () => null)
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
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const [snap, open] = await Promise.all([read($, snapshot), read($, diff)])
    const width = e.props.bodyColumns

    if (snap === null) {
      return <Text dimColor>Scanning…</Text>
    }
    if (snap.error !== null) {
      return (
        <Box flexDirection="column">
          <Text color="error">{snap.error}</Text>
          <Button key="refresh" label="↻ Refresh" hotkey="r" onPress={() => refresh($)} />
        </Box>
      )
    }

    const statusText = (file: ChangedFile) => (file.status === '?' ? '??' : file.status).padEnd(2)

    const viewed = open === null ? undefined : snap.files.find(file => file.path === open.path)
    if (open !== null && viewed !== undefined) {
      const body =
        open.error !== null ? (
          <Text color="error">{open.error}</Text>
        ) : open.hunks === null ? (
          <Text dimColor>Loading diff…</Text>
        ) : open.hunks === '' ? (
          <Text dimColor>{viewed.isBinary ? 'Binary file: no text diff' : 'No text changes to show'}</Text>
        ) : (
          <Code source={open.hunks} path={viewed.path} format="diff" />
        )
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Button key="back" label="← Back" hotkey="b" onPress={() => showList($, viewed.path)} />
            <Text> </Text>
            <Text color={STATUS_COLOR[viewed.status] ?? 'text'} bold>
              {statusText(viewed)}{' '}
            </Text>
            <Text wrap="truncate-start">{viewed.path}</Text>
          </Box>
          {viewed.from !== undefined && <Text dimColor>from {viewed.from}</Text>}
          <Text dimColor>{'─'.repeat(Math.max(1, width))}</Text>
          {body}
          {open.isTruncated && <Text dimColor>…cut here: the rest is too long to show</Text>}
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
            {statusText(file)}{' '}
          </Text>
          <Box width={pathWidth}>
            <Button key={`diff:${file.path}`} plain onPress={() => showDiff($, file.path)}>
              {label}
            </Button>
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
          <Button key="refresh" label="↻ Refresh" hotkey="r" onPress={() => refresh($)} />
        </Box>
      </Box>
    )
  })
}
