import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunResult } from 'claude-code'

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

// A fake repo: a modified, a deleted, a binary, a renamed and an untracked file.
// `opened` collects what a press handed to `open`.
function fakeGit(on: On, numstat: { current: string }, opened: string[] = []) {
  on('process.run', ($, e) => {
    if (e.argv[0] === 'open') {
      opened.push(e.argv.slice(1).join(' '))
      return ok('')
    }
    const args = e.argv.slice(1).join(' ')
    if (args === 'rev-parse --show-toplevel') return ok('/repo\n')
    if (args === 'symbolic-ref --short -q HEAD') return ok('feature/x\n')
    if (args === 'rev-parse --short -q --verify HEAD') return ok('abc1234\n')
    if (args === 'diff -M --numstat -z HEAD') return ok(numstat.current)
    if (args === 'diff -M --name-status -z HEAD') {
      return ok('M\0src/app.ts\0D\0old.ts\0M\0logo.png\0R100\0a.ts\0b.ts\0')
    }
    if (args === 'ls-files --others --exclude-standard -z') return ok('notes.md\0')
    if (args === 'diff --no-index --numstat -z -- /dev/null notes.md') {
      return ok('5\t0\t\0/dev/null\0notes.md\0', 1)
    }
    throw new Error(`unexpected git ${args}`)
  })
  on('ui.open', () => ({ value: { isPlaced: true } as const }))
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
    await ui.unmount()
  }
})

test('pressing a file opens it in its default app on every surface', async ($, on) => {
  mock.clock(on, { now: 0 })
  const opened: string[] = []
  fakeGit(on, { current: NUMSTAT }, opened)
  await $.command.run(CHANGES)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'git-changes',
      surface,
      component: 'Pane',
      requestId: 'git-changes',
      props: PANE_PROPS,
    })
    const keys = (await ui.findAll({ type: 'Button' })).map(button => button.key).filter(key => key?.startsWith('open:'))
    // old.ts is deleted, so it is the one file that cannot be opened.
    expect(keys).toEqual(['open:b.ts', 'open:logo.png', 'open:src/app.ts', 'open:notes.md'])
    await ui.press({ key: 'open:src/app.ts' })
    await ui.unmount()
  }
  expect(opened).toEqual(['/repo/src/app.ts', '/repo/src/app.ts'])
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
