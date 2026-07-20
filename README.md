# Momentum

A local workout dashboard: log sets/reps/weights at the gym, track history in
a CSV datasheet, and have Claude generate (and adjust) your next workout
based on your training plan and past sessions.

No cloud hosting, no database, no build step — Node/Express serving static
files + a few JSON endpoints, exposed with a Cloudflare quick tunnel so you
can use it from your phone.

## Running it

```bash
PORT=3001 ./start.sh
```

This installs dependencies on first run, starts the server, waits until it
actually answers on the port, then prints a
`https://xxxxx.trycloudflare.com` URL a few seconds later — that's your
public link for the session. Leave the terminal open; closing it (or
Ctrl+C) stops both the server and the tunnel. The URL changes every time you
restart.

## Password / login

The app is public through the tunnel, so every `/api` route requires a
login. On first start the server generates a password and prints it to the
terminal; enter it on the landing page. To pick your own instead:

```bash
MOMENTUM_PASSWORD=your-password PORT=3001 ./start.sh
```

Notes:

- The password hash lives in `data/auth.json` (delete it to regenerate a
  random password on next start).
- Changing `MOMENTUM_PASSWORD` invalidates all existing sessions.
- Sessions are cookies that last 30 days (`data/sessions.json`), so you
  won't retype the password every gym visit.

**Why `PORT=3001`**: plain `./start.sh` defaults to port 3000. If something
else on your machine is already using that port, override it with `PORT=`.

**If you see `EADDRINUSE`**: something's still bound to that port, usually a
leftover process from a previous run that didn't shut down cleanly (e.g. a
crashed terminal, or two `start.sh` instances started at once — only one
`node server.js` can hold a given port; a second one will fail silently
while its Cloudflare tunnel starts anyway and ends up pointing at nothing,
or coincidentally at the first instance). Free the port and retry:

```bash
lsof -ti:3001 | xargs kill
PORT=3001 ./start.sh
```

## How a workout gets created

1. **Create New Workout** in the dashboard — set time available, focus, and
   any notes (equipment unavailable, injury, etc.) — spawns the Claude Code
   CLI server-side to read [`workoutplan.md`](workoutplan.md) and
   `data/workout-history.csv`, then write `data/current-workout.json`.
2. **Open Current Workout** to log sets live at the gym; autosaves as you go.
3. Mid-workout, **Add exercise** / **Swap exercise** trigger the same kind of
   agent call, scoped to one exercise, without touching anything you've
   already logged.
4. **Finish & Save** appends every set to `data/workout-history.csv` — the
   single source of truth for Past Workouts and Trends & Stats, and what
   future generations read to inform weight suggestions and progressive
   overload.

See [`templates/AGENT_PROMPT.md`](templates/AGENT_PROMPT.md) and
[`templates/EDIT_EXERCISE_PROMPT.md`](templates/EDIT_EXERCISE_PROMPT.md) for
exactly what the agent is told.

Agent runs are sandboxed: no Bash, and each run gets a throwaway workspace
under `data/agent-workspace/` containing copies of only the files it needs.
The server schema-validates whatever the agent wrote before publishing it
to `data/current-workout.json`, and validates every browser payload the
same way before saving or logging it.

## Tests

```bash
npm test
```

## Data

Everything under `data/` is generated at runtime and gitignored — it's your
personal training data, not part of the app itself.
