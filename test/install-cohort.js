// Pin the complete official SDK peer graph to one release; caret peers otherwise mix RCs.
import { spawnSync } from 'node:child_process';
const version = process.env.DSH_VERSION;
if (!/^0\.1\.5-rc\.[12]$/u.test(version ?? '')) throw new Error('Set DSH_VERSION to 0.1.5-rc.1 or 0.1.5-rc.2');
const packages = new Set(['@deepseek-ai/dsh']);
const pending = [...packages];
while (pending.length) {
  const batch = pending.splice(0, 8);
  const manifests = await Promise.all(batch.map(async name => {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Cannot resolve ${name}@${version}: HTTP ${response.status}`);
    return response.json();
  }));
  for (const manifest of manifests) for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })) {
    if (!name.startsWith('@deepseek-ai/dsh-') || packages.has(name)) continue;
    packages.add(name); pending.push(name);
  }
}
console.log(`Installing ${packages.size} official packages at ${version}`);
const result = spawnSync('npm', ['install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', ...[...packages].map(name => `${name}@${version}`)], { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
