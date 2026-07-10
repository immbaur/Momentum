# Prompt: Generate the next workout

The dashboard runs this automatically: submitting "Create New Workout" has
`server.js` spawn `claude -p` (non-interactive, Read/Write tools only) with
everything after the `---` below as the prompt. You can also run it by hand
for debugging:

```
claude -p "$(sed -n '/^---$/,$p' templates/AGENT_PROMPT.md | tail -n +2)" --allowedTools Read,Write
```

---

You are generating my next gym workout for the Momentum dashboard.

Read these files first:
1. `workoutplan.md` — the exercise library, avoid-list, set/rep ranges, and
   weekly volume targets to follow.
2. `data/workout-request.json` — my preferences for today (time available,
   focus area, free-text notes). This runs non-interactively, so if the file
   is missing, don't ask — just assume no particular preference (full body,
   no time limit) and proceed.
3. `data/workout-history.csv` — my full set-by-set training log, including
   past weights, reps, and comments (`exercise_comment`, `workout_comment`
   columns). Use the most recent 1-2 weeks to figure out
   which muscle groups are undertrained and to suggest a sensible starting
   weight per exercise (progressive overload: if all sets last time hit the
   top of the rep range, bump the weight slightly). Also check the
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
  chosen from `workoutplan.md`'s Exercise Library, respecting the
  Exercises to Avoid list and honoring `preferences.focus` /
  `preferences.notes` (e.g. "only 30 min today" -> trim to 3-4 exercises or
  supersets; "upper body only, hiking later" -> skip legs).
  - `muscleGroup`: the library section the exercise came from (e.g.
    "Chest", "Back (Width)", "Shoulders", "Quads").
  - `type`: `"compound"` or `"isolation"` per the Sets & Reps section.
  - `targetSets` / `targetReps`: from the Sets & Reps ranges (3 sets /
    6-10 reps for compounds, 2-3 sets / 10-15 reps for isolation).
  - `comment`: optional short note to help me at the gym, e.g. "last time:
    30kg x8,8,7 — aim for 10 reps before adding weight".
  - `increaseWeightNextTime`: always `false` — this is a checkbox I tick
    myself at the gym, not something to pre-fill.
  - `sets`: pre-fill an array with `targetSets` entries, each
    `{ "setNumber": n, "weight": null, "reps": null }`.
    Leave `weight` and `reps` as `null` — I fill those in live at the gym.
- `comment`: leave as `""`.

Do not fill in actual `weight`/`reps` values — only targets and metadata.
As soon as the file is saved, the dashboard's "Current Workout" view picks
it up automatically (it polls while generation is in progress).
