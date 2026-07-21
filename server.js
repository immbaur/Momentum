const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const CURRENT_WORKOUT_PATH = path.join(DATA_DIR, 'current-workout.json');
const REQUEST_PATH = path.join(DATA_DIR, 'workout-request.json');
const HISTORY_CSV_PATH = path.join(DATA_DIR, 'workout-history.csv');
const AUTH_PATH = path.join(DATA_DIR, 'auth.json');
const SESSIONS_PATH = path.join(DATA_DIR, 'sessions.json');
const AGENT_WORKSPACE_DIR = path.join(DATA_DIR, 'agent-workspace');
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const AGENT_PROMPT_PATH = path.join(TEMPLATES_DIR, 'AGENT_PROMPT.md');
const EDIT_EXERCISE_PROMPT_PATH = path.join(TEMPLATES_DIR, 'EDIT_EXERCISE_PROMPT.md');
const GENERATION_TIMEOUT_MS = 5 * 60 * 1000;
// How many of the most recent workout sessions the agent gets to see. Covers
// roughly 2 weeks at the plan's ~4 workouts/week and at least two full turns
// through the A/B/C/D rotation, even with irregular gaps between sessions.
const RECENT_WORKOUT_COUNT = 10;

const SESSION_COOKIE = 'momentum_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 20;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 20;

// Length/range caps for everything that enters via the API or an agent.
const LIMITS = {
  id: 60,
  title: 100,
  focus: 100,
  notes: 500,
  reason: 300,
  exerciseName: 100,
  muscleGroup: 60,
  exerciseType: 30,
  targetReps: 30,
  exerciseComment: 400,
  exerciseNote: 1000,
  workoutComment: 2000,
  maxExercises: 20,
  maxSets: 20,
  maxTargetSets: 10,
  maxWeightKg: 1000,
  maxReps: 1000,
  minMinutes: 5,
  maxMinutes: 300
};

const CSV_COLUMNS = [
  'date', 'workout_id', 'workout_title', 'focus', 'muscle_group',
  'exercise', 'exercise_type', 'set_number', 'target_sets', 'target_reps',
  'weight', 'reps', 'exercise_comment', 'workout_comment',
  'increase_weight_next_time'
];

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(HISTORY_CSV_PATH)) {
  fs.writeFileSync(HISTORY_CSV_PATH, CSV_COLUMNS.join(',') + '\n');
}

// --- CSV helpers ---------------------------------------------------------

function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function csvRow(fields) {
  return CSV_COLUMNS.map((col) => csvEscape(fields[col])).join(',') + '\n';
}

// Parses a whole CSV document into an array of records. Unlike a
// line-by-line split, this handles newlines inside quoted fields, which
// csvEscape() produces for multiline comments.
function parseCsv(raw) {
  const records = [];
  let record = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (inQuotes) {
      if (char === '"') {
        if (raw[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter((r) => !(r.length === 1 && r[0] === ''));
}

function readHistoryRows() {
  const raw = fs.readFileSync(HISTORY_CSV_PATH, 'utf8');
  const records = parseCsv(raw);
  if (records.length <= 1) return [];
  return records.slice(1).map((values) => {
    const row = {};
    CSV_COLUMNS.forEach((col, idx) => {
      row[col] = values[idx] !== undefined ? values[idx] : '';
    });
    return row;
  });
}

function appendHistoryRows(rows) {
  const csvText = rows.map(csvRow).join('');
  fs.appendFileSync(HISTORY_CSV_PATH, csvText);
}

// Returns a copy of the history CSV containing only the most recent
// RECENT_WORKOUT_COUNT workout sessions, for the generation agent to read
// instead of the full (ever-growing) log. Rows are assumed to already be in
// chronological order, since appendHistoryRows() only ever adds to the end.
function recentHistoryCsv() {
  const rows = readHistoryRows();
  const idsInOrder = [];
  const seen = new Set();
  rows.forEach((row) => {
    const id = row.workout_id || row.date;
    if (!seen.has(id)) {
      seen.add(id);
      idsInOrder.push(id);
    }
  });
  const recentIds = new Set(idsInOrder.slice(-RECENT_WORKOUT_COUNT));
  const recentRows = rows.filter((row) => recentIds.has(row.workout_id || row.date));
  return CSV_COLUMNS.join(',') + '\n' + recentRows.map(csvRow).join('');
}

// --- JSON file helpers ----------------------------------------------------

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

// Atomic write (temp file + rename), since the server and the browser's
// autosave loop can both be writing while an agent result comes back.
function writeJson(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

// --- Input cleaning / schema validation ------------------------------------

// Strips control characters (keeps \n and \t) and caps length. Non-strings
// become '', so client/agent payload fields can be passed in directly.
function cleanText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').slice(0, maxLen);
}

function cleanLine(value, maxLen) {
  return cleanText(value, maxLen).replace(/\n/g, ' ');
}

function cleanPreferences(input) {
  const prefs = input && typeof input === 'object' ? input : {};
  const minutes = Number(prefs.timeAvailableMinutes);
  const validMinutes = Number.isFinite(minutes) &&
    minutes >= LIMITS.minMinutes && minutes <= LIMITS.maxMinutes;
  return {
    timeAvailableMinutes: validMinutes ? Math.round(minutes) : null,
    focus: cleanLine(prefs.focus, LIMITS.focus),
    notes: cleanText(prefs.notes, LIMITS.notes)
  };
}

// Validates a workout object (from the browser or from an agent) and returns
// a clean copy containing only whitelisted fields, so unknown or forged
// fields (rev, pendingEdit, ...) can never sneak into the stored file.
// Returns { workout } on success or { error } on failure.
function validateAndCleanWorkout(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Workout must be an object.' };
  }
  if (input.status !== 'in_progress') {
    return { error: 'Workout status must be "in_progress".' };
  }
  if (!Array.isArray(input.exercises) || input.exercises.length === 0) {
    return { error: 'Workout must contain at least one exercise.' };
  }
  if (input.exercises.length > LIMITS.maxExercises) {
    return { error: `Too many exercises (max ${LIMITS.maxExercises}).` };
  }
  if (input.performedAt != null && input.performedAt !== '' &&
      (typeof input.performedAt !== 'string' || isNaN(new Date(input.performedAt)))) {
    return { error: 'performedAt must be a parseable date string.' };
  }

  const exercises = [];
  for (let i = 0; i < input.exercises.length; i++) {
    const ex = input.exercises[i];
    const label = `Exercise ${i + 1}`;
    if (!ex || typeof ex !== 'object') return { error: `${label} must be an object.` };
    if (typeof ex.name !== 'string' || !ex.name.trim()) return { error: `${label} needs a name.` };
    const targetSets = Number(ex.targetSets);
    if (!Number.isInteger(targetSets) || targetSets < 1 || targetSets > LIMITS.maxTargetSets) {
      return { error: `${label}: targetSets must be an integer between 1 and ${LIMITS.maxTargetSets}.` };
    }
    if (!Array.isArray(ex.sets) || ex.sets.length === 0) {
      return { error: `${label} needs at least one set.` };
    }
    if (ex.sets.length > LIMITS.maxSets) {
      return { error: `${label}: too many sets (max ${LIMITS.maxSets}).` };
    }
    const sets = [];
    for (let s = 0; s < ex.sets.length; s++) {
      const set = ex.sets[s];
      if (!set || typeof set !== 'object') return { error: `${label}, set ${s + 1} must be an object.` };
      let weight = set.weight == null || set.weight === '' ? null : Number(set.weight);
      if (weight !== null) {
        if (!Number.isFinite(weight) || weight < 0 || weight > LIMITS.maxWeightKg) {
          return { error: `${label}, set ${s + 1}: weight out of range.` };
        }
        weight = Math.round(weight * 100) / 100;
      }
      let reps = set.reps == null || set.reps === '' ? null : Number(set.reps);
      if (reps !== null) {
        if (!Number.isFinite(reps) || reps < 0 || reps > LIMITS.maxReps) {
          return { error: `${label}, set ${s + 1}: reps out of range.` };
        }
        reps = Math.round(reps);
      }
      sets.push({ setNumber: s + 1, weight, reps });
    }
    exercises.push({
      name: cleanLine(ex.name, LIMITS.exerciseName).trim(),
      muscleGroup: cleanLine(ex.muscleGroup, LIMITS.muscleGroup),
      type: cleanLine(ex.type, LIMITS.exerciseType),
      targetSets,
      targetReps: cleanLine(ex.targetReps, LIMITS.targetReps),
      comment: cleanText(ex.comment, LIMITS.exerciseComment),
      note: cleanText(ex.note, LIMITS.exerciseNote),
      increaseWeightNextTime: ex.increaseWeightNextTime === true,
      sets
    });
  }

  return {
    workout: {
      id: cleanLine(input.id, LIMITS.id),
      performedAt: typeof input.performedAt === 'string' ? cleanLine(input.performedAt, 30) : '',
      status: 'in_progress',
      title: cleanLine(input.title, LIMITS.title),
      preferences: cleanPreferences(input.preferences),
      exercises,
      comment: cleanText(input.comment, LIMITS.workoutComment)
    }
  };
}

// --- Auth -------------------------------------------------------------------
// All /api routes (except login/status/health) require a session cookie
// obtained by posting the password to /api/login. The password comes from
// MOMENTUM_PASSWORD, or is generated once and printed at startup.

let auth = null;

function scryptHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, authRecord) {
  const record = authRecord || auth;
  if (!record || typeof password !== 'string') return false;
  const expected = Buffer.from(record.passwordHash, 'hex');
  const actual = crypto.scryptSync(password, record.salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function initAuth() {
  const stored = readJson(AUTH_PATH);
  const envPassword = process.env.MOMENTUM_PASSWORD;
  if (envPassword) {
    if (stored && verifyPassword(envPassword, stored)) {
      auth = stored;
      return;
    }
    const salt = crypto.randomBytes(16).toString('hex');
    auth = { salt, passwordHash: scryptHash(envPassword, salt) };
    writeJson(AUTH_PATH, auth);
    writeJson(SESSIONS_PATH, []); // password changed -> everyone logged out
    return;
  }
  if (stored) {
    auth = stored;
    return;
  }
  const generated = crypto.randomBytes(9).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  auth = { salt, passwordHash: scryptHash(generated, salt) };
  writeJson(AUTH_PATH, auth);
  console.log('');
  console.log(`  Momentum password (generated): ${generated}`);
  console.log('  Use it on the login page. Set MOMENTUM_PASSWORD to choose your');
  console.log('  own, or delete data/auth.json to generate a new one.');
  console.log('');
}

function loadSessions() {
  const sessions = readJson(SESSIONS_PATH);
  if (!Array.isArray(sessions)) return [];
  const cutoff = Date.now() - SESSION_TTL_MS;
  return sessions.filter((s) => s && typeof s.token === 'string' && s.createdAt >= cutoff);
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const sessions = loadSessions();
  sessions.push({ token, createdAt: Date.now() });
  writeJson(SESSIONS_PATH, sessions.slice(-MAX_SESSIONS));
  return token;
}

function isValidSession(token) {
  if (typeof token !== 'string' || !token) return false;
  const candidate = Buffer.from(token);
  return loadSessions().some((s) => {
    const stored = Buffer.from(s.token);
    return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
  });
}

function getSessionToken(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

// Brute-force throttle for /api/login. Behind the Cloudflare quick tunnel
// every request shares one upstream IP, so this is effectively a global
// cap — acceptable for a single-user app.
const loginAttempts = new Map(); // ip -> { count, windowStart }

function loginRateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_LOGIN_ATTEMPTS;
}

// --- Agent workspaces --------------------------------------------------------
// Each agent run happens in a throwaway directory containing copies of only
// the files it needs, laid out like the repo (templates/, data/). The agent
// gets no Bash and can only Read/Write inside its workspace; the server
// validates whatever it wrote before copying the result back.

let opCounter = 0;

function createAgentWorkspace(dataFiles) {
  opCounter += 1;
  const dir = path.join(AGENT_WORKSPACE_DIR, `${Date.now()}-${opCounter}`);
  fs.mkdirSync(path.join(dir, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  ['exercise-library.json', 'workout-template.json'].forEach((name) => {
    fs.copyFileSync(path.join(TEMPLATES_DIR, name), path.join(dir, 'templates', name));
  });
  fs.writeFileSync(path.join(dir, 'data', 'workout-history-recent.csv'), recentHistoryCsv());
  Object.entries(dataFiles).forEach(([name, content]) => {
    fs.writeFileSync(path.join(dir, 'data', name), content);
  });
  return dir;
}

function removeAgentWorkspace(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// --- Workout generation ----------------------------------------------------
// Runs templates/AGENT_PROMPT.md through the Claude Code CLI (non-interactive,
// Read/Write only, inside an agent workspace) so it can read the exercise
// library, the trimmed recent-history CSV, and workout-request.json, then
// write data/current-workout.json — which the server validates and publishes.

let generationProcess = null;

function getAgentPromptText() {
  const raw = fs.readFileSync(AGENT_PROMPT_PATH, 'utf8');
  const marker = '\n---\n';
  const idx = raw.indexOf(marker);
  return idx === -1 ? raw : raw.slice(idx + marker.length).trim();
}

function generateWorkout() {
  if (generationProcess) {
    generationProcess.kill('SIGTERM');
    generationProcess = null;
  }

  const preferences = cleanPreferences((readJson(REQUEST_PATH) || {}).preferences);
  writeJson(CURRENT_WORKOUT_PATH, {
    status: 'generating',
    requestedAt: new Date().toISOString(),
    preferences
  });

  const workspace = createAgentWorkspace({
    'workout-request.json': JSON.stringify(
      { requestedAt: new Date().toISOString(), preferences }, null, 2
    )
  });

  const child = spawn('claude', ['-p', getAgentPromptText(), '--allowedTools', 'Read,Write', '--model', 'sonnet'], {
    cwd: workspace
  });
  generationProcess = child;

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const timer = setTimeout(() => child.kill('SIGTERM'), GENERATION_TIMEOUT_MS);

  child.on('close', (code) => {
    clearTimeout(timer);
    // A superseded or canceled run must not write anything: a newer
    // generation or a discard may have changed state since it started.
    if (generationProcess !== child) {
      removeAgentWorkspace(workspace);
      return;
    }
    generationProcess = null;

    const disk = readJson(CURRENT_WORKOUT_PATH);
    if (!disk || disk.status !== 'generating') {
      removeAgentWorkspace(workspace);
      return;
    }

    const output = readJson(path.join(workspace, 'data', 'current-workout.json'));
    removeAgentWorkspace(workspace);
    const { workout, error } = output
      ? validateAndCleanWorkout(output)
      : { error: 'The agent did not produce a workout file.' };

    if (workout) {
      writeJson(CURRENT_WORKOUT_PATH, { ...workout, preferences, rev: 1 });
    } else {
      writeJson(CURRENT_WORKOUT_PATH, {
        status: 'error',
        message: code === 0
          ? `The agent finished but did not produce a valid workout. (${error})`
          : `Workout generation failed (exit code ${code}). ${stderr.slice(-500)}`,
        preferences
      });
    }
  });

  child.on('error', (err) => {
    clearTimeout(timer);
    if (generationProcess !== child) {
      removeAgentWorkspace(workspace);
      return;
    }
    generationProcess = null;
    removeAgentWorkspace(workspace);
    writeJson(CURRENT_WORKOUT_PATH, {
      status: 'error',
      message: `Could not start the agent: ${err.message}`,
      preferences
    });
  });
}

// --- Single-exercise add/swap -----------------------------------------------
// Same idea as workout generation, but scoped to one exercise inside an
// already in-progress workout. The workout stays fully intact (including
// any weights/reps already logged) while a `pendingEdit` flag is set; the
// agent edits its workspace copy and removes the flag, and the server
// validates and publishes the result. The PUT endpoint refuses to save over
// a file with a pending edit, so the browser's autosave can't race the agent.

let editProcess = null;

function getEditExercisePromptText({ action, exerciseIndex, reason }) {
  const raw = fs.readFileSync(EDIT_EXERCISE_PROMPT_PATH, 'utf8');
  const marker = '\n---\n';
  const idx = raw.indexOf(marker);
  const text = idx === -1 ? raw : raw.slice(idx + marker.length).trim();
  const targetLine = action === 'swap'
    ? `Target exercise index: ${exerciseIndex} (0-based, in the current \`exercises\` array).`
    : '';
  return text
    .replace('{{ACTION}}', action)
    .replace('{{TARGET_LINE}}', targetLine)
    .replace('{{REASON}}', reason || '(none given — use your judgement)')
    .replace('{{EXERCISE_INDEX}}', String(exerciseIndex));
}

function runExerciseEdit({ action, exerciseIndex, reason }) {
  const before = readJson(CURRENT_WORKOUT_PATH);
  if (!before || before.status !== 'in_progress') {
    return { error: 'No in-progress workout to edit.' };
  }
  if (action === 'swap' &&
      (!Number.isInteger(exerciseIndex) || exerciseIndex < 0 ||
       !Array.isArray(before.exercises) || exerciseIndex >= before.exercises.length)) {
    return { error: 'Invalid exercise index.' };
  }
  if (editProcess) {
    editProcess.kill('SIGTERM');
    editProcess = null;
  }

  // The reason is untrusted phone-typed text: cap it, flatten to one line,
  // and strip the delimiter token the prompt template wraps it in.
  const cleanReason = cleanLine(reason, LIMITS.reason).replace(/USER_REASON/g, '').trim();
  const pendingEdit = { action, exerciseIndex, reason: cleanReason, requestedAt: new Date().toISOString() };
  const withFlag = { ...before, pendingEdit };
  delete withFlag.pendingEditError;
  writeJson(CURRENT_WORKOUT_PATH, withFlag);

  const workspace = createAgentWorkspace({
    'current-workout.json': JSON.stringify(withFlag, null, 2)
  });

  const promptText = getEditExercisePromptText({ action, exerciseIndex, reason: cleanReason });
  const child = spawn('claude', ['-p', promptText, '--allowedTools', 'Read,Write,Edit', '--model', 'sonnet'], {
    cwd: workspace
  });
  editProcess = child;

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const timer = setTimeout(() => child.kill('SIGTERM'), GENERATION_TIMEOUT_MS);

  child.on('close', (code) => {
    clearTimeout(timer);
    if (editProcess !== child) {
      removeAgentWorkspace(workspace);
      return;
    }
    editProcess = null;

    const disk = readJson(CURRENT_WORKOUT_PATH);
    // The user may have canceled the edit or discarded the workout while
    // the agent ran; then this result is stale and must be dropped.
    if (!disk || disk.status !== 'in_progress' || !disk.pendingEdit ||
        disk.pendingEdit.requestedAt !== pendingEdit.requestedAt) {
      removeAgentWorkspace(workspace);
      return;
    }

    const output = readJson(path.join(workspace, 'data', 'current-workout.json'));
    removeAgentWorkspace(workspace);
    const nextRev = (Number.isInteger(disk.rev) ? disk.rev : 0) + 1;

    let failure = null;
    if (code !== 0) failure = `Edit failed (exit code ${code}). ${stderr.slice(-500)}`;
    else if (!output) failure = 'The agent did not write the workout file.';
    else if (output.pendingEdit) failure = 'The agent finished but did not update the exercise as expected.';
    else if (output.pendingEditError) failure = cleanText(String(output.pendingEditError), 500);

    if (!failure) {
      const { workout, error } = validateAndCleanWorkout(output);
      if (workout) {
        writeJson(CURRENT_WORKOUT_PATH, { ...workout, rev: nextRev });
        return;
      }
      failure = `The agent produced an invalid workout: ${error}`;
    }

    const restored = { ...disk, pendingEditError: failure, rev: nextRev };
    delete restored.pendingEdit;
    writeJson(CURRENT_WORKOUT_PATH, restored);
  });

  child.on('error', (err) => {
    clearTimeout(timer);
    if (editProcess !== child) {
      removeAgentWorkspace(workspace);
      return;
    }
    editProcess = null;
    removeAgentWorkspace(workspace);
    const disk = readJson(CURRENT_WORKOUT_PATH);
    if (!disk || disk.status !== 'in_progress' || !disk.pendingEdit ||
        disk.pendingEdit.requestedAt !== pendingEdit.requestedAt) {
      return;
    }
    const restored = { ...disk, pendingEditError: `Could not start the agent: ${err.message}` };
    delete restored.pendingEdit;
    writeJson(CURRENT_WORKOUT_PATH, restored);
  });

  return { ok: true };
}

// --- App -------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Unauthenticated: readiness probe for start.sh.
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

// Unauthenticated: lets the client decide whether to show the login page.
app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: isValidSession(getSessionToken(req)) });
});

app.post('/api/login', (req, res) => {
  if (loginRateLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  const password = (req.body || {}).password;
  if (!verifyPassword(password)) {
    return res.status(401).json({ error: 'Wrong password.' });
  }
  const token = createSession();
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const token = getSessionToken(req);
  if (token) {
    writeJson(SESSIONS_PATH, loadSessions().filter((s) => s.token !== token));
  }
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

// Every other /api route requires a valid session.
app.use('/api', (req, res, next) => {
  if (!isValidSession(getSessionToken(req))) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  next();
});

// Get the current workout (pending request or in-progress session)
app.get('/api/current-workout', (req, res) => {
  const current = readJson(CURRENT_WORKOUT_PATH);
  res.json(current || { status: 'none' });
});

// Submit preferences for a new workout. Writes a request file, then kicks
// off the agent (see generateWorkout) to read it and write
// data/current-workout.json using templates/workout-template.json's schema.
app.post('/api/workout-request', (req, res) => {
  const preferences = cleanPreferences(req.body);
  writeJson(REQUEST_PATH, { requestedAt: new Date().toISOString(), preferences });

  generateWorkout();

  res.json(readJson(CURRENT_WORKOUT_PATH));
});

// Re-run generation using the last saved preferences (e.g. after a failure).
app.post('/api/current-workout/retry', (req, res) => {
  if (!fs.existsSync(REQUEST_PATH)) {
    return res.status(400).json({ error: 'No workout request to retry.' });
  }
  generateWorkout();
  res.json(readJson(CURRENT_WORKOUT_PATH));
});

// Autosave the in-progress workout (weights, reps, comments) while at the
// gym. Requires the client's `rev` to match the stored one, so a stale tab
// can't silently overwrite newer state; the saved rev comes back bumped.
app.put('/api/current-workout', (req, res) => {
  const existing = readJson(CURRENT_WORKOUT_PATH);
  if (!existing || existing.status !== 'in_progress') {
    return res.status(409).json({ error: 'No active workout to save.' });
  }
  if (existing.pendingEdit) {
    return res.status(409).json({ error: 'An exercise edit is in progress.' });
  }
  const diskRev = Number.isInteger(existing.rev) ? existing.rev : 0;
  const clientRev = Number.isInteger((req.body || {}).rev) ? req.body.rev : 0;
  if (diskRev !== clientRev) {
    return res.status(409).json({ error: 'This workout was changed elsewhere.' });
  }
  const { workout, error } = validateAndCleanWorkout(req.body);
  if (error) {
    return res.status(400).json({ error });
  }
  const saved = { ...workout, rev: diskRev + 1 };
  writeJson(CURRENT_WORKOUT_PATH, saved);
  res.json(saved);
});

// Ask the agent to append one new exercise to the current workout.
app.post('/api/current-workout/exercises/add', (req, res) => {
  const result = runExerciseEdit({ action: 'add', exerciseIndex: null, reason: (req.body || {}).reason });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(readJson(CURRENT_WORKOUT_PATH));
});

// Ask the agent to replace one exercise (equipment unavailable, injury, etc.).
app.post('/api/current-workout/exercises/:index/swap', (req, res) => {
  const exerciseIndex = Number(req.params.index);
  const result = runExerciseEdit({ action: 'swap', exerciseIndex, reason: (req.body || {}).reason });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(readJson(CURRENT_WORKOUT_PATH));
});

// Cancel an in-flight add/swap. The exercise list is untouched since the
// agent works on a workspace copy that is only published after validation.
app.post('/api/current-workout/exercises/cancel-edit', (req, res) => {
  if (editProcess) {
    editProcess.kill('SIGTERM');
    editProcess = null;
  }
  const current = readJson(CURRENT_WORKOUT_PATH);
  if (current && current.pendingEdit) {
    delete current.pendingEdit;
    writeJson(CURRENT_WORKOUT_PATH, current);
  }
  res.json(readJson(CURRENT_WORKOUT_PATH) || { status: 'none' });
});

// Finish the current workout: log every set to the CSV datasheet, then
// clear current-workout.json so the dashboard returns to an empty state.
// The payload is schema-validated and must carry the current rev, so a
// stale tab can't append forged or outdated history rows.
app.post('/api/current-workout/finish', (req, res) => {
  const existing = readJson(CURRENT_WORKOUT_PATH);
  if (!existing || existing.status !== 'in_progress') {
    return res.status(409).json({ error: 'No in-progress workout to finish.' });
  }
  if (existing.pendingEdit) {
    return res.status(409).json({ error: 'An exercise edit is in progress.' });
  }
  const diskRev = Number.isInteger(existing.rev) ? existing.rev : 0;
  const clientRev = Number.isInteger((req.body || {}).rev) ? req.body.rev : 0;
  if (diskRev !== clientRev) {
    return res.status(409).json({ error: 'This workout was changed elsewhere. Reload before finishing.' });
  }

  const { workout, error } = validateAndCleanWorkout(req.body);
  if (error) {
    return res.status(400).json({ error });
  }

  const date = workout.performedAt || new Date().toISOString().slice(0, 16);
  const rows = [];
  workout.exercises.forEach((exercise) => {
    exercise.sets.forEach((set) => {
      rows.push({
        date,
        workout_id: workout.id,
        workout_title: workout.title,
        focus: workout.preferences.focus,
        muscle_group: exercise.muscleGroup,
        exercise: exercise.name,
        exercise_type: exercise.type,
        set_number: set.setNumber,
        target_sets: exercise.targetSets,
        target_reps: exercise.targetReps,
        weight: set.weight != null ? set.weight : '',
        reps: set.reps != null ? set.reps : '',
        exercise_comment: exercise.note,
        workout_comment: workout.comment,
        increase_weight_next_time: exercise.increaseWeightNextTime ? 'true' : 'false'
      });
    });
  });

  appendHistoryRows(rows);

  if (fs.existsSync(CURRENT_WORKOUT_PATH)) fs.unlinkSync(CURRENT_WORKOUT_PATH);
  if (fs.existsSync(REQUEST_PATH)) fs.unlinkSync(REQUEST_PATH);

  res.json({ status: 'completed', rowsWritten: rows.length });
});

// Discard the current workout (generating or in-progress) without logging it.
app.delete('/api/current-workout', (req, res) => {
  if (generationProcess) {
    generationProcess.kill('SIGTERM');
    generationProcess = null;
  }
  if (editProcess) {
    editProcess.kill('SIGTERM');
    editProcess = null;
  }
  if (fs.existsSync(CURRENT_WORKOUT_PATH)) fs.unlinkSync(CURRENT_WORKOUT_PATH);
  if (fs.existsSync(REQUEST_PATH)) fs.unlinkSync(REQUEST_PATH);
  res.json({ status: 'none' });
});

// Past workouts, grouped from the CSV datasheet.
app.get('/api/history', (req, res) => {
  const rows = readHistoryRows();
  const workoutsById = new Map();

  rows.forEach((row) => {
    const id = row.workout_id || `${row.date}-${row.workout_title}`;
    if (!workoutsById.has(id)) {
      workoutsById.set(id, {
        id,
        date: row.date,
        title: row.workout_title,
        focus: row.focus,
        comment: row.workout_comment,
        exercises: new Map()
      });
    }
    const workout = workoutsById.get(id);
    if (!workout.exercises.has(row.exercise)) {
      workout.exercises.set(row.exercise, {
        name: row.exercise,
        muscleGroup: row.muscle_group,
        type: row.exercise_type,
        targetSets: row.target_sets,
        targetReps: row.target_reps,
        comment: row.exercise_comment,
        increaseWeightNextTime: row.increase_weight_next_time === 'true',
        sets: []
      });
    }
    workout.exercises.get(row.exercise).sets.push({
      setNumber: row.set_number,
      weight: row.weight,
      reps: row.reps
    });
  });

  const workouts = Array.from(workoutsById.values())
    .map((w) => ({ ...w, exercises: Array.from(w.exercises.values()) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  res.json(workouts);
});

// Trend / progress stats derived from the CSV datasheet.
app.get('/api/stats', (req, res) => {
  const rows = readHistoryRows().filter((r) => r.weight !== '' || r.reps !== '');

  const workoutDates = new Set(rows.map((r) => r.date));
  const totalWorkouts = workoutDates.size;

  // Weekly volume per muscle group (volume = weight * reps summed per ISO week)
  const weeklyVolume = {}; // { weekKey: { muscleGroup: volume } }
  const exerciseProgress = {}; // { exerciseName: [{date, weight, reps, volume}] }

  rows.forEach((row) => {
    const weight = parseFloat(row.weight) || 0;
    const reps = parseFloat(row.reps) || 0;
    const volume = weight * reps;
    const week = isoWeekKey(row.date);

    if (row.muscle_group) {
      weeklyVolume[week] = weeklyVolume[week] || {};
      weeklyVolume[week][row.muscle_group] = (weeklyVolume[week][row.muscle_group] || 0) + volume;
    }

    if (row.exercise) {
      exerciseProgress[row.exercise] = exerciseProgress[row.exercise] || [];
      exerciseProgress[row.exercise].push({ date: row.date, weight, reps, volume });
    }
  });

  res.json({ totalWorkouts, weeklyVolume, exerciseProgress });
});

function isoWeekKey(dateStr) {
  // Use the literal YYYY-MM-DD digits when present: new Date('2024-12-30')
  // parses as UTC midnight, so reading it back through local getters would
  // shift the date by a day in negative-offset timezones.
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr));
  let d;
  if (ymd) {
    d = new Date(Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])));
  } else {
    const date = new Date(dateStr);
    if (isNaN(date)) return 'unknown';
    d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  }
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

if (require.main === module) {
  initAuth();
  // HOST=127.0.0.1 keeps the app reachable only through a local reverse
  // proxy (e.g. Caddy on a droplet); unset, it listens on all interfaces
  // as before for local/tunnel use.
  const HOST = process.env.HOST || '0.0.0.0';
  app.listen(PORT, HOST, () => {
    console.log(`Momentum dashboard running at http://localhost:${PORT}`);
  });
}

module.exports = {
  csvEscape,
  parseCsv,
  cleanText,
  cleanLine,
  cleanPreferences,
  validateAndCleanWorkout,
  isoWeekKey
};
