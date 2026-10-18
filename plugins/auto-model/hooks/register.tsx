import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AutoModelPick } from '../types'

// Auto Model — picks the right model ONCE, from the first prompt of a session,
// and keeps it for the whole session. It never switches mid-session: the prompt
// cache is tied to the model, so switching back and forth would make the new
// model re-read the whole conversation and cost more than it saves.

const MODELS = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
} as const
type Tier = keyof typeof MODELS
const NAMES: Record<Tier, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }

const pickAtom = atom({ plugin: 'auto-model', key: 'pick' } as const, null as AutoModelPick | null)
const decidedAtom = atom({ plugin: 'auto-model', key: 'decided' } as const, false)

const RULES = `You route a user's first message in a coding/assistant session to a model tier.
Reply with exactly one word: haiku, sonnet, or opus.
- haiku: a quick question, a definition, a one-line fix, a small lookup, a short rewrite, chit-chat.
- sonnet: normal work — writing or editing a file or two, debugging, a script, a summary, a page of writing, research with a few steps.
- opus: a big build or hard problem — a new app/site/feature across many files, architecture, a large refactor, a long multi-step plan, a deep analysis, anything ambiguous and high-stakes.
When unsure between two, pick the larger one.`

function isTier(x: unknown): x is Tier {
  return x === 'haiku' || x === 'sonnet' || x === 'opus'
}

async function isEnabled($: any): Promise<boolean> {
  const v = await $.store.get('enabled')
  return v !== false
}

async function chooseTier($: any, text: string): Promise<Tier> {
  const r = await $.model.complete({
    model: 'haiku',
    system: RULES,
    prompt: 'Message:\n"""\n' + text.slice(0, 4000) + '\n"""\nTier:',
    maxTokens: 5,
    effort: 'low',
    timeoutMs: 8000,
  })
  const word = r.isAnswered ? r.text.trim().toLowerCase().replace(/[^a-z]/g, '') : ''
  return isTier(word) ? word : 'sonnet'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const out = await next(e)
    try {
      await $.command.register({
        name: 'auto-model',
        description: 'Auto Model: show the pick, or on | off | haiku | sonnet | opus',
        argumentHint: '[on|off|haiku|sonnet|opus]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('auto-model: could not add /auto-model (' + String(err) + ')')
    }
    return out
  })

  // Decide once, at the first main-loop turn of the session.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (await read($, decidedAtom)) return next(e)
    await update($, decidedAtom, () => true)

    if (!(await isEnabled($))) return next(e)

    // A resumed session already has a cache on its model: keep it.
    const turns = await $.session.turns()
    // The person picked a model with /model: respect it.
    const rows = await $.config.list()
    const modelRow = rows.find(row => row.key === 'model')
    const manual = modelRow !== undefined && !/default/i.test(String(modelRow.value))
    if (turns > 1 || manual) return next(e)

    const text = (e.text || '').trim()
    if (text === '') return next(e)

    let tier: Tier = 'sonnet'
    try {
      tier = await chooseTier($, text)
    } catch {
      tier = 'sonnet'
    }
    const pick: AutoModelPick = { tier, model: MODELS[tier], how: 'auto' }
    await update($, pickAtom, () => pick)
    $.ui.toast('Auto Model picked ' + NAMES[tier] + ' for this session')
    $.ui.status('Auto Model: ' + NAMES[tier])
    return next(e)
  })

  // Every main-loop request of the session goes to the picked model.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const pick = await read($, pickAtom)
    if (pick === null || pick.how === 'kept') return yield* next(e)
    return yield* next({ ...e, model: pick.model })
  })

  on('command.run', { command: 'auto-model' }, async ($, e) => {
    const arg = (e.args || '').trim().toLowerCase()
    const pick = await read($, pickAtom)
    const turns = await $.session.turns()

    if (arg === 'off') {
      await $.store.set('enabled', false)
      return { text: 'Auto Model is off for new sessions. This session keeps ' + (pick ? NAMES[pick.tier] : 'its current model') + '.' }
    }
    if (arg === 'on') {
      await $.store.set('enabled', true)
      return { text: 'Auto Model is on. It picks a model from the first prompt of each new session.' }
    }
    if (isTier(arg)) {
      if (turns > 0 && pick !== null) {
        return {
          text: 'This session already runs on ' + NAMES[pick.tier] + '. Switching mid-session breaks the prompt cache and usually costs more — start a new session and run /auto-model ' + arg + ' before your first prompt, or use /model if you really want to switch.',
        }
      }
      await update($, decidedAtom, () => true)
      await update($, pickAtom, () => ({ tier: arg, model: MODELS[arg], how: 'forced' as const }))
      $.ui.status('Auto Model: ' + NAMES[arg])
      return { text: 'This session will use ' + NAMES[arg] + '.' }
    }

    const enabled = await isEnabled($)
    const now = pick ? NAMES[pick.tier] + (pick.how === 'forced' ? ' (you chose it)' : ' (picked from your first prompt)') : 'not picked yet — it picks from your first prompt'
    return {
      text: 'Auto Model is ' + (enabled ? 'on' : 'off') + '. This session: ' + now + '.\nUse /auto-model off, on, or haiku | sonnet | opus (before your first prompt).',
    }
  })
}
