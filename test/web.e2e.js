import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { fixture, pngFixture, zip } from './helpers.js';
import { sha256 } from '../session-format.js';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const parent = process.env.DSH_TEST_ROOT ?? join(repo, 'tmp');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, 'web-'));
const cwd = join(root, 'workspace');
const profile = join(root, 'home/profiles/web');
const env = { ...process.env, DSH_HOME: join(root, 'home') };
for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete env[key];
const pluginPackage = process.env.DSH_PLUGIN_PACKAGE;
await mkdir(cwd); await mkdir(join(profile, 'node_modules'), { recursive: true });
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-import-e2e', private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...pluginPackage ? [] : ['dsh-session-import']] } } }));
if (pluginPackage) {
  const install = spawnSync(process.env.DSH_BIN ?? 'dsh', ['plugin', '--profile', 'web', 'add', pluginPackage], { cwd, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(install.status, 0, install.stderr);
  const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
  assert.ok(manifest.dsh.profile.bundles.includes('dsh-session-import'));
  console.log('PASS official plugin add: package install and automatic bundle registration');
} else {
  await symlink(repo, join(profile, 'node_modules/dsh-session-import'), process.platform === 'win32' ? 'junction' : 'dir');
}
await writeFile(join(profile, 'cordis.patch.yml'), `- insert:\n    - id: import-test-model\n      name: ${JSON.stringify(join(repo, 'test/mock-provider.js'))}\n`);
const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const logfile = join(root, 'server.log');
const log = createWriteStream(logfile, { mode: 0o600 });
await once(log, 'open');
const server = spawn(process.env.DSH_BIN ?? 'dsh', ['web', '--host', '127.0.0.1', '--port', String(port), '--no-open'], { cwd, env, stdio: ['ignore', log.fd, log.fd] });
let browser;
let passed = false;
try {
  let start;
  for (let i = 0; i < 300; i += 1) {
    const text = await readFile(logfile, 'utf8');
    start = text.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/[^\\s]*`))?.[0];
    if (start) break;
    if (server.exitCode !== null) throw new Error(`DSH exited (${server.exitCode}); private log: ${logfile}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!start) throw new Error(`DSH startup timed out; private log: ${logfile}`);
  const origin = `http://127.0.0.1:${port}`;
  const anonymous = await fetch(`${origin}/api/session-import/status`);
  assert.equal(anonymous.status, 401, 'DSH must protect plugin endpoints');
  for (const action of ['analyze', 'import', 'delete']) {
    assert.equal((await fetch(`${origin}/api/session-import/${action}`, { method: 'POST' })).status, 401);
  }
  browser = await chromium.launch({ headless: true, ...(process.env.PW_BROWSER_CHANNEL ? { channel: process.env.PW_BROWSER_CHANNEL } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(start);
  await page.getByRole('button', { name: /^(继续|Continue)$/u }).waitFor({ timeout: 5000 })
    .then(() => page.getByRole('button', { name: /^(继续|Continue)$/u }).click()).catch(() => {});
  const status = await page.request.get(`${origin}/api/session-import/status`);
  assert.equal(status.status(), 200, 'authenticated status: ' + await status.text());
  assert.equal((await status.json()).compatible, true);
  const csrf = await page.request.post(`${origin}/api/session-import/import`, { headers: { origin: 'https://unrelated.example' }, data: fixture() });
  assert.equal(csrf.status(), 403);
  await page.getByRole('button', { name: '导入对话', exact: true }).click();
  await page.getByRole('dialog').locator('input[type=file]').setInputFiles({ name: 'legacy.jsonl', mimeType: 'application/json', buffer: fixture(0, { cwd }) });
  await page.getByRole('button', { name: '开始导入', exact: true }).waitFor();
  await page.getByRole('dialog').locator('select').selectOption('original');
  const response = page.waitForResponse(result => result.url().includes('/api/session-import/import?'));
  await page.getByRole('button', { name: '开始导入', exact: true }).click();
  const imported = await (await response).json();
  assert.equal(imported.ok, true); assert.equal(imported.resumed, true);
  await page.getByText('已打开导入的会话', { exact: true }).waitFor();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.getByText('hello from the source', { exact: true }).waitFor();
  const editor = page.locator('[contenteditable=true]').first();
  await editor.fill('continue the imported conversation'); await editor.press('Enter');
  await page.getByText('IMPORT_CONTINUATION_OK: original conversation history is present.', { exact: false }).first().waitFor({ timeout: 30000 });
  await page.screenshot({ path: join(root, 'continued.png') });
  console.log('PASS browser: choose legacy file, preview, import, open, continue with original history');

  // Round-trip the native exporter, including a descendant, PNG and binary file.
  const png = pngFixture(), file = Buffer.from('export round-trip\0binary bytes');
  const imageId = `sha256:${sha256(png)}`, digest = sha256(file);
  const rows = fixture(3, { cwd }).toString().trim().split('\n').map(JSON.parse);
  rows.find(row => row.type === 'user/message').data.content.push(
    { type: 'image', attachment: { attachmentId: imageId, mediaType: 'image/png', bytes: png.length, width: 1, height: 1 } },
    { type: 'file', attachment: { attachmentId: `sha256:${digest}`, bytes: file.length, name: 'sample.txt' } },
  );
  const archive = zip([['session.v3.jsonl', rows.map(JSON.stringify).join('\n')],
    ['subagents/child/session.v3.jsonl', fixture(3, { id: 'example-child', parentSession: 'example-root', origin: 'subagent', delegationDepth: 1, cwd })],
    [`media/${imageId}.png`, png], [`files/${digest.slice(0, 2)}/${digest}/sample.txt`, file]]);
  const requestImport = async data => {
    const response = await page.request.post(`${origin}/api/session-import/import?${new URLSearchParams({ workspace: cwd, name: 'tree.zip', restamp: '0' })}`, { headers: { 'content-type': 'application/octet-stream' }, data });
    const result = await response.json(); assert.equal(result.ok, true, JSON.stringify(result)); return result;
  };
  const first = await requestImport(archive);
  const exported = await page.request.get(`${origin}/api/session.export?sessionId=${first.sessionId}&includeDescendants=true`);
  assert.equal(exported.status(), 200);
  const nativeBytes = await exported.body();
  await writeFile(join(root, 'native-export.zip'), nativeBytes, { mode: 0o600 });
  const second = await requestImport(nativeBytes);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(second.sessionCount, 2);
  assert.deepEqual(second.extras, { subagentLogs: 1, mediaFiles: 1, files: 1 });
  for (const result of [first, second]) {
    const preview = await page.request.post(`${origin}/api/session-import/delete?sessionId=${result.sessionId}&dryRun=1`);
    assert.equal((await preview.json()).sessionIds.length, 2);
    const undo = await page.request.post(`${origin}/api/session-import/delete?sessionId=${result.sessionId}`);
    assert.equal((await undo.json()).deleted, true);
  }
  const cookieFile = join(root, 'smoke-cookie.txt');
  await writeFile(cookieFile, (await page.context().cookies()).map(item => `${item.name}=${item.value}`).join('; '), { mode: 0o600 });
  const smoke = spawnSync(process.execPath, [join(repo, 'test/smoke.js')], {
    env: { ...env, BASE_URL: origin, DSH_COOKIE_FILE: cookieFile, SMOKE_WORKSPACE: cwd, SMOKE_IMPORT: '1' }, encoding: 'utf8', timeout: 60000,
  });
  await rm(cookieFile);
  assert.equal(smoke.status, 0, smoke.stderr);
  process.stdout.write(smoke.stdout);
  assert.deepEqual(pageErrors, []);
  console.log('PASS native /export -> import: child sessions, PNG, binary file, reversible undo, no page errors');
  passed = true;
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    server.kill('SIGINT');
    await Promise.race([once(server, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
    if (server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
  }
  log.end();
  if (passed && pluginPackage) {
    const removed = spawnSync(process.env.DSH_BIN ?? 'dsh', ['plugin', '--profile', 'web', 'remove', 'dsh-session-import'], { cwd, env, encoding: 'utf8', timeout: 60000 });
    assert.equal(removed.status, 0, removed.stderr);
    const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'));
    assert.ok(!manifest.dsh.profile.bundles.includes('dsh-session-import'));
    assert.ok(!manifest.dependencies?.['dsh-session-import']);
    console.log('PASS official plugin remove: dependency and bundle registration removed');
  }
  if (passed && process.env.KEEP_DSH_TEST_DATA !== '1') await rm(root, { recursive: true, force: true });
  else console.log(`Test artifacts: ${root}`);
}
