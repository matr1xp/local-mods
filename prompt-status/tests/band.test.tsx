import { expect, mock, test } from 'claude-code/testing'

import { modelName, parseStatus, untilReset, windowName } from '../hooks/register'

const BAND = {
  plugin: 'prompt-status',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
  viewport: { columns: 105, rows: 40 },
} as const

test('band shows model, context fill and usage with its reset', async ($, on) => {
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 8, 12) })
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: e.model,
        input_tokens: 10,
        output_tokens: 10,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))

  for await (const _ of $.turn.step({
    turnId: 't1',
    index: 0,
    model: 'claude-opus-5-5',
    messageCount: 1,
  })) {
    // drain
  }
  const resetsAt = new Date(clock.now() + 36 * 60_000 - 1_000).toISOString()
  await $.session.measure({
    context: { tokens: 240_000, window: 1_000_000, percent: 24 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 40 },
      { kind: 'five_hour', percentUsed: 89, resetsAt },
    ],
    changed: ['context', 'rateLimits'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '[Opus 5.5 (1M context)]' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / 24%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / 89%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /resets in 36m/ })).toBeDefined()
    // The context bar is a flame on the terminal and text elsewhere; usage stays text.
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Raster' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^██$/ })).toBeUndefined()
    } else {
      expect(await ui.find({ type: 'Raster' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^██$/ })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: '█████████' })).toBeDefined()
    await ui.unmount()
  }
})

test('band yields to a survey', async ($, on) => {
  // Stands for the engine's own band, which a survey fills.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>survey</Text>
  })
  const ui = await $.ui.mount({
    ...BAND,
    surface: 'terminal',
    props: { ...BAND.props, hasSurvey: true },
  })
  expect(await ui.find({ type: 'Text', text: 'survey' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Context/ })).toBeUndefined()
  await ui.unmount()
})

test('formatting helpers', () => {
  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
  expect(modelName('claude-fable-5-1')).toBe('Fable 5.1')
  expect(modelName('opus[1m]')).toBe('Opus')
  expect(windowName(1_000_000)).toBe('1M')
  expect(windowName(200_000)).toBe('200k')
  expect(untilReset(new Date(3_600_000 + 125 * 60_000).toISOString(), 3_600_000)).toBe('2h 5m')
  expect(untilReset(undefined, 0)).toBe('')
  expect(parseStatus('# branch.oid abc1234def\n# branch.head main\n1 .M N... a b\n')).toEqual({
    branch: 'main',
    isDirty: true,
  })
  expect(parseStatus('# branch.oid abc1234def\n# branch.head (detached)\n')).toEqual({
    branch: 'abc1234',
    isDirty: false,
  })
})
