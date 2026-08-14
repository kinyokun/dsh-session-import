/**
 * session-import — DSH 会话日志导入插件(Host 侧)。
 *
 * 与浏览器端 client.js 配合,挂载 /session-import/* 接口:
 *   GET  /session-import/status   插件与依赖状态
 *   POST /session-import/analyze  解析 + 真实性验证(结构一致性 + SHA-256 指纹),不落盘
 *   POST /session-import/import   执行导入(支持 dryRun=1 预演)
 *   POST /session-import/delete   删除本插件导入的会话产物(测试/撤销导入)
 *
 * 支持两种输入:
 *   - 会话导出 ZIP(dsh /export 产物;自动识别根目录 session.jsonl,并统计
 *     subagents/ 与 media/ 附属物,不在本次导入范围);
 *   - 裸 .jsonl 日志(首行 session 头 + 事件行,含 text-chunks 等压缩存储行)。
 *
 * 导入行为:
 *   - 始终重新分配会话 ID(不覆盖本机已有会话);
 *   - restamp=1 时把事件时间戳整体平移到最后事件=当前时间(列表置顶);
 *   - 按 sync 参数选择性同步日志中的状态:模型与思考深度(request/header)、
 *     Agent 预设、权限预设、沙箱模式、审批策略、计划模式;
 *   - 过滤/重排后同步重写事件内的 seq 引用(messageSeqs、sourceEventSeqs、
 *     inbox/spliced.start、surfaceOp.start/end);
 *   - expectedHash 提供时执行 SHA-256 强校验,不一致直接拒绝。
 *
 * 真实性验证(结构层面,不依赖签名——当前 DSH 导出不含签名):
 *   error(拒绝导入):seq 不连续、事件行损坏、本版本无法解读的未知类型;
 *   warning(提示可疑):时间戳回退、turn/step 未闭合或错配、tool/call 无
 *   result、command 未完成、assistant 消息 id 重复等。
 */
import { createHash, randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { realpath, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

export const name = 'session-import';
export const inject = ['webServer'];
export const version = '1.0.0';

const MAX_BODY_BYTES = 256 * 1024 * 1024;
/** 单个 ZIP 条目解压后的大小上限(防御 zip 炸弹)。 */
const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;
/** 自定义标题的 UTF-8 字节上限(低于会话标题服务的 maxTitleBytes)。 */
const MAX_TITLE_BYTES = 100;

/** 本构建可解读的事件类型(与 dsh-session 生成的 KNOWN_SESSION_EVENT_TYPES 一致)。 */
const KNOWN_TYPES = new Set([
  'agent-preset/selected', 'agent/inbox/spliced', 'approval/asked', 'approval/decided',
  'approval/policy', 'assistant/chunk', 'assistant/message', 'command/done', 'command/run',
  'compaction/end', 'compaction/prune', 'compaction/start', 'compaction/summary',
  'feedback/record', 'goal/change', 'hook/invoked', 'hook/result', 'llm/retry',
  'llm/retry-started', 'permission/preset', 'plan/mode', 'request/context', 'request/header',
  'sandbox/mode', 'schedule/change', 'session/end-seed', 'session/title',
  'session/title-llm-request', 'step/end', 'step/start', 'subagent/descriptor',
  'todo/write', 'tool-workflow/agent-end', 'tool-workflow/agent-start',
  'tool-workflow/run-end', 'tool-workflow/run-start', 'tool/call', 'tool/code-dispatch',
  'tool/code-dispatch-start', 'tool/result', 'turn/end', 'turn/start', 'user/message',
  'web/deepseek-search-llm-request',
]);

/** 可同步组 → 事件类型。 */
const SYNC_GROUPS = {
  model: 'request/header',
  preset: 'agent-preset/selected',
  permission: 'permission/preset',
  sandbox: 'sandbox/mode',
  approval: 'approval/policy',
  plan: 'plan/mode',
};

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 本插件恢复为活跃态的导入会话 → 释放句柄(删除/停用时回收)。 */
const importedHandles = new Map();

function hasExactKeys(record, keys) {
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function sendJson(res, status, body) {
  try {
    if (res.writableEnded || res.destroyed) return;
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(text);
  } catch {
    // 连接已断开等,忽略
  }
}

function errorMessage(error) {
  return String(error && error.message ? error.message : error);
}

function httpError(statusCode, message, code = 'internal') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`上传超过大小上限(${Math.round(maxBytes / 1048576)} MB)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 最小 ZIP 读取器(仅本插件使用):解析 End of Central Directory → 中央目录 →
 * 按中央目录的偏移/大小读取各条目,支持 method 0(stored)与 8(deflate,inflateRaw)。
 * @param {Buffer} buf - 整个压缩包字节。
 * @returns {Map<string, Buffer>} 条目名 → 解压后字节。
 */
function readZipArchive(buf) {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error('不是有效的 ZIP 文件');
  let eocd = -1;
  const searchStart = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= searchStart; i -= 1) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP 缺少 End of Central Directory 记录');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const entryName = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if ((flags & 0x1) !== 0) throw new Error(`ZIP 条目 "${entryName}" 已加密,不支持加密压缩包`);
    if (uncompSize > MAX_ENTRY_BYTES) throw new Error(`ZIP 条目 "${entryName}" 解压后超过 ${Math.round(MAX_ENTRY_BYTES / 1048576)} MB 上限`);
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`ZIP 条目 "${entryName}" 本地头损坏`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) throw new Error(`ZIP 条目 "${entryName}" 数据越界`);
    let data = buf.subarray(dataStart, dataEnd);
    if (method === 8) data = inflateRawSync(data);
    else if (method !== 0) throw new Error(`ZIP 条目 "${entryName}" 使用不支持的压缩方法 ${method}`);
    if (data.length !== uncompSize) throw new Error(`ZIP 条目 "${entryName}" 解压后大小与目录声明不符(文件损坏)`);
    files.set(entryName, Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/**
 * 展开存储行:text-chunks / reasoning-chunks / tool-call-chunks → assistant/chunk
 * 事件序列;其余记录原样返回。校验失败即抛出(损坏存储 = 拒绝导入)。
 */
function expandRecord(record) {
  if (!isRecord(record)) return [record];
  const tag = record.type;
  if (tag !== 'text-chunks' && tag !== 'reasoning-chunks' && tag !== 'tool-call-chunks') return [record];
  const malformed = (why) => {
    throw new Error(`存储行 "${tag}" 损坏: ${why}`);
  };
  if (!hasExactKeys(record, ['type', 'seq0', 'time0', 'data'])) malformed('envelope 必须恰为 {type, seq0, time0, data}');
  if (!Number.isSafeInteger(record.seq0) || record.seq0 < 0) malformed('seq0 非法');
  if (!Number.isSafeInteger(record.time0)) malformed('time0 非法');
  const data = record.data;
  if (!isRecord(data)) malformed('data 必须是对象');
  let members;
  if (tag === 'tool-call-chunks') {
    const withName = hasExactKeys(data, ['turn', 'step', 'index', 'id', 'name', 'dt', 'args']);
    if (!withName && !hasExactKeys(data, ['turn', 'step', 'index', 'id', 'dt', 'args'])) malformed('data 键集合非法');
    if (typeof data.id !== 'string' || (withName && typeof data.name !== 'string')) malformed('id/name 类型非法');
    members = data.args;
  } else {
    if (!hasExactKeys(data, ['turn', 'step', 'index', 'dt', 'texts'])) malformed('data 键集合非法');
    members = data.texts;
  }
  if (typeof data.turn !== 'number' || typeof data.step !== 'number' || typeof data.index !== 'number') malformed('turn/step/index 必须是数字');
  if (!Array.isArray(members) || members.length === 0 || members.some((entry) => typeof entry !== 'string')) malformed('成员必须是非空字符串数组');
  const dt = data.dt;
  if (!Array.isArray(dt) || dt.some((gap) => !Number.isSafeInteger(gap))) malformed('dt 必须是安全整数数组');
  if (dt.length !== members.length - 1) malformed(`dt 长度 ${dt.length} 与成员数 ${members.length} 不匹配`);
  if (!Number.isSafeInteger(record.seq0 + members.length - 1)) malformed('成员 seq 超出安全整数');
  let time = record.time0;
  for (const gap of dt) {
    time += gap;
    if (!Number.isSafeInteger(time)) malformed('成员 time 超出安全整数');
  }
  const events = [];
  for (let k = 0; k < members.length; k += 1) {
    if (k > 0) time += dt[k - 1];
    let chunk;
    switch (tag) {
      case 'text-chunks':
        chunk = { type: 'text-delta', index: data.index, text: members[k] };
        break;
      case 'reasoning-chunks':
        chunk = { type: 'reasoning-delta', index: data.index, text: members[k] };
        break;
      default:
        chunk = {
          type: 'tool-call-delta',
          index: data.index,
          id: data.id,
          ...Object.hasOwn(data, 'name') ? { name: data.name } : {},
          argumentsDelta: members[k],
        };
        break;
    }
    events.push({
      type: 'assistant/chunk',
      seq: record.seq0 + k,
      time,
      data: { turn: data.turn, step: data.step, chunk },
    });
  }
  return events;
}

function isHeaderLine(value) {
  return isRecord(value)
    && value.type === 'session'
    && value.version === 0
    && typeof value.id === 'string'
    && typeof value.createdAt === 'number' && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
    && typeof value.delegationDepth === 'number' && Number.isSafeInteger(value.delegationDepth) && value.delegationDepth >= 0
    && (value.origin === undefined || value.origin === 'subagent')
    && (value.agentPreset === undefined || typeof value.agentPreset === 'string');
}

/**
 * 解析上传字节 → {header, events(已展开), extras}。
 * @param {Buffer} body - 原始上传字节。
 * @param {string} fileName - 客户端文件名(仅用于错误信息)。
 */
function parseUpload(body, fileName) {
  try {
    return parseUploadInner(body, fileName);
  } catch (error) {
    // 已带 HTTP 语义的错误原样抛出,其余一律按 400 bad-file(客户端传入的文件问题)
    if (typeof error?.statusCode === 'number') throw error;
    throw httpError(400, errorMessage(error), 'bad-file');
  }
}

function parseUploadInner(body, fileName) {
  const extras = { subagentLogs: 0, mediaFiles: 0 };
  let text;
  if (body.length >= 4 && body.readUInt32LE(0) === 0x04034b50) {
    const files = readZipArchive(body);
    const names = [...files.keys()];
    let target = names.find((n) => n === 'session.jsonl' && !n.includes('/'));
    if (target === undefined) target = names.find((n) => !n.includes('/') && n.toLowerCase().endsWith('.jsonl'));
    for (const n of names) {
      if (n.startsWith('subagents/') && n.toLowerCase().endsWith('.jsonl')) extras.subagentLogs += 1;
      else if (n.startsWith('media/')) extras.mediaFiles += 1;
    }
    if (target === undefined) {
      const listing = names.slice(0, 8).join(', ');
      throw new Error(`压缩包(${fileName})中没有找到根目录 session.jsonl;共 ${names.length} 个条目: ${listing}`);
    }
    text = files.get(target).toString('utf8');
  } else {
    text = body.toString('utf8');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split('\n');
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch (error) {
    throw new Error(`首行无法解析为 JSON: ${errorMessage(error)}`);
  }
  if (!isHeaderLine(header)) throw new Error('首行不是合法的 DSH 会话头(type: "session" 元数据行,version 0)');
  const events = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`第 ${i + 1} 行无法解析为 JSON: ${errorMessage(error)}`);
    }
    for (const event of expandRecord(record)) events.push(event);
  }
  return { header, events, extras };
}

function capList(list, max = 12) {
  if (list.length <= max) return list;
  const head = list.slice(0, max);
  head.push(`…共 ${list.length} 条`);
  return head;
}

/** 按 UTF-8 字节数截断(不切断多字节字符),用于自定义标题。 */
function truncateTitleUtf8(text, maxBytes) {
  let bytes = 0;
  let out = '';
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += ch;
  }
  return out.trimEnd();
}

/**
 * 结构真实性验证。errors 非空 → 拒绝导入;warnings 仅提示。
 */
function verifyLog(header, events) {
  const errors = [];
  const warnings = [];
  let seqBroken = false;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (!isRecord(event) || typeof event.type !== 'string' || event.type === '') {
      errors.push(`seq ${i} 不是合法事件对象`);
      seqBroken = true;
      continue;
    }
    if (!Number.isSafeInteger(event.seq) || event.seq !== i) {
      errors.push(`事件 seq 不连续(期望 ${i},实际 ${event.seq === undefined ? '缺失' : event.seq})`);
      seqBroken = true;
    }
    if (errors.length >= 20) break;
  }
  if (!seqBroken) {
    let last = Number.isSafeInteger(header.createdAt) ? header.createdAt : 0;
    let regressions = 0;
    for (const event of events) {
      const t = event.time;
      if (!Number.isSafeInteger(t)) {
        errors.push(`seq ${event.seq} 的 time 非法`);
        continue;
      }
      // assistant/chunk 是多块流式交错输出(推理/正文/工具调用块并行),块间
      // 时间天然交错,不参与全局单调性检查;其余事件按 append 顺序应单调不减。
      if (event.type === 'assistant/chunk') continue;
      if (t < last) regressions += 1;
      else last = t;
    }
    if (regressions > 0) warnings.push(`${regressions} 处时间戳回退(append-only 日志应单调不减,可能被编辑过)`);
    for (const event of events) {
      if (KNOWN_TYPES.has(event.type)) continue;
      if (event.ignorable === true) warnings.push(`seq ${event.seq} 事件类型 "${event.type}" 未知(已标记 ignorable)`);
      else errors.push(`seq ${event.seq} 事件类型 "${event.type}" 本版本无法解读(导入后该会话将无法打开)`);
      if (errors.length >= 20) break;
    }
    // 顶层 surface 元数据的 seq 引用必须指向更早的事件(冷读校验的硬性要求)
    for (const event of events) {
      const sources = event.sourceEventSeqs;
      if (Array.isArray(sources)) {
        for (const ref of sources) {
          if (Number.isSafeInteger(ref) && Number.isSafeInteger(event.seq) && ref >= event.seq) {
            errors.push(`seq ${event.seq} 的顶层 sourceEventSeqs 引用了自身/后续事件(${ref})`);
          }
        }
      }
      const op = event.surfaceOp;
      if (isRecord(op)) {
        for (const key of ['start', 'end']) {
          if (Number.isSafeInteger(op[key]) && Number.isSafeInteger(event.seq) && op[key] >= event.seq) {
            errors.push(`seq ${event.seq} 的顶层 surfaceOp.${key} 引用了自身/后续事件(${op[key]})`);
          }
        }
      }
      if (errors.length >= 20) break;
    }
  }
  // 配对与引用检查(seq 错误时仅作参考)
  const turnStack = [];
  const stepStack = [];
  const openCalls = new Map();
  const openCommands = new Map();
  const assistantIds = new Set();
  let lastTurn = 0;
  let dupAssistant = 0;
  let stepMismatch = 0;
  for (const event of events) {
    try {
      const data = isRecord(event.data) ? event.data : {};
      switch (event.type) {
        case 'turn/start': {
          if (typeof data.turn !== 'number' || data.turn <= lastTurn) warnings.push(`seq ${event.seq} 的 turn 编号异常(${data.turn})`);
          lastTurn = data.turn;
          turnStack.push({ seq: event.seq, turn: data.turn });
          break;
        }
        case 'turn/end': {
          const open = turnStack.pop();
          if (open === undefined) warnings.push(`seq ${event.seq} 出现多余的 turn/end`);
          else if (typeof data.turn === 'number' && data.turn !== open.turn) warnings.push(`seq ${event.seq} 的 turn/end 与打开的 turn ${open.turn}(seq ${open.seq})不匹配`);
          break;
        }
        case 'step/start':
          stepStack.push({ seq: event.seq, turn: data.turn, step: data.step });
          break;
        case 'step/end': {
          const open = stepStack.pop();
          if (open === undefined) warnings.push(`seq ${event.seq} 出现多余的 step/end`);
          else if (data.turn !== open.turn || data.step !== open.step) {
            stepMismatch += 1;
            if (stepMismatch <= 5) warnings.push(`seq ${event.seq} 的 step/end 与打开的 step ${open.turn}/${open.step}(seq ${open.seq})不匹配`);
          }
          break;
        }
        case 'tool/call':
          if (typeof data.callId === 'string' && data.callId !== '') openCalls.set(data.callId, event.seq);
          break;
        case 'tool/result': {
          const source = isRecord(data.message) ? data.message.source : undefined;
          const callId = isRecord(source) && source.kind === 'tool' ? source.callId : undefined;
          if (typeof callId === 'string' && callId !== '') {
            if (openCalls.has(callId)) openCalls.delete(callId);
            else warnings.push(`seq ${event.seq} 的 tool/result 找不到对应 tool/call(${callId})`);
          }
          break;
        }
        case 'command/run':
          if (typeof data.commandId === 'string') openCommands.set(data.commandId, event.seq);
          break;
        case 'command/done': {
          const commandId = typeof data.commandId === 'string' ? data.commandId : undefined;
          if (commandId !== undefined) {
            if (openCommands.has(commandId)) openCommands.delete(commandId);
            else warnings.push(`seq ${event.seq} 的 command/done 找不到对应 command/run(${commandId})`);
          }
          break;
        }
        case 'assistant/message': {
          const message = isRecord(data.message) ? data.message : {};
          if (typeof message.id === 'string') {
            if (assistantIds.has(message.id)) dupAssistant += 1;
            else assistantIds.add(message.id);
          }
          break;
        }
        default:
          break;
      }
    } catch {
      // 单个事件的配对检查不应让验证器崩溃
    }
  }
  if (turnStack.length > 0) warnings.push(`${turnStack.length} 个 turn 未闭合(最后打开于 seq ${turnStack[turnStack.length - 1].seq};日志可能在会话进行中导出)`);
  if (stepStack.length > 0) warnings.push(`${stepStack.length} 个 step 未闭合(最后打开于 seq ${stepStack[stepStack.length - 1].seq})`);
  if (openCalls.size > 0) warnings.push(`${openCalls.size} 个 tool/call 没有对应 tool/result(可能被截断)`);
  if (openCommands.size > 0) warnings.push(`${openCommands.size} 个 command 没有 command/done`);
  if (dupAssistant > 0) warnings.push(`${dupAssistant} 个 assistant 消息 id 重复(可能是消息替换/重放痕迹)`);
  const verdict = errors.length > 0 ? 'error' : warnings.length > 0 ? 'warn' : 'ok';
  return { errors: capList(errors), warnings: capList(warnings), verdict };
}

function extractPreview(header, events, extras, sha256, byteLength) {
  const counts = { user: 0, assistant: 0, toolCall: 0, toolResult: 0, turn: 0, step: 0 };
  let model = null;
  let agentPreset = null;
  let permission = null;
  let sandbox = null;
  let approval = null;
  let plan = null;
  let title = null;
  let lastTime = Number.isSafeInteger(header.createdAt) ? header.createdAt : 0;
  for (const event of events) {
    if (Number.isSafeInteger(event.time)) lastTime = event.time;
    const data = isRecord(event.data) ? event.data : {};
    switch (event.type) {
      case 'user/message': counts.user += 1; break;
      case 'assistant/message': counts.assistant += 1; break;
      case 'tool/call': counts.toolCall += 1; break;
      case 'tool/result': counts.toolResult += 1; break;
      case 'turn/start': counts.turn += 1; break;
      case 'step/start': counts.step += 1; break;
      case 'request/header': {
        const config = isRecord(data.header) && isRecord(data.header.config) ? data.header.config : {};
        model = {
          provider: typeof config.provider === 'string' ? config.provider : null,
          model: typeof config.model === 'string' ? config.model : null,
          reasoningEffort: typeof config.reasoningEffort === 'string' ? config.reasoningEffort : null,
          maxTokens: Number.isSafeInteger(config.maxTokens) ? config.maxTokens : null,
        };
        break;
      }
      case 'agent-preset/selected': if (typeof data.agentPreset === 'string') agentPreset = data.agentPreset; break;
      case 'permission/preset': if (typeof data.preset === 'string') permission = data.preset; break;
      case 'sandbox/mode': if (typeof data.mode === 'string') sandbox = data.mode; break;
      case 'approval/policy': if (typeof data.policy === 'string') approval = data.policy; break;
      case 'plan/mode': if (isRecord(data) && typeof data.active === 'boolean') plan = data.active; break;
      case 'session/title': if (typeof data.title === 'string' && data.title !== '') title = data.title; break;
      default: break;
    }
  }
  return {
    title,
    counts,
    eventCount: events.length,
    byteLength,
    lastTime,
    sync: { model, agentPreset, permission, sandbox, approval, plan },
    provenance: {
      originalId: header.id,
      createdAt: header.createdAt,
      cwd: typeof header.cwd === 'string' ? header.cwd : null,
      delegationDepth: header.delegationDepth ?? 0,
      headerAgentPreset: typeof header.agentPreset === 'string' ? header.agentPreset : null,
    },
    extras,
  };
}

/**
 * 重写事件顶层与 data 中的 seq 引用,使其在过滤重排后仍然正确。
 * DSH 的 surface 元数据(sourceEventSeqs、surfaceOp)位于事件 envelope 的顶层,
 * 而非 data 内部——两层都必须重写;引用到被删除事件的条目会被丢弃。
 */
function rewriteReferences(event, remapRef) {
  // —— 顶层 surface 元数据 ——
  const sources = event.sourceEventSeqs;
  if (Array.isArray(sources)) {
    const mapped = [];
    for (const ref of sources) {
      if (Number.isSafeInteger(ref)) {
        const next = remapRef(ref);
        if (next >= 0) mapped.push(next);
      } else {
        mapped.push(ref);
      }
    }
    event.sourceEventSeqs = mapped;
  }
  const op = event.surfaceOp;
  if (isRecord(op)) {
    let broken = false;
    const nextOp = { ...op };
    if (Number.isSafeInteger(op.start)) {
      const next = remapRef(op.start);
      if (next < 0) broken = true;
      else nextOp.start = next;
    }
    if (Number.isSafeInteger(op.end)) {
      const next = remapRef(op.end);
      if (next < 0) broken = true;
      else nextOp.end = next;
    }
    if (broken) delete event.surfaceOp;
    else event.surfaceOp = nextOp;
  }
  // —— data 层引用 ——
  const data = event.data;
  if (!isRecord(data)) return;
  for (const key of ['messageSeqs', 'sourceEventSeqs']) {
    const list = data[key];
    if (Array.isArray(list)) {
      const mapped = [];
      for (const ref of list) {
        if (Number.isSafeInteger(ref)) {
          const next = remapRef(ref);
          if (next >= 0) mapped.push(next);
        } else {
          mapped.push(ref);
        }
      }
      data[key] = mapped;
    }
  }
  if (event.type === 'agent/inbox/spliced' && Number.isSafeInteger(data.start)) {
    data.start = Math.max(0, remapRef(data.start));
  }
  const dataOp = data.surfaceOp;
  if (isRecord(dataOp)) {
    let broken = false;
    const nextOp = { ...dataOp };
    if (Number.isSafeInteger(dataOp.start)) {
      const next = remapRef(dataOp.start);
      if (next < 0) broken = true;
      else nextOp.start = next;
    }
    if (Number.isSafeInteger(dataOp.end)) {
      const next = remapRef(dataOp.end);
      if (next < 0) broken = true;
      else nextOp.end = next;
    }
    if (broken) delete data.surfaceOp;
    else data.surfaceOp = nextOp;
  }
}

/**
 * 回滚一次已落盘的导入:解除工作区记账 + 移除持久化产物。
 * 尽力而为(任何一步失败都只记录日志),供挂载失败/装载校验失败时使用。
 */
async function rollbackImported(ctx, id, cwd) {
  try {
    const workspaceRegistry = ctx.get('workspaceRegistry');
    if (workspaceRegistry !== undefined) {
      const workspace = await workspaceRegistry.resolveByPath(cwd);
      if (workspace !== undefined) await workspace.detachSession(id);
    }
  } catch (error) {
    ctx.logger?.warn?.(`session-import: rollback detach failed: ${errorMessage(error)}`);
  }
  try {
    const sessionPersistence = ctx.get('sessionPersistence');
    if (sessionPersistence !== undefined) {
      const headers = await sessionPersistence.list();
      const meta = headers.find((header) => header.id === id);
      const location = meta === undefined ? undefined : sessionPersistence.locate?.(meta);
      if (location !== undefined && typeof location.path === 'string' && location.path !== ''
        && /(^|[/\\])session\.jsonl(\.zstd)?$/.test(location.path)) {
        await rm(dirname(location.path), { recursive: true, force: true });
      }
    }
  } catch (error) {
    ctx.logger?.warn?.(`session-import: rollback artifact removal failed: ${errorMessage(error)}`);
  }
}

/**
 * 执行导入。options 通过查询参数传入:
 *   workspace: 目标工作区绝对路径 | 'original'(沿用日志原始 cwd,须在本机存在)
 *   restamp: '1'|'0'  时间戳平移到当前(默认 1)
 *   sync: 逗号分隔的同步组(model,preset,permission,sandbox,approval,plan;默认全部)
 *   title: 自定义标题(可选,追加一条 session/title 事件)
 *   expectedHash: 期望 SHA-256(可选,强校验)
 *   dryRun: '1' 时只做全部校验与计算,不落盘。
 */
async function applyImport(ctx, body, fileName, query) {
  const sessionPersistence = ctx.get('sessionPersistence');
  if (sessionPersistence === undefined) throw httpError(503, 'sessionPersistence 服务不可用', 'persistence');
  const workspaceRegistry = ctx.get('workspaceRegistry');
  if (workspaceRegistry === undefined) throw httpError(503, 'workspaceRegistry 服务不可用', 'workspace');

  const { header, events, extras } = parseUpload(body, fileName);
  const sha256 = createHash('sha256').update(body).digest('hex');

  const expected = typeof query.expectedHash === 'string' ? query.expectedHash.trim().toLowerCase() : '';
  if (expected !== '' && expected !== sha256) {
    throw httpError(409, 'SHA-256 与预期值不一致:该文件与导出方公布的指纹不符,可能被篡改', 'hash-mismatch');
  }

  const verification = verifyLog(header, events);
  if (verification.errors.length > 0) {
    throw httpError(422, `日志结构校验失败: ${verification.errors.join('; ')}`, 'structure');
  }

  const restamp = query.restamp !== '0';
  const syncParam = typeof query.sync === 'string' ? query.sync : Object.keys(SYNC_GROUPS).join(',');
  const enabled = new Set(syncParam.split(',').map((s) => s.trim()).filter((s) => s !== ''));
  for (const group of enabled) {
    if (!Object.hasOwn(SYNC_GROUPS, group)) {
      throw httpError(400, `未知的同步组 "${group}"(可用: ${Object.keys(SYNC_GROUPS).join(', ')})`, 'bad-request');
    }
  }
  const dropTypes = new Set(
    Object.entries(SYNC_GROUPS)
      .filter(([group]) => !enabled.has(group))
      .map(([, type]) => type),
  );

  const workspaceParam = typeof query.workspace === 'string' ? query.workspace.trim() : '';
  let targetCwd;
  if (workspaceParam === '' || workspaceParam === 'original') {
    if (typeof header.cwd !== 'string' || header.cwd === '') {
      throw httpError(400, '日志没有原始工作目录,请选择一个目标工作区', 'workspace');
    }
    try {
      targetCwd = await realpath(header.cwd);
    } catch {
      throw httpError(400, `日志原始工作目录在本机不存在(${header.cwd}),请选择其他工作区`, 'workspace');
    }
  } else {
    try {
      targetCwd = await realpath(workspaceParam);
    } catch {
      throw httpError(400, `目标工作区路径不存在或不可读: ${workspaceParam}`, 'workspace');
    }
  }
  const targetInfo = await stat(targetCwd);
  if (!targetInfo.isDirectory()) throw httpError(400, `目标工作区不是目录: ${targetCwd}`, 'workspace');

  const lastEventTime = events.reduce(
    (max, event) => (Number.isSafeInteger(event.time) && event.time > max ? event.time : max),
    Number.isSafeInteger(header.createdAt) ? header.createdAt : 0,
  );
  const shift = restamp ? Date.now() - lastEventTime : 0;

  const removedSeqs = [];
  const kept = [];
  for (const event of events) {
    if (dropTypes.has(event.type)) {
      removedSeqs.push(event.seq);
      continue;
    }
    kept.push(event);
  }
  const removedSet = new Set(removedSeqs);
  const removedBefore = (seq) => {
    let count = 0;
    for (const removed of removedSeqs) if (removed < seq) count += 1;
    return count;
  };
  /** 旧 seq → 新 seq;引用目标本身被删除时返回 -1(调用方丢弃该引用)。 */
  const remapRef = (seq) => (removedSet.has(seq) ? -1 : seq - removedBefore(seq));

  for (let i = 0; i < kept.length; i += 1) {
    const event = kept[i];
    event.seq = i;
    if (shift !== 0 && Number.isSafeInteger(event.time)) event.time += shift;
    rewriteReferences(event, remapRef);
  }

  const customTitle = truncateTitleUtf8(typeof query.title === 'string' ? query.title.trim() : '', MAX_TITLE_BYTES);
  if (customTitle !== '') {
    const tailTime = kept.length > 0 ? kept[kept.length - 1].time : header.createdAt + shift;
    kept.push({
      type: 'session/title',
      seq: kept.length,
      time: tailTime + 1,
      data: { title: customTitle.slice(0, 200), messageSeqs: [], source: { kind: 'user' } },
    });
  }
  if (kept.length === 0) throw httpError(422, '过滤后没有任何事件可导入', 'structure');

  const newHeader = {
    version: 0,
    id: `session-${randomUUID()}`,
    createdAt: shift !== 0 && Number.isSafeInteger(header.createdAt) ? header.createdAt + shift : header.createdAt,
    cwd: targetCwd,
    delegationDepth: Number.isSafeInteger(header.delegationDepth) ? header.delegationDepth : 0,
    ...(typeof header.agentPreset === 'string' ? { agentPreset: header.agentPreset } : {}),
    ...(header.origin === 'subagent' ? { origin: 'subagent' } : {}),
    ...(typeof header.parentSession === 'string' ? { parentSession: header.parentSession } : {}),
  };

  const summary = {
    sessionId: null,
    header: {
      id: newHeader.id,
      cwd: newHeader.cwd,
      agentPreset: newHeader.agentPreset ?? null,
      createdAt: newHeader.createdAt,
    },
    eventCount: kept.length,
    droppedSyncEvents: removedSeqs.length,
    sha256,
    restamped: shift !== 0,
    extras,
    verification: { errors: verification.errors, warnings: verification.warnings, verdict: verification.verdict },
  };

  if (query.dryRun === '1') {
    summary.dryRun = true;
    return summary;
  }

  await sessionPersistence.create(newHeader);
  await sessionPersistence.append(newHeader.id, kept);

  // 工作区挂载失败时回滚(避免留下孤立会话产物)
  try {
    let workspace = await workspaceRegistry.resolveByPath(targetCwd);
    if (workspace === undefined) workspace = await workspaceRegistry.create(targetCwd);
    await workspace.attachSession(newHeader.id);
  } catch (error) {
    await rollbackImported(ctx, newHeader.id, targetCwd);
    throw httpError(500, `挂载工作区失败,已回滚: ${errorMessage(error)}`, 'workspace-attach');
  }

  // 预热投影缓存,让会话列表立即显示标题/模型等元数据(失败不影响导入结果)
  try {
    const projectionCache = ctx.get('sessionProjectionCache');
    if (projectionCache !== undefined) await projectionCache.coldSnapshot(newHeader.id);
  } catch (error) {
    ctx.logger?.warn?.(`session-import: projection warm-up failed: ${errorMessage(error)}`);
  }

  // 装载校验:用持久化层的真实读取路径完整回放并校验一遍(runtime 级校验,
  // 含恢复修复),保证导入的会话一定可打开;失败则回滚。
  try {
    await sessionPersistence.load(newHeader.id);
  } catch (error) {
    await rollbackImported(ctx, newHeader.id, targetCwd);
    throw httpError(422, `导入后装载校验失败,已回滚: ${errorMessage(error)}`, 'structure');
  }

  // open=1:恢复为活跃会话。store 的 session/created 事件会被 api 网关转成
  // host/session-added 帧推给所有已连接页面——侧栏无需刷新即可看到新会话,
  // 且会话立即可用(后续 prompt 无需再恢复)。失败降级为冷会话,不影响导入。
  summary.resumed = false;
  if (query.open === '1') {
    const agentLoop = ctx.get('agentLoop');
    if (agentLoop !== undefined) {
      try {
        const handle = await agentLoop.resume(ctx, { resumeSessionId: newHeader.id });
        if (handle !== undefined && typeof handle.dispose === 'function') {
          importedHandles.set(newHeader.id, handle.dispose);
          summary.resumed = true;
        }
      } catch (error) {
        ctx.logger?.warn?.(`session-import: resume after import failed (session stays cold): ${errorMessage(error)}`);
      }
    }
  }

  summary.sessionId = newHeader.id;
  summary.dryRun = false;
  return summary;
}

/**
 * 删除本插件导入的会话产物:移除持久化 artifact 并解除工作区记账。
 * 本插件恢复为活跃态的会话先通过持有的句柄优雅释放(向页面推送
 * session-removed,侧栏实时消失);其他来源的活跃会话拒绝删除。
 */
async function deleteImportedSession(ctx, query) {
  const sessionPersistence = ctx.get('sessionPersistence');
  if (sessionPersistence === undefined) throw httpError(503, 'sessionPersistence 服务不可用', 'persistence');
  const id = typeof query.sessionId === 'string' ? query.sessionId.trim() : '';
  if (id === '') throw httpError(400, '缺少 sessionId 参数', 'bad-request');
  const sessions = ctx.get('sessions');
  if (sessions !== undefined && sessions.get(id) !== undefined) {
    const ownDispose = importedHandles.get(id);
    if (ownDispose === undefined) {
      throw httpError(409, '该会话当前正在内存中运行且不是本插件导入的会话,无法删除;请先在界面中离开该会话再重试', 'live');
    }
    try {
      await ownDispose();
    } catch (error) {
      throw httpError(500, `释放活跃会话失败: ${errorMessage(error)}`, 'internal');
    }
    importedHandles.delete(id);
  }
  let meta;
  try {
    const headers = await sessionPersistence.list();
    meta = headers.find((header) => header.id === id);
  } catch (error) {
    throw httpError(500, `读取会话清单失败: ${errorMessage(error)}`);
  }
  if (meta === undefined) throw httpError(404, `会话 "${id}" 不存在`, 'not-found');
  const location = sessionPersistence.locate?.(meta);
  if (location === undefined || typeof location.path !== 'string' || location.path === '') {
    throw httpError(500, `无法定位会话 "${id}" 的存储位置`, 'internal');
  }
  const target = location.path;
  if (!/(^|[/\\])session\.jsonl(\.zstd)?$/.test(target)) {
    throw httpError(500, `拒绝删除非会话产物路径: ${target}`, 'internal');
  }
  await rm(dirname(target), { recursive: true, force: true });
  try {
    const workspaceRegistry = ctx.get('workspaceRegistry');
    if (workspaceRegistry !== undefined && typeof meta.cwd === 'string') {
      const workspace = await workspaceRegistry.resolveByPath(meta.cwd);
      if (workspace !== undefined) await workspace.detachSession(id);
    }
  } catch (error) {
    ctx.logger?.warn?.(`session-import: detach after delete failed: ${errorMessage(error)}`);
  }
  return { deleted: true, sessionId: id, removedPath: target };
}

async function handleRequest(ctx, req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const query = Object.fromEntries(url.searchParams.entries());
  try {
    if (req.method === 'GET' && pathname === '/session-import/status') {
      sendJson(res, 200, {
        ok: true,
        plugin: 'session-import',
        version,
        persistence: ctx.get('sessionPersistence') !== undefined,
        workspaces: ctx.get('workspaceRegistry') !== undefined,
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/session-import/delete') {
      const result = await deleteImportedSession(ctx, query);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }
    if (req.method !== 'POST' || (pathname !== '/session-import/analyze' && pathname !== '/session-import/import')) {
      sendJson(res, 404, { ok: false, error: { code: 'not-found', message: 'not found' } });
      return;
    }
    const body = await readBody(req, MAX_BODY_BYTES);
    const fileName = query.name ?? 'session.log';
    if (pathname === '/session-import/analyze') {
      const { header, events, extras } = parseUpload(body, fileName);
      const sha256 = createHash('sha256').update(body).digest('hex');
      const verification = verifyLog(header, events);
      const preview = extractPreview(header, events, extras, sha256, body.length);
      sendJson(res, 200, {
        ok: true,
        preview,
        verification: {
          sha256,
          errors: verification.errors,
          warnings: verification.warnings,
          verdict: verification.verdict,
        },
      });
      return;
    }
    const summary = await applyImport(ctx, body, fileName, query);
    sendJson(res, 200, { ok: true, ...summary });
  } catch (error) {
    const status = typeof error?.statusCode === 'number' ? error.statusCode : 500;
    const code = typeof error?.code === 'string' ? error.code : 'internal';
    sendJson(res, status, { ok: false, error: { code, message: errorMessage(error) } });
  }
}

export function apply(ctx) {
  const webServer = ctx.webServer;
  ctx.effect(() => {
    const disposer = webServer.register({
      kind: 'prefix',
      path: '/session-import',
      handler: (req, res) => handleRequest(ctx, req, res),
    });
    return () => disposer();
  }, 'session-import: /session-import routes');
  // 插件停止时释放所有由本插件恢复的导入会话(重新变为冷会话)
  ctx.effect(() => () => {
    for (const dispose of importedHandles.values()) {
      Promise.resolve(dispose()).catch(() => {});
    }
    importedHandles.clear();
  }, 'session-import: dispose resumed imports');
  // 会话被其他路径释放时,同步清理跟踪表
  ctx.on('session/disposed', (session) => {
    importedHandles.delete(session.id);
  });
}
