/*
 * StudyPilot – user interface.
 *
 * The app is a single page with five "views" (dashboard, assignments, courses,
 * focus timer, settings). The URL hash (#tasks, #focus …) decides which view is
 * shown. All data lives in one `state` object that is saved to localStorage
 * after every change; the pure helper functions live in logic.js.
 */
(function () {
  'use strict';

  const L = window.StudyLogic;
  const STORAGE_KEY = 'studypilot.v1';
  const TIMER_KEY = 'studypilot.timer';
  const VIEWS = ['dashboard', 'tasks', 'courses', 'focus', 'settings'];
  const RING_CIRCUMFERENCE = 2 * Math.PI * 96;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  /** Escape user text before putting it into HTML (prevents broken markup / XSS). */
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
  }

  function icon(name) {
    return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  }

  function formatDate(isoDate, options) {
    const date = L.parseISODate(isoDate);
    return date ? date.toLocaleDateString('en-GB', options) : '';
  }

  /* ================================================================== */
  /* State & persistence                                                 */
  /* ================================================================== */

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return L.normalizeState(JSON.parse(raw));
    } catch (err) {
      console.warn('StudyPilot: could not read saved data, starting with sample data.', err);
    }
    // First visit: show sample data so the app is easy to explore.
    return L.createDemoState(new Date());
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (err) {
      console.warn('StudyPilot: could not save (storage full or blocked).', err);
    }
  }

  let state = loadState();
  save();

  const ui = {
    view: 'dashboard',
    filter: { status: 'open', courseId: 'all', query: '' },
    editingTaskId: null,
    editingCourseId: null,
  };

  const courseById = (id) => state.courses.find((c) => c.id === id) || null;
  const taskById = (id) => state.tasks.find((t) => t.id === id) || null;

  /* ================================================================== */
  /* Small UI helpers: toasts, confirm dialog, sound                     */
  /* ================================================================== */

  function toast(message, { actionLabel, onAction, timeout = 3500 } = {}) {
    const container = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.textContent = message;
    el.append(text);

    let closed = false;
    const dismiss = () => {
      if (closed) return;
      closed = true;
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 200);
    };

    if (actionLabel) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'toast-action';
      button.textContent = actionLabel;
      button.addEventListener('click', () => {
        onAction();
        dismiss();
      });
      el.append(button);
    }
    container.append(el);
    while (container.children.length > 3) container.firstElementChild.remove();
    setTimeout(dismiss, actionLabel ? 6000 : timeout);
  }

  function confirmDialog({ title, message, confirmText = 'Delete' }) {
    const dialog = $('#confirm-dialog');
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    $('#confirm-ok').textContent = confirmText;
    dialog.returnValue = '';
    dialog.showModal();
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    });
  }

  let audioCtx = null;
  function prepareAudio() {
    // Browsers only allow sound after a user gesture, so this runs when Start is clicked.
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (err) {
      audioCtx = null;
    }
  }
  function chime() {
    if (!audioCtx) return;
    const start = audioCtx.currentTime;
    [660, 880, 990].forEach((freq, i) => {
      const t = start + i * 0.16;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.5);
    });
  }

  /* ================================================================== */
  /* Router                                                              */
  /* ================================================================== */

  function viewFromHash() {
    const name = location.hash.replace('#', '');
    return VIEWS.includes(name) ? name : 'dashboard';
  }

  window.addEventListener('hashchange', () => {
    ui.view = viewFromHash();
    render();
    window.scrollTo(0, 0);
    $('#main').focus({ preventScroll: true });
  });

  function render() {
    for (const section of $$('.view')) section.hidden = section.dataset.view !== ui.view;
    for (const link of $$('[data-nav]')) {
      if (link.dataset.nav === ui.view) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    const renderers = {
      dashboard: renderDashboard,
      tasks: renderTasks,
      courses: renderCourses,
      focus: renderFocus,
      settings: renderSettings,
    };
    renderers[ui.view]();
    renderTimer();
  }

  /* ================================================================== */
  /* Shared pieces of markup                                             */
  /* ================================================================== */

  function courseTag(course) {
    if (!course) return '<span class="course-tag"><i class="dot"></i>No course</span>';
    return `<span class="course-tag" data-c="${course.color}"><i class="dot"></i>${esc(course.name)}</span>`;
  }

  function priorityTag(priority) {
    const label = { high: 'High', medium: 'Medium', low: 'Low' }[priority] || 'Medium';
    return `<span class="prio prio-${priority}" title="${label} priority"><span class="prio-bars" aria-hidden="true"><i></i><i></i><i></i></span>${label}</span>`;
  }

  function taskItem(task, today, { compact = false } = {}) {
    const course = courseById(task.courseId);
    const status = L.taskStatus(task, today);
    const dueText = task.done ? 'Done' : L.dueLabel(L.daysUntil(task.due, today));
    const dueIcon = { overdue: 'alert', today: 'clock', soon: 'clock', later: 'calendar', done: 'check' }[status];
    const fullDate = formatDate(task.due, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const title = esc(task.title);

    const meta = [courseTag(course)];
    if (!compact) meta.push(priorityTag(task.priority));
    if (task.estimate) meta.push(`<span>${esc(L.formatHours(task.estimate))}</span>`);
    if (!compact && fullDate) meta.push(`<span>${esc(fullDate)}</span>`);

    const actions = compact ? '' : `
      <div class="task-actions">
        ${task.done ? '' : `<button class="icon-btn" data-action="focus-task" title="Start a focus session" aria-label="Start a focus session for ${title}">${icon('play')}</button>`}
        <button class="icon-btn" data-action="edit-task" title="Edit" aria-label="Edit ${title}">${icon('edit')}</button>
        <button class="icon-btn danger" data-action="delete-task" title="Delete" aria-label="Delete ${title}">${icon('trash')}</button>
      </div>`;

    return `
      <li class="task${task.done ? ' is-done' : ''}" data-id="${esc(task.id)}">
        <button class="check" data-action="toggle-task" aria-pressed="${task.done}"
          aria-label="${task.done ? 'Mark as not done' : 'Mark as done'}: ${title}">${icon('check')}</button>
        <div class="task-main">
          <div class="task-title">${title}</div>
          <div class="task-meta">${meta.join('')}</div>
          ${!compact && task.notes ? `<p class="task-notes">${esc(task.notes)}</p>` : ''}
        </div>
        <span class="due due-${status}" title="${esc(fullDate)}">${icon(dueIcon)}${esc(dueText)}</span>
        ${actions}
      </li>`;
  }

  function emptyState(iconName, title, text, buttonHtml = '') {
    return `<div class="empty">${icon(iconName)}<h3>${esc(title)}</h3><p>${esc(text)}</p>${buttonHtml}</div>`;
  }

  /* ================================================================== */
  /* Dashboard                                                           */
  /* ================================================================== */

  function statTile(label, value, sub, extraClass = '', iconName = '') {
    return `
      <div class="stat ${extraClass}">
        <div class="stat-label">${iconName ? icon(iconName) : ''}${esc(label)}</div>
        <div class="stat-value">${esc(value)}</div>
        <div class="stat-sub">${esc(sub)}</div>
      </div>`;
  }

  function renderDashboard() {
    const today = new Date();
    const hour = today.getHours();
    $('#greeting').textContent =
      hour < 5 ? 'Studying late?' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    $('#today-label').textContent = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    $('#demo-banner').hidden = !state.meta.demo;

    const s = L.dashboardStats(state, today);
    $('#stats').innerHTML = [
      statTile('Open assignments', s.open, `${s.doneThisWeek} completed in the last 7 days`),
      statTile('Due in next 7 days', s.dueSoon, s.dueSoon ? 'Plan your week' : 'Nothing due soon'),
      statTile('Overdue', s.overdue, s.overdue ? 'Needs attention' : 'All caught up', s.overdue ? 'is-alert' : '', s.overdue ? 'alert' : ''),
      statTile('Focus, last 7 days', L.formatMinutes(s.focusWeek), 'From finished focus rounds', '', 'clock'),
      statTile('Study streak', `${s.streak} ${s.streak === 1 ? 'day' : 'days'}`, s.streak ? 'Keep it going!' : 'Do a focus round today', 'is-streak', 'flame'),
    ].join('');

    const upcoming = L.sortTasks(state.tasks.filter((t) => !t.done)).slice(0, 5);
    $('#next-deadlines').innerHTML = upcoming.length
      ? upcoming.map((t) => taskItem(t, today, { compact: true })).join('')
      : '<li class="empty-row">Nothing left to do. Add an assignment to get started.</li>';

    renderFocusChart(today);
    renderCourseProgress();
  }

  function axisLabel(minutes) {
    if (minutes === 0) return '0';
    if (minutes < 60) return `${minutes}m`;
    return `${minutes / 60}h`;
  }

  function renderFocusChart(today) {
    const days = L.focusByDay(state.sessions, today);
    const total = days.reduce((sum, d) => sum + d.minutes, 0);
    $('#week-total').textContent = `${L.formatMinutes(total)} total`;

    const max = Math.max(...days.map((d) => d.minutes));
    const scale = L.niceScale(max);
    const maxIndex = max > 0 ? days.findIndex((d) => d.minutes === max) : -1;

    const gridlines = scale.ticks
      .map((t) => `<div class="gridline${t === 0 ? ' is-base' : ''}" style="bottom:${(t / scale.max) * 100}%"><span>${axisLabel(t)}</span></div>`)
      .join('');

    const cols = days
      .map((d, i) => {
        const full = formatDate(d.date, { weekday: 'long', day: 'numeric', month: 'short' });
        const value = L.formatMinutes(d.minutes);
        const cap = i === maxIndex ? `<span class="cap-label">${esc(value)}</span>` : '';
        return `<div class="col" tabindex="0" data-value="${esc(value)}" data-label="${esc(full)}" aria-label="${esc(full)}: ${esc(value)}">
            <div class="bar" style="height:${(d.minutes / scale.max) * 100}%">${cap}</div>
          </div>`;
      })
      .join('');

    const labels = days.map((d) => `<span class="${d.isToday ? 'is-today' : ''}">${d.isToday ? 'Today' : d.label}</span>`).join('');

    const table = `<table class="sr-only"><caption>Focus minutes per day, last 7 days</caption>
      <tr><th>Day</th><th>Minutes</th></tr>
      ${days.map((d) => `<tr><td>${d.label}</td><td>${d.minutes}</td></tr>`).join('')}</table>`;

    $('#focus-chart').innerHTML = `
      <div class="chart-plot"><div class="plot-area">${gridlines}<div class="cols">${cols}</div></div></div>
      <div class="chart-x" aria-hidden="true">${labels}</div>
      <div class="chart-tooltip" hidden></div>
      ${table}`;
  }

  // One tooltip for the whole chart, positioned above whichever column is hovered/focused.
  function showChartTooltip(col) {
    const chart = $('#focus-chart');
    const tip = $('.chart-tooltip', chart);
    if (!tip) return;
    tip.innerHTML = `<strong>${esc(col.dataset.value)}</strong>${esc(col.dataset.label)}`;
    const chartBox = chart.getBoundingClientRect();
    const colBox = col.getBoundingClientRect();
    const barBox = $('.bar', col).getBoundingClientRect();
    tip.hidden = false;
    const half = tip.offsetWidth / 2;
    let x = colBox.left - chartBox.left + colBox.width / 2;
    x = Math.max(half, Math.min(chartBox.width - half, x));
    tip.style.left = `${x}px`;
    tip.style.top = `${Math.min(barBox.top, colBox.bottom - 4) - chartBox.top - 8}px`;
  }
  function hideChartTooltip() {
    const tip = $('#focus-chart .chart-tooltip');
    if (tip) tip.hidden = true;
  }
  $('#focus-chart').addEventListener('pointerover', (e) => {
    const col = e.target.closest('.col');
    if (col) showChartTooltip(col);
  });
  $('#focus-chart').addEventListener('pointerleave', hideChartTooltip);
  $('#focus-chart').addEventListener('focusin', (e) => {
    const col = e.target.closest('.col');
    if (col) showChartTooltip(col);
  });
  $('#focus-chart').addEventListener('focusout', hideChartTooltip);

  function renderCourseProgress() {
    const container = $('#course-progress');
    if (!state.courses.length) {
      container.innerHTML = emptyState('book', 'No courses yet', 'Add your courses to see how far you have come in each one.',
        `<button class="btn btn-primary" data-action="new-course">${icon('plus')}Add a course</button>`);
      return;
    }
    container.innerHTML = state.courses
      .map((c) => {
        const p = L.courseProgress(state.tasks, c.id);
        return `
          <div data-c="${c.color}">
            <div class="progress-head">${courseTag(c)}<span class="muted">${p.done} of ${p.total} done</span></div>
            <div class="progress" role="progressbar" aria-label="${esc(c.name)} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.percent}">
              <div class="progress-fill" style="width:${p.percent}%"></div>
            </div>
          </div>`;
      })
      .join('');
  }

  /* ================================================================== */
  /* Assignments                                                         */
  /* ================================================================== */

  const STATUS_FILTERS = [
    { id: 'open', label: 'To do' },
    { id: 'week', label: 'Next 7 days' },
    { id: 'overdue', label: 'Overdue' },
    { id: 'done', label: 'Done' },
    { id: 'all', label: 'All' },
  ];

  function renderTasks() {
    const today = new Date();
    const f = ui.filter;
    if (f.courseId !== 'all' && f.courseId !== '' && !courseById(f.courseId)) f.courseId = 'all';

    // Status buttons with counts (counts respect the course + search filters).
    $('#status-filter').innerHTML = STATUS_FILTERS.map((s) => {
      const count = L.filterTasks(state.tasks, { ...f, status: s.id }, today).length;
      return `<button type="button" data-status="${s.id}" aria-pressed="${f.status === s.id}">${s.label}<span class="count">${count}</span></button>`;
    }).join('');

    // Course dropdown.
    const courseOptions = state.courses.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
    const select = $('#course-filter');
    select.innerHTML = `<option value="all">All courses</option>${courseOptions}<option value="">No course</option>`;
    select.value = f.courseId;

    const search = $('#task-search');
    if (search.value !== f.query) search.value = f.query;

    const tasks = L.sortTasks(L.filterTasks(state.tasks, f, today));
    const container = $('#task-groups');

    if (!tasks.length) {
      const nothingAtAll = state.tasks.length === 0;
      container.innerHTML = nothingAtAll
        ? emptyState('tasks', 'No assignments yet', 'Add your first assignment with a due date and StudyPilot will keep track of it for you.',
          `<button class="btn btn-primary" data-action="new-task">${icon('plus')}New assignment</button>`)
        : emptyState('search', 'Nothing here', f.status === 'overdue' ? 'No overdue assignments – nice work!' : 'No assignments match these filters.');
      return;
    }

    container.innerHTML = L.groupTasks(tasks, today)
      .map((g) => `
        <section class="task-group">
          <h2 class="task-group-title">${esc(g.title)} <span class="count">· ${g.tasks.length}</span></h2>
          <ul class="task-list">${g.tasks.map((t) => taskItem(t, today)).join('')}</ul>
        </section>`)
      .join('');
  }

  $('#status-filter').addEventListener('click', (e) => {
    const button = e.target.closest('[data-status]');
    if (!button) return;
    ui.filter.status = button.dataset.status;
    renderTasks();
  });
  $('#course-filter').addEventListener('change', (e) => {
    ui.filter.courseId = e.target.value;
    renderTasks();
  });
  $('#task-search').addEventListener('input', (e) => {
    ui.filter.query = e.target.value;
    renderTasks();
  });

  function toggleTask(id) {
    const task = taskById(id);
    if (!task) return;
    task.done = !task.done;
    task.doneAt = task.done ? new Date().toISOString() : null;
    save();
    render();
    if (task.done) {
      toast(`Nice! “${task.title}” is done.`, {
        actionLabel: 'Undo',
        onAction: () => {
          task.done = false;
          task.doneAt = null;
          save();
          render();
        },
      });
    }
  }

  function deleteTask(id) {
    const index = state.tasks.findIndex((t) => t.id === id);
    if (index === -1) return;
    const [removed] = state.tasks.splice(index, 1);
    if (timer.taskId === removed.id) timer.taskId = '';
    save();
    render();
    toast(`Deleted “${removed.title}”`, {
      actionLabel: 'Undo',
      onAction: () => {
        state.tasks.splice(Math.min(index, state.tasks.length), 0, removed);
        save();
        render();
      },
    });
  }

  /* ---------- Task dialog ---------- */

  const taskDialog = $('#task-dialog');
  const taskForm = $('#task-form');

  function setErrors(form, errors) {
    for (const el of $$('[data-error]', form)) {
      const message = errors[el.dataset.error] || '';
      el.textContent = message;
      const input = form.elements[el.dataset.error];
      if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
    }
  }

  function openTaskDialog(id) {
    const task = id ? taskById(id) : null;
    ui.editingTaskId = task ? task.id : null;
    $('#task-dialog-title').textContent = task ? 'Edit assignment' : 'New assignment';

    const select = taskForm.elements.courseId;
    select.innerHTML = `<option value="">No course</option>${state.courses
      .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
      .join('')}`;

    const defaultCourse = ui.view === 'tasks' && courseById(ui.filter.courseId) ? ui.filter.courseId : '';
    taskForm.elements.title.value = task ? task.title : '';
    select.value = task ? task.courseId || '' : defaultCourse;
    taskForm.elements.due.value = task ? task.due : L.toISODate(L.addDays(new Date(), 7));
    taskForm.elements.priority.value = task ? task.priority : 'medium';
    taskForm.elements.estimate.value = task && task.estimate !== null ? task.estimate : '';
    taskForm.elements.notes.value = task ? task.notes : '';
    setErrors(taskForm, {});

    taskDialog.showModal();
    taskForm.elements.title.focus();
  }

  taskForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(taskForm));
    const result = L.validateTask(data);
    setErrors(taskForm, result.errors);
    if (!result.valid) {
      const first = Object.keys(result.errors)[0];
      taskForm.elements[first].focus();
      return;
    }
    const existing = ui.editingTaskId ? taskById(ui.editingTaskId) : null;
    if (existing) {
      Object.assign(existing, result.value);
    } else {
      state.tasks.push({
        id: L.uid(),
        ...result.value,
        done: false,
        doneAt: null,
        createdAt: new Date().toISOString(),
      });
    }
    save();
    taskDialog.close();
    render();
    toast(existing ? 'Assignment updated' : `Added “${result.value.title}”`);
  });

  /* ================================================================== */
  /* Courses                                                             */
  /* ================================================================== */

  function renderCourses() {
    const today = new Date();
    const grid = $('#course-grid');
    if (!state.courses.length) {
      grid.innerHTML = emptyState('book', 'No courses yet', 'Add the courses you are taking this semester. Each one gets its own colour.',
        `<button class="btn btn-primary" data-action="new-course">${icon('plus')}Add your first course</button>`);
      return;
    }
    grid.innerHTML = state.courses
      .map((c) => {
        const p = L.courseProgress(state.tasks, c.id);
        const open = L.sortTasks(state.tasks.filter((t) => t.courseId === c.id && !t.done));
        const next = open[0] ? L.dueLabel(L.daysUntil(open[0].due, today)).replace('Due ', '') : '—';
        const focus = L.formatMinutes(L.focusMinutesForCourse(state.sessions, c.id));
        const name = esc(c.name);
        return `
          <article class="course-card" data-c="${c.color}" data-id="${esc(c.id)}">
            <div class="course-card-top">
              <i class="dot"></i>
              <h3>${name}</h3>
              <div class="actions">
                <button class="icon-btn" data-action="edit-course" title="Edit" aria-label="Edit ${name}">${icon('edit')}</button>
                <button class="icon-btn danger" data-action="delete-course" title="Delete" aria-label="Delete ${name}">${icon('trash')}</button>
              </div>
            </div>
            <div class="progress" role="progressbar" aria-label="${name} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.percent}">
              <div class="progress-fill" style="width:${p.percent}%"></div>
            </div>
            <p class="progress-label">${p.done} of ${p.total} assignments done · ${p.percent}%</p>
            <dl class="course-facts">
              <div><dt>Open</dt><dd>${open.length}</dd></div>
              <div><dt>Next deadline</dt><dd>${esc(next)}</dd></div>
              <div><dt>Focus time</dt><dd>${esc(focus)}</dd></div>
            </dl>
            <a class="link" href="#tasks" data-action="view-course">View assignments →</a>
          </article>`;
      })
      .join('');
  }

  const courseDialog = $('#course-dialog');
  const courseForm = $('#course-form');

  function openCourseDialog(id) {
    const course = id ? courseById(id) : null;
    ui.editingCourseId = course ? course.id : null;
    $('#course-dialog-title').textContent = course ? 'Edit course' : 'New course';
    const selected = course ? course.color : L.nextColorSlot(state.courses);
    $('#swatches').innerHTML = Array.from({ length: L.COLOR_SLOTS }, (_, i) =>
      `<label class="swatch" data-c="${i}"><input type="radio" name="color" value="${i}" ${i === selected ? 'checked' : ''} aria-label="Colour ${i + 1}"></label>`).join('');
    courseForm.elements.name.value = course ? course.name : '';
    setErrors(courseForm, {});
    courseDialog.showModal();
    courseForm.elements.name.focus();
  }

  courseForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(courseForm));
    const result = L.validateCourse({ ...data, id: ui.editingCourseId }, state.courses);
    setErrors(courseForm, result.errors);
    if (!result.valid) {
      courseForm.elements.name.focus();
      return;
    }
    const existing = ui.editingCourseId ? courseById(ui.editingCourseId) : null;
    if (existing) Object.assign(existing, result.value);
    else state.courses.push({ id: L.uid(), ...result.value });
    save();
    courseDialog.close();
    render();
    toast(existing ? 'Course updated' : `Added course “${result.value.name}”`);
  });

  async function deleteCourse(id) {
    const course = courseById(id);
    if (!course) return;
    const count = state.tasks.filter((t) => t.courseId === id).length;
    const ok = await confirmDialog({
      title: `Delete “${course.name}”?`,
      message: count
        ? `Its ${count} assignment${count === 1 ? '' : 's'} will be kept, but without a course.`
        : 'This course has no assignments.',
      confirmText: 'Delete course',
    });
    if (!ok) return;
    state.courses = state.courses.filter((c) => c.id !== id);
    for (const t of state.tasks) if (t.courseId === id) t.courseId = null;
    for (const s of state.sessions) if (s.courseId === id) s.courseId = null;
    if (ui.filter.courseId === id) ui.filter.courseId = 'all';
    save();
    render();
    toast(`Deleted course “${course.name}”`);
  }

  /* ================================================================== */
  /* Focus timer (Pomodoro)                                              */
  /* ================================================================== */

  // The timer stores the moment it should end instead of counting down every
  // second. That keeps it accurate even when the browser throttles background tabs.
  const minutesFor = (mode) => (mode === 'focus' ? state.settings.focusMinutes : state.settings.breakMinutes);

  function freshTimer(mode = 'focus') {
    const planned = minutesFor(mode);
    return { mode, running: false, endsAt: null, planned, remaining: planned * 60, taskId: '' };
  }

  function loadTimer() {
    try {
      const saved = JSON.parse(localStorage.getItem(TIMER_KEY));
      if (saved && (saved.mode === 'focus' || saved.mode === 'break') && Number(saved.planned) > 0) {
        return { ...freshTimer(saved.mode), ...saved };
      }
    } catch (err) { /* ignore */ }
    return freshTimer();
  }

  const timer = loadTimer();
  let tickHandle = null;

  function saveTimer() {
    try {
      localStorage.setItem(TIMER_KEY, JSON.stringify(timer));
    } catch (err) { /* ignore */ }
  }

  function remainingSeconds() {
    return timer.running ? Math.max(0, (timer.endsAt - Date.now()) / 1000) : timer.remaining;
  }

  function setMode(mode) {
    const taskId = timer.taskId;
    Object.assign(timer, freshTimer(mode), { taskId });
    saveTimer();
  }

  function startTimer() {
    if (timer.running) return;
    prepareAudio();
    if (timer.remaining <= 0) setMode(timer.mode);
    timer.running = true;
    timer.endsAt = Date.now() + timer.remaining * 1000;
    saveTimer();
    startTicking();
    renderTimer();
  }

  function pauseTimer() {
    if (!timer.running) return;
    timer.remaining = remainingSeconds();
    timer.running = false;
    timer.endsAt = null;
    saveTimer();
    renderTimer();
  }

  function completeTimer() {
    const finished = timer.mode;
    if (finished === 'focus') {
      const task = taskById(timer.taskId);
      state.sessions.push({
        id: L.uid(),
        minutes: timer.planned,
        endedAt: new Date().toISOString(),
        taskId: task ? task.id : null,
        courseId: task ? task.courseId : null,
      });
      save();
      toast(`Focus round done – ${L.formatMinutes(timer.planned)} logged. Take a break!`, { timeout: 6000 });
    } else {
      toast('Break is over. Ready for another round?', { timeout: 6000 });
    }
    chime();
    setMode(finished === 'focus' ? 'break' : 'focus');
    render();
  }

  function tick() {
    if (!timer.running) {
      stopTicking();
      return;
    }
    if (remainingSeconds() <= 0) {
      stopTicking();
      completeTimer();
      return;
    }
    renderTimer();
  }

  function startTicking() {
    if (!tickHandle) tickHandle = setInterval(tick, 250);
  }
  function stopTicking() {
    clearInterval(tickHandle);
    tickHandle = null;
  }

  function renderTimer() {
    const remaining = remainingSeconds();
    const text = L.formatTimer(remaining);
    const isFocus = timer.mode === 'focus';
    const started = timer.running || remaining < timer.planned * 60;

    // Title bar + floating chip are visible from every view.
    document.title = started ? `${text} · ${isFocus ? 'Focus' : 'Break'} – StudyPilot` : 'StudyPilot – study planner';
    const chip = $('#timer-chip');
    chip.hidden = !started || ui.view === 'focus';
    chip.classList.toggle('is-break', !isFocus);
    chip.classList.toggle('is-paused', !timer.running);
    $('#timer-chip-text').textContent = `${isFocus ? 'Focus' : 'Break'} ${text}${timer.running ? '' : ' (paused)'}`;

    if (ui.view !== 'focus') return;

    $('#timer-card').dataset.mode = timer.mode;
    $('#timer-mode').textContent = isFocus ? 'Focus' : 'Break';
    $('#timer-display').textContent = text;
    const task = taskById(timer.taskId);
    $('#timer-sub').textContent = !isFocus
      ? 'Stretch, drink some water'
      : task ? task.title : timer.running ? 'Stay focused' : started ? 'Paused' : 'Ready when you are';

    const fraction = timer.planned > 0 ? remaining / (timer.planned * 60) : 0;
    const ring = $('#ring-progress');
    ring.style.strokeDasharray = `${RING_CIRCUMFERENCE}`;
    ring.style.strokeDashoffset = `${RING_CIRCUMFERENCE * (1 - fraction)}`;

    const startButton = $('#timer-start');
    $('span', startButton).textContent = timer.running ? 'Pause' : started ? 'Resume' : 'Start';
    $('use', startButton).setAttribute('href', timer.running ? '#i-timer' : '#i-play');
    $('#timer-reset').disabled = !started;
  }

  function renderFocus() {
    const today = new Date();
    // Task picker: open assignments grouped by course.
    const open = L.sortTasks(state.tasks.filter((t) => !t.done));
    if (timer.taskId && !open.some((t) => t.id === timer.taskId)) timer.taskId = '';
    const groups = [...state.courses, null].map((course) => {
      const items = open.filter((t) => (course ? t.courseId === course.id : !t.courseId));
      if (!items.length) return '';
      const options = items.map((t) => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('');
      return `<optgroup label="${esc(course ? course.name : 'No course')}">${options}</optgroup>`;
    });
    const select = $('#focus-task');
    select.innerHTML = `<option value="">Just studying (no specific assignment)</option>${groups.join('')}`;
    select.value = timer.taskId;

    $('#focus-length').value = state.settings.focusMinutes;
    $('#break-length').value = state.settings.breakMinutes;

    // Today's sessions.
    const todayKey = L.toISODate(today);
    const sessions = state.sessions
      .filter((s) => L.toISODate(new Date(s.endedAt)) === todayKey)
      .sort((a, b) => b.endedAt.localeCompare(a.endedAt));
    $('#today-total').textContent = sessions.length
      ? `${L.formatMinutes(L.focusMinutesOn(state.sessions, todayKey))} · ${sessions.length} round${sessions.length === 1 ? '' : 's'}`
      : '';
    $('#session-list').innerHTML = sessions.length
      ? sessions
        .map((s) => {
          const task = taskById(s.taskId);
          const course = courseById(s.courseId);
          const time = new Date(s.endedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
          const what = task ? task.title : 'General studying';
          return `<li${course ? ` data-c="${course.color}"` : ''}>
              <span class="session-time">${esc(time)}</span>
              <span class="session-what">${course ? '<i class="dot" style="display:inline-block;margin-right:8px"></i>' : ''}${esc(what)}</span>
              <span class="session-mins">${esc(L.formatMinutes(s.minutes))}</span>
            </li>`;
        })
        .join('')
      : '<li class="empty-row" style="display:block">No focus rounds yet today. Pick an assignment and press Start.</li>';
  }

  $('#timer-start').addEventListener('click', () => (timer.running ? pauseTimer() : startTimer()));
  $('#timer-reset').addEventListener('click', () => {
    stopTicking();
    setMode(timer.mode);
    renderTimer();
  });
  $('#timer-skip').addEventListener('click', () => {
    stopTicking();
    setMode(timer.mode === 'focus' ? 'break' : 'focus');
    renderTimer();
  });
  $('#focus-task').addEventListener('change', (e) => {
    timer.taskId = e.target.value;
    saveTimer();
    renderTimer();
  });

  function onDurationChange(input, key, mode, max) {
    const value = Math.min(max, Math.max(1, Math.round(Number(input.value) || 0)));
    input.value = value;
    state.settings[key] = value;
    save();
    // Apply straight away if the timer for that mode isn't running; otherwise use it next round.
    if (!timer.running && timer.mode === mode) setMode(mode);
    renderTimer();
  }
  $('#focus-length').addEventListener('change', (e) => onDurationChange(e.target, 'focusMinutes', 'focus', 120));
  $('#break-length').addEventListener('change', (e) => onDurationChange(e.target, 'breakMinutes', 'break', 60));

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick();
  });

  /* ================================================================== */
  /* Settings                                                            */
  /* ================================================================== */

  function applyTheme() {
    const theme = state.settings.theme;
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }

  function renderSettings() {
    for (const button of $$('[data-theme-choice]')) {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === state.settings.theme));
    }
    const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
    $('#data-summary').textContent =
      `${n(state.courses.length, 'course')} · ${n(state.tasks.length, 'assignment')} · ${n(state.sessions.length, 'focus round')}`;
  }

  $('#theme-choice').addEventListener('click', (e) => {
    const button = e.target.closest('[data-theme-choice]');
    if (!button) return;
    state.settings.theme = button.dataset.themeChoice;
    save();
    applyTheme();
    renderSettings();
  });

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `studypilot-backup-${L.toISODate(new Date())}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Backup downloaded');
  }

  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let raw;
    try {
      raw = JSON.parse(await file.text());
    } catch (err) {
      toast('That file is not valid JSON.');
      return;
    }
    if (!raw || !Array.isArray(raw.tasks) || !Array.isArray(raw.courses)) {
      toast('That file does not look like a StudyPilot backup.');
      return;
    }
    const imported = L.normalizeState(raw);
    const ok = await confirmDialog({
      title: 'Replace your data?',
      message: `The backup has ${imported.courses.length} courses and ${imported.tasks.length} assignments. Your current data will be replaced.`,
      confirmText: 'Import',
    });
    if (!ok) return;
    state = imported;
    state.meta.demo = false;
    save();
    applyTheme();
    render();
    toast('Backup imported');
  });

  function replaceState(next, message) {
    next.settings = { ...next.settings, ...state.settings };
    state = next;
    stopTicking();
    Object.assign(timer, freshTimer());
    saveTimer();
    ui.filter = { status: 'open', courseId: 'all', query: '' };
    save();
    render();
    toast(message);
  }

  /* ================================================================== */
  /* Global click handling (event delegation)                            */
  /* ================================================================== */

  document.addEventListener('click', async (e) => {
    const closeButton = e.target.closest('[data-close]');
    if (closeButton) {
      closeButton.closest('dialog').close();
      return;
    }
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    const taskId = el.closest('.task') && el.closest('.task').dataset.id;
    const courseId = el.closest('.course-card') && el.closest('.course-card').dataset.id;

    switch (action) {
      case 'new-task':
        openTaskDialog();
        break;
      case 'toggle-task':
        toggleTask(taskId);
        break;
      case 'edit-task':
        openTaskDialog(taskId);
        break;
      case 'delete-task':
        deleteTask(taskId);
        break;
      case 'focus-task':
        timer.taskId = taskId;
        if (!timer.running && timer.mode === 'break') setMode('focus');
        saveTimer();
        location.hash = '#focus';
        break;
      case 'new-course':
        openCourseDialog();
        break;
      case 'edit-course':
        openCourseDialog(courseId);
        break;
      case 'delete-course':
        deleteCourse(courseId);
        break;
      case 'view-course':
        ui.filter = { status: 'open', courseId, query: '' };
        break; // the link itself navigates to #tasks
      case 'demo-keep':
        state.meta.demo = false;
        save();
        render();
        break;
      case 'demo-clear':
        if (await confirmDialog({ title: 'Clear the sample data?', message: 'All sample courses, assignments and focus rounds will be removed so you can add your own.', confirmText: 'Clear sample data' })) {
          replaceState(L.emptyState(), 'Sample data cleared. Start by adding a course!');
          location.hash = '#courses';
        }
        break;
      case 'export':
        exportData();
        break;
      case 'load-demo':
        if (await confirmDialog({ title: 'Load sample data?', message: 'Your current courses, assignments and focus rounds will be replaced by sample data.', confirmText: 'Load sample data' })) {
          replaceState(L.createDemoState(new Date()), 'Sample data loaded');
        }
        break;
      case 'reset-all':
        if (await confirmDialog({ title: 'Delete all data?', message: 'This removes every course, assignment and focus round from this browser. Export a backup first if you want to keep them.', confirmText: 'Delete everything' })) {
          replaceState(L.emptyState(), 'All data deleted');
        }
        break;
      default:
        break;
    }
  });

  // Clicking the dimmed backdrop closes a dialog.
  for (const dialog of $$('dialog')) {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
  }

  // Keyboard shortcut: N = new assignment.
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
    e.preventDefault();
    openTaskDialog();
  });

  /* ================================================================== */
  /* Start-up                                                            */
  /* ================================================================== */

  applyTheme();
  ui.view = viewFromHash();
  // A focus round that finished while the page was closed still counts.
  if (timer.running && remainingSeconds() <= 0) completeTimer();
  else if (timer.running) startTicking();
  render();

  // Exposed for the automated browser tests only.
  window.__studyPilot = { getState: () => state, timer };
})();
