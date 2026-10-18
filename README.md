# Hussam's Claude Code mods

Three mods for the Code tab of the Claude desktop app (and terminal sessions):

| Mod | What it does | How to use |
| --- | --- | --- |
| **auto-model** | Reads your first prompt of a session and picks Haiku (quick questions), Sonnet (normal work) or Opus (big builds) for the whole session. It never switches mid-session, so the prompt cache stays intact and you don't pay to re-read the conversation. If you chose a model yourself with /model, it leaves it alone. | Automatic. `/auto-model` shows the pick; `/auto-model off` / `on`; `/auto-model opus` before your first prompt forces one. |
| **prompt-upgrade** | Asks you 3 quick questions, then rewrites a one-line prompt into a detailed one you can edit, run, put in the prompt box, or copy. | `/upgrade make a landing page for my honey brand` |
| **todays-report** | Counts the tasks Claude finished, estimates hours saved and what that time is worth — today, this week, month, year. | `/report` · `/report rate 45` to set your hourly value (default $40) |

Model use: auto-model makes one tiny Haiku call per new session; prompt-upgrade makes one Haiku call (questions) and one Sonnet call (the rewrite) each time you run it; todays-report makes none.

The "hours saved" figure is an estimate: 3 min for a question answered, otherwise 5 min + 2 min per tool action + 6 min per file edit, capped at 3 h per task.
