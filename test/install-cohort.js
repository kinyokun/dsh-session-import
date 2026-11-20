// Pin the complete official SDK peer graph to one release; caret peers otherwise mix RCs.
import { spawnSync } from 'node:child_process';
import { collectCohort } from './cohort.js';

const version = process.env.DSH_VERSION;
const { selected, skipped } = await collectCohort(version);
if (skipped.length) console.log(`Skipping ${skipped.length} package(s) not available on ${process.platform}/${process.arch}: ${skipped.join(', ')}`);
console.log(`Installing ${selected.length} official packages at ${version}`);
const result = spawnSync('npm', ['install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', ...selected.map(name => `${name}@${version}`)], { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
