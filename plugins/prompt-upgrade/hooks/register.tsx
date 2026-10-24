import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { UpgradeView } from '../types'

// Prompt Upgrade — /prompt-upgrade <short prompt>
// Asks a few quick questions, then rewrites the short prompt into a detailed
// one you can edit, copy, put in the prompt box, or run with one click.

const PANE = 'prompt-upgrade'
const EMPTY: UpgradeView = { phase: 'start', original: '', questions: [], result: '', error: '', round: 0 }

const view = atom({ plugin: 'prompt-upgrade', key: 'view' } as const, EMPTY)
const answers = atom({ plugin: 'prompt-upgrade', key: 'answers' } as const, [] as string[])
const draft = atom({ plugin: 'prompt-upgrade', key: 'draft' } as const, '')

const ASK_SYSTEM = `You help someone turn a short request to an AI assistant into a detailed, high-quality prompt.
Before rewriting, you ask the few questions whose answers would change the result the most:
the goal or audience, the scope, the format or deliverable, constraints (tools, length, style, deadline), and what "done" looks like.
Ask 3 questions (never more than 4). Each is one short, plain sentence a busy person can answer in a few words.
Skip anything the request already answers. Reply with ONLY a JSON array of strings, nothing else.`

const WRITE_SYSTEM = `You rewrite a short request into a detailed prompt for an AI coding/work assistant (Claude Code).
Write it in the person's own voice ("I want...", "Build...").
Include, as fits: the goal and why, context, specific requirements, the deliverable and its format, constraints, quality bar, and how to check it is done.
Use the person's answers; where they skipped a question, choose a sensible default and say so briefly in the prompt.
Keep it tight: short sections or bullets, no filler, no preamble. Reply with ONLY the finished prompt.`

function parseQuestions(text: string): string[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start >= 0 && end > start) {
    try {
      const list = JSON.parse(text.slice(start, end + 1))
      if (Array.isArray(list)) {
        const qs = list.map(q => String(q).trim()).filter(q => q.length > 0)
        if (qs.length > 0) return qs.slice(0, 4)
      }
    } catch {
      // fall through to line parsing
    }
  }
  return text
    .split('\n')
    .map(line => line.replace(/^[\s\-*\d.)]+/, '').trim())
    .filter(line => line.endsWith('?'))
    .slice(0, 4)
}

async function begin($: any, original: string) {
  const text = original.trim()
  if (text === '') return
  const before = await read($, view)
  const round = before.round + 1
  await update($, answers, () => [])
  await update($, draft, () => '')
  await update($, view, () => ({ ...EMPTY, phase: 'asking' as const, original: text, round }))

  const r = await $.model.complete({
    model: 'haiku',
    system: ASK_SYSTEM,
    prompt: 'Request:\n"""\n' + text + '\n"""',
    maxTokens: 400,
    effort: 'low',
    timeoutMs: 30000,
  })
  if (!r.isAnswered) {
    await update($, view, v => ({ ...v, phase: 'error' as const, error: 'Could not get questions (' + r.reason + ').' }))
    return
  }
  const questions = parseQuestions(r.text)
  if (questions.length === 0) {
    await write($)
    return
  }
  await update($, view, v => ({ ...v, phase: 'questions' as const, questions }))
}

async function write($: any) {
  const v = await read($, view)
  const given = await read($, answers)
  await update($, view, cur => ({ ...cur, phase: 'writing' as const }))

  const qa = v.questions
    .map((q, i) => 'Q: ' + q + '\nA: ' + ((given[i] || '').trim() || '(skipped)'))
    .join('\n\n')
  const r = await $.model.complete({
    model: 'sonnet',
    system: WRITE_SYSTEM,
    prompt: 'Short request:\n"""\n' + v.original + '\n"""\n\nQuestions and answers:\n' + (qa || '(none)') + '\n\nThe detailed prompt:',
    maxTokens: 2000,
    timeoutMs: 90000,
  })
  if (!r.isAnswered) {
    await update($, view, cur => ({ ...cur, phase: 'error' as const, error: 'Could not write the prompt (' + r.reason + ').' }))
    return
  }
  const result = r.text.trim()
  await update($, draft, () => result)
  await update($, view, cur => ({ ...cur, phase: 'done' as const, result }))
}

async function finalText($: any): Promise<string> {
  const edited = await read($, draft)
  const v = await read($, view)
  return (edited || v.result).trim()
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const out = await next(e)
    try {
      await $.command.register({
        name: 'prompt-upgrade',
        description: 'Prompt Upgrade: answer a few questions, get a detailed prompt',
        argumentHint: '<your short prompt>',
      })
    } catch (err) {
      $.ui.log('prompt-upgrade: could not add /prompt-upgrade (' + String(err) + ')')
    }
    return out
  })

  on('command.run', { command: 'prompt-upgrade' }, async ($, e) => {
    const opened = await $.ui.open({ id: PANE, title: 'Prompt Upgrade', focus: true })
    const text = (e.args || '').trim()
    if (text === '') {
      const v = await read($, view)
      await update($, view, () => ({ ...EMPTY, round: v.round + 1 }))
    } else {
      void begin($, text)
    }
    if (!opened.isPlaced) {
      return { text: 'Prompt Upgrade could not open its panel here (' + String((opened as any).reason || 'no panel') + '). It works in the Code tab of the desktop app and in a terminal session.' }
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e) as any
    const v = await read($, view)
    const width = Math.max(30, (e.props as any).bodyColumns ?? 60)

    const header = (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Prompt Upgrade</Text>
        {v.original !== '' && <Text dimColor wrap="wrap">Your prompt: {v.original}</Text>}
      </Box>
    )

    if (v.phase === 'start') {
      return (
        <Box flexDirection="column" width={width}>
          {header}
          <Text>Type a short prompt and press Enter. I'll ask a few quick questions, then write a detailed version.</Text>
          {Input && (
            <Input
              key={'start-' + v.round}
              label="Prompt: "
              placeholder="e.g. make a landing page for my honey brand"
              submitLabel="upgrade"
              autoFocus
              onSubmit={(text: string) => {
                void begin($, text)
              }}
            />
          )}
        </Box>
      )
    }

    if (v.phase === 'asking' || v.phase === 'writing') {
      return (
        <Box flexDirection="column" width={width}>
          {header}
          <Text dimColor>{v.phase === 'asking' ? 'Thinking of a few questions…' : 'Writing your detailed prompt…'}</Text>
        </Box>
      )
    }

    if (v.phase === 'error') {
      return (
        <Box flexDirection="column" width={width}>
          {header}
          <Text color="red">{v.error}</Text>
          <Box marginTop={1}>
            <Button key="retry" label="Try again" variant="primary" onPress={() => { void begin($, v.original) }} />
            <Text> </Text>
            <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
          </Box>
        </Box>
      )
    }

    if (v.phase === 'questions') {
      return (
        <Box flexDirection="column" width={width}>
          {header}
          <Text dimColor>Answer what you can — skip any. Then press Write my prompt.</Text>
          {v.questions.map((q, i) => (
            <Box flexDirection="column" marginTop={1}>
              <Text wrap="wrap">{i + 1}. {q}</Text>
              {Input && (
                <Input
                  key={'a-' + v.round + '-' + i}
                  placeholder="your answer"
                  submitLabel={i === v.questions.length - 1 ? 'write' : 'next'}
                  autoFocus={i === 0 ? true : undefined}
                  onInput={(text: string) => {
                    void update($, answers, list => {
                      const copy = list.slice()
                      copy[i] = text
                      return copy
                    })
                  }}
                  onSubmit={(text: string) => {
                    void (async () => {
                      await update($, answers, list => {
                        const copy = list.slice()
                        copy[i] = text
                        return copy
                      })
                      if (i === v.questions.length - 1) await write($)
                    })()
                  }}
                />
              )}
            </Box>
          ))}
          <Box marginTop={1}>
            <Button key="write" label="Write my prompt" variant="primary" onPress={() => { void write($) }} />
            <Text> </Text>
            <Button key="skip" label="Skip questions" onPress={() => { void write($) }} />
          </Box>
        </Box>
      )
    }

    // done
    const lines = Math.min(18, Math.max(6, v.result.split('\n').length + 1))
    return (
      <Box flexDirection="column" width={width}>
        {header}
        <Text dimColor>Your upgraded prompt — edit it right here, then pick what to do with it.</Text>
        {Input ? (
          <Input
            key={'result-' + v.round}
            value={v.result}
            rows={lines}
            submitLabel="run"
            onInput={(text: string) => { void update($, draft, () => text) }}
            onSubmit={(text: string) => {
              void (async () => {
                await update($, draft, () => text)
                const t = await finalText($)
                await $.ui.close({ id: PANE })
                await $.prompt.submit({ text: t, asUser: true })
              })()
            }}
          />
        ) : (
          <Text wrap="wrap">{v.result}</Text>
        )}
        <Box marginTop={1} flexWrap="wrap">
          <Button
            key="run"
            label="Run it"
            variant="primary"
            onPress={() => {
              void (async () => {
                const t = await finalText($)
                await $.ui.close({ id: PANE })
                await $.prompt.submit({ text: t, asUser: true })
              })()
            }}
          />
          <Text> </Text>
          <Button
            key="fill"
            label="Put in prompt box"
            onPress={() => {
              void (async () => {
                const t = await finalText($)
                await $.prompt.fill({ text: t })
                await $.ui.close({ id: PANE })
              })()
            }}
          />
          <Text> </Text>
          <Button
            key="copy"
            label="Copy"
            onPress={() => {
              void (async () => {
                const t = await finalText($)
                const done = await $.ui.copy({ text: t, surface: e.surface })
                $.ui.toast(done.isCopied ? 'Prompt copied' : 'Could not copy here — use Put in prompt box')
              })()
            }}
          />
          <Text> </Text>
          <Button key="again" label="Start over" onPress={() => { void update($, view, cur => ({ ...EMPTY, round: cur.round + 1 })) }} />
          <Text> </Text>
          <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}
