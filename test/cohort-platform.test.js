import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestMatchesPlatform } from './cohort-platform.js';
import { collectCohort } from './cohort.js';

test('darwin-only package is skipped on linux and kept on macOS', () => {
  const manifest = { os: ['darwin'] };
  assert.equal(manifestMatchesPlatform(manifest, 'linux', 'x64'), false);
  assert.equal(manifestMatchesPlatform(manifest, 'darwin', 'arm64'), true);
});

test('manifest without os/cpu restrictions matches every platform', () => {
  assert.equal(manifestMatchesPlatform({}, 'linux', 'x64'), true);
  assert.equal(manifestMatchesPlatform({ os: [], cpu: [] }, 'darwin', 'arm64'), true);
});

test('negated os entries deny only the named platform', () => {
  assert.equal(manifestMatchesPlatform({ os: ['!win32'] }, 'linux', 'x64'), true);
  assert.equal(manifestMatchesPlatform({ os: ['!win32'] }, 'win32', 'x64'), false);
});

test('cpu restrictions are honoured', () => {
  assert.equal(manifestMatchesPlatform({ cpu: ['arm64'] }, 'darwin', 'x64'), false);
  assert.equal(manifestMatchesPlatform({ cpu: ['arm64'] }, 'darwin', 'arm64'), true);
  assert.equal(manifestMatchesPlatform({ cpu: ['*'] }, 'linux', 's390x'), true);
});

const manifests = {
  '@deepseek-ai/dsh': { name: '@deepseek-ai/dsh', dependencies: { '@deepseek-ai/dsh-cua-bundle': '1.0.0' } },
  '@deepseek-ai/dsh-cua-bundle': { name: '@deepseek-ai/dsh-cua-bundle', optionalDependencies: { '@deepseek-ai/dsh-experimental-cua-macos': '1.0.0' }, peerDependencies: { '@deepseek-ai/dsh-session': '~1.0.0' } },
  '@deepseek-ai/dsh-experimental-cua-macos': { name: '@deepseek-ai/dsh-experimental-cua-macos', os: ['darwin'] },
  '@deepseek-ai/dsh-session': { name: '@deepseek-ai/dsh-session' },
};
const fetchJson = async name => {
  if (!manifests[name]) throw new Error('unexpected package ' + name);
  return manifests[name];
};

test('cohort keeps the whole graph on the matching platform', async () => {
  const cohort = await collectCohort('1.0.0', { fetchJson, platform: 'darwin', arch: 'arm64' });
  assert.deepEqual(cohort.skipped, []);
  assert.deepEqual(cohort.selected.sort(), Object.keys(manifests).sort());
});

test('cohort drops darwin-only packages on linux', async () => {
  const cohort = await collectCohort('1.0.0', { fetchJson, platform: 'linux', arch: 'x64' });
  assert.deepEqual(cohort.skipped, ['@deepseek-ai/dsh-experimental-cua-macos']);
  assert.equal(cohort.selected.includes('@deepseek-ai/dsh-experimental-cua-macos'), false);
  assert.equal(cohort.selected.includes('@deepseek-ai/dsh-cua-bundle'), true);
});

test('cohort rejects an invalid version before touching the registry', async () => {
  await assert.rejects(collectCohort('latest', { fetchJson }), /DSH_VERSION/);
});
