# Momentum Architecture and Code Review

Date: 2026-07-13

## Scope

This review covers the current Express/static Momentum app:

- `server.js`
- `public/app.js`
- `public/index.html`
- `public/style.css`
- `start.sh`
- `README.md`
- agent prompt templates under `templates/`

The app is a local-first workout dashboard that stores runtime data in JSON/CSV files and invokes the Claude CLI to generate or edit workouts.

## Architecture Summary

Momentum has a deliberately small architecture:

- Express serves static assets and JSON endpoints.
- `data/current-workout.json` stores the active workout.
- `data/workout-request.json` stores the latest generation request.
- `data/workout-history.csv` is the long-term workout log and source for history/stats.
- `data/workout-history-recent.csv` is derived for agent context.
- The browser owns most UI state during a workout and autosaves whole workout objects.
- Claude CLI processes act as asynchronous workers that read/write repo-local files.
- `start.sh` runs the server and exposes it through a Cloudflare quick tunnel.

This is a good fit for a small personal tool: low operational overhead, easy data portability, and no database or build step. The main risks come from treating a public tunnel like a local-only app, trusting whole client/agent payloads, and coordinating file writes between the browser and spawned agent processes.

## Findings

### High: Public tunnel exposes unauthenticated read/write APIs

`start.sh` exposes the server through Cloudflare, while the API endpoints in `server.js` allow reading, generating, overwriting, finishing, or deleting workout data without authentication.

Relevant code:

- `start.sh`: `cloudflared tunnel --url "http://localhost:$PORT"`
- `server.js`: `POST /api/workout-request`
- `server.js`: `PUT /api/current-workout`
- `server.js`: `POST /api/current-workout/finish`
- `server.js`: `DELETE /api/current-workout`
- `server.js`: `GET /api/history`
- `server.js`: `GET /api/stats`

Impact:

- Anyone with the tunnel URL can read personal workout history.
- Anyone with the URL can mutate or delete current workout data.
- Anyone with the URL can trigger Claude CLI generation/edit processes.

Recommendations:

- Add a per-session token or password and require it for every `/api/*` route.
- Store the token in an environment variable or generate it in `start.sh` and print it with the tunnel URL.
- Add middleware that rejects requests missing the token.
- Consider Cloudflare Access or another authenticated tunnel mode if this becomes more than a private personal utility.

### High: User-controlled prompt text reaches a CLI agent with file write and Bash access

The server spawns Claude CLI with `Write`, `Edit`, and `Bash` permissions. User-controlled fields such as workout notes and add/swap reasons are available to the agent prompt.

Relevant code:

- `server.js`: `spawn('claude', ['-p', getAgentPromptText(), '--allowedTools', 'Read,Write,Bash', ...])`
- `server.js`: `spawn('claude', ['-p', promptText, '--allowedTools', 'Read,Write,Edit,Bash', ...])`
- `server.js`: `reason || '(none given ...)'` is interpolated directly into the prompt.
- `templates/AGENT_PROMPT.md` and `templates/EDIT_EXERCISE_PROMPT.md` acknowledge that `Bash` is full access, not command-scoped.

Impact:

- Prompt injection can steer the agent away from the intended JSON-writing task.
- With `Bash` enabled, a malicious public request could become a local command execution path.
- With `Write/Edit` enabled in the repo root, the agent can modify project files, not just runtime data.

Recommendations:

- Remove `Bash` from allowed tools and validate JSON server-side instead of asking the agent to run `python3 -m json.tool`.
- If shell access is unavoidable, run the agent in a constrained temporary workspace containing only the needed data/templates and copy back only validated output.
- Wrap user input in clear data-only delimiters and instruct the agent to treat it as untrusted text.
- Cap `notes` and `reason` length.
- Validate the generated workout schema before accepting `data/current-workout.json`.

### High: Server trusts whole client and agent payloads as authoritative state

`PUT /api/current-workout` writes the entire browser-supplied object to disk if `status` is `"in_progress"`. `POST /api/current-workout/finish` appends rows based entirely on the submitted payload.

Relevant code:

- `server.js`: `app.put('/api/current-workout', ...)`
- `server.js`: `writeJson(CURRENT_WORKOUT_PATH, workout)`
- `server.js`: `app.post('/api/current-workout/finish', ...)`
- `server.js`: history rows are built directly from `req.body`

Impact:

- A stale browser tab can overwrite newer server state.
- Malformed generated workouts can crash client rendering.
- Duplicate or forged history rows can be appended.
- Invalid numbers, dates, indexes, and strings can enter long-term history.

Recommendations:

- Add schema validation for workout, exercise, and set objects.
- Validate ranges for weights, reps, set counts, indexes, and date fields.
- On finish, load the current workout from disk and merge only allowed client-entered fields instead of trusting the entire request body.
- Add a `version` or `updatedAt` field for optimistic concurrency so stale autosaves can be rejected safely.
- Prefer atomic writes: write to a temp file, then rename.

### Medium: Agent process cancellation can race with newer state

When a generation or edit is superseded, the old child process is killed and the global process variable is cleared. Its later `close` handler can still write an error state over newer state.

Relevant code:

- `server.js`: `generateWorkout()`
- `server.js`: `runExerciseEdit()`
- `server.js`: child `close` handlers write `current-workout.json` without verifying that the closing child is still the active worker.

Impact:

- A canceled generation can overwrite a newer in-progress workout with an error.
- A canceled edit can reintroduce `pendingEditError` after the user has continued.
- A delete/discard can be followed by a stale child handler recreating `current-workout.json`.

Recommendations:

- Assign each generation/edit a unique operation id.
- Store that id in memory and in `current-workout.json`.
- In child handlers, write results only if the operation id still matches.
- At minimum, check `if (child !== generationProcess)` or `if (child !== editProcess)` before writing.

### Medium: CSV writer supports newlines, but CSV reader does not

`csvEscape()` quotes newline-containing fields, but `readHistoryRows()` splits the file on every newline before parsing lines.

Relevant code:

- `server.js`: `csvEscape()`
- `server.js`: `readHistoryRows()`
- `server.js`: `raw.split('\n')`

Impact:

- Multiline comments can corrupt parsed history.
- Stats and history grouping can become incorrect.
- Future agent context can be malformed.

Recommendations:

- Use a real CSV parser such as `csv-parse`.
- Alternatively, prevent newline characters in comments before writing.
- Consider JSONL or SQLite for history if the app grows.

### Medium: Client ignores save and finish failures

The client generally awaits fetches but does not check `response.ok`. Autosave can display "Saved" after a server-side rejection, and finish can navigate home after a failed append.

Relevant code:

- `public/app.js`: `scheduleSave()`
- `public/app.js`: `saveNow()`
- `public/app.js`: `flushSave()`
- `public/app.js`: `finishWorkout()`
- `public/app.js`: add/swap exercise request handlers

Impact:

- Data loss can happen silently.
- A pending agent edit can cause autosaves to receive `409`, but the UI may still show "Saved".
- Finish failures are not visible to the user.

Recommendations:

- Check `res.ok` for every mutation.
- Show clear save failure status and keep the user on the current screen if finish fails.
- Disable "Finish & Save" while a save is in flight.
- Retry transient autosave failures.

### Low: Startup script can launch a tunnel to a dead or wrong server

`start.sh` backgrounds `node server.js`, waits one second, and starts `cloudflared` regardless of whether the server started successfully.

Relevant code:

- `start.sh`: `node server.js &`
- `start.sh`: `sleep 1`
- `start.sh`: `cloudflared tunnel --url ...`

Observed behavior:

- `npm start` failed locally with `EADDRINUSE` on port `3000`.
- The README already describes this class of issue.

Recommendations:

- After starting Node, verify the process is still alive.
- Probe `http://localhost:$PORT` before starting the tunnel.
- If the server failed, print a direct error and exit.

### Low: Browser dependency is loaded from a floating CDN target

Chart.js is loaded from `https://cdn.jsdelivr.net/npm/chart.js@4`.

Relevant code:

- `public/index.html`: CDN script tag

Impact:

- Minor/patch changes in Chart.js can alter behavior without a code change.
- There is no subresource integrity protection.
- The app will not fully work offline unless the CDN is reachable.

Recommendations:

- Pin an exact Chart.js version.
- Add SRI if continuing to use a CDN.
- Vendor Chart.js locally if offline reliability matters.

## Improvement Roadmap

### 1. Add API authentication

Highest value fix. Protect all `/api/*` routes before using the app through a public tunnel again.

Suggested approach:

- Generate or configure `MOMENTUM_TOKEN`.
- Add Express middleware for `/api`.
- Pass token from the browser in an `Authorization` header or query param from the initial URL.

### 2. Introduce schema validation

Add a small validation layer around:

- workout request preferences
- current workout files
- exercise arrays
- set arrays
- finish payloads
- add/swap indexes and reasons

This can be hand-written at the current size, or use a schema library such as Zod/Ajv.

### 3. Constrain agent execution

Treat the agent as an untrusted worker boundary:

- no `Bash`
- constrained working directory
- temp output file
- server-side schema validation
- operation ids for stale process protection

### 4. Make file writes atomic and concurrent-safe

Recommended helpers:

- `readCurrentWorkout()`
- `writeCurrentWorkoutAtomic()`
- `appendHistoryRowsAtomic()`
- `validateWorkout()`
- `startGenerationOperation()`
- `completeGenerationOperation()`

Atomic writes matter because both the server and agent can read/write the same JSON file.

### 5. Improve client error handling

The gym-use flow should fail loudly and recoverably:

- "Saving..." should become "Save failed. Retry"
- finish should not navigate away on failure
- add/swap should show failures from the server
- destructive actions should be disabled while requests are in flight

### 6. Consider SQLite when history grows

CSV is fine for the first version, but SQLite would make the following easier:

- reliable multiline comments
- deduplication
- workout/session identity
- stats queries
- migrations
- backups

The app can remain local-first with SQLite.

## Testing Gaps

There are currently no automated tests or lint scripts in `package.json`.

Recommended initial tests:

- CSV escaping/parsing round trip, especially commas, quotes, and newlines.
- `isoWeekKey()` edge cases.
- workout schema validation.
- finish flow appends expected rows and clears current/request files.
- stale generation/edit process handlers do not overwrite newer state.
- API auth middleware accepts/rejects correctly.

Recommended scripts:

```json
{
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  }
}
```

## Dependency Check

`npm audit --omit=dev` reported 0 vulnerabilities during review.

## Startup Check

`npm start` failed during review because port `3000` was already in use:

```text
Error: listen EADDRINUSE: address already in use :::3000
```

This confirms the startup script should verify server readiness before opening a tunnel.
