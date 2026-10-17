export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type Totals = Tokens & { requests: number; subagentRequests: number }

export type LastRequest = Tokens & { model: string; isSubagent: boolean }

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Snapshot = {
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  rateLimits: Limit[]
  costUsd?: number
}

/** The context fill and cost the pane draws while they ease toward the snapshot. */
export type Shown = { context: number; cost: number }

declare module 'claude-code' {
  interface PluginState {
    'token-usage': {
      totals: Totals
      last: LastRequest | null
      snapshot: Snapshot | null
      shown: Shown
    }
  }
}
