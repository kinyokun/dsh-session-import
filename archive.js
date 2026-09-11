import { crc32, inflateRawSync } from 'node:zlib';

export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 4096;

/** Read bounded, CRC-checked ZIP entries without extracting archive paths to disk. */
export function readZipArchive(bytes) {
  const files = new Map();
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p -= 1) {
    if (bytes.readUInt32LE(p) === 0x06054b50 && p + 22 + bytes.readUInt16LE(p + 20) === bytes.length) {
      end = p;
      break;
    }
  }
  if (end < 0) throw new Error('ZIP 目录缺失或文件不完整');
  const count = bytes.readUInt16LE(end + 10);
  const size = bytes.readUInt32LE(end + 12);
  let p = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt32LE(end + 4) !== 0 || bytes.readUInt16LE(end + 8) !== count) throw new Error('不支持分卷 ZIP');
  if (count === 65535 || p === 0xffffffff || size === 0xffffffff) throw new Error('不支持 ZIP64');
  if (count > MAX_ENTRIES || p + size !== end) throw new Error('ZIP 目录越界或条目过多');
  const directory = p;
  let expanded = 0;
  const names = new Set();
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > end || bytes.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const flags = bytes.readUInt16LE(p + 8);
    const method = bytes.readUInt16LE(p + 10);
    const checksum = bytes.readUInt32LE(p + 16);
    const compressed = bytes.readUInt32LE(p + 20);
    const length = bytes.readUInt32LE(p + 24);
    const nameLength = bytes.readUInt16LE(p + 28);
    const next = p + 46 + nameLength + bytes.readUInt16LE(p + 30) + bytes.readUInt16LE(p + 32);
    const offset = bytes.readUInt32LE(p + 42);
    if (next > end || offset + 30 > directory || bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error('ZIP 条目越界');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(p + 46, p + 46 + nameLength));
    if (!name || /^[\\/]/u.test(name) || /^[a-z]:/iu.test(name) || /[\\\x00-\x1f\x7f]/u.test(name)
      || name.split('/').some(part => part === '..' || part === '.') || name.includes('//')) throw new Error('ZIP 包含不安全路径');
    if (names.has(name)) throw new Error(`ZIP 包含重复条目: ${name}`);
    names.add(name);
    if ((bytes.readUInt32LE(p + 38) >>> 16 & 0xf000) === 0xa000) throw new Error('ZIP 不允许符号链接');
    if ((flags & 1) !== 0 || ![0, 8].includes(method)) throw new Error('ZIP 已加密或使用不支持的压缩算法');
    const localLength = bytes.readUInt16LE(offset + 26);
    const dataStart = offset + 30 + localLength + bytes.readUInt16LE(offset + 28);
    if (dataStart + compressed > directory || bytes.readUInt16LE(offset + 8) !== method
      || bytes.readUInt16LE(offset + 6) !== flags
      || !bytes.subarray(offset + 30, offset + 30 + localLength).equals(bytes.subarray(p + 46, p + 46 + nameLength))) {
      throw new Error('ZIP 本地头与目录不一致');
    }
    expanded += length;
    if (expanded > MAX_EXPANDED_BYTES) throw new Error('ZIP 解压总量超过 512 MB');
    const raw = bytes.subarray(dataStart, dataStart + compressed);
    const data = method === 8 ? inflateRawSync(raw, { maxOutputLength: Math.max(1, length) }) : raw;
    if (data.length !== length || crc32(data) !== checksum) throw new Error(`ZIP 校验失败: ${name}`);
    if (!name.endsWith('/')) files.set(name, data);
    p = next;
  }
  if (p !== end) throw new Error('ZIP 目录长度不一致');
  return files;
}
