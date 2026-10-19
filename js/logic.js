/*
 * StudyPilot – pure logic (no DOM access).
 *
 * Everything in here is a plain function so it can be unit tested with Node
 * (see tests/logic.test.js). In the browser the functions are exposed as
 * window.StudyLogic; in Node they are exported with module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.StudyLogic = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;
  const PRIORITIES = ['high', 'medium', 'low'];
  const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
  const COLOR_SLOTS = 8;
  const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const DEFAULT_SETTINGS = Object.freeze({
    focusMinutes: 25,
    breakMinutes: 5,
    theme: 'system', // 'system' | 'light' | 'dark'
  });

  /* ------------------------------------------------------------------ */
  /* Dates                                                               */
  /* ------------------------------------------------------------------ */

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  /** Date -> 'YYYY-MM-DD' in the user's local time zone. */
  function toISODate(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /** 'YYYY-MM-DD' -> local Date at midnight, or null if the string is not a real date. */
  function parseISODate(str) {
    if (typeof str !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str.trim());
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const date = new Date(y, mo - 1, d);
    // Rejects things like 2026-02-31 that JavaScript would silently roll over.
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    return date;
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function addDays(date, n) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
  }

  /** Whole calendar days from a to b (DST-safe because it compares UTC midnights). */
  function daysBetween(a, b) {
    const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((ub - ua) / DAY_MS);
  }

  /** Days from `today` until the due date string. Negative = overdue, null = no/invalid date. */
  function daysUntil(dueStr, today) {
    const due = parseISODate(dueStr);
    if (!due) return null;
    return daysBetween(today, due);
  }

  /** Monday of the week that contains `date`. */
  function startOfWeek(date) {
    const offset = (date.getDay() + 6) % 7; // Sunday (0) -> 6, Monday (1) -> 0
    return addDays(date, -offset);
  }

  /** Human friendly description of a due date distance. */
  function dueLabel(days) {
    if (days === null || days === undefined || Number.isNaN(days)) return 'No due date';
    if (days === 0) return 'Due today';
    if (days === 1) return 'Due tomorrow';
    if (days === -1) return 'Overdue by 1 day';
    if (days < 0) return `Overdue by ${-days} days`;
    if (days < 14) return `Due in ${days} days`;
    return `Due in ${Math.floor(days / 7)} weeks`;
  }

  /* ------------------------------------------------------------------ */
  /* Tasks                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * 'done' | 'overdue' | 'today' | 'soon' (1–3 days) | 'later'
   */
  function taskStatus(task, today) {
    if (task.done) return 'done';
    const d = daysUntil(task.due, today);
    if (d === null) return 'later';
    if (d < 0) return 'overdue';
    if (d === 0) return 'today';
    if (d <= 3) return 'soon';
    return 'later';
  }

  const STATUS_ORDER = ['overdue', 'today', 'soon', 'later', 'done'];
  const STATUS_TITLES = {
    overdue: 'Overdue',
    today: 'Due today',
    soon: 'Next 3 days',
    later: 'Later',
    done: 'Completed',
  };

  /**
   * Open tasks first (earliest deadline first, then highest priority),
   * completed tasks last (most recently completed first). Returns a new array.
   */
  function sortTasks(tasks) {
    return tasks.slice().sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      if (a.done && b.done) {
        return String(b.doneAt || '').localeCompare(String(a.doneAt || ''));
      }
      const da = a.due || '9999-12-31';
      const db = b.due || '9999-12-31';
      if (da !== db) return da < db ? -1 : 1;
      const pa = PRIORITY_RANK[a.priority] ?? 1;
      const pb = PRIORITY_RANK[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return String(a.title).localeCompare(String(b.title));
    });
  }

  /**
   * filter.status: 'open' | 'week' | 'overdue' | 'done' | 'all'
   * filter.courseId: 'all' | '' (no course) | a course id
   * filter.query: free text matched against title and notes
   */
  function filterTasks(tasks, filter, today) {
    const status = (filter && filter.status) || 'open';
    const courseId = filter && filter.courseId !== undefined ? filter.courseId : 'all';
    const query = ((filter && filter.query) || '').trim().toLowerCase();

    return tasks.filter((t) => {
      if (courseId !== 'all' && (t.courseId || '') !== courseId) return false;
      if (query) {
        const haystack = `${t.title} ${t.notes || ''}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      const s = taskStatus(t, today);
      switch (status) {
        case 'open':
          return !t.done;
        case 'week': {
          if (t.done) return false;
          const d = daysUntil(t.due, today);
          return d !== null && d >= 0 && d <= 6;
        }
        case 'overdue':
          return s === 'overdue';
        case 'done':
          return t.done;
        default:
          return true;
      }
    });
  }

  /** Splits an already sorted list into display groups in STATUS_ORDER. */
  function groupTasks(tasks, today) {
    const groups = {};
    for (const t of tasks) {
      const s = taskStatus(t, today);
      (groups[s] = groups[s] || []).push(t);
    }
    return STATUS_ORDER.filter((s) => groups[s]).map((s) => ({
      status: s,
      title: STATUS_TITLES[s],
      tasks: groups[s],
    }));
  }

  function courseProgress(tasks, courseId) {
    const own = tasks.filter((t) => t.courseId === courseId);
    const done = own.filter((t) => t.done).length;
    const total = own.length;
    return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
  }

  /* ------------------------------------------------------------------ */
  /* Focus sessions & statistics                                         */
  /* ------------------------------------------------------------------ */

  function sessionDate(session) {
    const d = new Date(session.endedAt);
    return Number.isNaN(d.getTime()) ? null : toISODate(d);
  }

  /**
   * Minutes of focus per day for the last 7 days (6 days ago … today).
   * A rolling window is used instead of Monday–Sunday so the chart is never
   * empty at the start of a new week.
   */
  function focusByDay(sessions, today) {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const date = addDays(today, -i);
      days.push({
        label: WEEKDAY_SHORT[(date.getDay() + 6) % 7],
        date: toISODate(date),
        minutes: 0,
        isToday: i === 0,
      });
    }
    const index = new Map(days.map((d, i) => [d.date, i]));
    for (const s of sessions) {
      const key = sessionDate(s);
      if (key && index.has(key)) days[index.get(key)].minutes += Number(s.minutes) || 0;
    }
    return days;
  }

  function focusMinutesOn(sessions, dateStr) {
    return sessions.reduce((sum, s) => (sessionDate(s) === dateStr ? sum + (Number(s.minutes) || 0) : sum), 0);
  }

  function focusMinutesForCourse(sessions, courseId) {
    return sessions.reduce((sum, s) => (s.courseId === courseId ? sum + (Number(s.minutes) || 0) : sum), 0);
  }

  /**
   * Number of consecutive days with at least one focus session, counting back
   * from today. If today has no session yet the streak can still be alive from
   * yesterday (you have until midnight to keep it going).
   */
  function studyStreak(sessions, today) {
    const days = new Set(sessions.map(sessionDate).filter(Boolean));
    let cursor = startOfDay(today);
    if (!days.has(toISODate(cursor))) cursor = addDays(cursor, -1);
    let streak = 0;
    while (days.has(toISODate(cursor))) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }
    return streak;
  }

  function dashboardStats(state, today) {
    const open = state.tasks.filter((t) => !t.done);
    const overdue = open.filter((t) => taskStatus(t, today) === 'overdue').length;
    const dueSoon = open.filter((t) => {
      const d = daysUntil(t.due, today);
      return d !== null && d >= 0 && d <= 6;
    }).length;
    const weekStart = toISODate(addDays(today, -6));
    const focusWeek = focusByDay(state.sessions, today).reduce((sum, d) => sum + d.minutes, 0);
    const doneThisWeek = state.tasks.filter((t) => t.done && t.doneAt && toISODate(new Date(t.doneAt)) >= weekStart).length;
    return {
      open: open.length,
      overdue,
      dueSoon,
      focusWeek,
      doneThisWeek,
      streak: studyStreak(state.sessions, today),
    };
  }

  /** Round chart axis: returns { max, ticks } with 2–4 evenly spaced ticks. */
  function niceScale(maxValue) {
    const steps = [15, 30, 60, 90, 120, 180, 240, 360, 480, 600];
    const value = Math.max(0, Number(maxValue) || 0);
    if (value === 0) return { max: 60, ticks: [0, 30, 60] };
    let step = steps.find((s) => value / s <= 3);
    if (!step) step = Math.ceil(value / 3 / 60) * 60;
    const max = Math.ceil(value / step) * step;
    const ticks = [];
    for (let t = 0; t <= max; t += step) ticks.push(t);
    return { max, ticks };
  }

  /* ------------------------------------------------------------------ */
  /* Formatting                                                          */
  /* ------------------------------------------------------------------ */

  function formatMinutes(total) {
    const m = Math.max(0, Math.round(Number(total) || 0));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }

  function formatTimer(seconds) {
    const s = Math.max(0, Math.ceil(Number(seconds) || 0));
    return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
  }

  function formatHours(h) {
    const n = Number(h);
    if (!n) return '';
    return `~${Number.isInteger(n) ? n : n.toFixed(1)} h`;
  }

  /* ------------------------------------------------------------------ */
  /* Validation                                                          */
  /* ------------------------------------------------------------------ */

  function validateTask(input) {
    const errors = {};
    const title = String(input.title || '').trim();
    if (!title) errors.title = 'Give the assignment a name.';
    else if (title.length > 120) errors.title = 'Keep the name under 120 characters.';

    const due = String(input.due || '').trim();
    if (!due) errors.due = 'Pick a due date.';
    else if (!parseISODate(due)) errors.due = 'That is not a valid date.';

    const priority = PRIORITIES.includes(input.priority) ? input.priority : 'medium';

    let estimate = null;
    if (input.estimate !== '' && input.estimate !== null && input.estimate !== undefined) {
      estimate = Number(input.estimate);
      if (!Number.isFinite(estimate) || estimate < 0 || estimate > 200) {
        errors.estimate = 'Use a number of hours between 0 and 200.';
      }
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors,
      value: {
        title,
        due,
        priority,
        estimate: errors.estimate ? null : estimate,
        courseId: input.courseId || null,
        notes: String(input.notes || '').trim().slice(0, 2000),
      },
    };
  }

  function validateCourse(input, courses) {
    const errors = {};
    const name = String(input.name || '').trim();
    if (!name) errors.name = 'Give the course a name.';
    else if (name.length > 60) errors.name = 'Keep the name under 60 characters.';
    else if (courses.some((c) => c.id !== input.id && c.name.toLowerCase() === name.toLowerCase())) {
      errors.name = 'You already have a course with that name.';
    }
    let color = Number(input.color);
    if (!Number.isInteger(color) || color < 0 || color >= COLOR_SLOTS) color = nextColorSlot(courses);
    return { valid: Object.keys(errors).length === 0, errors, value: { name, color } };
  }

  /** Colours are handed out in a fixed order; the first unused slot wins. */
  function nextColorSlot(courses) {
    const used = new Set(courses.map((c) => c.color));
    for (let i = 0; i < COLOR_SLOTS; i++) if (!used.has(i)) return i;
    return courses.length % COLOR_SLOTS;
  }

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function emptyState() {
    return {
      version: 1,
      courses: [],
      tasks: [],
      sessions: [],
      settings: { ...DEFAULT_SETTINGS },
      meta: { demo: false },
    };
  }

  function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  /**
   * Turns whatever was found in localStorage (or an imported file) into a
   * valid state object. Malformed entries are dropped instead of crashing the app.
   */
  function normalizeState(raw) {
    const state = emptyState();
    if (!raw || typeof raw !== 'object') return state;

    if (Array.isArray(raw.courses)) {
      for (const c of raw.courses) {
        if (!c || typeof c !== 'object' || !c.id || !String(c.name || '').trim()) continue;
        state.courses.push({
          id: String(c.id),
          name: String(c.name).trim().slice(0, 60),
          color: clampInt(c.color, 0, COLOR_SLOTS - 1, nextColorSlot(state.courses)),
        });
      }
    }
    const courseIds = new Set(state.courses.map((c) => c.id));

    if (Array.isArray(raw.tasks)) {
      for (const t of raw.tasks) {
        if (!t || typeof t !== 'object' || !t.id || !String(t.title || '').trim()) continue;
        state.tasks.push({
          id: String(t.id),
          title: String(t.title).trim().slice(0, 120),
          courseId: courseIds.has(t.courseId) ? t.courseId : null,
          due: parseISODate(t.due) ? t.due : '',
          priority: PRIORITIES.includes(t.priority) ? t.priority : 'medium',
          estimate: Number.isFinite(Number(t.estimate)) && t.estimate !== null && t.estimate !== '' ? Number(t.estimate) : null,
          notes: String(t.notes || '').slice(0, 2000),
          done: Boolean(t.done),
          doneAt: t.done && t.doneAt ? String(t.doneAt) : null,
          createdAt: t.createdAt ? String(t.createdAt) : new Date().toISOString(),
        });
      }
    }
    const taskIds = new Set(state.tasks.map((t) => t.id));

    if (Array.isArray(raw.sessions)) {
      for (const s of raw.sessions) {
        if (!s || typeof s !== 'object' || Number.isNaN(new Date(s.endedAt).getTime())) continue;
        const minutes = Number(s.minutes);
        if (!Number.isFinite(minutes) || minutes <= 0) continue;
        state.sessions.push({
          id: String(s.id || uid()),
          minutes: Math.min(600, minutes),
          endedAt: String(s.endedAt),
          courseId: courseIds.has(s.courseId) ? s.courseId : null,
          taskId: taskIds.has(s.taskId) ? s.taskId : null,
        });
      }
    }

    const settings = raw.settings || {};
    state.settings = {
      focusMinutes: clampInt(settings.focusMinutes, 1, 120, DEFAULT_SETTINGS.focusMinutes),
      breakMinutes: clampInt(settings.breakMinutes, 1, 60, DEFAULT_SETTINGS.breakMinutes),
      theme: ['system', 'light', 'dark'].includes(settings.theme) ? settings.theme : 'system',
    };
    state.meta = { demo: Boolean(raw.meta && raw.meta.demo) };
    return state;
  }

  /** Sample data relative to `today`, so the demo always looks current. */
  function createDemoState(today) {
    const state = emptyState();
    state.meta.demo = true;
    const iso = (offset) => toISODate(addDays(today, offset));
    const at = (offset, hour) => {
      const d = addDays(today, offset);
      d.setHours(hour, 0, 0, 0);
      return d.toISOString();
    };

    const courses = [
      { id: 'c-ai', name: 'Intro to AI', color: 0 },
      { id: 'c-math', name: 'Mathematics 2', color: 1 },
      { id: 'c-web', name: 'Web Development', color: 2 },
      { id: 'c-stat', name: 'Statistics', color: 3 },
    ];
    state.courses = courses;

    const task = (id, title, courseId, dueOffset, priority, estimate, extra = {}) => ({
      id,
      title,
      courseId,
      due: iso(dueOffset),
      priority,
      estimate,
      notes: extra.notes || '',
      done: Boolean(extra.doneOffset !== undefined),
      doneAt: extra.doneOffset !== undefined ? at(extra.doneOffset, 15) : null,
      createdAt: at(-10, 9),
    });

    state.tasks = [
      task('t1', 'Vibe coding assignment', 'c-ai', 6, 'high', 6, { notes: 'Build an app with AI, record a demo, push to GitHub.' }),
      task('t2', 'Problem set 5: integrals', 'c-math', 1, 'high', 3),
      task('t3', 'Read chapter 7 (Bayes)', 'c-stat', 0, 'medium', 1.5),
      task('t4', 'Group project: wireframes', 'c-web', -1, 'high', 2, { notes: 'Share Figma link with the group.' }),
      task('t5', 'Quiz: search algorithms', 'c-ai', 3, 'medium', 1),
      task('t6', 'Lab report: hypothesis tests', 'c-stat', 10, 'medium', 4),
      task('t7', 'Exam revision plan', 'c-math', 20, 'low', 1),
      task('t8', 'Portfolio page in HTML/CSS', 'c-web', 8, 'low', 3),
      task('t9', 'Problem set 4: derivatives', 'c-math', -5, 'high', 3, { doneOffset: -6 }),
      task('t10', 'Read chapter 6 (probability)', 'c-stat', -3, 'medium', 1.5, { doneOffset: -3 }),
      task('t11', 'Lecture notes: neural networks', 'c-ai', -2, 'low', 1, { doneOffset: -1 }),
    ];

    const session = (dayOffset, hour, minutes, courseId, taskId) => ({
      id: uid(),
      minutes,
      endedAt: at(dayOffset, hour),
      courseId,
      taskId,
    });
    state.sessions = [
      session(-6, 10, 25, 'c-math', 't9'),
      session(-6, 11, 25, 'c-math', 't9'),
      session(-5, 14, 25, 'c-stat', 't10'),
      session(-4, 9, 50, 'c-ai', 't1'),
      session(-3, 13, 25, 'c-stat', 't10'),
      session(-3, 16, 25, 'c-web', 't4'),
      session(-2, 10, 25, 'c-ai', 't11'),
      session(-2, 11, 25, 'c-math', 't2'),
      session(-2, 19, 25, 'c-ai', 't1'),
      session(-1, 12, 25, 'c-ai', 't11'),
      session(-1, 18, 50, 'c-math', 't2'),
    ];
    // One round earlier today (an hour ago, but never before midnight).
    const earlierToday = Math.max(startOfDay(today).getTime() + 60000, today.getTime() - 60 * 60000);
    state.sessions.push({ id: uid(), minutes: 25, endedAt: new Date(earlierToday).toISOString(), courseId: 'c-stat', taskId: 't3' });
    return state;
  }

  return {
    COLOR_SLOTS,
    DEFAULT_SETTINGS,
    PRIORITIES,
    STATUS_TITLES,
    WEEKDAY_SHORT,
    toISODate,
    parseISODate,
    addDays,
    daysBetween,
    daysUntil,
    startOfWeek,
    dueLabel,
    taskStatus,
    sortTasks,
    filterTasks,
    groupTasks,
    courseProgress,
    focusByDay,
    focusMinutesOn,
    focusMinutesForCourse,
    studyStreak,
    dashboardStats,
    niceScale,
    formatMinutes,
    formatTimer,
    formatHours,
    validateTask,
    validateCourse,
    nextColorSlot,
    uid,
    emptyState,
    normalizeState,
    createDemoState,
  };
});
