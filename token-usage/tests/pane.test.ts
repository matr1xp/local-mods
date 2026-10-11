import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'token-usage',
  component: 'Pane',
  requestId: 'token-usage',
  props: {
    title: 'Token usage',
    isFocused: false,
    bodyColumns: 46,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 28 },
    view: {},
  },
  viewport: { columns: 48, rows: 30 },
} as const

const USAGE = {
  model: 'claude-opus-5-5',
  input_tokens: 1_234,
  output_tokens: 56_000,
  cache_read_input_tokens: 2_500_000,
  cache_creation_input_tokens: 80_000,
}

test('pane adds up model requests and shows the latest measurement', async ($, on) => {
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: USAGE,
    }
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))

  const step = { turnId: 't1', model: 'claude-opus-5-5', messageCount: 3 }
  for (const [index, agentId] of [[0, undefined], [1, 'sub-1']] as const) {
    const stream = $.turn.step({ ...step, index, ...(agentId ? { agentId } : {}) })
    for await (const _ of stream) {
      // drain
    }
  }
  await $.session.measure({
    context: { tokens: 96_200, window: 200_000, percent: 48 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 23.5 }],
    cost: { usd: 1.234 },
    changed: ['context', 'rateLimits', 'cost'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /48%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /96k \/ 200k tokens/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /in 2\.5k · out 112k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /cache read 5\.0M/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 requests \(1 subagent\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /cost \$1\.23/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Last request \(subagent\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5h .* 23\.5%/ })).toBeDefined()
    await ui.unmount()
  }
})

test('pane says when there is no reading yet', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /No reading yet/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0 requests/ })).toBeDefined()
  await ui.unmount()
})
