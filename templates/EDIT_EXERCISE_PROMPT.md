# Prompt: Add or swap a single exercise

The dashboard runs this automatically when you tap "+ Add Exercise" or
"Swap exercise" mid-workout. `server.js` fills in the placeholders below and
runs it through the Claude Code CLI (non-interactive, Read/Write/Edit/Bash —
Bash is granted for JSON validation only, see below; it is full Bash access,
not a sandboxed subset, since the CLI's `--allowedTools` command-scoping
doesn't actually restrict what runs).

---

You are editing my in-progress gym workout for the Momentum dashboard,
mid-session — I may have already logged weights/reps on other exercises.

Action: {{ACTION}}
{{TARGET_LINE}}
My reason: {{REASON}}

Read these files first:
1. `templates/exercise-library.json` — the compact exercise library
   (`exercises`: `name`/`muscleGroup`/`type`/`targetReps` per entry), the
   `avoid` list, `setsPerExercise`, and `weeklyVolumeTargets` (useful for
   the `add` action, to judge which muscle group is furthest behind
   target).
2. `data/workout-history-recent.csv` — my training log for the last ~10
   workout sessions (already filtered server-side), for a
   progressive-overload weight suggestion on the new exercise if it's one
   I've done recently.
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
  `templates/workout-template.json`: `name`, `muscleGroup`, `type`,
  `targetReps` (copy `muscleGroup`/`type`/`targetReps` straight from the
  matching entry in `exercise-library.json`), `targetSets`
  (`setsPerExercise` from `exercise-library.json`), `comment` (short
  rationale — why this exercise, and a starting-weight suggestion from
  history if I've done it before), `note: ""`,
  `increaseWeightNextTime: false`, and `sets`: an array of `targetSets`
  entries, each `{ "setNumber": n, "weight": null, "reps": null }`.
- Do not touch anything else in the file — leave `id`, `performedAt`,
  `title`, `preferences`, top-level `comment`, and every other exercise
  (including any weight/reps I've already logged there) exactly as they
  are. Only add or replace the one exercise.
- Remove the top-level `pendingEdit` field before saving. Its presence is
  what tells the dashboard this edit is still in progress, so the file
  isn't usable again until it's gone.

After writing the file, run `python3 -m json.tool data/current-workout.json`
to confirm it's valid JSON before finishing — if it errors, fix and rewrite
the file. You have Bash available but it's only meant for this validation
step; there's no other shell work to do here.

If you can't come up with a sensible exercise (e.g. nothing in the library
fits), still remove `pendingEdit`, but instead add a top-level
`pendingEditError` string explaining why, and leave the `exercises` array
unchanged.
