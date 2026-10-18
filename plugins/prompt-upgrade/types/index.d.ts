export type UpgradePhase = 'start' | 'asking' | 'questions' | 'writing' | 'done' | 'error'

export type UpgradeView = {
  phase: UpgradePhase
  /** The short prompt the person started from */
  original: string
  /** The quick questions the model asked */
  questions: string[]
  /** The detailed prompt, once written */
  result: string
  /** What went wrong, in the 'error' phase */
  error: string
  /** Bumped on every new run so the fields redraw empty */
  round: number
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-upgrade': { view: UpgradeView; answers: string[]; draft: string }
  }
}
