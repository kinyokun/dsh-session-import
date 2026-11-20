/**
 * 官方 cohort 里有只面向单一平台的包：0.2.2-rc.5 起
 * @deepseek-ai/dsh-experimental-cua-macos 的 manifest 声明 "os": ["darwin"]，
 * 而它只是 dsh-cua-bundle 的 optionalDependency。
 *
 * CI 为了让整个 peer 图固定在同一版本，会显式安装每一个官方包；
 * 在 Linux runner 上显式安装 darwin-only 包会被 npm 以 EBADPLATFORM 拒绝。
 * 安装前按 manifest 的 os / cpu 过滤，语义与 npm 的 os/cpu 字段一致：
 * 空数组表示不限制，普通项是白名单，'*' 通配，'!x' 是黑名单。
 */
export function manifestMatchesPlatform(manifest, platform = process.platform, arch = process.arch) {
  return matchesList(manifest?.os, platform) && matchesList(manifest?.cpu, arch);
}

function matchesList(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true;
  const entries = list.filter(entry => typeof entry === 'string');
  if (entries.includes('!' + value)) return false;
  const allowed = entries.filter(entry => !entry.startsWith('!'));
  if (allowed.length === 0) return true;
  return allowed.includes(value) || allowed.includes('*');
}
