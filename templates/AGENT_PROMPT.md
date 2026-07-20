# Prompt: Generate the next workout

The dashboard runs this automatically: submitting "Create New Workout" has
`server.js` spawn `claude -p` (non-interactive, Read/Write/Bash — Bash is
granted for JSON validation only, see below; the CLI's `--allowedTools`
scoping like `Bash(cmd *)` doesn't actually restrict which commands run, so
this is full Bash access, not a sandboxed subset) with everything after the
`---` below as the prompt. You can also run it by hand for debugging:

```
claude -p "$(sed -n '/^---$/,$p' templates/AGENT_PROMPT.md | tail -n +2)" --allowedTools "Read,Write,Bash"
```

---

You are generating my next gym workout for the Momentum dashboard.

Read these files first:
1. `templates/exercise-library.json` — the compact exercise library
   (`exercises`: `name`/`muscleGroup`/`type`/`targetReps` per entry), the
   `avoid` list, `setsPerExercise`, `weeklyVolumeTargets` (target working
   sets per muscle group per week), and `exampleWorkouts` (four proven
   exercise groupings from the plan — good reference for which exercises
   pair well in one session, but not mandatory; feel free to mix and match
   based on history). This is the machine-readable mirror of
   `workoutplan.md`'s Exercise Library / Exercises to Avoid / Sets & Reps /
   Weekly Training Volume / Weekly Schedule sections — read this instead of
   the markdown.
2. `data/workout-request.json` — my preferences for today (time available,
   focus area, free-text notes). This runs non-interactively, so if the file
   is missing, don't ask — just assume no particular preference (full body,
   no time limit) and proceed.
3. `data/workout-history-recent.csv` — my set-by-set training log for my
   last ~10 workout sessions (already filtered server-side to the recent
   window, so this is everything you need — there's no need to look for a
   fuller history file), including past weights, reps, and my own notes
   from the gym (`exercise_comment`, `workout_comment` columns — these are
   things I wrote, not past AI suggestions). Use it to figure out which
   muscle groups are undertrained and to suggest a sensible starting weight
   per exercise (progressive overload: if all sets last time hit the top of
   the rep range, bump the weight slightly). Also check the
   `increase_weight_next_time` column — if it's `true` on the most recent
   occurrence of an exercise, I flagged at the gym that the weight should go
   up this time, so bump it even if the rep range wasn't fully maxed out.

Then write `data/current-workout.json`, matching the schema in
`templates/workout-template.json`, with these rules:

- `status` must be `"in_progress"`.
- `id`: unique, e.g. `YYYY-MM-DD-am` / `YYYY-MM-DD-pm`.
- `performedAt`: current local date and time in `YYYY-MM-DDTHH:mm` format
  (e.g. `2026-07-08T09:00`). This is just a default — I can adjust it in
  the dashboard if I actually do the workout at a different time.
- `title`: short label, e.g. "Push Day", "Legs", "Upper Mix".
- `preferences`: copy verbatim from `data/workout-request.json`.
- `exercises`: 5 exercises (fewer if `timeAvailableMinutes` is tight),
  chosen from `exercise-library.json`'s `exercises` list, respecting its
  `avoid` list and honoring `preferences.focus` / `preferences.notes` (e.g.
  "only 30 min today" -> trim to 3-4 exercises or supersets; "upper body
  only, hiking later" -> skip legs). Lean on an `exampleWorkouts` grouping
  as a starting point where it fits, then use recent history against
  `weeklyVolumeTargets` to decide which muscle groups need the work most
  this session.
  - `muscleGroup` / `type` / `targetReps`: copy straight from the matching
    entry in `exercise-library.json`.
  - `targetSets`: `setsPerExercise` from `exercise-library.json`.
  - `comment`: optional short note to help me at the gym, e.g. "last time:
    30kg x8,8,7 — aim for 10 reps before adding weight". This is shown as
    read-only context above the sets, not something I edit.
  - `note`: always `""` — this is a free-text box I fill in myself at the
    gym (not something to pre-fill), and it becomes next time's
    `exercise_comment` in the CSV history.
  - `increaseWeightNextTime`: always `false` — this is a checkbox I tick
    myself at the gym, not something to pre-fill.
  - `sets`: pre-fill an array with `targetSets` entries, each
    `{ "setNumber": n, "weight": null, "reps": null }`.
    Leave `weight` and `reps` as `null` — I fill those in live at the gym.
- `comment`: leave as `""`.

Do not fill in actual `weight`/`reps` values — only targets and metadata.
After writing the file, run `python3 -m json.tool data/current-workout.json`
to confirm it's valid JSON before finishing — if it errors, fix and rewrite
the file. You have Bash available but it's only meant for this validation
step; there's no other shell work to do here.
As soon as the file is saved, the dashboard's "Current Workout" view picks
it up automatically (it polls while generation is in progress).
