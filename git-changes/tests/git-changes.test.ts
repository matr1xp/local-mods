import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

// The test runner has timers; the mod's typings name no host, so they are declared here.
declare function setTimeout(callback: () => void, ms: number): unknown

const PANE_PROPS = {
  title: 'Changes',
  isFocused: false,
  bodyColumns: 70,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

const ok = (stdout: string, exitCode = 0): { value: ProcessRunResult } => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

const CHANGES = {
  command: 'changes',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

const APP_DIFF =
  'diff --git a/src/app.ts b/src/app.ts\nindex 1111111..2222222 100644\n--- a/src/app.ts\n+++ b/src/app.ts\n' +
  '@@ -1,2 +1,2 @@\n const a = 1\n-const b = 2\n+const b = 3\n'

// A fake repo: a modified, a deleted, a binary, a renamed and an untracked file.
// `diffs` holds what `git diff -- <path>` prints for a file; `ran` collects each git call;
// `repo` names the commit HEAD points at and a file's work-tree content, its diff when unset;
// a git call named in `repo.held` is answered as it is made, but only once that promise settles.
type Repo = { head: string; contents: Record<string, string>; held?: Record<string, Promise<void>> }
function fakeGit(
  on: On,
  numstat: { current: string },
  diffs: Record<string, string> = {},
  ran: string[] = [],
  repo: Repo = { head: 'abc1234def', contents: {} },
) {
  on('process.run', async (_$, e) => {
    const args = e.argv.slice(1).join(' ')
    ran.push(args)
    const answer = answerGit(args)
    const held = repo.held?.[args]
    if (held !== undefined) {
      delete repo.held?.[args]
      await held
    }
    return answer
  })
  on('ui.open', () => ({ value: { isPlaced: true } as const }))

  function answerGit(args: string) {
    const shown = /^diff --no-color --no-ext-diff (?:-M HEAD|--no-index) -- (.+)$/.exec(args)?.[1]
    if (shown !== undefined) return ok(diffs[shown] ?? '', shown.startsWith('/dev/null') ? 1 : 0)
    if (args === 'rev-parse --show-toplevel') return ok('/repo\n')
    if (args === 'symbolic-ref --short -q HEAD') return ok('feature/x\n')
    if (args === 'rev-parse --short -q --verify HEAD') return ok('abc1234\n')
    if (args === 'rev-parse -q --verify HEAD') return ok(`${repo.head}\n`)
    // A file's content stands in for its blob id.
    const hashed = /^hash-object -- (.+)$/.exec(args)?.[1]
    if (hashed !== undefined) return ok(`${repo.contents[hashed] ?? diffs[hashed] ?? ''}\n`)
    if (args === 'diff -M --numstat -z HEAD') return ok(numstat.current)
    if (args === 'diff -M --name-status -z HEAD') {
      return ok('M\0src/app.ts\0D\0old.ts\0M\0logo.png\0R100\0a.ts\0b.ts\0')
    }
    if (args === 'ls-files --others --exclude-standard -z') return ok('notes.md\0')
    if (args === 'diff --no-index --numstat -z -- /dev/null notes.md') {
      return ok('5\t0\t\0/dev/null\0notes.md\0', 1)
    }
    throw new Error(`unexpected git ${args}`)
  }
}

const NUMSTAT = '12\t3\tsrc/app.ts\0' + '0\t7\told.ts\0' + '-\t-\tlogo.png\0' + '0\t0\t\0a.ts\0b.ts\0'

test('/changes opens the pane and sums the diff stats', async ($, on) => {
  mock.clock(on, { now: 0 })
  fakeGit(on, { current: NUMSTAT })

  const answer = await $.command.run(CHANGES)

  expect(answer.text).toContain('5 files changed, +17 -10')
})

test('the pane lists each file with colored stats on every surface', async ($, on) => {
  mock.clock(on, { now: 0 })
  fakeGit(on, { current: NUMSTAT })
  await $.command.run(CHANGES)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'git-changes',
      surface,
      component: 'Pane',
      requestId: 'git-changes',
      props: PANE_PROPS,
    })
    expect(await ui.find({ type: 'Text', text: 'feature/x' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '+12' }))?.props.color).toBe('success')
    expect((await ui.find({ type: 'Text', text: '-7' }))?.props.color).toBe('error')
    expect(await ui.find({ type: 'Text', text: 'bin' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+5' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: 'D ' }))?.props.color).toBe('error')
    expect((await ui.find({ type: 'Button', key: 'refresh' }))?.props.label).toBe('↻ Refresh')
    await ui.unmount()
  }
})

const mountPane = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'git-changes', surface, component: 'Pane', requestId: 'git-changes', props: PANE_PROPS })

test('pressing a file shows its diff in the pane, and Back returns to the list, on every surface', async ($, on) => {
  mock.clock(on, { now: 0 })
  fakeGit(on, { current: NUMSTAT }, { 'src/app.ts': APP_DIFF })
  await $.command.run(CHANGES)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    const keys = (await ui.findAll({ type: 'Button' })).map(button => button.key).filter(key => key?.startsWith('diff:'))
    // Every file has a diff, the deleted one too.
    expect(keys).toEqual(['diff:b.ts', 'diff:logo.png', 'diff:old.ts', 'diff:src/app.ts', 'diff:notes.md'])

    await ui.press({ key: 'diff:src/app.ts' })
    const code = await ui.find({ type: 'Code' })
    expect(code?.props.format).toBe('diff')
    // git's file header is dropped: Code reads hunks alone.
    expect(code?.props.source).toBe('@@ -1,2 +1,2 @@\n const a = 1\n-const b = 2\n+const b = 3')
    expect(await ui.find({ type: 'Text', text: 'src/app.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'diff:old.ts' })).toBeUndefined()

    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'diff:old.ts' })).toBeDefined()
    await ui.unmount()
  }
})

test('an untracked file diffs against /dev/null, a rename names both paths', async ($, on) => {
  mock.clock(on, { now: 0 })
  const ran: string[] = []
  fakeGit(on, { current: NUMSTAT }, { '/dev/null notes.md': '--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1 @@\n+hi\n' }, ran)
  await $.command.run(CHANGES)
  const ui = await mountPane($)

  await ui.press({ key: 'diff:notes.md' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -0,0 +1 @@\n+hi')

  await ui.press({ key: 'back' })
  await ui.press({ key: 'diff:b.ts' })
  expect(ran).toContain('diff --no-color --no-ext-diff -M HEAD -- a.ts b.ts')
  // A pure rename has no hunks.
  expect(await ui.find({ type: 'Text', text: 'No text changes to show' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'from a.ts' })).toBeDefined()

  await ui.press({ key: 'back' })
  await ui.press({ key: 'diff:logo.png' })
  expect(await ui.find({ type: 'Text', text: 'Binary file: no text diff' })).toBeDefined()
  await ui.unmount()
})

test('a diff too long to draw is cut at a line, its last hunk renumbered', async ($, on) => {
  mock.clock(on, { now: 0 })
  const added = Array.from({ length: 20_000 }, (_, i) => `+line ${i}`).join('\n')
  fakeGit(on, { current: NUMSTAT }, { 'src/app.ts': `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -0,0 +1,20000 @@\n${added}\n` })
  await $.command.run(CHANGES)
  const ui = await mountPane($)

  await ui.press({ key: 'diff:src/app.ts' })
  const source = String((await ui.find({ type: 'Code' }))?.props.source)
  expect(source.length).toBeLessThanOrEqual(90_000)
  const kept = source.split('\n').length - 1
  expect(source.startsWith(`@@ -0,0 +1,${kept} @@\n+line 0\n`)).toBe(true)
  expect(await ui.find({ type: 'Text', text: /cut here/ })).toBeDefined()
  await ui.unmount()
})

test('a single line longer than a drawing is cut inside the line', async ($, on) => {
  mock.clock(on, { now: 0 })
  const minified = `+${'x'.repeat(200_000)}`
  fakeGit(on, { current: NUMSTAT }, { 'src/app.ts': `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -0,0 +1 @@\n${minified}\n` })
  await $.command.run(CHANGES)
  const ui = await mountPane($)

  await ui.press({ key: 'diff:src/app.ts' })
  const source = String((await ui.find({ type: 'Code' }))?.props.source)
  expect(source.length).toBeLessThan(100_000)
  expect(source.startsWith('@@ -0,0 +1,1 @@\n+xxxx')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /cut here/ })).toBeDefined()
  await ui.unmount()
})

test('a cut that lands just after a hunk header drops the empty hunk', async ($, on) => {
  mock.clock(on, { now: 0 })
  const first = `@@ -1,0 +1,1 @@\n+${'a'.repeat(1000)}`
  const raw = `--- a/src/app.ts\n+++ b/src/app.ts\n${first}\n@@ -50,0 +51,1 @@\n+${'b'.repeat(200_000)}\n`
  fakeGit(on, { current: NUMSTAT }, { 'src/app.ts': raw })
  await $.command.run(CHANGES)
  const ui = await mountPane($)

  await ui.press({ key: 'diff:src/app.ts' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe(first)
  expect(await ui.find({ type: 'Text', text: /cut here/ })).toBeDefined()
  await ui.unmount()
})

// A large diff of src/app.ts whose counts stay +20000 -0 whatever `word` is.
const largeDiff = (word: string) => {
  const added = Array.from({ length: 20_000 }, (_, i) => `+${word} ${i}`).join('\n')
  return `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -0,0 +1,20000 @@\n${added}\n`
}

// A tool call, as after an Edit, with the pane up: the mod rescans and reloads the diff.
function afterTool(on: On) {
  on('tool.call', () => ({ result: {} }))
  on('ui.panes', () => ({
    value: [{ id: 'git-changes', title: 'Changes', isShown: true, isFocused: false, isPlaced: true }],
  }))
}

test('a large diff is not re-run while its file holds still', async ($, on) => {
  mock.clock(on, { now: 0 })
  const ran: string[] = []
  fakeGit(on, { current: NUMSTAT }, { 'src/app.ts': largeDiff('line') }, ran)
  afterTool(on)
  await $.command.run(CHANGES)
  const ui = await mountPane($)
  await ui.press({ key: 'diff:src/app.ts' })

  const diffRuns = () => ran.filter(args => args.startsWith('diff --no-color')).length
  const before = diffRuns()
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(diffRuns()).toBe(before)
  await ui.unmount()
})

test('a large diff reloads when an edit keeps its counts, or HEAD moves', async ($, on) => {
  mock.clock(on, { now: 0 })
  const diffs = { 'src/app.ts': largeDiff('line') }
  const repo: Repo = { head: 'abc1234def', contents: {} }
  fakeGit(on, { current: NUMSTAT }, diffs, [], repo)
  afterTool(on)
  await $.command.run(CHANGES)
  const ui = await mountPane($)
  await ui.press({ key: 'diff:src/app.ts' })
  const source = async () => String((await ui.find({ type: 'Code' }))?.props.source)
  expect(await source()).toContain('+line 0\n')

  // The same +/- counts, other text.
  diffs['src/app.ts'] = largeDiff('word')
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(await source()).toContain('+word 0\n')

  // An amend: the same work tree and counts, diffed against another commit.
  repo.contents['src/app.ts'] = diffs['src/app.ts']
  diffs['src/app.ts'] = largeDiff('amended')
  repo.head = 'fed4321cba'
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(await source()).toContain('+amended 0\n')
  await ui.unmount()
})

test('a diff load that finishes late does not overwrite a newer one', async ($, on) => {
  mock.clock(on, { now: 0 })
  const diffs = { 'src/app.ts': APP_DIFF }
  // The load from opening the file reads git first and answers last, so a poll overtakes it.
  let release = () => {}
  const held = { 'diff --no-color --no-ext-diff -M HEAD -- src/app.ts': new Promise<void>(r => (release = r)) }
  const ran: string[] = []
  fakeGit(on, { current: NUMSTAT }, diffs, ran, { head: 'abc1234def', contents: {}, held })
  afterTool(on)
  await $.command.run(CHANGES)
  const ui = await mountPane($)
  const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
  const until = async (args: string, count: number) => {
    for (let i = 0; i < 1000 && ran.filter(each => each === args).length < count; i++) await tick()
  }
  const press = ui.press({ key: 'diff:src/app.ts' })
  await until('diff --no-color --no-ext-diff -M HEAD -- src/app.ts', 1)
  diffs['src/app.ts'] = APP_DIFF.replace('const b = 3', 'const b = 4')
  // The poll scans, then gets as far with its own load as it may before the first answers.
  const call = $.tool.call({ tool: 'Bash', command: 'ls' })
  await until('diff --no-index --numstat -z -- /dev/null notes.md', 2)
  for (let i = 0; i < 20; i++) await tick()
  release()
  await Promise.all([press, call])
  expect((await ui.find({ type: 'Code' }))?.props.source).toContain('+const b = 4')
  await ui.unmount()
})

test('the diff goes back to the list once its file no longer differs', async ($, on) => {
  mock.clock(on, { now: 0 })
  const numstat = { current: NUMSTAT }
  fakeGit(on, numstat, { 'src/app.ts': APP_DIFF })
  await $.command.run(CHANGES)
  const ui = await mountPane($)
  await ui.press({ key: 'diff:src/app.ts' })
  expect(await ui.find({ type: 'Code' })).toBeDefined()

  // Reverted: gone from the numstat. A refresh (the r key on the list, or the poll) drops the diff.
  numstat.current = NUMSTAT.replace('12\t3\tsrc/app.ts\0', '')
  await ui.unmount()
  await $.command.run(CHANGES)
  const again = await mountPane($)
  expect(await again.find({ type: 'Code' })).toBeUndefined()
  expect(await again.find({ type: 'Button', key: 'diff:src/app.ts' })).toBeUndefined()
  await again.unmount()
})

test('a file whose stats move is highlighted until the next change', async ($, on) => {
  mock.clock(on, { now: 0 })
  const numstat = { current: NUMSTAT }
  fakeGit(on, numstat)
  await $.command.run(CHANGES)

  numstat.current = NUMSTAT.replace('12\t3\tsrc/app.ts', '20\t3\tsrc/app.ts')
  await $.command.run(CHANGES)

  const ui = await $.ui.mount({
    plugin: 'git-changes',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'git-changes',
    props: PANE_PROPS,
  })
  expect((await ui.find({ type: 'Text', text: '+20' }))?.props.bold).toBe(true)
  expect((await ui.find({ type: 'Text', text: '-7' }))?.props.bold).toBe(false)
  expect(await ui.find({ type: 'Text', text: /just changed/ })).toBeDefined()
  await ui.unmount()
})
