export type AutoModelPick = {
  /** The tier picked for this session */
  tier: 'haiku' | 'sonnet' | 'opus'
  /** The model id every main-loop request of this session is sent to */
  model: string
  /** Why: 'auto' (classified), 'forced' (/auto-model <tier>), 'kept' (manual /model or resumed session) */
  how: 'auto' | 'forced' | 'kept'
}

declare module 'claude-code' {
  interface PluginState {
    'auto-model': { pick: AutoModelPick | null; decided: boolean }
  }
}
