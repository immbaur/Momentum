const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const CURRENT_WORKOUT_PATH = path.join(DATA_DIR, 'current-workout.json');
const REQUEST_PATH = path.join(DATA_DIR, 'workout-request.json');
const HISTORY_CSV_PATH = path.join(DATA_DIR, 'workout-history.csv');
const AGENT_PROMPT_PATH = path.join(__dirname, 'templates', 'AGENT_PROMPT.md');
const EDIT_EXERCISE_PROMPT_PATH = path.join(__dirname, 'templates', 'EDIT_EXERCISE_PROMPT.md');
const GENERATION_TIMEOUT_MS = 5 * 60 * 1000;

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

function parseCsvLine(line) {
  const result = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
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
      result.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  result.push(field);
  return result;
}

function readHistoryRows() {
  const raw = fs.readFileSync(HISTORY_CSV_PATH, 'utf8');
  const lines = raw.split('\n').filter((l) => l.length > 0);
  if (lines.length <= 1) return [];
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    CSV_COLUMNS.forEach((col, idx) => {
      row[col] = values[idx] !== undefined ? values[idx] : '';
    });
    rows.push(row);
  }
  return rows;
}

function appendHistoryRows(rows) {
  const csvText = rows.map(csvRow).join('');
  fs.appendFileSync(HISTORY_CSV_PATH, csvText);
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

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// --- Workout generation ----------------------------------------------------
// Runs templates/AGENT_PROMPT.md through the Claude Code CLI (non-interactive,
// scoped to Read/Write only) so it can read workoutplan.md, the CSV history,
// and workout-request.json, then write data/current-workout.json itself.

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

  const preferences = (readJson(REQUEST_PATH) || {}).preferences || {};
  writeJson(CURRENT_WORKOUT_PATH, {
    status: 'generating',
    requestedAt: new Date().toISOString(),
    preferences
  });

  const child = spawn('claude', ['-p', getAgentPromptText(), '--allowedTools', 'Read,Write'], {
    cwd: __dirname
  });
  generationProcess = child;

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const timer = setTimeout(() => child.kill('SIGTERM'), GENERATION_TIMEOUT_MS);

  child.on('close', (code) => {
    clearTimeout(timer);
    generationProcess = null;
    const result = readJson(CURRENT_WORKOUT_PATH);
    if (result && result.status === 'in_progress') return;
    writeJson(CURRENT_WORKOUT_PATH, {
      status: 'error',
      message: code === 0
        ? 'The agent finished but did not produce a valid workout.'
        : `Workout generation failed (exit code ${code}). ${stderr.slice(-500)}`,
      preferences
    });
  });

  child.on('error', (err) => {
    clearTimeout(timer);
    generationProcess = null;
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
// agent removes that flag once it's done editing data/current-workout.json
// in place. The PUT endpoint refuses to save over a file with a pending
// edit, so the browser's autosave can't race the agent's write.

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
  if (editProcess) {
    editProcess.kill('SIGTERM');
    editProcess = null;
  }

  writeJson(CURRENT_WORKOUT_PATH, {
    ...before,
    pendingEdit: { action, exerciseIndex, reason: reason || '', requestedAt: new Date().toISOString() }
  });

  const promptText = getEditExercisePromptText({ action, exerciseIndex, reason });
  const child = spawn('claude', ['-p', promptText, '--allowedTools', 'Read,Write,Edit'], {
    cwd: __dirname
  });
  editProcess = child;

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const timer = setTimeout(() => child.kill('SIGTERM'), GENERATION_TIMEOUT_MS);

  child.on('close', (code) => {
    clearTimeout(timer);
    editProcess = null;
    const result = readJson(CURRENT_WORKOUT_PATH);
    if (result && !result.pendingEdit) return; // agent cleared the flag itself
    writeJson(CURRENT_WORKOUT_PATH, {
      ...(result || before),
      pendingEdit: undefined,
      pendingEditError: code === 0
        ? 'The agent finished but did not update the exercise as expected.'
        : `Edit failed (exit code ${code}). ${stderr.slice(-500)}`
    });
  });

  child.on('error', (err) => {
    clearTimeout(timer);
    editProcess = null;
    writeJson(CURRENT_WORKOUT_PATH, {
      ...before,
      pendingEdit: undefined,
      pendingEditError: `Could not start the agent: ${err.message}`
    });
  });

  return { ok: true };
}

// --- App -------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Get the current workout (pending request or in-progress session)
app.get('/api/current-workout', (req, res) => {
  const current = readJson(CURRENT_WORKOUT_PATH);
  res.json(current || { status: 'none' });
});

// Submit preferences for a new workout. Writes a request file, then kicks
// off the agent (see generateWorkout) to read it and write
// data/current-workout.json using templates/workout-template.json's schema.
app.post('/api/workout-request', (req, res) => {
  const { timeAvailableMinutes, focus, notes } = req.body || {};

  const request = {
    requestedAt: new Date().toISOString(),
    preferences: {
      timeAvailableMinutes: timeAvailableMinutes || null,
      focus: focus || '',
      notes: notes || ''
    }
  };
  writeJson(REQUEST_PATH, request);

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

// Autosave the in-progress workout (weights, reps, comments) while at the gym.
app.put('/api/current-workout', (req, res) => {
  const workout = req.body;
  if (!workout || workout.status !== 'in_progress') {
    return res.status(400).json({ error: 'Expected a workout with status "in_progress"' });
  }
  const existing = readJson(CURRENT_WORKOUT_PATH);
  if (existing && existing.pendingEdit) {
    return res.status(409).json({ error: 'An exercise edit is in progress.' });
  }
  writeJson(CURRENT_WORKOUT_PATH, workout);
  res.json(workout);
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
// agent only writes once, at the end, after removing `pendingEdit`.
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
app.post('/api/current-workout/finish', (req, res) => {
  const workout = req.body;
  if (!workout || !Array.isArray(workout.exercises)) {
    return res.status(400).json({ error: 'Malformed workout payload' });
  }

  const date = workout.performedAt || workout.date || new Date().toISOString().slice(0, 16);
  const rows = [];
  workout.exercises.forEach((exercise) => {
    (exercise.sets || []).forEach((set) => {
      rows.push({
        date,
        workout_id: workout.id || '',
        workout_title: workout.title || '',
        focus: (workout.preferences && workout.preferences.focus) || '',
        muscle_group: exercise.muscleGroup || '',
        exercise: exercise.name || '',
        exercise_type: exercise.type || '',
        set_number: set.setNumber != null ? set.setNumber : '',
        target_sets: exercise.targetSets != null ? exercise.targetSets : '',
        target_reps: exercise.targetReps || '',
        weight: set.weight != null ? set.weight : '',
        reps: set.reps != null ? set.reps : '',
        exercise_comment: exercise.note || '',
        workout_comment: workout.comment || '',
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
  const date = new Date(dateStr);
  if (isNaN(date)) return 'unknown';
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

app.listen(PORT, () => {
  console.log(`Momentum dashboard running at http://localhost:${PORT}`);
});
