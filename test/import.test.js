import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import AttachmentStore from '@deepseek-ai/dsh-attachment-local';
import { Session } from '@deepseek-ai/dsh-session';
import { SessionImporter } from '../importer.js';
import { parseUpload, prepareSessions, sha256 } from '../session-format.js';
import { RecoveryStore } from '../storage-adapter.js';
import { fixture, zip, pngFixture } from './helpers.js';

async function harness(t, compression = 'none') {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-import-test-'));
  const cwd = join(dir, 'workspace'); await mkdir(cwd);
  const context = new Context();
  await context.plugin(JsonlPersistence, { root: join(dir, 'sessions'), compression });
  await context.plugin(AttachmentStore, { dshHome: join(dir, 'home') });
  const attached = new Set();
  const workspace = { async attachSession(id) { attached.add(id); }, async detachSession(id) { attached.delete(id); } };
  const registry = { async resolveByPath() { return workspace; } };
  const ctx = { get: key => key === 'workspaceRegistry' ? registry : context.get(key) };
  const importer = new SessionImporter(ctx);
  t.after(async () => { await importer.dispose(); await context.fiber.dispose(); await rm(dir, { recursive: true, force: true }); });
  return { dir, cwd, context, importer, workspace, attached, persistence: context.sessionPersistence };
}

for (const version of [0, 1, 2, 3]) test(`official migration accepts v${version} and preserves conversation text`, () => {
  const parsed = parseUpload(fixture(version));
  assert.equal(parsed.logs[0].header.version, 3);
  const log = prepareSessions(parsed, '/private/tmp', { restamp: false })[0];
  const restored = Session.fromRestore(log.header.id, log.events, log.header, log.inheritedEventCount, 'detached');
  assert.deepEqual(restored.deriveMessages().map(message => message.role), ['system', 'user', 'assistant']);
  assert.match(JSON.stringify(restored.deriveMessages()), /hello from the assistant/);
});

test('refuses future formats, damaged sequences and unknown required events', () => {
  assert.throws(() => parseUpload(fixture(4)), /v4|version 4|format 4/i);
  const lines = fixture(3).toString().trim().split('\n');
  assert.throws(() => parseUpload(Buffer.from(lines.filter((_, i) => i !== 4).join('\n'))), /seq|contiguous|sequence/i);
  const event = JSON.parse(lines[1]); event.type = 'future/unknown'; lines[1] = JSON.stringify(event);
  assert.throws(() => parseUpload(Buffer.from(lines.join('\n'))), /unknown|unrecognized|unsupported|vocabulary/i);
});

test('refuses ambiguous roots, duplicate IDs, cyclic and orphan child sessions', () => {
  assert.throws(() => parseUpload(zip([['a.jsonl', fixture()], ['b.jsonl', fixture()]])), /唯一/);
  assert.throws(() => parseUpload(zip([['session.jsonl', fixture()], ['subagents/a/session.jsonl', fixture()]])), /重复会话/);
  assert.throws(() => parseUpload(zip([['session.jsonl', fixture()], ['subagents/a/session.jsonl', fixture(0, { id: 'a', parentSession: 'missing' })]])), /父会话/);
  assert.throws(() => parseUpload(zip([['session.jsonl', fixture()], ['subagents/a/session.jsonl', fixture(0, { id: 'a', parentSession: 'a' })]])), /循环/);
});

test('ZIP rejects traversal, duplicate entries, CRC corruption and expansion claims', () => {
  assert.throws(() => parseUpload(zip([['../session.jsonl', fixture()]])), /不安全/);
  assert.throws(() => parseUpload(zip([['session.jsonl', fixture()], ['session.jsonl', fixture()]])), /重复条目/);
  const archive = zip([['session.jsonl', fixture()]]);
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
  const corrupt = Buffer.from(archive); corrupt.writeUInt32LE(0, central + 16);
  assert.throws(() => parseUpload(corrupt), /校验失败/);
  const huge = Buffer.from(archive); huge.writeUInt32LE(600 * 1024 * 1024, central + 24);
  assert.throws(() => parseUpload(huge), /512 MB/);
});

for (const compression of ['none', 'zstd']) test(`real ${compression} backend: tree import, independent reopen, continued log and guarded undo`, async t => {
  const h = await harness(t, compression);
  const bytes = zip([['session.v3.jsonl', fixture(3)], ['subagents/child/session.v3.jsonl', fixture(3, { id: 'example-child', parentSession: 'example-root', origin: 'subagent', delegationDepth: 1 })]]);
  const before = Buffer.from(bytes);
  const result = await h.importer.import(bytes, 'tree.zip', { workspace: h.cwd, restamp: '0' });
  assert.deepEqual(bytes, before);
  assert.equal(result.sessionCount, 2);
  assert.deepEqual([...h.attached], [result.sessionId]);
  const child = await h.persistence.stat(result.sessionIds[1]);
  assert.equal(child.header.parentSession, result.sessionId);
  const independent = new Context();
  await independent.plugin(JsonlPersistence, { root: join(h.dir, 'sessions'), compression });
  try {
    const reader = await independent.sessionPersistence.open(result.sessionId, 'read');
    const log = await reader.read();
    assert.match(JSON.stringify(log.events), /hello from the source/);
    const offset = log.events.length;
    await reader.close();
    const writer = await independent.sessionPersistence.open(result.sessionId, 'write');
    await writer.append([{ type: 'turn/start', seq: offset, time: 2000, data: { turn: 2 } }, { type: 'turn/end', seq: offset + 1, time: 2001, data: { turn: 2, reason: { kind: 'completed' } } }]);
    await writer.close();
    await assert.rejects(h.importer.undo({ sessionId: result.sessionId }), /发生变化/);
  } finally { await independent.fiber.dispose(); }
});

test('dry run and fingerprint mismatch do not create sessions or journals', async t => {
  const h = await harness(t);
  const result = await h.importer.import(fixture(), 'old.jsonl', { workspace: h.cwd, dryRun: '1' });
  assert.equal(result.sessionId, null);
  assert.equal(result.dryRun, true);
  await assert.rejects(h.importer.import(fixture(), 'old.jsonl', { workspace: h.cwd, expectedHash: '0'.repeat(64) }), /指纹/);
  assert.equal((await h.persistence.list()).length, 0);
  assert.deepEqual(await readdir(h.dir), ['workspace']);
});

test('undo survives plugin restart, refuses non-owned sessions and quarantines an unchanged import', async t => {
  const h = await harness(t);
  const result = await h.importer.import(fixture(), 'old.jsonl', { workspace: h.cwd });
  const importer = new SessionImporter(h.importer.ctx);
  const preview = await importer.undo({ sessionId: result.sessionId, dryRun: '1' });
  assert.equal(preview.recoverable, true);
  assert.equal((await h.persistence.list()).length, 1);
  await assert.rejects(importer.undo({ sessionId: 'unrelated-session' }), /导入记录/);
  const undone = await importer.undo({ sessionId: result.sessionId });
  assert.equal(undone.deleted, true);
  assert.equal((await h.persistence.list()).length, 0);
  assert.equal(h.attached.size, 0);
  const journal = JSON.parse(await readFile(undone.recoveryRecord));
  assert.equal(journal.status, 'undone');
  assert.match(await readFile(join(journal.quarantined[0].destination, 'session.v3.jsonl'), 'utf8'), /hello from the source/);
});

test('failed workspace attachment rolls back the entire tree and releases writer locks', async t => {
  const h = await harness(t);
  h.workspace.attachSession = async () => { throw new Error('injected attach failure'); };
  const bytes = zip([['session.jsonl', fixture()], ['subagents/a/session.jsonl', fixture(0, { id: 'a', parentSession: 'example-root' })]]);
  await assert.rejects(h.importer.import(bytes, 'tree.zip', { workspace: h.cwd }), /已撤销/);
  assert.equal((await h.persistence.list()).length, 0);
  const recovery = new RecoveryStore(h.persistence);
  const journals = await readdir(join(recovery.recovery, 'imports'));
  const journal = JSON.parse(await readFile(join(recovery.recovery, 'imports', journals[0])));
  assert.equal(journal.status, 'rolled-back');
  assert.equal(journal.quarantined.length, 2);
});

test('restores binary file attachments and rejects missing or mismatched archive bytes', async t => {
  const h = await harness(t);
  const data = Buffer.from('binary file\0exact bytes'); const digest = sha256(data);
  const ref = { attachmentId: `sha256:${digest}`, bytes: data.length, name: 'sample.txt' };
  const rows = fixture(3).toString().trim().split('\n').map(JSON.parse);
  rows.find(row => row.type === 'user/message').data.content.push({ type: 'file', attachment: ref });
  const log = rows.map(JSON.stringify).join('\n'); const filePath = `files/${digest.slice(0, 2)}/${digest}/sample.txt`;
  assert.throws(() => parseUpload(zip([['session.v3.jsonl', log]])), /缺少引用/);
  assert.throws(() => parseUpload(zip([['session.v3.jsonl', log], [filePath, Buffer.from('wrong')]])), /指纹或大小/);
  const result = await h.importer.import(zip([['session.v3.jsonl', log], [filePath, data]]), 'files.zip', { workspace: h.cwd });
  const chunks = [];
  for await (const chunk of h.context.attachments.readFileStream(ref)) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), data);
  assert.equal(result.extras.files, 1);
  await h.importer.undo({ sessionId: result.sessionId });
  const retained = [];
  for await (const chunk of h.context.attachments.readFileStream(ref)) retained.push(chunk);
  assert.deepEqual(Buffer.concat(retained), data);
});

test('real image store restores a PNG from an official media path', async t => {
  const h = await harness(t);
  const png = pngFixture();
  // Obtain a normalized reference from an independent source store, as official /export does.
  const source = new Context(); await source.plugin(AttachmentStore, { dshHome: join(h.dir, 'source-home') });
  try {
    const ref = await source.attachments.saveImage({ data: png, mediaType: 'image/png', name: 'pixel.png' });
    const stored = await source.attachments.readImage(ref);
    const rows = fixture(3).toString().trim().split('\n').map(JSON.parse);
    rows.find(row => row.type === 'user/message').data.content.push({ type: 'image', attachment: ref });
    const result = await h.importer.import(zip([['session.v3.jsonl', rows.map(JSON.stringify).join('\n')], [`media/${ref.attachmentId}.png`, stored.data]]), 'image.zip', { workspace: h.cwd });
    assert.equal(result.extras.mediaFiles, 1);
    const reader = await h.persistence.open(result.sessionId, 'read');
    try {
      const log = await reader.read();
      const image = log.events.find(e => e.type === 'user/message').data.content.find(part => part.type === 'image');
      const restored = await h.context.attachments.readImage(image.attachment);
      assert.deepEqual(restored.data, stored.data);
    } finally { await reader.close(); }
  } finally { await source.fiber.dispose(); }
});

test('append failure closes its handle and quarantines the newly created session', async t => {
  const h = await harness(t);
  const original = h.persistence.create.bind(h.persistence);
  let closed = false;
  h.persistence.create = async (...args) => {
    const handle = await original(...args);
    return { append: async () => { throw new Error('injected append failure'); },
      flush: () => handle.flush(), close: async () => { await handle.close(); closed = true; } };
  };
  await assert.rejects(h.importer.import(fixture(), 'old.jsonl', { workspace: h.cwd }), /已撤销/);
  assert.equal(closed, true);
  assert.equal((await h.persistence.list()).length, 0);
  assert.equal(h.attached.size, 0);
});

test('a missing runtime agent does not undo a completed import', async t => {
  const h = await harness(t);
  const result = await h.importer.import(fixture(), 'old.jsonl', { workspace: h.cwd, open: '1' });
  assert.equal(result.resumed, false);
  assert.match(result.warnings.join(' '), /自动恢复未完成/);
  assert.equal((await h.persistence.list()).length, 1);
  assert.equal(h.attached.has(result.sessionId), true);
});

test('undo refuses a live imported session even before its new events flush', async t => {
  const h = await harness(t);
  const result = await h.importer.import(fixture(), 'old.jsonl', { workspace: h.cwd });
  const original = h.importer.ctx.get;
  h.importer.ctx.get = key => key === 'sessions' ? { get: id => id === result.sessionId ? {} : undefined } : original(key);
  h.importer.live.set(result.sessionId, { dispose: async () => {} });
  await assert.rejects(h.importer.undo({ sessionId: result.sessionId }), /打开状态/);
  assert.equal(h.attached.has(result.sessionId), true);
});

for (const version of [0, 3]) test(`v${version} seeded root retains its inherited history after detaching from the source parent`, async t => {
  const h = await harness(t);
  const rows = fixture(version, { parentSession: 'external-parent', origin: 'subagent', ...(version < 2 ? { seedLength: 0 } : { isSeeded: true }) }).toString().trim().split('\n').map(JSON.parse);
  if (version < 2) rows[0].seedLength = rows.length - 2;
  else {
    const cut = rows.length - 2;
    rows.splice(rows.length - 1, 0, { type: 'session/end-seed', seq: cut, time: 1000 + cut, data: { inherited: true } });
    rows.at(-1).seq += 1;
  }
  const result = await h.importer.import(Buffer.from(rows.map(JSON.stringify).join('\n')), 'seeded.jsonl', { workspace: h.cwd });
  const reader = await h.persistence.open(result.sessionId, 'read');
  try {
    const restored = await reader.read();
    assert.equal(reader.header.parentSession, undefined);
    assert.equal(reader.header.isSeeded, true);
    assert.ok(reader.inheritedEventCount > 0);
    assert.equal(restored.events[reader.inheritedEventCount].type, 'session/end-seed');
    assert.match(JSON.stringify(restored.events), /hello from the source/);
  } finally { await reader.close(); }
});
