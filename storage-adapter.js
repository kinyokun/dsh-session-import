import { lstat, mkdir, readFile, realpath, rename, open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { errorOf, SESSION_FORMAT_VERSION } from './session-format.js';

const OWN_ID = /^session-import-[a-f0-9-]{36}$/u;
const inside = (root, child) => { const rel = relative(root, child); return rel !== '' && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel); };

/** Isolate the one backend-specific operation: quarantine plugin-owned JSONL directories.
 * DSH has no public delete API. The diagnostic locator is checked before any import writes;
 * all log reads/writes use public SessionHandle methods. No shared attachment is deleted.
 */
export class RecoveryStore {
  constructor(persistence) {
    if (SESSION_FORMAT_VERSION !== 3 || persistence?.name !== 'session-persistence-jsonl' || typeof persistence.config?.root !== 'string'
      || typeof persistence.locate !== 'function' || ['create', 'open', 'stat', 'list', 'flush'].some(method => typeof persistence[method] !== 'function')) {
      throw errorOf(503, '当前导入需要 DSH 0.1.5 的 JSONL 存储后端；未写入任何会话。', 'compatibility');
    }
    this.persistence = persistence;
    this.root = resolve(persistence.config.root);
    this.recovery = join(dirname(this.root), `${basename(this.root)}-import-recovery`);
  }

  pathFor(header) {
    if (!OWN_ID.test(header.id)) throw errorOf(409, '拒绝处理非本插件创建的会话', 'ownership');
    const location = this.persistence.locate(header);
    if (location?.kind !== 'jsonl' || typeof location.path !== 'string'
      || !/^session\.v3\.jsonl(?:\.zstd)?$/u.test(basename(location.path))
      || !inside(this.root, location.path)) throw errorOf(503, '存储布局已改变，需要更新导入插件', 'compatibility');
    return dirname(location.path);
  }

  async save(journal) {
    await mkdir(join(this.recovery, 'imports'), { recursive: true, mode: 0o700 });
    const path = this.journalPath(journal.rootId);
    const temp = `${path}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(journal, null, 2)); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, path);
  }

  journalPath(id) {
    if (!OWN_ID.test(id)) throw errorOf(404, '没有找到该会话的导入记录', 'not-found');
    return join(this.recovery, 'imports', `${id}.json`);
  }

  async load(id) {
    try {
      const value = JSON.parse(await readFile(this.journalPath(id), 'utf8'));
      if (value.rootId !== id || !Array.isArray(value.sessions)) throw new Error('导入记录无效');
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') throw errorOf(404, '没有找到该会话的导入记录', 'not-found');
      throw error;
    }
  }

  /** Rename only a validated owned directory; retain a restore mapping outside the active root. */
  async quarantine(header, importId) {
    const source = this.pathFor(header);
    let info;
    try { info = await lstat(source); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw errorOf(409, '会话目录不是普通目录', 'ownership');
    const canonicalRoot = await realpath(this.root);
    if (!inside(canonicalRoot, await realpath(source))) throw errorOf(409, '会话目录超出存储根目录', 'ownership');
    const folder = join(this.recovery, 'quarantine', importId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const destination = join(folder, header.id);
    await rename(source, destination);
    return { source, destination };
  }
}
