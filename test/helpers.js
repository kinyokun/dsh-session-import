import { crc32, deflateRawSync, deflateSync } from 'node:zlib';

export function pngFixture() {
  const chunk = (kind, data) => {
    const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length); out.write(kind, 4); data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 32, 64, 128, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

/** Synthetic released-format log, with a system prompt and complete assistant stream. */
export function fixture(version = 0, options = {}) {
  const header = { type: 'session', version, id: 'example-root', createdAt: 1000, cwd: '/private/tmp', delegationDepth: 0,
    ...(version >= 2 ? { isSeeded: false } : {}), ...options };
  const user = { id: 'example-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello from the source' }] };
  const assistant = { id: 'example-assistant', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' }, content: [{ type: 'text', text: 'hello from the assistant' }] };
  const rows = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    ...(version === 3 ? [{ type: 'system/message', data: { turn: 1, step: 1, message: { id: 'system-example', role: 'system', content: [{ type: 'text', text: 'Be helpful.' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } } }, surfaceOp: 'append' }] : []),
    { type: 'request/header', data: { header: { config: { provider: 'mock', model: 'mock' }, ...(version < 3 ? { system: 'Be helpful.' } : {}) }, reason: 'initial' } },
    { type: 'user/message', data: user, surfaceOp: 'append' },
  ];
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'hello from the assistant' },
    { type: 'block-end', index: 0, block: assistant.content[0] },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  if (version < 2) {
    const start = rows.length;
    rows.push(...chunks.map(chunk => ({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk } })));
    rows.push({ type: 'assistant/message', data: { turn: 1, step: 1, message: assistant }, surfaceOp: 'append', sourceEventSeqs: chunks.map((_, i) => start + i) });
  } else {
    rows.push({ type: 'assistant/message', data: { turn: 1, step: 1, message: assistant,
      stream: chunks.map((chunk, i) => ({ type: 'chunk', time: 1000 + rows.length + i, chunk })) }, surfaceOp: 'append' });
  }
  rows.push({ type: 'step/end', data: { turn: 1, step: 1 } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session/title', data: { title: '导入测试', messageSeqs: [], source: { kind: 'user' } } });
  return Buffer.from([header, ...rows.map((row, seq) => ({ ...row, seq, time: 1001 + seq }))].map(JSON.stringify).join('\n') + '\n');
}

/** Tiny test ZIP writer; duplicate entries remain expressible for rejection tests. */
export function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [path, input] of entries) {
    const name = Buffer.from(path), data = Buffer.from(input), packed = deflateRawSync(data), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(offset, 42);
    locals.push(local, name, packed); central.push(record, name); offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
