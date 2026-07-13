# Prompt: Add or swap a single exercise

The dashboard runs this automatically when you tap "+ Add Exercise" or
"Swap exercise" mid-workout. `server.js` fills in the placeholders below and
runs it through the Claude Code CLI (non-interactive, Read/Write/Edit only).

---

You are editing my in-progress gym workout for the Momentum dashboard,
mid-session — I may have already logged weights/reps on other exercises.

Action: {{ACTION}}
{{TARGET_LINE}}
My reason: {{REASON}}

Read these files first:
1. `workoutplan.md` — the exercise library, avoid-list, set/rep ranges.
2. `data/workout-history.csv` — my training log, for a progressive-overload
   weight suggestion on the new exercise if it's one I've done before.
3. `data/current-workout.json` — read it fresh right now. It may have just
   been updated with sets I logged moments ago.

Then update `data/current-workout.json`. It's simple JSON, so parse it
mentally, build the full updated object, and use the Write tool to save the
whole file back — that's more reliable here than a targeted string edit.

- If action is `add`: append ONE new exercise object to the end of the
  `exercises` array. Pick something that complements what's already in the
  workout — don't duplicate a muscle group already well covered unless my
  reason asks for it — and respect my reason (equipment unavailable,
  injury, wanting more of a specific muscle group, short on time, etc.).
- If action is `swap`: replace the exercise at index {{EXERCISE_INDEX}} in
  the `exercises` array (0-based) with a new one. Prefer the same muscle
  group unless my reason rules that out (e.g. an injury affecting that
  whole group), in which case pick a sensible alternative that still fits
  the workout's overall focus.
- The new exercise object must match the schema in
  `templates/workout-template.json`: `name`, `muscleGroup`, `type`
  (`"compound"` or `"isolation"`), `targetSets`, `targetReps`, `comment`
  (short rationale — why this exercise, and a starting-weight suggestion
  from history if I've done it before), `note: ""`,
  `increaseWeightNextTime: false`, and `sets`: an array of `targetSets`
  entries, each `{ "setNumber": n, "weight": null, "reps": null }`.
- Do not touch anything else in the file — leave `id`, `performedAt`,
  `title`, `preferences`, top-level `comment`, and every other exercise
  (including any weight/reps I've already logged there) exactly as they
  are. Only add or replace the one exercise.
- Remove the top-level `pendingEdit` field before saving. Its presence is
  what tells the dashboard this edit is still in progress, so the file
  isn't usable again until it's gone.

If you can't come up with a sensible exercise (e.g. nothing in the library
fits), still remove `pendingEdit`, but instead add a top-level
`pendingEditError` string explaining why, and leave the `exercises` array
unchanged.
