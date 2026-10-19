// Unit tests for js/logic.js – run with:  npm test   (or: node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/logic.js');

const d = (str) => L.parseISODate(str);
const MONDAY = d('2026-10-19'); // a Monday

test('parseISODate accepts real dates and rejects impossible ones', () => {
  assert.equal(L.toISODate(d('2026-02-28')), '2026-02-28');
  assert.equal(d('2026-02-31'), null);
  assert.equal(d('2026-13-01'), null);
  assert.equal(d('hello'), null);
  assert.equal(d(undefined), null);
});

test('daysUntil counts calendar days, including across DST change', () => {
  assert.equal(L.daysUntil('2026-10-19', MONDAY), 0);
  assert.equal(L.daysUntil('2026-10-20', MONDAY), 1);
  assert.equal(L.daysUntil('2026-10-17', MONDAY), -2);
  // Clocks go back in Europe on 25 Oct 2026 – still 7 whole days.
  assert.equal(L.daysUntil('2026-10-26', MONDAY), 7);
  assert.equal(L.daysUntil('', MONDAY), null);
});

test('dueLabel gives friendly text', () => {
  assert.equal(L.dueLabel(0), 'Due today');
  assert.equal(L.dueLabel(1), 'Due tomorrow');
  assert.equal(L.dueLabel(5), 'Due in 5 days');
  assert.equal(L.dueLabel(-1), 'Overdue by 1 day');
  assert.equal(L.dueLabel(-4), 'Overdue by 4 days');
  assert.equal(L.dueLabel(15), 'Due in 2 weeks');
  assert.equal(L.dueLabel(null), 'No due date');
});

test('taskStatus classifies tasks', () => {
  assert.equal(L.taskStatus({ due: '2026-10-18', done: false }, MONDAY), 'overdue');
  assert.equal(L.taskStatus({ due: '2026-10-19', done: false }, MONDAY), 'today');
  assert.equal(L.taskStatus({ due: '2026-10-22', done: false }, MONDAY), 'soon');
  assert.equal(L.taskStatus({ due: '2026-10-23', done: false }, MONDAY), 'later');
  assert.equal(L.taskStatus({ due: '2026-10-01', done: true }, MONDAY), 'done');
});

test('sortTasks: open first by deadline then priority, done last', () => {
  const tasks = [
    { id: 'a', title: 'A', due: '2026-10-25', priority: 'low', done: false },
    { id: 'b', title: 'B', due: '2026-10-20', priority: 'low', done: false },
    { id: 'c', title: 'C', due: '2026-10-20', priority: 'high', done: false },
    { id: 'd', title: 'D', due: '2026-10-10', priority: 'high', done: true, doneAt: '2026-10-09T10:00:00Z' },
    { id: 'e', title: 'E', due: '2026-10-11', priority: 'high', done: true, doneAt: '2026-10-12T10:00:00Z' },
  ];
  assert.deepEqual(L.sortTasks(tasks).map((t) => t.id), ['c', 'b', 'a', 'e', 'd']);
  assert.equal(tasks[0].id, 'a', 'original array is not mutated');
});

test('filterTasks by status, course and search text', () => {
  const tasks = [
    { id: '1', title: 'Essay draft', notes: '', courseId: 'x', due: '2026-10-18', done: false },
    { id: '2', title: 'Lab report', notes: 'bring data', courseId: 'y', due: '2026-10-21', done: false },
    { id: '3', title: 'Old quiz', notes: '', courseId: 'x', due: '2026-10-01', done: true },
    { id: '4', title: 'Far away', notes: '', courseId: null, due: '2026-12-01', done: false },
  ];
  const ids = (f) => L.filterTasks(tasks, f, MONDAY).map((t) => t.id);
  assert.deepEqual(ids({ status: 'open' }), ['1', '2', '4']);
  assert.deepEqual(ids({ status: 'overdue' }), ['1']);
  assert.deepEqual(ids({ status: 'week' }), ['2']);
  assert.deepEqual(ids({ status: 'done' }), ['3']);
  assert.deepEqual(ids({ status: 'all', courseId: 'x' }), ['1', '3']);
  assert.deepEqual(ids({ status: 'all', courseId: '' }), ['4']);
  assert.deepEqual(ids({ status: 'all', query: 'DATA' }), ['2']);
});

test('groupTasks keeps a fixed group order', () => {
  const tasks = L.sortTasks([
    { id: '1', title: 'x', due: '2026-10-30', done: false },
    { id: '2', title: 'y', due: '2026-10-18', done: false },
    { id: '3', title: 'z', due: '2026-10-19', done: true },
  ]);
  assert.deepEqual(L.groupTasks(tasks, MONDAY).map((g) => g.status), ['overdue', 'later', 'done']);
});

test('courseProgress', () => {
  const tasks = [
    { courseId: 'a', done: true }, { courseId: 'a', done: false }, { courseId: 'a', done: true }, { courseId: 'b', done: false },
  ];
  assert.deepEqual(L.courseProgress(tasks, 'a'), { done: 2, total: 3, percent: 67 });
  assert.deepEqual(L.courseProgress(tasks, 'zzz'), { done: 0, total: 0, percent: 0 });
});

test('startOfWeek returns Monday (also for Sundays)', () => {
  assert.equal(L.toISODate(L.startOfWeek(d('2026-10-25'))), '2026-10-19'); // Sunday
  assert.equal(L.toISODate(L.startOfWeek(d('2026-10-19'))), '2026-10-19');
  assert.equal(L.toISODate(L.startOfWeek(d('2026-10-22'))), '2026-10-19');
});

const at = (date, hour) => { const x = d(date); x.setHours(hour); return x.toISOString(); };

test('focusByDay sums minutes per day for the last 7 days', () => {
  const sessions = [
    { minutes: 25, endedAt: at('2026-10-19', 10) },
    { minutes: 25, endedAt: at('2026-10-19', 14) },
    { minutes: 50, endedAt: at('2026-10-21', 9) },
    { minutes: 30, endedAt: at('2026-10-15', 9) }, // 6 days before the 21st – included
    { minutes: 25, endedAt: at('2026-10-14', 9) }, // 7 days before – ignored
  ];
  const days = L.focusByDay(sessions, d('2026-10-21'));
  assert.deepEqual(days.map((x) => x.minutes), [30, 0, 0, 0, 50, 0, 50]);
  assert.deepEqual(days.map((x) => x.label), ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed']);
  assert.equal(days[6].isToday, true);
  // Regression test: on a Monday the chart must still show last week's work.
  assert.equal(L.focusByDay(sessions, MONDAY).reduce((s, x) => s + x.minutes, 0), 105);
});

test('studyStreak counts consecutive days and survives until midnight', () => {
  const sessions = ['2026-10-16', '2026-10-17', '2026-10-18'].map((x) => ({ minutes: 25, endedAt: at(x, 12) }));
  assert.equal(L.studyStreak(sessions, MONDAY), 3, 'yesterday still counts');
  sessions.push({ minutes: 25, endedAt: at('2026-10-19', 9) });
  assert.equal(L.studyStreak(sessions, MONDAY), 4);
  assert.equal(L.studyStreak(sessions, d('2026-10-21')), 0, 'a missed day breaks it');
  assert.equal(L.studyStreak([], MONDAY), 0);
});

test('niceScale picks round axis values', () => {
  assert.deepEqual(L.niceScale(0), { max: 60, ticks: [0, 30, 60] });
  assert.deepEqual(L.niceScale(40), { max: 45, ticks: [0, 15, 30, 45] });
  assert.deepEqual(L.niceScale(75), { max: 90, ticks: [0, 30, 60, 90] });
  assert.equal(L.niceScale(500).max >= 500, true);
});

test('formatting helpers', () => {
  assert.equal(L.formatMinutes(0), '0 min');
  assert.equal(L.formatMinutes(45), '45 min');
  assert.equal(L.formatMinutes(60), '1 h');
  assert.equal(L.formatMinutes(135), '2 h 15 min');
  assert.equal(L.formatTimer(1500), '25:00');
  assert.equal(L.formatTimer(59.2), '01:00');
  assert.equal(L.formatTimer(-5), '00:00');
  assert.equal(L.formatHours(1.5), '~1.5 h');
  assert.equal(L.formatHours(null), '');
});

test('validateTask catches missing and bad input', () => {
  const bad = L.validateTask({ title: '  ', due: '2026-02-31', estimate: '-3' });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.title && bad.errors.due && bad.errors.estimate);

  const good = L.validateTask({ title: ' Essay ', due: '2026-11-01', priority: 'high', estimate: '2.5', courseId: '' });
  assert.equal(good.valid, true);
  assert.deepEqual(good.value, { title: 'Essay', due: '2026-11-01', priority: 'high', estimate: 2.5, courseId: null, notes: '' });
  assert.equal(L.validateTask({ title: 'x', due: '2026-11-01', priority: 'urgent!!' }).value.priority, 'medium');
});

test('validateCourse rejects duplicates but allows renaming itself', () => {
  const courses = [{ id: 'a', name: 'Maths', color: 0 }];
  assert.equal(L.validateCourse({ name: 'maths' }, courses).valid, false);
  assert.equal(L.validateCourse({ id: 'a', name: 'Maths' }, courses).valid, true);
  assert.equal(L.validateCourse({ name: 'Physics' }, courses).value.color, 1);
});

test('nextColorSlot fills gaps in fixed order', () => {
  assert.equal(L.nextColorSlot([]), 0);
  assert.equal(L.nextColorSlot([{ color: 0 }, { color: 2 }]), 1);
});

test('normalizeState repairs broken or hostile data', () => {
  assert.deepEqual(L.normalizeState(null).tasks, []);
  const s = L.normalizeState({
    courses: [{ id: 'c1', name: 'AI', color: 99 }, { name: 'no id' }, null],
    tasks: [
      { id: 't1', title: 'ok', courseId: 'gone', due: 'not-a-date', priority: 'x' },
      { id: 't2', title: '' },
      'junk',
    ],
    sessions: [{ minutes: 25, endedAt: 'never' }, { minutes: -5, endedAt: '2026-10-19T10:00:00Z' }, { minutes: 25, endedAt: '2026-10-19T10:00:00Z', courseId: 'c1' }],
    settings: { focusMinutes: 9999, breakMinutes: 'abc', theme: 'neon' },
  });
  assert.equal(s.courses.length, 1);
  assert.equal(s.courses[0].color, 7);
  assert.equal(s.tasks.length, 1);
  assert.equal(s.tasks[0].courseId, null);
  assert.equal(s.tasks[0].due, '');
  assert.equal(s.tasks[0].priority, 'medium');
  assert.equal(s.sessions.length, 1);
  assert.deepEqual(s.settings, { focusMinutes: 120, breakMinutes: 5, theme: 'system' });
});

test('demo data is valid and relative to today', () => {
  const demo = L.createDemoState(MONDAY);
  const again = L.normalizeState(JSON.parse(JSON.stringify(demo)));
  assert.equal(again.tasks.length, demo.tasks.length);
  assert.equal(again.sessions.length, demo.sessions.length);
  assert.equal(again.meta.demo, true);
  const stats = L.dashboardStats(demo, MONDAY);
  assert.equal(stats.overdue, 1);
  assert.ok(stats.streak >= 6);
});
