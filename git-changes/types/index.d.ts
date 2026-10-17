/**
 * One changed file, as `git diff --numstat` / `--name-status` against HEAD
 * report it (staged and unstaged together), or an untracked file.
 */
export type ChangedFile = {
  /** Repo-relative path (the new path for a rename). */
  path: string
  /** git's status letter (M, A, D, R, C, T, U), or `?` for untracked. */
  status: string
  /** Lines added; null when binary or not counted. */
  added: number | null
  /** Lines deleted; null when binary or not counted. */
  deleted: number | null
  isBinary: boolean
}

export type Snapshot = {
  /** The repository's top level, absolute; '' when the scan failed. */
  root: string
  branch: string
  files: ChangedFile[]
  /** Paths whose stats changed in the latest scan that found a difference. */
  fresh: string[]
  /** When the list last changed, ms since the epoch. */
  changedAt: number
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'git-changes': { snapshot: Snapshot | null }
  }
}
