export type Limit = { percentUsed: number; resetsAt?: string }

export type Reading = {
  model: string | null
  contextWindow: number | null
  contextPercent: number | null
  limit: Limit | null
}

export type Git = { dir: string; branch: string | null; isDirty: boolean }

declare module 'claude-code' {
  interface PluginState {
    'prompt-status': {
      reading: Reading
      git: Git | null
      now: number
      shown: number
    }
  }
}
