import { manifestMatchesPlatform } from './cohort-platform.js';

/**
 * 解析一个已发布 DSH 版本对应的完整官方包图。
 * 显式安装每个官方包是为了把 peer 图钉在同一版本；但包里存在单平台包
 * （0.2.2-rc.5 起 dsh-experimental-cua-macos 仅 darwin），必须按 os/cpu 过滤，
 * 否则 Linux CI 在 npm install 阶段 EBADPLATFORM 失败。
 */
export async function collectCohort(version, {
  fetchJson = defaultFetchJson,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version ?? '')) {
    throw new Error('Set DSH_VERSION to a released @deepseek-ai/dsh version');
  }
  const packages = new Set(['@deepseek-ai/dsh']);
  const collected = new Map();
  const pending = [...packages];
  while (pending.length) {
    const batch = pending.splice(0, 8);
    const manifests = await Promise.all(batch.map(name => fetchJson(name, version)));
    for (const manifest of manifests) {
      collected.set(manifest.name, manifest);
      for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })) {
        if (!name.startsWith('@deepseek-ai/dsh-') || packages.has(name)) continue;
        packages.add(name);
        pending.push(name);
      }
    }
  }
  const selected = [...packages].filter(name => manifestMatchesPlatform(collected.get(name), platform, arch));
  const skipped = [...packages].filter(name => !manifestMatchesPlatform(collected.get(name), platform, arch));
  return { selected, skipped };
}

async function defaultFetchJson(name, version) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Cannot resolve ${name}@${version}: HTTP ${response.status}`);
  return response.json();
}
