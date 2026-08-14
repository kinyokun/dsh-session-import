/**
 * session-import 浏览器端插件(经 /plugins/session-import/client.js 下发)。
 *
 * 1) 在新对话界面(hero)的模式选择(Agent 预设芯片)右侧注入"导入对话"按钮;
 * 2) 点击打开导入对话框:选择 .zip/.jsonl → 宿主解析 + 真实性验证
 *    (结构一致性 + SHA-256 指纹,可选预期指纹强校验) → 勾选要同步的状态
 *    (模型/思考深度、Agent 预设、权限预设、沙箱模式、审批策略、计划模式)
 *    → 选择目标工作区、置顶时间戳、自定义标题 → 导入并打开会话。
 */
window.__ModuleLoader__.load({
  id: 'session-import',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;

    const CSS = `
.dsh-session-import-hero-btn {
  display: inline-flex; align-items: center; gap: 5px;
  margin-left: 2px; border-radius: 12px; padding: 4px 10px;
  font-size: 13px; line-height: 18px; font-family: inherit;
  color: var(--dsw-alias-label-secondary, #5f6673);
  background: transparent; border: 1px solid transparent; cursor: pointer;
  white-space: nowrap;
}
.dsh-session-import-hero-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.06));
  color: var(--dsw-alias-label-primary, #1f2329);
}
.dsh-session-import-hero-btn svg { flex: none; }

.dsh-session-import-overlay {
  position: fixed; inset: 0; z-index: 10000;
  display: flex; align-items: center; justify-content: center;
  font-family: inherit;
}
.dsh-session-import-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.42); }
.dsh-session-import-panel {
  position: relative; box-sizing: border-box;
  width: min(700px, calc(100vw - 40px));
  max-height: min(86vh, 940px); overflow-y: auto;
  background: var(--dsw-alias-bg-base, #ffffff);
  border: 1px solid var(--dsw-alias-border-l2, #e6e8ec);
  border-radius: 16px; padding: 20px 22px;
  box-shadow: 0 24px 72px rgba(0,0,0,.28);
  color: var(--dsw-alias-label-primary, #1f2329);
}
.dsh-session-import-title {
  margin: 0 0 4px; font-size: 16px; font-weight: 600; line-height: 24px;
}
.dsh-session-import-subtitle { margin: 0 0 14px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a919e); }
.dsh-session-import-section {
  margin: 14px 0 0; padding-top: 12px; border-top: 1px solid var(--dsw-alias-border-l2, #eef0f3);
}
.dsh-session-import-section-title { margin: 0 0 8px; font-size: 13px; font-weight: 600; line-height: 18px; }
.dsh-session-import-rows { display: flex; flex-direction: column; gap: 6px; }
.dsh-session-import-row {
  display: flex; align-items: center; gap: 8px;
  font-size: 12.5px; line-height: 18px; color: var(--dsw-alias-label-secondary, #4b5260);
}
.dsh-session-import-row strong { color: var(--dsw-alias-label-primary, #1f2329); font-weight: 550; }
.dsh-session-import-row .mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px; background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05));
  border-radius: 6px; padding: 1px 6px;
}
.dsh-session-import-check { display: flex; align-items: center; gap: 7px; cursor: pointer; user-select: none; }
.dsh-session-import-check input { accent-color: var(--dsw-alias-state-business-primary, #3f6ff0); margin: 0; }
.dsh-session-import-check.disabled { opacity: .5; cursor: default; }

.dsh-session-import-badge { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 600; line-height: 18px; }
.dsh-session-import-badge.ok { color: #0e7a4d; background: rgba(22,163,74,.12); }
.dsh-session-import-badge.warn { color: #a05c00; background: rgba(240,171,31,.16); }
.dsh-session-import-badge.error { color: #b02a2a; background: rgba(225,60,60,.14); }

.dsh-session-import-anomaly { margin: 4px 0 0; padding-left: 14px; font-size: 12px; line-height: 17px; position: relative; }
.dsh-session-import-anomaly::before { content: ''; position: absolute; left: 2px; top: 6px; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.dsh-session-import-anomaly.err { color: #b02a2a; }
.dsh-session-import-anomaly.warn { color: #a05c00; }

.dsh-session-import-dropzone {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
  border: 1.5px dashed var(--dsw-alias-border-l2, #d7dbe2); border-radius: 12px;
  padding: 30px 16px; text-align: center; cursor: pointer;
  color: var(--dsw-alias-label-secondary, #4b5260); font-size: 13px; line-height: 20px;
}
.dsh-session-import-dropzone:hover, .dsh-session-import-dropzone.drag {
  border-color: var(--dsw-alias-state-business-primary, #3f6ff0);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.03));
}
.dsh-session-import-dropzone .hint { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a919e); }

.dsh-session-import-field { display: flex; flex-direction: column; gap: 5px; margin-top: 8px; }
.dsh-session-import-field > label { font-size: 12px; font-weight: 550; color: var(--dsw-alias-label-secondary, #4b5260); }
.dsh-session-import-field select, .dsh-session-import-field input[type="text"] {
  box-sizing: border-box; width: 100%; border-radius: 10px; padding: 7px 10px;
  border: 1px solid var(--dsw-alias-border-l2, #d7dbe2);
  background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1f2329);
  font-size: 13px; font-family: inherit; outline: none;
}
.dsh-session-import-field select:focus, .dsh-session-import-field input[type="text"]:focus {
  border-color: var(--dsw-alias-state-business-primary, #3f6ff0);
}

.dsh-session-import-hash-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.dsh-session-import-hash-row code {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05));
  border-radius: 8px; padding: 6px 10px;
}
.dsh-session-import-hash-match { font-size: 12px; font-weight: 600; }
.dsh-session-import-hash-match.ok { color: #0e7a4d; }
.dsh-session-import-hash-match.bad { color: #b02a2a; }

.dsh-session-import-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; margin-top: 16px; }
.dsh-session-import-btn {
  border-radius: 10px; padding: 7px 14px; font-size: 13px; font-weight: 550; font-family: inherit;
  border: 1px solid var(--dsw-alias-border-l2, #d7dbe2); cursor: pointer;
  background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1f2329);
}
.dsh-session-import-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05)); }
.dsh-session-import-btn.primary {
  background: var(--dsw-alias-state-business-primary, #3f6ff0); border-color: transparent; color: #fff;
}
.dsh-session-import-btn.primary:hover { filter: brightness(1.06); }
.dsh-session-import-btn:disabled { opacity: .55; cursor: not-allowed; }

.dsh-session-import-error {
  margin-top: 10px; border-radius: 10px; padding: 10px 12px; font-size: 12.5px; line-height: 18px;
  background: rgba(225,60,60,.1); color: #b02a2a; white-space: pre-wrap; word-break: break-all;
}
.dsh-session-import-done { text-align: center; padding: 14px 0 4px; }
.dsh-session-import-done .ok-icon { font-size: 30px; line-height: 36px; color: #16a34a; }
.dsh-session-import-done .msg { margin-top: 6px; font-size: 13.5px; font-weight: 600; }
.dsh-session-import-done .detail { margin-top: 4px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8a919e); }
.dsh-session-import-spinner {
  display: inline-block; width: 14px; height: 14px; vertical-align: -2px;
  border: 2px solid rgba(63,111,240,.25); border-top-color: var(--dsw-alias-state-business-primary, #3f6ff0);
  border-radius: 50%; animation: dsh-session-import-spin .8s linear infinite;
}
@keyframes dsh-session-import-spin { to { transform: rotate(360deg); } }
`;

    const inject = ['slots'];

    // —— 对话框开合状态(按钮在 React 树外,通过小型外部 store 桥接)——
    let dialogOpen = false;
    const dialogListeners = new Set();
    function setDialogOpen(value) {
      if (dialogOpen === value) return;
      dialogOpen = value;
      for (const listener of dialogListeners) listener();
    }
    function useDialogOpen() {
      const [value, setValue] = React.useState(dialogOpen);
      React.useEffect(() => {
        const listener = () => setValue(dialogOpen);
        dialogListeners.add(listener);
        return () => dialogListeners.delete(listener);
      }, []);
      return value;
    }

    function useStore(store) {
      const subscribe = React.useCallback((callback) => {
        const unsub = store.subscribe(callback);
        return () => { if (typeof unsub === 'function') unsub(); };
      }, [store]);
      return React.useSyncExternalStore(subscribe, () => store.getSnapshot());
    }

    const IMPORT_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 10.5V2.75M8 2.75L5.25 5.5M8 2.75l2.75 2.75" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.75 9.75v2.4c0 .66.54 1.2 1.2 1.2h8.1c.66 0 1.2-.54 1.2-1.2v-2.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes)) return '未知';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / 1048576).toFixed(2)} MB`;
    }

    function formatTime(ms) {
      if (!Number.isFinite(ms)) return '未知';
      const date = new Date(ms);
      if (Number.isNaN(date.getTime())) return '未知';
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    const SYNC_KEYS = [
      { key: 'model', label: '模型与思考深度' },
      { key: 'preset', label: 'Agent 预设(模式)' },
      { key: 'permission', label: '权限预设' },
      { key: 'sandbox', label: '沙箱模式' },
      { key: 'approval', label: '审批策略' },
      { key: 'plan', label: '计划模式' },
    ];

    function syncValueOf(sync, key) {
      // 宿主 analyze 返回的同步信息字段名为 agentPreset,而同步组键名是 preset
      const value = sync[key === 'preset' ? 'agentPreset' : key];
      if (value === null || value === undefined || value === '') return null;
      if (key === 'model') {
        const parts = [value.model, value.provider].filter(Boolean);
        if (value.reasoningEffort) parts.push(`思考深度 ${value.reasoningEffort}`);
        return parts.join(' · ');
      }
      if (key === 'plan') return value ? '已开启' : '未开启';
      return String(value);
    }

    function analyzeFile(bytes, fileName) {
      const params = new URLSearchParams();
      params.set('name', fileName);
      return fetch(`/session-import/analyze?${params.toString()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
      });
    }

    function importFile(bytes, fileName, options) {
      const params = new URLSearchParams();
      params.set('name', fileName);
      params.set('workspace', options.workspace);
      params.set('restamp', options.restamp ? '1' : '0');
      // open=1:导入后立即恢复为活跃会话,宿主向所有页面推送 session-added 帧,
      // 侧栏无需刷新即可看到新会话
      params.set('open', '1');
      params.set('sync', SYNC_KEYS.filter((group) => options.sync[group.key]).map((group) => group.key).join(','));
      if (typeof options.title === 'string' && options.title.trim() !== '') params.set('title', options.title.trim());
      if (typeof options.expectedHash === 'string' && options.expectedHash.trim() !== '') params.set('expectedHash', options.expectedHash.trim());
      return fetch(`/session-import/import?${params.toString()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
      });
    }

    async function jsonOf(response) {
      let data = null;
      try { data = await response.json(); } catch { /* 非 JSON 响应 */ }
      return { response, data };
    }

    function ImportDialog({ sessions, workspaces, onClose }) {
      const workspaceState = useStore(workspaces.list);
      const [phase, setPhase] = React.useState('idle'); // idle | analyzing | preview | importing | done
      const [error, setError] = React.useState(null);
      const [file, setFile] = React.useState(null);
      const [fileBytes, setFileBytes] = React.useState(null);
      const [preview, setPreview] = React.useState(null);
      const [verification, setVerification] = React.useState(null);
      const [options, setOptions] = React.useState(null);
      const [result, setResult] = React.useState(null);
      const [dragOver, setDragOver] = React.useState(false);
      const inputRef = React.useRef(null);

      const items = Array.isArray(workspaceState.items) ? workspaceState.items : [];
      const recentId = workspaceState.recentWorkspaceId;

      const startAnalyze = React.useCallback(async (bytes, name) => {
        setPhase('analyzing');
        setError(null);
        try {
          const { response, data } = await jsonOf(await analyzeFile(bytes, name));
          if (!response.ok || data === null || data.ok !== true) {
            throw new Error(data?.error?.message ?? `解析失败(HTTP ${response.status})`);
          }
          const sync = {};
          for (const group of SYNC_KEYS) sync[group.key] = syncValueOf(data.preview.sync, group.key) !== null;
          const defaultWorkspace = items.find((item) => item.workspaceId === recentId)?.path
            ?? items[0]?.path
            ?? (typeof data.preview.provenance.cwd === 'string' ? 'original' : '');
          setPreview(data.preview);
          setVerification(data.verification);
          setOptions({
            workspace: defaultWorkspace,
            restamp: true,
            sync,
            expectedHash: '',
            title: '',
          });
          setPhase('preview');
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
          setPhase('idle');
        }
      }, [items, recentId]);

      const pickFile = React.useCallback((selected) => {
        if (selected === null) return;
        setFile(selected);
        selected.arrayBuffer().then((buffer) => {
          const bytes = new Uint8Array(buffer);
          setFileBytes(bytes);
          return startAnalyze(bytes, selected.name);
        }).catch((err) => {
          setError(String(err && err.message ? err.message : err));
          setPhase('idle');
        });
      }, [startAnalyze]);

      const startImport = React.useCallback(async () => {
        if (options === null || fileBytes === null || file === null) return;
        if (verification !== null && verification.verdict === 'error') return;
        setPhase('importing');
        setError(null);
        try {
          const { response, data } = await jsonOf(await importFile(fileBytes, file.name, options));
          if (!response.ok || data === null || data.ok !== true) {
            throw new Error(data?.error?.message ?? `导入失败(HTTP ${response.status})`);
          }
          setResult(data);
          if (typeof data.sessionId === 'string' && data.sessionId !== '') {
            try {
              await Promise.allSettled([sessions.refresh(), workspaces.refresh()]);
              sessions.open(data.sessionId);
            } catch (openError) {
              console.error('[session-import] open failed:', openError);
            }
          }
          setPhase('done');
          setTimeout(() => onClose(), 1400);
        } catch (err) {
          setError(String(err && err.message ? err.message : err));
          setPhase('preview');
        }
      }, [options, fileBytes, file, verification, sessions, workspaces, onClose]);

      const expected = typeof options?.expectedHash === 'string' ? options.expectedHash.trim().toLowerCase() : '';
      const hashMatches = expected !== '' && verification !== null && expected === verification.sha256;

      // —— 面板内容按阶段组装 ——
      const dropzone = h('div', {
        className: `dsh-session-import-dropzone${dragOver ? ' drag' : ''}`,
        onClick: () => { if (inputRef.current !== null) inputRef.current.click(); },
        onDragOver: (event) => { event.preventDefault(); setDragOver(true); },
        onDragLeave: () => setDragOver(false),
        onDrop: (event) => {
          event.preventDefault();
          setDragOver(false);
          const dropped = event.dataTransfer.files && event.dataTransfer.files[0];
          pickFile(dropped ?? null);
        },
      },
        h('div', null, '点击选择或拖入会话日志文件'),
        h('div', { className: 'hint' }, '支持 /export 导出的 .zip 压缩包,或裸 .jsonl 日志'),
        h('input', {
          ref: inputRef,
          type: 'file',
          accept: '.zip,.jsonl,.json,.log,.txt,application/zip,application/json',
          style: { display: 'none' },
          onChange: (event) => {
            pickFile(event.target.files && event.target.files[0] ? event.target.files[0] : null);
            event.target.value = '';
          },
        }));

      const statusRow = (text) => h('div', { className: 'dsh-session-import-row', style: { padding: '18px 0' } },
        h('span', { className: 'dsh-session-import-spinner' }), ` ${text}`);

      const previewBlock = () => {
        const p = preview;
        if (p === null || verification === null || options === null) return null;
        const syncGroups = SYNC_KEYS.filter((group) => syncValueOf(p.sync, group.key) !== null);
        const anomalies = [
          ...verification.errors.map((text) => ({ text, kind: 'err' })),
          ...verification.warnings.map((text) => ({ text, kind: 'warn' })),
        ];

        const verdictBadge = verification.verdict === 'ok'
          ? h('span', { className: 'dsh-session-import-badge ok' }, '✓ 结构一致性检查通过')
          : verification.verdict === 'warn'
            ? h('span', { className: 'dsh-session-import-badge warn' }, `⚠ 结构一致性: ${anomalies.length} 个可疑点`)
            : h('span', { className: 'dsh-session-import-badge error' }, `✕ 结构错误: ${verification.errors.length} 处(不可导入)`);

        const summaryRows = [
          h('div', { className: 'dsh-session-import-row' }, '标题: ', h('strong', null, p.title ?? '(无)')),
          h('div', { className: 'dsh-session-import-row' },
            '原始会话: ', h('span', { className: 'mono' }, p.provenance.originalId),
            ' · 创建于 ', formatTime(p.provenance.createdAt)),
          h('div', { className: 'dsh-session-import-row' },
            `共 ${p.counts.user} 条用户消息 / ${p.counts.assistant} 条助手消息 / ${p.counts.toolCall} 次工具调用 / ${p.counts.turn} 个轮次 · ${p.eventCount} 个事件 · ${formatBytes(p.byteLength)}`),
        ];
        if (p.extras.subagentLogs > 0 || p.extras.mediaFiles > 0) {
          summaryRows.push(h('div', { className: 'dsh-session-import-row' },
            `压缩包内另有 ${p.extras.subagentLogs} 个子代理日志与 ${p.extras.mediaFiles} 个媒体附件(本次不导入)`));
        }
        const summarySection = h('div', { className: 'dsh-session-import-section' },
          h('div', { className: 'dsh-session-import-section-title' }, '日志概要'),
          h('div', { className: 'dsh-session-import-rows' }, summaryRows));

        const anomalyList = anomalies.length > 0
          ? h('div', { style: { marginTop: 6 } },
            anomalies.map((item, index) => h('div', {
              key: index,
              className: `dsh-session-import-anomaly ${item.kind}`,
            }, item.text)))
          : null;

        const hashRow = h('div', { className: 'dsh-session-import-hash-row' },
          h('code', { title: verification.sha256 }, `SHA-256 ${verification.sha256}`),
          h('button', {
            type: 'button',
            className: 'dsh-session-import-btn',
            onClick: () => {
              if (navigator.clipboard) navigator.clipboard.writeText(verification.sha256).catch(() => {});
            },
          }, '复制'));

        const hashFieldChildren = [
          h('label', null, '预期 SHA-256(可选:与导出方另行公布的指纹比对,不匹配将拒绝导入)'),
          h('input', {
            type: 'text',
            placeholder: '粘贴导出方公布的 64 位十六进制指纹',
            value: options.expectedHash,
            spellCheck: false,
            onChange: (event) => setOptions({ ...options, expectedHash: event.target.value }),
          }),
        ];
        if (expected !== '') {
          hashFieldChildren.push(h('span', {
            className: `dsh-session-import-hash-match ${hashMatches ? 'ok' : 'bad'}`,
          }, hashMatches ? '✓ 与文件指纹一致' : '✕ 与文件指纹不一致(导入会被拒绝)'));
        }

        const verifySection = h('div', { className: 'dsh-session-import-section' },
          h('div', { className: 'dsh-session-import-section-title' }, '真实性验证'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            verdictBadge,
            h('span', { className: 'dsh-session-import-row', style: { fontSize: 11.5 } }, '注意:结构检查与指纹能发现多数篡改,但无法证明作者身份')),
          anomalyList,
          hashRow,
          h('div', { className: 'dsh-session-import-field' }, hashFieldChildren));

        const syncRows = syncGroups.map((group) => {
          const value = syncValueOf(p.sync, group.key);
          return h('label', {
            key: group.key,
            className: `dsh-session-import-check${options.sync[group.key] ? '' : ' disabled'}`,
          },
            h('input', {
              type: 'checkbox',
              checked: options.sync[group.key],
              onChange: (event) => setOptions({
                ...options,
                sync: { ...options.sync, [group.key]: event.target.checked },
              }),
            }),
            h('span', null, `${group.label}: `, h('strong', null, value)));
        });
        const syncSection = syncGroups.length > 0
          ? h('div', { className: 'dsh-session-import-section' },
            h('div', { className: 'dsh-session-import-section-title' }, '同步到会话'),
            h('div', { className: 'dsh-session-import-rows' }, syncRows))
          : h('div', { className: 'dsh-session-import-row', style: { marginTop: 10 } }, '日志中未发现可同步的状态信息');

        const workspaceOptions = [];
        if (typeof p.provenance.cwd === 'string') {
          workspaceOptions.push(h('option', { value: 'original' }, `保持日志原始目录(${p.provenance.cwd})`));
        }
        for (const item of items) {
          workspaceOptions.push(h('option', { key: item.workspaceId, value: item.path }, `${item.title}(${item.path})`));
        }

        const optionsSection = h('div', { className: 'dsh-session-import-section' },
          h('div', { className: 'dsh-session-import-section-title' }, '导入选项'),
          h('div', { className: 'dsh-session-import-field' },
            h('label', null, '目标工作区'),
            h('select', {
              value: options.workspace,
              onChange: (event) => setOptions({ ...options, workspace: event.target.value }),
            }, workspaceOptions)),
          h('div', { className: 'dsh-session-import-field' },
            h('label', null, '导入后标题(可选,留空沿用日志内标题)'),
            h('input', {
              type: 'text',
              placeholder: p.title ?? '自定义标题',
              value: options.title,
              onChange: (event) => setOptions({ ...options, title: event.target.value }),
            })),
          h('label', { className: 'dsh-session-import-check', style: { marginTop: 10 } },
            h('input', {
              type: 'checkbox',
              checked: options.restamp,
              onChange: (event) => setOptions({ ...options, restamp: event.target.checked }),
            }),
            h('span', null, '置顶显示(把事件时间戳平移到当前,保持原有相对间隔)')));

        return h(React.Fragment, null, summarySection, verifySection, syncSection, optionsSection);
      };

      const doneBlock = h('div', { className: 'dsh-session-import-done' },
        h('div', { className: 'ok-icon' }, '✓'),
        h('div', { className: 'msg' }, '导入成功'),
        h('div', { className: 'detail' },
          result?.sessionId ? `已打开新会话 ${result.sessionId}` : '会话已导入,可在会话列表中打开'));

      const resetSelection = () => {
        setPhase('idle');
        setError(null);
        setPreview(null);
        setVerification(null);
        setFile(null);
        setFileBytes(null);
      };

      const actionsRow = h('div', { className: 'dsh-session-import-actions' },
        phase === 'preview'
          ? h(React.Fragment, null,
            h('button', { type: 'button', className: 'dsh-session-import-btn', onClick: resetSelection }, '重新选择'),
            h('button', {
              type: 'button',
              className: 'dsh-session-import-btn primary',
              disabled: verification !== null && verification.verdict === 'error',
              onClick: () => { startImport().catch(() => {}); },
            }, '开始导入'))
          : h('button', {
            type: 'button',
            className: 'dsh-session-import-btn',
            onClick: () => { if (phase !== 'importing') onClose(); },
          }, '取消'));

      const panelChildren = [
        h('h2', { className: 'dsh-session-import-title' }, '导入会话日志'),
        h('p', { className: 'dsh-session-import-subtitle' },
          '把其他人导出的 DSH 会话(或其子代理日志)导入为新的会话,并按需同步模型、思考深度、Agent 模式与状态栏设置。'),
      ];
      if (phase === 'idle') panelChildren.push(dropzone);
      else if (phase === 'analyzing') panelChildren.push(statusRow('正在解析并验证文件…'));
      else if (phase === 'preview') panelChildren.push(previewBlock());
      else if (phase === 'importing') panelChildren.push(statusRow('正在导入会话…'));
      else if (phase === 'done') panelChildren.push(doneBlock);
      if (error !== null) panelChildren.push(h('div', { className: 'dsh-session-import-error' }, error));
      panelChildren.push(actionsRow);

      return h('div', { className: 'dsh-session-import-overlay' },
        h('div', {
          className: 'dsh-session-import-backdrop',
          onClick: () => { if (phase !== 'importing') onClose(); },
        }),
        h('div', { className: 'dsh-session-import-panel', role: 'dialog', 'aria-modal': 'true' }, panelChildren));
    }

    function SessionImportOverlay({ sessions, workspaces }) {
      const open = useDialogOpen();
      return open
        ? h(ImportDialog, { sessions, workspaces, onClose: () => setDialogOpen(false) })
        : null;
    }

    function apply(ctx) {
      ctx.effect(() => {
        if (typeof document === 'undefined') return undefined;
        let tag = document.querySelector('style[data-plugin-css="session-import"]');
        if (tag === null) {
          tag = document.createElement('style');
          tag.dataset.pluginCss = 'session-import';
          document.head.appendChild(tag);
        }
        tag.textContent = CSS;
        return () => tag.remove();
      }, 'session-import: styles');

      ctx.inject(['sessions', 'workspaces'], (scope) => {
        scope.slots.inject('shell.overlay', () => scope.slots.register(
          { name: 'shell.overlay', id: 'session-import' },
          () => h(SessionImportOverlay, {
            sessions: scope.sessions,
            workspaces: scope.workspaces,
          }),
        ));

        // 新对话界面:在"模式选择"(Agent 预设芯片)右侧注入导入按钮。
        // 该位置没有可加性 Slot,按钮以 seat 的 data-slot 锚点为基准插入为兄弟节点,
        // 并用 MutationObserver 跟随 seat 的出现/消失/重挂载。
        scope.effect(() => {
          if (typeof document === 'undefined') return undefined;
          let btn = null;
          const seatSelector = '#root [data-slot="conversation.hero.agentPreset"]';
          const ensure = () => {
            const seat = document.querySelector(seatSelector);
            if (seat === null || seat.parentElement === null) {
              if (btn !== null) { btn.remove(); btn = null; }
              return;
            }
            if (btn !== null && btn.previousElementSibling !== seat) {
              btn.remove();
              btn = null;
            }
            if (btn === null) {
              btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'dsh-session-import-hero-btn';
              btn.innerHTML = `${IMPORT_ICON}<span>导入对话</span>`;
              btn.title = '导入其他人导出的会话日志(.zip / .jsonl)';
              btn.addEventListener('click', () => setDialogOpen(true));
              seat.parentElement.insertBefore(btn, seat.nextSibling);
            }
          };
          const observer = new MutationObserver(() => ensure());
          const root = document.getElementById('root') ?? document.body;
          observer.observe(root, { childList: true, subtree: true });
          ensure();
          return () => {
            observer.disconnect();
            if (btn !== null) btn.remove();
          };
        }, 'session-import: hero import button');
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
