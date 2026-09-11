import { realpath, stat } from 'node:fs/promises';
import { attachmentKey, errorOf, parseUpload, prepareSessions, previewOf, validatePrepared, visitObjects } from './session-format.js';
import { RecoveryStore } from './storage-adapter.js';

/** Serializes mutations and owns only the live agents created by this importer. */
export class SessionImporter {
  constructor(ctx) { this.ctx = ctx; this.live = new Map(); this.pending = Promise.resolve(); this.stopping = false; }

  exclusive(action) {
    if (this.stopping) return Promise.reject(errorOf(503, '插件正在停止', 'stopping'));
    const task = this.pending.then(action);
    this.pending = task.catch(() => {});
    return task;
  }

  async dispose() {
    this.stopping = true;
    await this.pending;
    const results = await Promise.allSettled([...this.live.values()].map(handle => handle.dispose()));
    this.live.clear();
    const errors = results.filter(item => item.status === 'rejected').map(item => item.reason);
    if (errors.length) throw new AggregateError(errors, '释放导入会话失败');
  }

  services() {
    const persistence = this.ctx.get('sessionPersistence');
    const workspaces = this.ctx.get('workspaceRegistry');
    if (!workspaces || typeof workspaces.resolveByPath !== 'function') throw errorOf(503, '工作区服务不可用', 'compatibility');
    return { persistence, workspaces, recovery: new RecoveryStore(persistence) };
  }

  async target(query, parsed) {
    const path = !query.workspace || query.workspace === 'original' ? parsed.logs[0].header.cwd : query.workspace;
    if (!path) throw errorOf(400, '请选择目标工作区', 'workspace');
    try {
      const cwd = await realpath(path);
      if (!(await stat(cwd)).isDirectory()) throw new Error('不是目录');
      return cwd;
    } catch { throw errorOf(400, '目标工作区不存在或不可读', 'workspace'); }
  }

  /** Validate every attachment first. Bare logs can only reuse verified local objects. */
  async validateAttachments(parsed) {
    if (!parsed.attachments.length) return;
    const store = this.ctx.get('attachments');
    if (!store) throw errorOf(503, '附件存储服务不可用', 'attachments');
    for (const item of parsed.attachments) {
      try {
        if (item.data && item.type === 'image') await store.validateImage({ data: item.data, mediaType: item.ref.mediaType, name: item.ref.name });
        if (!item.data) {
          if (item.type === 'image') await store.readImage(item.ref);
          else for await (const chunk of store.readFileStream(item.ref)) void chunk;
        }
      } catch (error) { throw errorOf(422, `附件不可用 (${item.path}): ${error.message}`, 'attachments'); }
    }
  }

  async saveAttachments(parsed, logs) {
    const store = this.ctx.get('attachments');
    const saved = new Map();
    for (const item of parsed.attachments) {
      if (!item.data) continue;
      const ref = item.type === 'image'
        ? await store.saveImage({ data: item.data, mediaType: item.ref.mediaType, name: item.ref.name })
        : await store.saveFile({ data: item.data, name: item.ref.name });
      saved.set(item.key, ref);
    }
    for (const log of logs) {
      for (const event of log.events) visitObjects(event.data, block => {
        if (!['image', 'file'].includes(block.type) || !block.attachment) return;
        const ref = saved.get(attachmentKey(block.type, block.attachment));
        if (ref) block.attachment = { ...ref, ...(block.type === 'image' && block.attachment.name ? { name: block.attachment.name } : {}) };
      });
      validatePrepared(log);
    }
  }

  /** Parse and migrate before writes; close every writer before workspace attachment/resume. */
  import(bytes, filename, query = {}) {
    return this.exclusive(async () => {
      const parsed = parseUpload(bytes, filename);
      if (query.expectedHash && (!/^[a-f0-9]{64}$/iu.test(query.expectedHash) || query.expectedHash.toLowerCase() !== parsed.sha256)) {
        throw errorOf(409, '文件 SHA-256 与预期指纹不一致', 'hash');
      }
      if (query.sync !== undefined) throw errorOf(400, '新版导入完整保留会话状态，不再支持删除部分状态事件；请刷新插件页面。', 'options');
      const { persistence, workspaces, recovery } = this.services();
      const cwd = await this.target(query, parsed);
      const title = (query.title ?? '').trim();
      if (Buffer.byteLength(title) > 100) throw errorOf(400, '标题最多 100 UTF-8 字节', 'options');
      const logs = prepareSessions(parsed, cwd, { restamp: query.restamp !== '0', title });
      for (const log of logs) recovery.pathFor(log.header);
      await this.validateAttachments(parsed);
      const summary = {
        sessionId: null, sessionCount: logs.length, eventCount: logs.reduce((n, log) => n + log.events.length, 0),
        sha256: parsed.sha256, extras: previewOf(parsed).extras, warnings: [...parsed.warnings], resumed: false,
      };
      if (query.dryRun === '1') return { ...summary, dryRun: true };
      const journal = { rootId: logs[0].header.id, status: 'pending', createdAt: Date.now(), cwd, sourceSha256: parsed.sha256, sessions: [], quarantined: [] };
      await recovery.save(journal);
      let workspace;
      try {
        await this.saveAttachments(parsed, logs);
        // The root is attached only once every child is durable and independently readable.
        for (const log of logs) {
          const record = { header: log.header, revision: null, created: false };
          journal.sessions.push(record);
          await recovery.save(journal);
          const writer = await persistence.create(log.header, { inheritedEventCount: log.inheritedEventCount });
          record.created = true;
          try { await writer.append(log.events); await writer.flush(); }
          finally { await writer.close(); }
          const reader = await persistence.open(log.header.id, 'read');
          try { const content = await reader.read(); validatePrepared({ ...log, events: content.events }); }
          finally { await reader.close(); }
          record.revision = (await persistence.stat(log.header.id)).revision;
        }
        workspace = await workspaces.resolveByPath(cwd) ?? await workspaces.create(cwd);
        await workspace.attachSession(logs[0].header.id);
        journal.status = 'complete';
        await recovery.save(journal);
      } catch (error) {
        const failures = [];
        if (workspace) {
          try { await workspace.detachSession(journal.rootId); } catch (cause) { failures.push(cause.message); }
        }
        for (const record of [...journal.sessions].reverse()) {
          const { header } = record;
          if (!record.created) {
            try {
              await stat(recovery.pathFor(header));
              failures.push('创建会话未返回句柄，但已存在目录；保留该目录以便检查');
            } catch (cause) { if (cause.code !== 'ENOENT') failures.push(cause.message); }
            continue;
          }
          try {
            if (this.ctx.get('sessions')?.get(header.id)) throw new Error('新会话已被其他入口打开，保留数据以便恢复');
            const moved = await recovery.quarantine(header, journal.rootId); if (moved) journal.quarantined.push(moved);
          }
          catch (cause) { failures.push(cause.message); }
        }
        journal.status = failures.length ? 'recovery-required' : 'rolled-back';
        journal.failures = failures;
        try { await recovery.save(journal); } catch (cause) { failures.push(cause.message); }
        throw errorOf(500, failures.length
          ? `导入失败；部分恢复步骤未完成，记录位于 ${recovery.journalPath(journal.rootId)}。原因: ${error.message}`
          : `导入失败，已撤销工作区挂载并隔离新会话以便恢复: ${error.message}`, 'import-failed');
      }
      summary.sessionId = journal.rootId;
      summary.sessionIds = logs.map(log => log.header.id);
      // Resume failure does not undo a successfully committed import. The UI still opens cold history.
      if (query.open === '1') {
        try {
          const loop = this.ctx.get('agentLoop');
          if (!loop) throw new Error('当前 profile 没有 agentLoop');
          const handle = await loop.resume(this.ctx, { resumeSessionId: journal.rootId });
          this.live.set(journal.rootId, handle);
          summary.resumed = true;
          for (const record of journal.sessions) record.revision = (await persistence.stat(record.header.id)).revision;
          await recovery.save(journal);
        } catch (error) { summary.warnings.push(`会话已导入；自动恢复未完成，可从侧栏打开。${error.message}`); }
      }
      return summary;
    });
  }

  /** Undo only an unchanged import owned by our durable journal; preserve logs in quarantine. */
  undo(query) {
    return this.exclusive(async () => {
      const { persistence, workspaces, recovery } = this.services();
      const journal = await recovery.load(query.sessionId);
      if (journal.status !== 'complete') throw errorOf(409, '该导入已撤销或需要先恢复', 'state');
      const sessions = this.ctx.get('sessions');
      for (const { header, revision } of journal.sessions) {
        if (sessions?.get(header.id)) throw errorOf(409, '会话仍处于打开状态，请先关闭会话再撤销', 'live');
        if ((await persistence.stat(header.id)).revision !== revision) throw errorOf(409, '导入后会话已发生变化，拒绝撤销以保留新内容', 'modified');
      }
      if (query.dryRun === '1') return { dryRun: true, sessionId: journal.rootId, sessionIds: journal.sessions.map(item => item.header.id), recoverable: true };
      const workspace = await workspaces.resolveByPath(journal.cwd);
      await workspace?.detachSession(journal.rootId);
      journal.status = 'undoing';
      await recovery.save(journal);
      try {
        for (const { header } of [...journal.sessions].reverse()) {
          const moved = await recovery.quarantine(header, journal.rootId);
          if (moved) journal.quarantined.push(moved);
          await recovery.save(journal);
        }
        journal.status = 'undone';
        await recovery.save(journal);
      } catch (error) {
        journal.status = 'recovery-required';
        journal.failures = [error.message];
        await recovery.save(journal);
        throw errorOf(500, `撤销未完成，恢复记录: ${recovery.journalPath(journal.rootId)}`, 'recovery');
      }
      return { deleted: true, sessionId: journal.rootId, recoverable: true, recoveryRecord: recovery.journalPath(journal.rootId) };
    });
  }
}
