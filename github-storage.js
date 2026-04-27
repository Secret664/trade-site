/**
 * github-storage.js  v2
 * ────────────────────────────────────────────────────────
 * 修正点:
 *   - 全fetch に8秒タイムアウト追加（レート制限・ネットワーク詰まり対策）
 *   - fetchAllRecords / fetchNissiDates / loadRecord すべてに安全なフォールバック
 *   - ローカル実行時（file:// / localhost）も動作するよう localStorage フォールバック
 */

const GHS = (() => {

  /* ══ リポジトリ情報を URL から自動検出 ══ */
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

  /* ══ fetch にタイムアウトを付与 ══ */
  const TIMEOUT_MS = 8000;
  function fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    return fetch(url, { ...options, signal: controller.signal })
      .finally(() => clearTimeout(timer));
  }

  /* ══ API ヘルパー ══ */
  function apiHeaders(withAuth = false) {
    const h = { 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' };
    if (withAuth && getPAT()) h['Authorization'] = `token ${getPAT()}`;
    return h;
  }
  function apiUrl(repo, path) {
    return `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${path}`;
  }

  /* ══ localStorage フォールバック ══ */
  function loadLocalFallback(dateKey) {
    try {
      const raw = localStorage.getItem(`trade_${dateKey}`);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function scanLocalStorage() {
    const dates = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (/^trade_\d{8}$/.test(k)) dates.push(k.replace('trade_', ''));
      }
    } catch {}
    return dates.sort();
  }

  /* ══ 単一記録の読み込み ══ */
  async function loadRecord(dateKey) {
    const repo = detectRepo();
    if (!repo) return loadLocalFallback(dateKey);
    try {
      const res = await fetchWithTimeout(apiUrl(repo, `data/${dateKey}.json`), {
        headers: apiHeaders(false)
      });
      if (res.status === 404) return loadLocalFallback(dateKey); // まだ保存なし→LSフォールバック
      if (!res.ok) throw new Error(`API ${res.status}`);
      const file = await res.json();
      const text = atob(file.content.replace(/\n/g, ''));
      return JSON.parse(text);
    } catch (e) {
      console.warn('loadRecord fallback to localStorage:', e.message);
      return loadLocalFallback(dateKey); // ネットワーク失敗→LSフォールバック
    }
  }

  /* ══ data/ フォルダから全記録を一括取得 ══ */
  async function fetchAllRecords() {
    const repo = detectRepo();

    // GitHub Pages 以外 or API 失敗時は localStorage から収集
    const localFallback = () => {
      const dates = scanLocalStorage();
      return dates.map(dk => loadLocalFallback(dk)).filter(Boolean);
    };

    if (!repo) return localFallback();

    try {
      const res = await fetchWithTimeout(apiUrl(repo, 'data'), { headers: apiHeaders(false) });
      if (res.status === 404) return localFallback(); // data/ フォルダがまだない
      if (res.status === 403) {                       // レート制限
        console.warn('GitHub API rate limit, falling back to localStorage');
        return localFallback();
      }
      if (!res.ok) return localFallback();

      const files = await res.json();
      if (!Array.isArray(files)) return localFallback();

      const jsonFiles = files.filter(f => f.type === 'file' && /^\d{8}\.json$/.test(f.name));
      if (!jsonFiles.length) return localFallback();

      const results = await Promise.allSettled(
        jsonFiles.map(async f => {
          try {
            const r = await fetchWithTimeout(f.download_url);
            return r.ok ? r.json() : null;
          } catch { return null; }
        })
      );
      const ghRecords = results
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value)
        .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

      // localStorage にしか残っていない古いデータもマージ
      const lsDates = scanLocalStorage();
      lsDates.forEach(dk => {
        if (!ghRecords.find(r => r.date === dk)) {
          const d = loadLocalFallback(dk);
          if (d) ghRecords.push(d);
        }
      });
      return ghRecords.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    } catch (e) {
      console.warn('fetchAllRecords fallback to localStorage:', e.message);
      return localFallback();
    }
  }

  /* ══ nissi/ フォルダのファイル一覧 ══ */
  async function fetchNissiDates() {
    const repo = detectRepo();
    if (!repo) return scanLocalStorage();
    try {
      const res = await fetchWithTimeout(apiUrl(repo, 'nissi'), { headers: apiHeaders(false) });
      if (!res.ok) return scanLocalStorage();
      const files = await res.json();
      if (!Array.isArray(files)) return scanLocalStorage();
      const ghDates = files
        .filter(f => f.type === 'file' && /^\d{8}\.html$/.test(f.name))
        .map(f => f.name.replace('.html', ''))
        .sort();
      // localStorage にあるキーもマージ
      scanLocalStorage().forEach(d => { if (!ghDates.includes(d)) ghDates.push(d); });
      return ghDates.sort();
    } catch (e) {
      console.warn('fetchNissiDates fallback:', e.message);
      return scanLocalStorage();
    }
  }

  /* ══ 記録の保存（PUT） ══ */
  async function saveRecord(dateKey, data) {
    const repo = detectRepo();
    if (!repo) throw new Error('GitHub Pages 環境以外では保存できません');
    if (!hasPAT()) throw new Error('PAT_REQUIRED');

    const path    = `data/${dateKey}.json`;
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
    const url     = apiUrl(repo, path);

    let sha;
    try {
      const existing = await fetchWithTimeout(url, { headers: apiHeaders(true) });
      if (existing.ok) { const j = await existing.json(); sha = j.sha; }
    } catch {}

    const res = await fetchWithTimeout(url, {
      method:  'PUT',
      headers: apiHeaders(true),
      body:    JSON.stringify({ message: `📅 ${dateKey}`, content, ...(sha ? { sha } : {}) })
    });

    if (res.status === 401) { clearPAT(); throw new Error('PAT_INVALID'); }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `API ${res.status}`);
    }

    // ローカルにも保存（オフライン時のフォールバック用）
    try { localStorage.setItem(`trade_${dateKey}`, JSON.stringify(data)); } catch {}

    return await res.json();
  }

  /* ══ 保存ラッパー（PAT なければモーダル） ══ */
  async function saveWithPAT(dateKey, data, onSaved, onError) {
    const doSave = async () => {
      try {
        await saveRecord(dateKey, data);
        if (onSaved) onSaved();
      } catch (e) {
        if (e.message === 'PAT_REQUIRED' || e.message === 'PAT_INVALID') {
          showPATModal(doSave);
        } else {
          if (onError) onError(e.message);
        }
      }
    };
    await doSave();
  }

  /* ══ PAT 入力モーダル ══ */
  function showPATModal(onSuccess) {
    const existing = document.getElementById('ghs-modal');
    if (existing) existing.remove();
    const repo    = detectRepo();
    const repoStr = repo ? `${repo.owner}/${repo.repo}` : 'あなたのリポジトリ';
    const patUrl  = 'https://github.com/settings/tokens/new?scopes=repo&description=TradeRecord';

    const modal = document.createElement('div');
    modal.id = 'ghs-modal';
    modal.innerHTML = `
      <div id="ghs-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:10000;
        display:flex;align-items:center;justify-content:center;padding:20px;">
        <div style="background:#161b22;border:1px solid #30363d;border-radius:12px;
          width:100%;max-width:480px;overflow:hidden;box-shadow:0 16px 48px #0009;">
          <div style="padding:20px 24px;border-bottom:1px solid #30363d;display:flex;align-items:center;gap:10px;">
            <span style="font-size:22px;">🔑</span>
            <div>
              <div style="font-size:15px;font-weight:700;color:#e6edf3;">GitHub PAT 設定</div>
              <div style="font-size:12px;color:#6e7681;">記録をリポジトリに保存するために必要です</div>
            </div>
          </div>
          <div style="padding:20px 24px;">
            <div style="background:#21262d;border:1px solid #30363d;border-radius:8px;
              padding:14px 16px;margin-bottom:14px;font-size:12px;color:#8b949e;line-height:1.9;">
              <div style="color:#e6edf3;font-weight:700;margin-bottom:6px;">📋 PAT の取得手順</div>
              1. 下のリンクをクリック（新しいタブ）<br>
              2. <code style="background:#0d1117;padding:1px 5px;border-radius:3px;color:#58a6ff;">repo</code> スコープを確認<br>
              3. 「Generate token」→ トークンをコピー<br>
              4. 下の入力欄に貼り付け<br>
              <a href="${patUrl}" target="_blank" rel="noopener" style="color:#58a6ff;font-weight:700;display:inline-block;margin-top:6px;">
                → GitHub でトークンを発行する ↗
              </a>
            </div>
            <div style="background:#1f6feb15;border:1px solid #1f6feb44;border-radius:6px;
              padding:10px 14px;font-size:11px;color:#8b949e;margin-bottom:14px;">
              🔒 セッション内のみ保持。ブラウザを閉じると自動削除されます。
            </div>
            <div style="font-size:11px;color:#6e7681;letter-spacing:.06em;margin-bottom:6px;">PERSONAL ACCESS TOKEN</div>
            <input id="ghs-pat-input" type="password" placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
              style="width:100%;background:#0d1117;border:1px solid #30363d;border-radius:6px;
              padding:10px 14px;color:#e6edf3;font-family:'JetBrains Mono',monospace;
              font-size:14px;outline:none;margin-bottom:6px;box-sizing:border-box;" autocomplete="off">
            <div id="ghs-pat-err" style="font-size:12px;color:#f85149;min-height:18px;margin-bottom:12px;"></div>
            <div style="display:flex;gap:10px;">
              <button id="ghs-save-btn" style="flex:1;background:#3fb950;color:#000;font-weight:700;font-size:13px;
                padding:10px;border:none;border-radius:6px;cursor:pointer;font-family:inherit;">
                保存して記録する
              </button>
              <button id="ghs-cancel-btn" style="background:#21262d;color:#8b949e;font-size:13px;
                padding:10px 18px;border:1px solid #30363d;border-radius:6px;cursor:pointer;font-family:inherit;">
                キャンセル
              </button>
            </div>
            <div style="margin-top:12px;text-align:center;font-size:11px;color:#6e7681;">
              リポジトリ: <code style="color:#58a6ff;">${repoStr}</code>
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
    showPATModal
  };
})();
