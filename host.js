import { SessionImporter } from './importer.js';
import { MAX_UPLOAD_BYTES } from './archive.js';
import { errorOf, parseUpload, previewOf, SESSION_FORMAT_VERSION } from './session-format.js';

export const name = 'session-import';
export const inject = ['connection', 'sessionPersistence', 'workspaceRegistry'];
export const version = '2.0.0';

function json(status, data) {
  return new Response(JSON.stringify(data), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  } });
}

async function readBody(request) {
  const chunks = [];
  let length = 0;
  if (request.body) {
    for await (const chunk of request.body) {
      length += chunk.length;
      if (length > MAX_UPLOAD_BYTES) throw errorOf(413, '上传超过 256 MB', 'too-large');
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks);
}

/** Use the official Connection boundary for browser authentication and request trust. */
export function apply(ctx) {
  const importer = new SessionImporter(ctx);
  let active = 0;
  const handler = async request => {
    const url = new URL(request.url);
    const query = Object.fromEntries(url.searchParams);
    let admitted = false;
    try {
      if (url.pathname === '/api/session-import/status') {
        let reason = null;
        try { importer.services(); } catch (error) { reason = error.message; }
        return json(200, { ok: true, plugin: name, version, formatVersion: SESSION_FORMAT_VERSION,
          compatible: reason === null, reason, persistence: !!ctx.get('sessionPersistence'), workspaces: !!ctx.get('workspaceRegistry') });
      }
      if (active >= 2) throw errorOf(503, '已有导入请求正在处理，请稍后重试', 'busy');
      active += 1;
      admitted = true;
      if (Number(request.headers.get('content-length')) > MAX_UPLOAD_BYTES) throw errorOf(413, '上传超过 256 MB', 'too-large');
      if (url.pathname === '/api/session-import/delete') {
        return json(200, { ok: true, ...await importer.undo(query) });
      }
      const bytes = await readBody(request);
      if (url.pathname === '/api/session-import/analyze') {
        const parsed = parseUpload(bytes, query.name ?? 'session.jsonl');
        return json(200, { ok: true, preview: previewOf(parsed), verification: {
          sha256: parsed.sha256, errors: [], warnings: parsed.warnings.map(message => ({ message })),
          verdict: parsed.warnings.length ? 'warning' : 'ok',
        } });
      }
      return json(200, { ok: true, ...await importer.import(bytes, query.name ?? 'session.jsonl', query) });
    } catch (error) {
      return json(error.statusCode ?? 500, { ok: false, error: { code: error.code ?? 'internal', message: error.message } });
    } finally { if (admitted) active -= 1; }
  };
  for (const action of ['status', 'analyze', 'import', 'delete']) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `/api/session-import/${action}`, methods: [action === 'status' ? 'GET' : 'POST'],
      requestBody: action === 'status' ? 'buffered' : 'streaming', fetch: handler,
    }), `session-import: ${action} route`);
  }
  ctx.effect(() => () => importer.dispose(), 'session-import: dispose owned agents');
  ctx.on('session/disposed', session => { importer.live.delete(session.id); });
}
