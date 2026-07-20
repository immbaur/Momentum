const app = document.getElementById('app');
const pageTitle = document.getElementById('page-title');
const backBtn = document.getElementById('back-btn');
const unitToggleBtn = document.getElementById('unit-toggle');

const TITLES = {
  login: 'Momentum',
  home: 'Momentum',
  'new-workout': 'New Workout',
  'current-workout': 'Current Workout',
  history: 'Past Workouts',
  trends: 'Trends & Stats'
};

let saveTimer = null;
let retrySaveTimer = null;
let workoutState = null; // in-memory copy of the current workout while logging
let currentView = 'home';
let generatingPollTimer = null;
let collapsedExercises = new Set(); // exercise names currently minimized, for overview during a workout

Chart.defaults.color = '#9aa0ab';
Chart.defaults.borderColor = '#2e333d';

backBtn.addEventListener('click', () => navigate('home'));

unitToggleBtn.textContent = getUnit();
unitToggleBtn.addEventListener('click', () => {
  setUnit(getUnit() === 'kg' ? 'lb' : 'kg');
  unitToggleBtn.textContent = getUnit();
  navigate(currentView);
});

function navigate(view) {
  currentView = view;
  clearTimeout(generatingPollTimer);
  generatingPollTimer = null;
  pageTitle.textContent = TITLES[view] || 'Momentum';
  backBtn.hidden = view === 'home' || view === 'login';
  unitToggleBtn.hidden = view === 'login';
  app.innerHTML = '';
  const tpl = document.getElementById(`tpl-${view}`);
  app.appendChild(tpl.content.cloneNode(true));

  if (view === 'login') wireLogin();
  if (view === 'home') wireHome();
  if (view === 'new-workout') wireNewWorkout();
  if (view === 'current-workout') loadCurrentWorkout();
  if (view === 'history') loadHistory();
  if (view === 'trends') loadTrends();
}

// --- API helper --------------------------------------------------------
// fetch wrapper that surfaces failures instead of ignoring them: throws an
// Error with `.status` set, and bounces to the login page on 401.

async function api(path, options) {
  let res;
  try {
    res = await fetch(path, options);
  } catch (networkErr) {
    const err = new Error('Network error — check your connection.');
    err.status = 0;
    throw err;
  }
  if (res.status === 401) {
    navigate('login');
    const err = new Error('Signed out.');
    err.status = 401;
    throw err;
  }
  if (!res.ok) {
    let message = `Request failed (${res.status}).`;
    try {
      const body = await res.json();
      if (body && body.error) message = body.error;
    } catch (ignored) { /* non-JSON error body */ }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// --- Login ---------------------------------------------------------------

function wireLogin() {
  const form = document.getElementById('login-form');
  const errorEl = document.getElementById('login-error');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await api('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: new FormData(form).get('password') })
      });
      navigate('home');
    } catch (err) {
      errorEl.textContent = err.status === 401 ? 'Wrong password.' : err.message;
      errorEl.hidden = false;
      button.disabled = false;
    }
  });
}

// --- Weight units ------------------------------------------------------
// Weights are always stored in kg (JSON files and the CSV datasheet).
// The unit toggle only affects how they're displayed/entered here.

const KG_PER_LB = 0.45359237;

function getUnit() {
  return localStorage.getItem('momentum-unit') || 'lb';
}

function setUnit(unit) {
  localStorage.setItem('momentum-unit', unit);
}

function kgToDisplay(kg) {
  const num = Number(kg);
  if (isNaN(num)) return kg;
  const val = getUnit() === 'lb' ? num / KG_PER_LB : num;
  return Math.round(val * 10) / 10;
}

function displayToKg(value) {
  const num = Number(value);
  if (isNaN(num)) return null;
  const kg = getUnit() === 'lb' ? num * KG_PER_LB : num;
  return Math.round(kg * 100) / 100;
}

function wireHome() {
  document.querySelectorAll('.menu-btn').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.view));
  });
}

// --- New workout -----------------------------------------------------------

function wireNewWorkout() {
  const form = document.getElementById('new-workout-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (data.timeAvailableMinutes) {
      data.timeAvailableMinutes = Number(data.timeAvailableMinutes);
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api('/api/workout-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      navigate('current-workout');
    } catch (err) {
      button.disabled = false;
      if (err.status !== 401) await showMessage(`Could not start the workout: ${err.message}`);
    }
  });
}

// --- Current workout ---------------------------------------------------

async function loadCurrentWorkout() {
  const container = document.getElementById('current-workout-content');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  let workout;
  try {
    workout = await api('/api/current-workout');
  } catch (err) {
    if (err.status === 401) return;
    container.innerHTML = `<p class="empty-state">Could not load the workout: ${escapeHtml(err.message)}<br><br><button class="secondary-btn" id="reload-current">Retry</button></p>`;
    document.getElementById('reload-current').addEventListener('click', () => loadCurrentWorkout());
    return;
  }

  if (workout.status === 'none' || !workout.status) {
    container.innerHTML = `
      <div class="empty-state">
        No workout in progress.<br>
        Start one from <strong>Create New Workout</strong>.
      </div>`;
    return;
  }

  if (workout.status === 'generating') {
    renderGenerating(container, workout);
    generatingPollTimer = setTimeout(() => {
      if (currentView === 'current-workout') loadCurrentWorkout();
    }, 3000);
    return;
  }

  if (workout.status === 'error') {
    renderGenerationError(container, workout);
    return;
  }

  if (workout.status === 'in_progress' && workout.pendingEdit) {
    renderEditingExercise(container, workout);
    generatingPollTimer = setTimeout(() => {
      if (currentView === 'current-workout') loadCurrentWorkout();
    }, 3000);
    return;
  }

  if (workout.status === 'in_progress' && workout.pendingEditError) {
    renderEditError(container, workout);
    return;
  }

  if (workout.status === 'in_progress') {
    workoutState = workout;
    renderInProgress(container, workout);
  }
}

function renderGenerating(container, workout) {
  const prefs = workout.preferences || {};
  container.innerHTML = `
    <div class="card pending-box">
      <p><strong>Generating your workout…</strong></p>
      <p class="pill">Time: ${prefs.timeAvailableMinutes || 'any'} min · Focus: ${prefs.focus || 'none'}</p>
      ${prefs.notes ? `<p class="exercise-meta">"${escapeHtml(prefs.notes)}"</p>` : ''}
      <p>The agent is reading your workout plan and history to put this
together. This usually takes under a minute — this page checks
automatically.</p>
      <div class="action-row">
        <button class="danger-btn" id="discard-pending">Cancel</button>
      </div>
    </div>`;
  document.getElementById('discard-pending').addEventListener('click', discardCurrentWorkout);
}

function renderGenerationError(container, workout) {
  const prefs = workout.preferences || {};
  container.innerHTML = `
    <div class="card pending-box">
      <p><strong>Workout generation failed.</strong></p>
      <p class="exercise-meta">${escapeHtml(workout.message || 'Unknown error.')}</p>
      <div class="action-row">
        <button class="secondary-btn" id="retry-generation">Retry</button>
        <button class="danger-btn" id="discard-pending">Discard</button>
      </div>
    </div>`;
  document.getElementById('retry-generation').addEventListener('click', async () => {
    try {
      await api('/api/current-workout/retry', { method: 'POST' });
      navigate('current-workout');
    } catch (err) {
      if (err.status !== 401) await showMessage(`Could not retry: ${err.message}`);
    }
  });
  document.getElementById('discard-pending').addEventListener('click', discardCurrentWorkout);
}

function renderEditingExercise(container, workout) {
  const isSwap = workout.pendingEdit.action === 'swap';
  container.innerHTML = `
    <div class="card pending-box">
      <p><strong>${isSwap ? 'Swapping exercise' : 'Adding exercise'}…</strong></p>
      ${workout.pendingEdit.reason ? `<p class="exercise-meta">"${escapeHtml(workout.pendingEdit.reason)}"</p>` : ''}
      <p>The rest of your workout is untouched — this only ${isSwap ? 'replaces the one exercise' : 'adds a new exercise'}.
      Usually done within a minute — this page checks automatically.</p>
      <div class="action-row">
        <button class="danger-btn" id="cancel-edit">Cancel</button>
      </div>
    </div>`;
  document.getElementById('cancel-edit').addEventListener('click', async () => {
    try {
      await api('/api/current-workout/exercises/cancel-edit', { method: 'POST' });
      navigate('current-workout');
    } catch (err) {
      if (err.status !== 401) await showMessage(`Could not cancel: ${err.message}`);
    }
  });
}

function renderEditError(container, workout) {
  container.innerHTML = `
    <div class="card pending-box">
      <p><strong>Exercise not changed.</strong></p>
      <p class="exercise-meta">${escapeHtml(workout.pendingEditError || 'Unknown error.')}</p>
      <div class="action-row">
        <button class="secondary-btn" id="dismiss-edit-error">Dismiss</button>
      </div>
    </div>`;
  document.getElementById('dismiss-edit-error').addEventListener('click', async () => {
    // The server drops pendingEditError on the next save (unknown fields
    // never round-trip), so saving the workout as-is dismisses it.
    delete workout.pendingEditError;
    workoutState = workout;
    await saveNow();
    navigate('current-workout');
  });
}

function renderInProgress(container, workout) {
  const prefs = workout.preferences || {};
  const exercisesHtml = workout.exercises.map((ex, exIdx) => {
    const isCollapsed = collapsedExercises.has(ex.name);
    const sets = ex.sets || [];
    const completedSets = sets.filter((s) => s.weight != null && s.reps != null).length;
    const isDone = sets.length > 0 && completedSets === sets.length;

    const bodyHtml = isCollapsed ? '' : `
      <div class="exercise-meta">Target: ${ex.targetSets}×${escapeHtml(ex.targetReps || '')}${ex.comment ? ` · ${escapeHtml(ex.comment)}` : ''}</div>
      ${sets.map((set, setIdx) => `
        <div class="set-row">
          <span class="set-label">#${set.setNumber != null ? set.setNumber : setIdx + 1}</span>
          <input type="number" inputmode="decimal" placeholder="${getUnit()}" data-field="weight" data-ex="${exIdx}" data-set="${setIdx}" value="${set.weight != null ? kgToDisplay(set.weight) : ''}">
          <input type="number" inputmode="numeric" placeholder="reps" data-field="reps" data-ex="${exIdx}" data-set="${setIdx}" value="${set.reps != null ? set.reps : ''}">
          <button type="button" class="remove-set-btn" data-remove-set data-ex="${exIdx}" data-set="${setIdx}" ${sets.length <= 1 ? 'disabled' : ''}>&times;</button>
        </div>
      `).join('')}
      <button type="button" class="add-set-btn" data-add-set="${exIdx}">+ Add set</button>
      <textarea class="exercise-comment" rows="1" placeholder="Your notes for this exercise" data-ex-note="${exIdx}">${escapeHtml(ex.note || '')}</textarea>
      <label class="increase-weight-label">
        <input type="checkbox" data-increase-weight="${exIdx}" ${ex.increaseWeightNextTime ? 'checked' : ''}>
        Increase weight next time
      </label>
      <div class="exercise-actions">
        <button type="button" class="text-btn" data-swap-exercise="${exIdx}">Swap exercise</button>
        <button type="button" class="text-btn danger-text-btn" data-remove-exercise="${exIdx}">Remove exercise</button>
      </div>
    `;

    return `
      <div class="card exercise-card" data-ex-idx="${exIdx}">
        <div class="exercise-header" data-toggle-exercise="${escapeAttr(ex.name)}">
          <div class="exercise-header-main">
            <h3>${escapeHtml(ex.name)}</h3>
            <span class="pill">${escapeHtml(ex.muscleGroup || '')}</span>
          </div>
          <div class="exercise-header-status">
            <span class="completion-badge${isDone ? ' done' : ''}">${completedSets}/${sets.length}</span>
            <span class="collapse-chevron">${isCollapsed ? '▸' : '▾'}</span>
          </div>
        </div>
        ${bodyHtml}
      </div>
    `;
  }).join('');

  if (!workout.performedAt) {
    workout.performedAt = nowLocalISO();
  }

  const summaryParts = [];
  if (prefs.focus) summaryParts.push(escapeHtml(prefs.focus));
  if (prefs.timeAvailableMinutes) summaryParts.push(`${prefs.timeAvailableMinutes} min`);
  const summaryPill = summaryParts.length ? `<span class="pill">${summaryParts.join(' · ')}</span>` : '';

  container.innerHTML = `
    <div class="workout-summary">
      <div>
        <h2>${escapeHtml(workout.title || 'Workout')}</h2>
        ${summaryPill}
      </div>
    </div>
    <div class="card">
      <label class="field-label">
        Performed at
        <input type="datetime-local" id="performed-at" value="${escapeAttr(workout.performedAt)}">
      </label>
    </div>
    ${exercisesHtml}
    <button type="button" class="add-set-btn" id="add-exercise-btn">+ Add exercise</button>
    <div class="card">
      <label class="field-label">
        Workout comment
        <textarea id="workout-comment" class="exercise-comment" rows="2" placeholder="How did the session feel?">${escapeHtml(workout.comment || '')}</textarea>
      </label>
    </div>
    <div class="action-row">
      <button class="danger-btn" id="discard-workout">Discard</button>
      <button class="primary-btn" id="finish-workout">Finish &amp; Save</button>
    </div>
    <p class="exercise-meta" id="save-status" style="text-align:center;margin-top:0.75rem;"></p>
  `;

  document.getElementById('performed-at').addEventListener('input', (e) => {
    workoutState.performedAt = e.target.value;
    scheduleSave();
  });
  scheduleSave(); // persist the default performedAt if it was just filled in

  container.querySelectorAll('[data-toggle-exercise]').forEach((header) => {
    header.addEventListener('click', (e) => {
      const name = e.currentTarget.dataset.toggleExercise;
      if (collapsedExercises.has(name)) collapsedExercises.delete(name);
      else collapsedExercises.add(name);
      renderInProgress(container, workoutState);
    });
  });

  container.querySelectorAll('input[data-field]').forEach((input) => {
    input.addEventListener('input', onSetFieldChange);
  });
  container.querySelectorAll('input[data-field="weight"]').forEach((input) => {
    input.addEventListener('change', onWeightCommit);
  });
  container.querySelectorAll('textarea[data-ex-note]').forEach((textarea) => {
    textarea.addEventListener('input', (e) => {
      workoutState.exercises[Number(e.target.dataset.exNote)].note = e.target.value;
      scheduleSave();
    });
  });
  container.querySelectorAll('[data-add-set]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const exIdx = Number(e.target.dataset.addSet);
      const sets = workoutState.exercises[exIdx].sets;
      sets.push({ setNumber: sets.length + 1, weight: null, reps: null });
      scheduleSave();
      renderInProgress(container, workoutState);
    });
  });
  container.querySelectorAll('[data-remove-set]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const exIdx = Number(e.target.dataset.ex);
      const setIdx = Number(e.target.dataset.set);
      const sets = workoutState.exercises[exIdx].sets;
      if (sets.length <= 1) return;
      sets.splice(setIdx, 1);
      sets.forEach((s, i) => { s.setNumber = i + 1; });
      scheduleSave();
      renderInProgress(container, workoutState);
    });
  });
  container.querySelectorAll('input[data-increase-weight]').forEach((checkbox) => {
    checkbox.addEventListener('change', (e) => {
      workoutState.exercises[Number(e.target.dataset.increaseWeight)].increaseWeightNextTime = e.target.checked;
      scheduleSave();
    });
  });
  document.getElementById('workout-comment').addEventListener('input', (e) => {
    workoutState.comment = e.target.value;
    scheduleSave();
  });
  document.getElementById('finish-workout').addEventListener('click', finishWorkout);
  document.getElementById('discard-workout').addEventListener('click', discardCurrentWorkout);
  document.getElementById('add-exercise-btn').addEventListener('click', addExercise);
  container.querySelectorAll('[data-swap-exercise]').forEach((btn) => {
    btn.addEventListener('click', (e) => swapExercise(Number(e.target.dataset.swapExercise)));
  });
  container.querySelectorAll('[data-remove-exercise]').forEach((btn) => {
    btn.addEventListener('click', (e) => removeExercise(container, Number(e.target.dataset.removeExercise)));
  });
}

async function addExercise() {
  const reason = await promptForText(
    'Add an exercise. Any reason or preference? (optional)',
    'e.g. add more core work, no barbell available'
  );
  if (reason === null) return;
  try {
    await flushSave();
    await api('/api/current-workout/exercises/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    navigate('current-workout');
  } catch (err) {
    if (err.status !== 401) await showMessage(`Could not add an exercise: ${err.message}`);
  }
}

async function swapExercise(exIdx) {
  const exName = workoutState.exercises[exIdx].name;
  const reason = await promptForText(
    `Swap "${exName}" for something else. Why?`,
    'e.g. no cable machine available, shoulder pain'
  );
  if (reason === null) return;
  try {
    await flushSave();
    await api(`/api/current-workout/exercises/${exIdx}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason })
    });
    navigate('current-workout');
  } catch (err) {
    if (err.status !== 401) await showMessage(`Could not swap the exercise: ${err.message}`);
  }
}

async function removeExercise(container, exIdx) {
  const exName = workoutState.exercises[exIdx].name;
  if (!(await showConfirm(`Remove "${exName}" from this workout?`))) return;
  workoutState.exercises.splice(exIdx, 1);
  scheduleSave();
  renderInProgress(container, workoutState);
}

function onSetFieldChange(e) {
  const { field, ex, set } = e.target.dataset;
  const exIdx = Number(ex);
  const setIdx = Number(set);
  let value = e.target.value;
  if (field === 'weight') {
    value = value === '' ? null : displayToKg(value);
  } else if (field === 'reps') {
    value = value === '' ? null : Number(value);
  }
  workoutState.exercises[exIdx].sets[setIdx][field] = value;
  scheduleSave();
}

// Fires once a weight field is committed (blur / done typing), not on every
// keystroke, so a two-digit weight like "45" doesn't propagate as "4" first.
// Carries the value over to this exercise's other still-empty sets, so only
// #1 needs typing in the common case of using the same weight across all
// sets. Sets the user has already filled in are left alone.
function onWeightCommit(e) {
  const exIdx = Number(e.target.dataset.ex);
  const setIdx = Number(e.target.dataset.set);
  const value = workoutState.exercises[exIdx].sets[setIdx].weight;
  if (value == null) return;

  workoutState.exercises[exIdx].sets.forEach((otherSet, otherIdx) => {
    if (otherIdx === setIdx || otherSet.weight != null) return;
    otherSet.weight = value;
    const otherInput = document.querySelector(
      `input[data-field="weight"][data-ex="${exIdx}"][data-set="${otherIdx}"]`
    );
    if (otherInput) otherInput.value = kgToDisplay(value);
  });

  scheduleSave();
}

// --- Saving ----------------------------------------------------------------
// Autosaves are debounced, checked for success, and retried on transient
// failures. A 409 means the server has newer state (another tab or an agent
// edit finished) — reload it instead of overwriting.

function setSaveStatus(text) {
  const el = document.getElementById('save-status');
  if (el) el.textContent = text;
}

function scheduleSave() {
  setSaveStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveNow(); }, 500);
}

async function saveNow() {
  if (!workoutState) return;
  clearTimeout(retrySaveTimer);
  try {
    const saved = await api('/api/current-workout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workoutState)
    });
    if (workoutState) workoutState.rev = saved.rev;
    setSaveStatus('Saved');
  } catch (err) {
    if (err.status === 401) return;
    if (err.status === 409) {
      setSaveStatus('Reloading latest version…');
      if (currentView === 'current-workout') navigate('current-workout');
      return;
    }
    if (err.status === 400) {
      setSaveStatus(`Not saved: ${err.message}`);
      return;
    }
    setSaveStatus('Save failed — retrying…');
    retrySaveTimer = setTimeout(saveNow, 3000);
  }
}

// Writes the in-memory workout to disk right now, bypassing the debounce.
// Used before handing off to an agent (add/swap exercise) so it reads fresh
// data instead of racing the next scheduled autosave.
async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  await saveNow();
}

async function finishWorkout() {
  if (!(await showConfirm('Finish this workout and save it to your history?'))) return;
  const btn = document.getElementById('finish-workout');
  if (btn) btn.disabled = true;
  clearTimeout(saveTimer);
  clearTimeout(retrySaveTimer);
  try {
    await api('/api/current-workout/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workoutState)
    });
    workoutState = null;
    navigate('home');
  } catch (err) {
    if (btn) btn.disabled = false;
    if (err.status === 401) return;
    if (err.status === 409) {
      await showMessage(`Could not finish: ${err.message}`);
      navigate('current-workout');
      return;
    }
    await showMessage(`Could not save the workout: ${err.message} Nothing was lost — try again.`);
  }
}

async function discardCurrentWorkout() {
  if (!(await showConfirm('Discard this workout? Nothing will be saved.'))) return;
  clearTimeout(saveTimer);
  clearTimeout(retrySaveTimer);
  try {
    await api('/api/current-workout', { method: 'DELETE' });
    workoutState = null;
    navigate('home');
  } catch (err) {
    if (err.status !== 401) await showMessage(`Could not discard: ${err.message}`);
  }
}

function showConfirm(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box">
        <p>${escapeHtml(message)}</p>
        <div class="action-row">
          <button class="secondary-btn" data-choice="cancel">Cancel</button>
          <button class="danger-btn" data-choice="ok">Confirm</button>
        </div>
      </div>`;
    overlay.addEventListener('click', (e) => {
      const choice = e.target.dataset.choice;
      if (!choice) return;
      overlay.remove();
      resolve(choice === 'ok');
    });
    document.body.appendChild(overlay);
  });
}

// One-button informational dialog (errors, notices).
function showMessage(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box">
        <p>${escapeHtml(message)}</p>
        <div class="action-row" style="grid-template-columns:1fr;">
          <button class="primary-btn" data-choice="ok">OK</button>
        </div>
      </div>`;
    overlay.addEventListener('click', (e) => {
      if (!e.target.dataset.choice) return;
      overlay.remove();
      resolve();
    });
    document.body.appendChild(overlay);
  });
}

// Resolves to the trimmed text on "Continue", or null on "Cancel".
function promptForText(message, placeholder) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.innerHTML = `
      <div class="confirm-box">
        <p>${escapeHtml(message)}</p>
        <textarea id="prompt-input" rows="2" placeholder="${escapeAttr(placeholder || '')}"></textarea>
        <div class="action-row" style="margin-top:0.75rem;">
          <button class="secondary-btn" data-choice="cancel">Cancel</button>
          <button class="primary-btn" data-choice="ok">Continue</button>
        </div>
      </div>`;
    overlay.addEventListener('click', (e) => {
      const choice = e.target.dataset.choice;
      if (!choice) return;
      const value = overlay.querySelector('#prompt-input').value.trim();
      overlay.remove();
      resolve(choice === 'ok' ? value : null);
    });
    document.body.appendChild(overlay);
  });
}

// --- History -------------------------------------------------------------

async function loadHistory() {
  const container = document.getElementById('history-content');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  let workouts;
  try {
    workouts = await api('/api/history');
  } catch (err) {
    if (err.status === 401) return;
    container.innerHTML = `<p class="empty-state">Could not load history: ${escapeHtml(err.message)}</p>`;
    return;
  }

  if (!workouts.length) {
    container.innerHTML = '<p class="empty-state">No completed workouts yet.</p>';
    return;
  }

  container.innerHTML = `<div class="card" style="padding:0;">` + workouts.map((w) => `
    <details class="history-item">
      <summary><span>${escapeHtml(w.title || 'Workout')} — ${escapeHtml(formatDateTime(w.date))}</span>${w.focus ? `<span class="pill">${escapeHtml(w.focus)}</span>` : ''}</summary>
      ${w.exercises.map((ex) => `
        <div class="history-exercise">
          <strong>${escapeHtml(ex.name)}</strong>
          <span class="exercise-meta">${escapeHtml(ex.muscleGroup || '')}</span>
          <div class="history-sets">${ex.sets.map((s) => `${s.weight ? kgToDisplay(s.weight) : '-'}${getUnit()}×${s.reps || '-'}`).join('  ·  ')}</div>
          ${ex.comment ? `<div class="exercise-meta">"${escapeHtml(ex.comment)}"</div>` : ''}
          ${ex.increaseWeightNextTime ? '<div class="exercise-meta increase-flag">&#8593; increase weight next time</div>' : ''}
        </div>
      `).join('')}
      ${w.comment ? `<p class="exercise-meta" style="margin-top:0.75rem;">"${escapeHtml(w.comment)}"</p>` : ''}
    </details>
  `).join('') + `</div>`;
}

// --- Trends ----------------------------------------------------------------

async function loadTrends() {
  const container = document.getElementById('trends-content');
  container.innerHTML = '<p class="empty-state">Loading…</p>';
  let stats;
  try {
    stats = await api('/api/stats');
  } catch (err) {
    if (err.status === 401) return;
    container.innerHTML = `<p class="empty-state">Could not load stats: ${escapeHtml(err.message)}</p>`;
    return;
  }

  if (!stats.totalWorkouts) {
    container.innerHTML = '<p class="empty-state">No data yet. Finish a workout to see trends.</p>';
    return;
  }

  const weeks = Object.keys(stats.weeklyVolume).sort();
  const muscleGroups = Array.from(new Set(weeks.flatMap((w) => Object.keys(stats.weeklyVolume[w]))));

  container.innerHTML = `
    <div class="stat-grid">
      <div class="stat-box"><div class="value">${stats.totalWorkouts}</div><div class="label">Workouts logged</div></div>
      <div class="stat-box"><div class="value">${Object.keys(stats.exerciseProgress).length}</div><div class="label">Exercises tracked</div></div>
    </div>
    <div class="chart-wrap">
      <h3>Weekly volume by muscle group (${getUnit()})</h3>
      <canvas id="volume-chart" height="220"></canvas>
    </div>
    <div class="chart-wrap">
      <h3>Exercise</h3>
      <select id="exercise-select"></select>
      <canvas id="exercise-chart" height="220" style="margin-top:0.75rem;"></canvas>
    </div>
  `;

  const palette = ['#4f8cff', '#3ecf8e', '#e8b339', '#ff6b6b', '#a78bfa', '#38bdf8', '#f472b6', '#fb923c', '#94a3b8'];
  new Chart(document.getElementById('volume-chart'), {
    type: 'bar',
    data: {
      labels: weeks,
      datasets: muscleGroups.map((mg, i) => ({
        label: mg,
        data: weeks.map((w) => kgToDisplay(stats.weeklyVolume[w][mg] || 0)),
        backgroundColor: palette[i % palette.length]
      }))
    },
    options: {
      responsive: true,
      scales: { x: { stacked: true }, y: { stacked: true } },
      plugins: { legend: { labels: { color: '#f0f1f3' } } }
    }
  });

  const select = document.getElementById('exercise-select');
  const exerciseNames = Object.keys(stats.exerciseProgress);
  select.innerHTML = exerciseNames.map((n) => `<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`).join('');

  let exerciseChart = null;
  function renderExerciseChart(name) {
    const points = stats.exerciseProgress[name] || [];
    if (exerciseChart) exerciseChart.destroy();
    exerciseChart = new Chart(document.getElementById('exercise-chart'), {
      type: 'line',
      data: {
        labels: points.map((p) => p.date),
        datasets: [{
          label: `Weight (${getUnit()})`,
          data: points.map((p) => kgToDisplay(p.weight)),
          borderColor: '#4f8cff',
          tension: 0.25
        }]
      },
      options: { responsive: true, plugins: { legend: { labels: { color: '#f0f1f3' } } } }
    });
  }
  select.addEventListener('change', () => renderExerciseChart(select.value));
  if (exerciseNames.length) renderExerciseChart(exerciseNames[0]);
}

// --- Utils -------------------------------------------------------------

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function escapeAttr(str) {
  return escapeHtml(str);
}

function nowLocalISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDateTime(str) {
  if (!str) return '';
  const d = new Date(str);
  if (isNaN(d)) return str;
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

// --- Startup: show the app if a session exists, otherwise the landing page.

(async () => {
  try {
    const res = await fetch('/api/auth/status');
    const status = await res.json();
    navigate(status.authenticated ? 'home' : 'login');
  } catch (err) {
    navigate('login');
  }
})();
