import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const base = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:3080');
if (!['http:', 'https:'].includes(base.protocol)) throw new Error('BASE_URL must be an HTTP origin');
const cookiePath = process.env.DSH_COOKIE_FILE;
if (!cookiePath) throw new Error('Set DSH_COOKIE_FILE to a private file containing the logged-in Cookie header value (never commit it).');
const cookie = (await readFile(cookiePath, 'utf8')).trim();
const good = await readFile(new URL('./fixtures/good.jsonl', import.meta.url));
const gap = await readFile(new URL('./fixtures/tampered-gap.jsonl', import.meta.url));
const request = async (action, query = {}, body, method = 'POST') => {
  const url = new URL(`/api/session-import/${action}`, base); url.search = new URLSearchParams(query);
  const result = await fetch(url, { method, headers: { cookie, 'content-type': 'application/octet-stream' }, body, signal: AbortSignal.timeout(60000) });
  assert.notEqual(result.status, 401, 'login expired; refresh DSH_COOKIE_FILE');
  return { status: result.status, value: await result.json() };
};
assert.equal((await request('status', {}, undefined, 'GET')).value.compatible, true);
assert.equal((await request('analyze', { name: 'good.jsonl' }, good)).value.verification.verdict, 'ok');
assert.equal((await request('analyze', { name: 'gap.jsonl' }, gap)).status, 400);
const options = { workspace: process.env.SMOKE_WORKSPACE ?? process.cwd(), name: 'good.jsonl' };
const dry = await request('import', { ...options, dryRun: '1' }, good);
assert.equal(dry.value.dryRun, true); assert.equal(dry.value.sessionId, null);
assert.equal((await request('import', { ...options, dryRun: '1', expectedHash: '0'.repeat(64) }, good)).status, 409);
console.log('PASS status, format validation, dry run and fingerprint guard');
if (process.env.SMOKE_IMPORT === '1') {
  const imported = await request('import', options, good);
  assert.equal(imported.value.ok, true);
  const query = { sessionId: imported.value.sessionId };
  assert.equal((await request('delete', { ...query, dryRun: '1' })).value.recoverable, true);
  assert.equal((await request('delete', query)).value.deleted, true);
  console.log('PASS real import and recoverable undo');
}
