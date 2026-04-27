/**
 * github-storage.js  v3
 * ────────────────────────────────────────────────────────
 * 設計方針（v3 で変更）:
 *   localStorage を「メイン」ストア → 即座に表示・保存
 *   GitHub API  を「任意の同期先」 → PAT設定時のみ使用
 *
 *   読込優先順:
 *     1. localStorage（即時、デバイスローカル）
 *     2. GitHub data/*.json（PAT設定済みかつオンライン時に追加取得）
 *
 *   書込:
 *     1. localStorage に必ず保存（即時）
 *     2. GitHub にも保存（PAT設定済みの場合のみ、非同期）
 */

const GHS = (() => {

  /* ══ リポジトリ情報 ══ */
  function detectRepo() {
    try {
      const { hostname, pathname } = location;
      const m = hostname.match(/^(.+)\.github\.io$/);
      if (!m) return null;
      const owner = m[1];
      const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
      const repo  = parts.length ? parts[0] : owner + '.github.io';
      return { owner, repo };
    } catch { return null; }
  }

  /* ══ PAT 管理 ══ */
  const PAT_KEY = 'gh_trade_pat';
  function getPAT()    { try { return sessionStorage.getItem(PAT_KEY) || ''; } catch { return ''; } }
  function setPAT(pat) { try { sessionStorage.setItem(PAT_KEY, pat.trim()); } catch {} }
  function clearPAT()  { try { sessionStorage.removeItem(PAT_KEY); } catch {} }
  function hasPAT()    { return !!getPAT(); }

  /* ══ localStorage ══ */
  function lsSave(dateKey, data) {
    try { localStorage.setItem(`trade_${dateKey}`, JSON.stringify(data)); return true; }
    catch { return false; }
  }
  function lsLoad(dateKey) {
    try {
      const raw = localStorage.getItem(`trade_${dateKey}`);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function lsAllRecords() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!/^trade_\d{8}$/.test(k)) continue;
        try {
          const d = JSON.parse(localStorage.getItem(k));
          if (d && d.date) {
            if (!d.label) d.label = `${d.date.slice(0,4)}-${d.date.slice(4,6)}-${d.date.slice(6,8)}`;
            out.push(d);
          }
        } catch {}
      }
    } catch {}
    return out.sort((a, b) => a.date.localeCompare(b.date));
  }
  function lsAllDates() {
    const dates = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (/^trade_\d{8}$/.test(k)) dates.push(k.replace('trade_', ''));
      }
    } catch {}
    return dates.sort();
  }

  /* ══ fetch + タイムアウト ══ */
  function fetchTO(url, opts = {}, ms = 8000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
  }
  function apiHeaders(auth = false) {
    const h = { 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' };
    if (auth && getPAT()) h['Authorization'] = `token ${getPAT()}`;
    return h;
  }
  function apiUrl(repo, path) {
    return `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${path}`;
  }

  /* ══ 単一記録を読む（localStorage 優先、_src でソースを付与） ══ */
  async function loadRecord(dateKey) {
    // まず localStorage から即時返す
    const local = lsLoad(dateKey);
    if (local) { local._src = 'local'; return local; }

    // localStorage になければ GitHub から取得
    const repo = detectRepo();
    if (!repo) return null;
    try {
      const res = await fetchTO(apiUrl(repo, `data/${dateKey}.json`), { headers: apiHeaders(false) });
      if (!res.ok) return null;
      const file = await res.json();
      const data = JSON.parse(atob(file.content.replace(/\n/g, '')));
      data._src = 'github';
      lsSave(dateKey, data); // ローカルにキャッシュ
      return data;
    } catch { return null; }
  }

  /* ══ 全記録を読む（localStorage 優先、GitHub でマージ） ══ */
  async function fetchAllRecords() {
    // localStorage から即時取得
    const local = lsAllRecords();

    // GitHub からの追加取得を試みる（PAT 不要・公開リポジトリ）
    const repo = detectRepo();
    if (!repo) return local;

    try {
      const res = await fetchTO(apiUrl(repo, 'data'), { headers: apiHeaders(false) });
      if (!res.ok) return local;
      const files = await res.json();
      if (!Array.isArray(files)) return local;

      const jsonFiles = files.filter(f => f.type === 'file' && /^\d{8}\.json$/.test(f.name));
      const ghResults = await Promise.allSettled(
        jsonFiles.map(async f => {
          try {
            const r = await fetchTO(f.download_url, {});
            return r.ok ? r.json() : null;
          } catch { return null; }
        })
      );
      // GitHub と localStorage をマージ（GitHub データを優先）
      const merged = [...local];
      ghResults.forEach(r => {
        if (r.status !== 'fulfilled' || !r.value) return;
        const d = r.value;
        if (!d.date) return;
        if (!d.label) d.label = `${d.date.slice(0,4)}-${d.date.slice(4,6)}-${d.date.slice(6,8)}`;
        const idx = merged.findIndex(m => m.date === d.date);
        if (idx >= 0) merged[idx] = d; // 既存を上書き
        else merged.push(d);
        lsSave(d.date, d); // ローカルにキャッシュ
      });
      return merged.sort((a, b) => a.date.localeCompare(b.date));
    } catch { return local; }
  }

  /* ══ nissi/ ファイル一覧 ══ */
  async function fetchNissiDates() {
    const local = lsAllDates();
    const repo = detectRepo();
    if (!repo) return local;
    try {
      const res = await fetchTO(apiUrl(repo, 'nissi'), { headers: apiHeaders(false) });
      if (!res.ok) return local;
      const files = await res.json();
      if (!Array.isArray(files)) return local;
      const ghDates = files
        .filter(f => f.type === 'file' && /^\d{8}\.html$/.test(f.name))
        .map(f => f.name.replace('.html', ''));
      local.forEach(d => { if (!ghDates.includes(d)) ghDates.push(d); });
      return ghDates.sort();
    } catch { return local; }
  }

  /* ══ 保存（localStorage 即時 + GitHub 非同期） ══ */
  async function saveRecord(dateKey, data) {
    // ① localStorage に即時保存（必ず成功）
    lsSave(dateKey, data);

    // ② GitHub にも保存（PAT 必要）
    const repo = detectRepo();
    if (!repo) throw new Error('GITHUB_PAGES_ONLY');
    if (!hasPAT()) throw new Error('PAT_REQUIRED');

    const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
    const url     = apiUrl(repo, `data/${dateKey}.json`);

    let sha;
    try {
      const ex = await fetchTO(url, { headers: apiHeaders(true) });
      if (ex.ok) { const j = await ex.json(); sha = j.sha; }
    } catch {}

    const res = await fetchTO(url, {
      method: 'PUT',
      headers: apiHeaders(true),
      body: JSON.stringify({ message: `📅 ${dateKey}`, content, ...(sha ? { sha } : {}) })
    });

    if (res.status === 401) { clearPAT(); throw new Error('PAT_INVALID'); }
    if (!res.ok) { const e = await res.json().catch(()=>({})); throw new Error(e.message || `API ${res.status}`); }
    return true;
  }

  /* ══ 保存ラッパー v3.1
   * PAT なし → localStorage のみ、onSaved('local')
   * PAT あり → localStorage + GitHub、onSaved('github')
   * GitHub 失敗 → onError を呼ぶ（localStorage は保存済）
   */
  async function saveWithPAT(dateKey, data, onSaved, onError) {
    // ① localStorage に必ず保存
    lsSave(dateKey, data);

    const repo = detectRepo();
    if (!repo) {
      // ローカル環境: localStorage のみ
      if (onSaved) onSaved('local');
      return;
    }

    // ② PAT がない → localStorage 保存完了を通知 + モーダルで同期を促す
    if (!hasPAT()) {
      if (onSaved) onSaved('local');
      showPATModal(async () => {
        try {
          await saveRecord(dateKey, data);
          if (onSaved) onSaved('github');
        } catch (e2) {
          if (onError) onError(e2.message);
        }
      });
      return;
    }

    // ③ PAT あり → GitHub に保存
    try {
      await saveRecord(dateKey, data);
      if (onSaved) onSaved('github');
    } catch (e) {
      if (e.message === 'PAT_INVALID') {
        clearPAT();
        if (onSaved) onSaved('local');
        showPATModal(async () => {
          try { await saveRecord(dateKey, data); if (onSaved) onSaved('github'); }
          catch (e2) { if (onError) onError(e2.message); }
        });
      } else {
        if (onError) onError(`GitHub同期失敗: ${e.message}（この端末には保存済）`);
      }
    }
  }

  /* ══ PAT 入力モーダル ══ */
  function showPATModal(onSuccess) {
    const existing = document.getElementById('ghs-modal');
    if (existing) existing.remove();
    const repo    = detectRepo();
    const repoStr = repo ? `${repo.owner}/${repo.repo}` : '(ローカル環境)';
    const patUrl  = 'https://github.com/settings/tokens/new?scopes=repo&description=TradeRecord';

    const modal = document.createElement('div');
    modal.id = 'ghs-modal';
    modal.innerHTML = `
      <div id="ghs-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:10000;
        display:flex;align-items:center;justify-content:center;padding:20px;">
        <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;
          width:100%;max-width:480px;overflow:hidden;box-shadow:0 20px 60px #000b;">
          <div style="padding:20px 24px;border-bottom:1px solid #30363d;display:flex;align-items:center;gap:10px;">
            <span style="font-size:22px;">🔑</span>
            <div>
              <div style="font-size:15px;font-weight:700;color:#e6edf3;">GitHub 同期設定（任意）</div>
              <div style="font-size:12px;color:#6e7681;">設定しなくてもこの端末での保存は完了しています</div>
            </div>
          </div>
          <div style="padding:20px 24px;">
            <div style="background:#3fb95015;border:1px solid #3fb95040;border-radius:8px;
              padding:12px 16px;margin-bottom:14px;font-size:12px;color:#8b949e;line-height:1.7;">
              ✅ <strong style="color:#3fb950;">この端末への保存は完了しています</strong><br>
              複数端末で同期したい場合のみ、PATを設定してください。
            </div>
            <div style="background:#21262d;border:1px solid #30363d;border-radius:8px;
              padding:14px 16px;margin-bottom:14px;font-size:12px;color:#8b949e;line-height:1.9;">
              <div style="color:#e6edf3;font-weight:700;margin-bottom:6px;">📋 PAT 取得手順</div>
              1. 下のリンクをクリック（新しいタブ）<br>
              2. <code style="background:#0d1117;padding:1px 5px;border-radius:3px;color:#58a6ff;">repo</code> スコープを確認 → Generate<br>
              3. トークンをコピーして下に貼り付け<br>
              <a href="${patUrl}" target="_blank" rel="noopener"
                style="color:#58a6ff;font-weight:700;display:inline-block;margin-top:4px;">
                → GitHub でトークンを発行 ↗
              </a>
            </div>
            <div style="font-size:11px;color:#6e7681;letter-spacing:.06em;margin-bottom:6px;">PERSONAL ACCESS TOKEN</div>
            <input id="ghs-pat-input" type="password" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;
              padding:10px 14px;color:#e6edf3;font-family:'JetBrains Mono',monospace;
              font-size:14px;outline:none;margin-bottom:6px;box-sizing:border-box;" autocomplete="off">
            <div id="ghs-pat-err" style="font-size:12px;color:#f85149;min-height:16px;margin-bottom:10px;"></div>
            <div style="display:flex;gap:10px;">
              <button id="ghs-save-btn" style="flex:1;background:#1f6feb;color:#fff;font-weight:700;font-size:13px;
                padding:10px;border:none;border-radius:6px;cursor:pointer;font-family:inherit;">
                PATを設定して同期する
              </button>
              <button id="ghs-cancel-btn" style="background:#21262d;color:#8b949e;font-size:13px;
                padding:10px 18px;border:1px solid #30363d;border-radius:6px;cursor:pointer;font-family:inherit;">
                この端末のみで OK
              </button>
            </div>
            <div style="margin-top:10px;text-align:center;font-size:10px;color:#3d5068;">
              ${repoStr} · セッション終了時に自動削除
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const input   = document.getElementById('ghs-pat-input');
    const errEl   = document.getElementById('ghs-pat-err');
    const saveBtn = document.getElementById('ghs-save-btn');

    input.focus();
    input.addEventListener('keydown', e => { if (e.key === 'Enter') saveBtn.click(); });
    saveBtn.addEventListener('click', () => {
      const pat = input.value.trim();
      if (!pat) { errEl.textContent = '⚠️ トークンを入力してください'; return; }
      setPAT(pat);
      modal.remove();
      if (onSuccess) onSuccess();
    });
    document.getElementById('ghs-cancel-btn').addEventListener('click', () => modal.remove());
    document.getElementById('ghs-overlay').addEventListener('click', e => {
      if (e.target.id === 'ghs-overlay') modal.remove();
    });
  }

  return {
    detectRepo, getPAT, setPAT, clearPAT, hasPAT,
    loadRecord, saveRecord, saveWithPAT,
    fetchAllRecords, fetchNissiDates,
    showPATModal,
    // デバッグ用
    lsAllRecords, lsAllDates
  };
})();
