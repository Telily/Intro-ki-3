// End-to-end test: opens the real app in a headless browser and clicks through
// the main features like a user would.
//   npm install && npx playwright install chromium && npm run test:e2e
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    const body = await readFile(join(root, path === '/' ? 'index.html' : path));
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'text/html' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const errors = [];
let passed = 0;
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

async function newPage(viewport = { width: 1280, height: 860 }) {
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url);
  return page;
}

console.log('StudyPilot end-to-end tests');
const page = await newPage();

await step('first visit shows dashboard with sample data', async () => {
  await page.waitForSelector('#stats .stat');
  assert.equal(await page.isVisible('#demo-banner'), true);
  assert.equal(await page.locator('#next-deadlines .task').count(), 5);
  assert.equal(await page.locator('#focus-chart .col').count(), 7);
  assert.equal(await page.locator('#course-progress .progress').count(), 4);
});

await step('add an assignment through the dialog (with validation)', async () => {
  await page.click('[data-view="dashboard"] [data-action="new-task"]');
  await page.fill('#task-form [name="title"]', '');
  await page.click('#task-form button[type="submit"]');
  assert.match(await page.textContent('[data-error="title"]'), /name/);
  await page.fill('#task-form [name="title"]', 'E2E test essay <b>bold?</b>');
  await page.selectOption('#task-form [name="courseId"]', { label: 'Statistics' });
  await page.check('#task-form [name="priority"][value="high"]', { force: true });
  await page.fill('#task-form [name="estimate"]', '2');
  await page.click('#task-form button[type="submit"]');
  assert.equal(await page.isVisible('#task-dialog'), false);
  const titles = await page.evaluate(() => window.__studyPilot.getState().tasks.map((t) => t.title));
  assert.ok(titles.includes('E2E test essay <b>bold?</b>'));
});

await step('assignments view: filters, search and HTML is escaped', async () => {
  await page.click('[data-nav="tasks"]');
  await page.fill('#task-search', 'e2e test');
  assert.equal(await page.locator('#task-groups .task').count(), 1);
  assert.equal(await page.locator('#task-groups .task-title b').count(), 0, 'user text must not become HTML');
  await page.fill('#task-search', '');
  await page.click('[data-status="overdue"]');
  assert.equal(await page.locator('#task-groups .task').count(), 1);
  await page.click('[data-status="open"]');
});

await step('complete a task, then undo', async () => {
  const before = await page.locator('[data-status="done"] .count').textContent();
  await page.locator('#task-groups .task', { hasText: 'E2E test essay' }).locator('[data-action="toggle-task"]').click();
  const after = await page.locator('[data-status="done"] .count').textContent();
  assert.equal(Number(after), Number(before) + 1);
  await page.click('.toast-action');
  assert.equal(await page.locator('[data-status="done"] .count').textContent(), before);
});

await step('edit and delete (with undo) an assignment', async () => {
  const row = page.locator('#task-groups .task', { hasText: 'E2E test essay' });
  await row.locator('[data-action="edit-task"]').click();
  await page.fill('#task-form [name="title"]', 'E2E renamed');
  await page.click('#task-form button[type="submit"]');
  await page.locator('#task-groups .task', { hasText: 'E2E renamed' }).locator('[data-action="delete-task"]').click();
  assert.equal(await page.locator('#task-groups .task', { hasText: 'E2E renamed' }).count(), 0);
  await page.click('.toast-action');
  assert.equal(await page.locator('#task-groups .task', { hasText: 'E2E renamed' }).count(), 1);
});

await step('add a course (duplicate names rejected) and delete it', async () => {
  await page.click('[data-nav="courses"]');
  await page.waitForSelector('[data-view="courses"]:not([hidden]) .course-card');
  const start = await page.locator('.course-card').count();
  await page.click('[data-view="courses"] [data-action="new-course"]');
  await page.fill('#course-form [name="name"]', 'statistics');
  await page.click('#course-form button[type="submit"]');
  assert.match(await page.textContent('[data-error="name"]'), /already/);
  await page.fill('#course-form [name="name"]', 'Databases');
  await page.click('#course-form button[type="submit"]');
  assert.equal(await page.locator('.course-card').count(), start + 1);
  await page.locator('.course-card', { hasText: 'Databases' }).locator('[data-action="delete-course"]').click();
  await page.click('#confirm-ok');
  // The dialog's "close" event fires asynchronously, so wait for the re-render.
  await page.waitForFunction((n) => document.querySelectorAll('.course-card').length === n, start);
});

await step('"View assignments" on a course filters the list', async () => {
  await page.locator('.course-card', { hasText: 'Web Development' }).locator('[data-action="view-course"]').click();
  await page.waitForSelector('[data-view="tasks"]:not([hidden])');
  assert.equal(await page.inputValue('#course-filter'), 'c-web');
  const courses = await page.locator('#task-groups .course-tag').allTextContents();
  assert.ok(courses.length > 0 && courses.every((c) => c.includes('Web Development')));
});

await step('focus timer: start, pause, finish a round and log it', async () => {
  await page.locator('#task-groups .task').first().locator('[data-action="focus-task"]').click();
  await page.waitForSelector('[data-view="focus"]:not([hidden])');
  assert.notEqual(await page.inputValue('#focus-task'), '');
  await page.fill('#focus-length', '1');
  await page.dispatchEvent('#focus-length', 'change');
  assert.equal(await page.textContent('#timer-display'), '01:00');
  await page.click('#timer-start');
  await page.waitForTimeout(1300);
  assert.match(await page.textContent('#timer-start'), /Pause/);
  assert.notEqual(await page.textContent('#timer-display'), '01:00');
  await page.click('#timer-start');
  assert.match(await page.textContent('#timer-start'), /Resume/);
  const sessionsBefore = await page.evaluate(() => window.__studyPilot.getState().sessions.length);
  // Fast-forward: pretend the round's end time has passed.
  await page.click('#timer-start');
  await page.evaluate(() => { window.__studyPilot.timer.endsAt = Date.now() - 10; });
  await page.waitForFunction(() => window.__studyPilot.timer.mode === 'break');
  const sessionsAfter = await page.evaluate(() => window.__studyPilot.getState().sessions.length);
  assert.equal(sessionsAfter, sessionsBefore + 1);
  assert.equal(await page.locator('#session-list li').count() >= 1, true);
  assert.equal(await page.getAttribute('#timer-card', 'data-mode'), 'break');
});

await step('data survives a page reload', async () => {
  const count = await page.evaluate(() => window.__studyPilot.getState().tasks.length);
  await page.reload();
  await page.waitForSelector('#timer-display');
  assert.equal(await page.evaluate(() => window.__studyPilot.getState().tasks.length), count);
});

await step('theme switch to dark mode', async () => {
  await page.click('[data-nav="settings"]');
  await page.click('[data-theme-choice="dark"]');
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  await page.click('[data-theme-choice="system"]');
  assert.equal(await page.getAttribute('html', 'data-theme'), null);
});

await step('start fresh clears sample data and shows empty states', async () => {
  await page.click('[data-nav="dashboard"]');
  await page.click('[data-action="demo-clear"]');
  await page.click('#confirm-ok');
  await page.waitForSelector('[data-view="courses"]:not([hidden])');
  assert.equal(await page.locator('.course-card').count(), 0);
  assert.equal(await page.isVisible('#course-grid .empty'), true);
  await page.click('[data-nav="dashboard"]');
  assert.equal(await page.isVisible('#demo-banner'), false);
});

await step('corrupted saved data does not crash the app', async () => {
  const p = await newPage();
  await p.evaluate(() => localStorage.setItem('studypilot.v1', '{"tasks":[{"broken":true}],"courses":"nope"'));
  await p.reload();
  await p.waitForSelector('#stats .stat');
  await p.close();
});

await step('mobile layout has no horizontal scrolling', async () => {
  const p = await newPage({ width: 375, height: 760 });
  for (const view of ['dashboard', 'tasks', 'courses', 'focus', 'settings']) {
    await p.click(`[data-nav="${view}"]`);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${view} overflows by ${overflow}px`);
  }
  await p.close();
});

await step('no JavaScript errors in the console', async () => {
  assert.deepEqual(errors, []);
});

console.log(`\n${passed} steps passed${process.exitCode ? ', some FAILED' : ''}.`);
await browser.close();
server.close();
