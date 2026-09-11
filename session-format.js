import { createHash, randomUUID } from 'node:crypto';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import { SESSION_FORMAT_VERSION, Session } from '@deepseek-ai/dsh-session';
import { MAX_UPLOAD_BYTES, readZipArchive } from './archive.js';

export { SESSION_FORMAT_VERSION };
const MAX_SESSIONS = 256;
const MAX_EVENTS = 1_000_000;
const IMAGE_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const errorOf = (statusCode, message, code = 'bad-file') => Object.assign(new Error(message), { statusCode, code });

/** Delegate historical decoding, migration and semantic validation to the installed DSH catalog. */
export function parseSession(bytes, filename) {
  try {
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '').split('\n');
    const physical = JSON.parse(lines[0]);
    const restore = sessionFormatCatalog.createRestore(physical, { recovery: 'strict', validation: 'current' });
    let count = 0;
    for (const line of lines.slice(1)) {
      if (!line.trim()) continue;
      if (++count > MAX_EVENTS) throw new Error('会话事件超过上限');
      restore.decodeRow(JSON.parse(line));
    }
    const artifact = restore.finish();
    if (artifact.events.length > MAX_EVENTS) throw new Error('会话事件超过上限');
    return { ...artifact, sourceVersion: physical.version, filename };
  } catch (error) {
    throw errorOf(400, `${filename}: ${error.message}`);
  }
}

/** Walk structured event data; user text and JSON encoded in text are never rewritten. */
export function visitObjects(value, visitor) {
  const stack = [value];
  while (stack.length) {
    const item = stack.pop();
    if (item === null || typeof item !== 'object') continue;
    visitor(item);
    for (const child of Object.values(item)) if (child !== null && typeof child === 'object') stack.push(child);
  }
}

export function attachmentKey(type, ref) {
  return `${type}:${ref.attachmentId}:${type === 'file' ? ref.name : ''}`;
}

/** Locate exactly the media/file entries named by the logical session logs. */
function attachmentsOf(logs, files, zipped) {
  const refs = new Map();
  for (const log of logs) for (const event of log.events) visitObjects(event.data, block => {
    if (!['image', 'file'].includes(block.type) || !block.attachment) return;
    const ref = block.attachment;
    const key = attachmentKey(block.type, ref);
    if (refs.has(key)) {
      if (JSON.stringify(refs.get(key).ref) !== JSON.stringify(ref)) {
        // Display names may differ for the same image; its bytes and dimensions may not.
        const old = refs.get(key).ref;
        if (['bytes', 'mediaType', 'width', 'height'].some(field => old[field] !== ref[field])) throw errorOf(400, '同一附件的元数据不一致');
      }
      return;
    }
    const digest = typeof ref.attachmentId === 'string' ? ref.attachmentId.replace(/^sha256:/u, '') : '';
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw errorOf(400, '附件标识不是有效的 SHA-256');
    let path;
    if (block.type === 'image') {
      const ext = IMAGE_EXTENSIONS[ref.mediaType];
      if (!ext) throw errorOf(400, '图片附件类型不受支持');
      path = `media/${ref.attachmentId}.${ext}`;
      if (!files.has(path) && ext === 'jpg') path = `media/${ref.attachmentId}.jpeg`;
    } else {
      if (typeof ref.name !== 'string') throw errorOf(400, '文件附件缺少名称');
      const name = ref.name.replace(/[\\/\u0000-\u001f\u007f]/gu, '_');
      const safeName = ['', '.', '..'].includes(name) ? 'file' : name;
      path = `files/${digest.slice(0, 2)}/${digest}/${safeName}`;
    }
    const data = files.get(path);
    if (zipped && data === undefined) throw errorOf(400, `压缩包缺少引用的附件: ${path}`);
    if (data && (data.length !== ref.bytes || sha256(data) !== digest)) throw errorOf(400, `附件指纹或大小不一致: ${path}`);
    refs.set(key, { key, type: block.type, ref, data, path });
  });
  return [...refs.values()];
}

/** Parse a complete import before starting any writes. */
export function parseUpload(bytes, filename = 'session.jsonl') {
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw errorOf(413, '上传文件为空或超过 256 MB');
  const zipped = bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
  let files;
  try { files = zipped ? readZipArchive(bytes) : new Map([[filename, bytes]]); }
  catch (error) { throw errorOf(400, error.message); }
  const rootNames = zipped ? [...files.keys()].filter(name => !name.includes('/') && /\.jsonl$/iu.test(name)) : [filename];
  if (rootNames.length !== 1) throw errorOf(400, '压缩包必须包含唯一的根会话 JSONL');
  const childNames = zipped ? [...files.keys()].filter(name => /^subagents\/.+\.jsonl$/iu.test(name)) : [];
  if (childNames.length >= MAX_SESSIONS) throw errorOf(400, '子会话数量超过 255');
  const logs = [rootNames[0], ...childNames].map(name => parseSession(files.get(name), name));
  const byId = new Map(logs.map(log => [log.header.id, log]));
  if (byId.size !== logs.length) throw errorOf(400, '压缩包包含重复会话 ID 或多个日志代际');
  if (logs.reduce((n, log) => n + log.events.length, 0) > MAX_EVENTS) throw errorOf(400, '事件总量超过上限');
  const root = logs[0];
  for (const log of logs.slice(1)) {
    const seen = new Set([log.header.id]);
    let parent = log.header.parentSession;
    while (parent !== root.header.id) {
      if (!byId.has(parent)) throw errorOf(400, '子会话缺少所属父会话');
      if (seen.has(parent)) throw errorOf(400, '会话关系包含循环');
      seen.add(parent);
      parent = byId.get(parent).header.parentSession;
    }
  }
  const attachments = attachmentsOf(logs, files, zipped);
  const warnings = [];
  if (attachments.some(item => !item.data)) warnings.push('裸 JSONL 不包含附件；导入前会检查目标 DSH 是否已有这些附件。');
  if (root.header.parentSession) warnings.push('根会话会作为独立会话导入，不连接目标机器上同名的旧父会话。');
  return { logs, attachments, sha256: sha256(bytes), byteLength: bytes.length, warnings };
}

/** Keep the established preview API while reporting the complete archive and migrated format. */
export function previewOf(parsed) {
  const { header, events } = parsed.logs[0];
  let title = null;
  const sync = { model: null, agentPreset: header.agentPreset ?? null, permission: null, sandbox: null, approval: null, plan: null };
  const counts = { turn: 0, step: 0, user: 0, assistant: 0, tool: 0 };
  for (const event of events) {
    const data = event.data;
    if (event.type === 'session/title') title = data.title;
    if (event.type === 'request/header') sync.model = data.header.config;
    if (event.type === 'agent-preset/selected') sync.agentPreset = data.agentPreset;
    if (event.type === 'permission/preset') sync.permission = data.preset;
    if (event.type === 'sandbox/mode') sync.sandbox = data.mode;
    if (event.type === 'approval/policy') sync.approval = data.policy;
    if (event.type === 'plan/mode') sync.plan = data.active;
    const count = { 'turn/start': 'turn', 'step/start': 'step', 'user/message': 'user', 'assistant/message': 'assistant', 'tool/call': 'tool' }[event.type];
    if (count) counts[count] += 1;
  }
  return {
    title, sync, counts, eventCount: events.length, totalEventCount: parsed.logs.reduce((n, log) => n + log.events.length, 0),
    byteLength: parsed.byteLength, lastTime: events.at(-1)?.time ?? header.createdAt,
    formatVersion: SESSION_FORMAT_VERSION, sourceVersions: [...new Set(parsed.logs.map(log => log.sourceVersion))],
    provenance: { originalId: header.id, createdAt: header.createdAt, cwd: header.cwd ?? null, delegationDepth: header.delegationDepth ?? 0 },
    extras: { subagentLogs: parsed.logs.length - 1, mediaFiles: parsed.attachments.filter(item => item.type === 'image').length, files: parsed.attachments.filter(item => item.type === 'file').length },
  };
}

/** Give the imported tree fresh identities without filtering events or changing sequence references. */
export function prepareSessions(parsed, cwd, { restamp = true, title = '' } = {}) {
  const ids = new Map(parsed.logs.map(log => [log.header.id, `session-import-${randomUUID()}`]));
  const latestTime = parsed.logs.reduce((latest, log) => log.events.reduce((time, event) => Math.max(time, event.time), Math.max(latest, log.header.createdAt)), 0);
  const shift = restamp ? Math.max(0, Date.now() - latestTime) : 0;
  const rootId = parsed.logs[0].header.id;
  return parsed.logs.map((source, index) => {
    const log = structuredClone(source);
    log.header.id = ids.get(source.header.id);
    log.header.cwd = cwd;
    log.header.createdAt += shift;
    if (index === 0) {
      delete log.header.parentSession;
      delete log.header.origin;
      log.header.delegationDepth = 0;
    } else {
      log.header.parentSession = ids.get(source.header.parentSession);
      let depth = 1;
      let parent = source.header.parentSession;
      while (parent !== rootId) { parent = parsed.logs.find(item => item.header.id === parent).header.parentSession; depth += 1; }
      log.header.delegationDepth = depth;
    }
    for (const event of log.events) {
      event.time += shift;
      if (Array.isArray(event.data?.stream)) for (const record of event.data.stream) {
        if (typeof record.time === 'number') record.time += shift;
        if (typeof record.time0 === 'number') record.time0 += shift;
      }
      visitObjects(event.data, value => {
        for (const key of ['sessionId', 'parentSessionId', 'childSessionId', 'sourceSessionId', 'targetSessionId']) {
          if (typeof value[key] === 'string' && ids.has(value[key])) value[key] = ids.get(value[key]);
        }
      });
    }
    if (index === 0 && title) log.events.push({
      type: 'session/title', seq: log.events.length, time: Math.max(Date.now(), log.events.at(-1)?.time ?? 0),
      data: { title, messageSeqs: [], source: { kind: 'user' } },
    });
    validatePrepared(log);
    return log;
  });
}

/** Invoke the current runtime's restoration checks after identity/attachment substitutions. */
export function validatePrepared(log) {
  Session.fromRestore(log.header.id, structuredClone(log.events), log.header, log.inheritedEventCount, 'detached');
}
