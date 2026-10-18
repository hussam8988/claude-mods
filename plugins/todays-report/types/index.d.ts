export type ReportRange = 'day' | 'week' | 'month' | 'year'

declare module 'claude-code' {
  interface PluginState {
    'todays-report': { range: ReportRange; tick: number }
  }
}
