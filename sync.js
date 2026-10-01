(() => {
  'use strict';

  const STATE_KEY = 'fitlog:dashboard:v3';
  const SYNC_KEY = 'fitlog-sync';
  const AI_KEY = 'fitlog-ai-settings';
  const AUTH_KEY = 'fitlog-auth';
  const PROJECT_URL = 'https://woyrhbvvizsjgxtlaclg.supabase.co';
  // Supabase → Project Settings → API의 anon public 키. 공개용 키라 앱에 넣어도 안전하다(데이터는 RLS가 지킨다).
  // 비어 있으면 이 기기에 저장된 기존 연결 키를 쓴다.
  const PUBLIC_ANON_KEY = '';
  const AI_PREF_FIELDS = ['functionName', 'model', 'coachModel'];
  const nativeSetItem = Storage.prototype.setItem;
  let syncing = false;
  let syncTimer = null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const safeJson = (value, fallback = null) => {
    try { return JSON.parse(value); } catch { return fallback; }
  };
  const readState = () => safeJson(localStorage.getItem(STATE_KEY), { profile: {}, logs: {}, inbody: [] });
  const normalizeProjectUrl = value => String(value || '')
    .trim()
    .replace('woyrhbvvizsjgxtlaclq.supabase.co', 'woyrhbvvizsjgxtlaclg.supabase.co')
    .replace(/\/rest\/v1\/?$/i, '')
    .replace(/\/+$/, '');
  const readSync = () => {
    const config = safeJson(localStorage.getItem(SYNC_KEY), {}) || {};
    const corrected = normalizeProjectUrl(config.url);
    if (corrected && corrected !== config.url) {
      config.url = corrected;
      nativeSetItem.call(localStorage, SYNC_KEY, JSON.stringify(config));
    }
    return config;
  };
  const validSync = (config = readSync()) => Boolean(config.url && config.key);
  const projectConfig = () => {
    const config = readSync();
    return { url: config.url || PROJECT_URL, key: PUBLIC_ANON_KEY || config.key || '' };
  };

  // ---------- 이메일 6자리 코드 로그인 ----------
  const readSession = () => safeJson(localStorage.getItem(AUTH_KEY), null);
  const signedIn = () => Boolean(readSession()?.refresh_token);
  let refreshing = null;

  function storeSession(data) {
    const session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      user: { id: data.user?.id, email: data.user?.email },
      synced: data.user?.id && readSession()?.user?.id === data.user.id ? readSession().synced : false
    };
    nativeSetItem.call(localStorage, AUTH_KEY, JSON.stringify(session));
    return session;
  }

  async function authCall(path, body, token, method = 'POST') {
    const config = projectConfig();
    if (!config.key) throw new Error('이 기기에 Supabase anon public 키가 없어요. 아래 "고급: Supabase 직접 연결"에 한 번만 입력해 주세요.');
    const headers = { apikey: config.key, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetch(`${new URL(config.url).origin}/auth/v1/${path}`, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    } catch {
      throw new Error('인터넷 연결을 확인해 주세요.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data.msg || data.error_description || data.message || '';
      const error = new Error(message || `로그인 요청 실패 (${response.status})`);
      error.status = response.status;
      if (response.status === 429 || /rate limit|security purposes/i.test(message)) error.message = '요청이 너무 잦아요. 잠시 뒤에 다시 시도해 주세요.';
      else if (/invalid login credentials/i.test(message)) error.message = '이메일 또는 비밀번호가 맞지 않아요.';
      else if (/email not confirmed/i.test(message)) error.message = '가입 확인 메일의 링크를 먼저 눌러 주세요. 메일이 안 보이면 스팸함도 확인해 주세요.';
      else if (/already registered|already exists/i.test(message)) error.message = '이미 가입된 이메일이에요. 로그인을 눌러 주세요.';
      else if (/password/i.test(message) && /least|short|weak/i.test(message)) error.message = '비밀번호는 6자 이상으로 정해 주세요.';
      else if (/signups not allowed/i.test(message)) error.message = '새 가입이 막혀 있어요. 등록된 이메일인지 확인해 주세요.';
      throw error;
    }
    return data;
  }

  // 메일 속 링크를 누르면 이 앱 주소로 돌아오게 한다.
  const appUrl = () => location.origin + location.pathname;
  const signIn = async (email, password) => storeSession(await authCall('token?grant_type=password', { email, password }));
  async function signUp(email, password) {
    const data = await authCall(`signup?redirect_to=${encodeURIComponent(appUrl())}`, { email, password });
    if (data.access_token) return { session: storeSession(data) };
    // 이미 가입된 이메일이면 Supabase는 빈 identities를 돌려준다.
    if (Array.isArray(data.identities) && !data.identities.length) throw new Error('이미 가입된 이메일이에요. 로그인을 눌러 주세요.');
    return { needsConfirm: true };
  }
  const requestReset = email => authCall(`recover?redirect_to=${encodeURIComponent(appUrl())}`, { email });
  async function updatePassword(password) {
    const token = await getAccessToken();
    if (!token) throw new Error('로그인이 만료됐어요. 비밀번호 재설정 메일을 다시 받아 주세요.');
    await authCall('user', { password }, token, 'PUT');
  }

  // 가입 확인·비밀번호 재설정 링크로 들어오면 주소 뒤(#access_token=…)의 로그인 정보를 저장한다.
  let recoveryMode = false;
  let linkNotice = '';
  async function consumeAuthLink() {
    const hash = (sessionStorage.getItem('fitlog:authHash') || location.hash).replace(/^#/, '');
    sessionStorage.removeItem('fitlog:authHash');
    if (!/access_token=|error_description=/.test(hash)) return;
    const params = new URLSearchParams(hash);
    history.replaceState(null, '', `${location.pathname}${location.search}#more`);
    if (params.get('error_description')) {
      linkNotice = /expired/i.test(params.get('error_description')) ? '메일 링크가 만료됐어요. 다시 요청해 주세요.' : '메일 링크를 확인하지 못했어요. 다시 요청해 주세요.';
      return;
    }
    try {
      const token = params.get('access_token');
      const user = await authCall('user', null, token, 'GET');
      storeSession({ access_token: token, refresh_token: params.get('refresh_token'), expires_at: +params.get('expires_at') || 0, expires_in: +params.get('expires_in') || 3600, user });
      recoveryMode = params.get('type') === 'recovery';
      linkNotice = recoveryMode ? '새 비밀번호를 정해 주세요.' : '이메일 확인이 끝났어요. 로그인됐어요.';
    } catch {
      linkNotice = '메일 링크로 로그인하지 못했어요. 이메일·비밀번호로 로그인해 주세요.';
    }
  }

  // 만료 1분 전이면 refresh 토큰으로 새로 받는다. 네트워크 오류로는 로그아웃시키지 않는다.
  async function getAccessToken() {
    const session = readSession();
    if (!session?.refresh_token) return null;
    if (session.access_token && session.expires_at - 60 > Date.now() / 1000) return session.access_token;
    refreshing ||= authCall('token?grant_type=refresh_token', { refresh_token: session.refresh_token })
      .then(storeSession)
      .catch(error => {
        if (error.status === 400 || error.status === 401) localStorage.removeItem(AUTH_KEY);
        return null;
      })
      .finally(() => { refreshing = null; });
    return (await refreshing)?.access_token || null;
  }

  async function signOut() {
    const token = await getAccessToken().catch(() => null);
    if (token) authCall('logout', {}, token).catch(() => {});
    localStorage.removeItem(AUTH_KEY);
  }

  window.FitLogAuth = {
    signedIn,
    email: () => readSession()?.user?.email || '',
    accessToken: getAccessToken,
    project: projectConfig
  };

  // ---------- AI 설정(모델·함수 이름)도 기록과 함께 동기화한다. 토큰은 기기에만 둔다. ----------
  function aiPrefsFrom(settings) {
    const prefs = {};
    AI_PREF_FIELDS.forEach(field => { if (settings?.[field]) prefs[field] = settings[field]; });
    return prefs;
  }

  function seedAiPrefs(state) {
    if (state.settings?.ai) return state;
    const prefs = aiPrefsFrom(safeJson(localStorage.getItem(AI_KEY), {}));
    if (!Object.keys(prefs).length) return state;
    // 기존 기기 값은 오래된 것으로 표시해 클라우드에 있는 값이 있으면 그쪽을 따른다.
    return { ...state, settings: { ...(state.settings || {}), ai: { ...prefs, updatedAt: '2000-01-01T00:00:00.000Z' } } };
  }

  function applyAiPrefs(state) {
    const ai = state.settings?.ai;
    if (!ai) return;
    const current = safeJson(localStorage.getItem(AI_KEY), {}) || {};
    const next = { ...current, ...aiPrefsFrom(ai) };
    if (stableJson(aiPrefsFrom(current)) !== stableJson(aiPrefsFrom(next))) nativeSetItem.call(localStorage, AI_KEY, JSON.stringify(next));
  }

  function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function stateSignature(raw) {
    const state = normalizeBackup(raw);
    const { lastSaved, syncedAt, ...content } = state;
    return stableJson(content);
  }

  function normalizeBackup(raw) {
    const source = raw?.state || raw || {};
    const oldProfile = source.profile || {};
    return {
      ...source,
      profile: {
        ...oldProfile,
        name: oldProfile.name || '',
        workoutGoal: Number(oldProfile.workoutGoal || oldProfile.workoutDays || 5),
        targetFat: Number(oldProfile.targetFat || oldProfile.goalBodyFat || 15),
        targets: {
          kcal: 2200, protein: 153, carbs: 260, fat: 61,
          ...(oldProfile.targets || {})
        }
      },
      logs: source.logs || {},
      inbody: Array.isArray(source.inbody) ? source.inbody : []
    };
  }

  // 같은 id면 나중에 고친 쪽(updatedAt)을, 시각이 없으면 이 기기 쪽을 남긴다. 지운 항목(deleted)은 되살리지 않는다.
  function mergeItems(cloudItems = [], localItems = [], deleted = {}) {
    const map = new Map();
    [...cloudItems, ...localItems].forEach(item => {
      if (item?.id && deleted[item.id]) return;
      const key = item.id ? `id:${item.id}` : `legacy:${stableJson(item)}`;
      const existing = map.get(key);
      if (existing && Date.parse(existing.updatedAt || 0) > Date.parse(item.updatedAt || 0)) return;
      map.set(key, item);
    });
    return [...map.values()];
  }

  // 삭제 표시는 90일 지나면 정리한다.
  function mergeDeleted(...sources) {
    const cutoff = Date.now() - 90 * 86400000;
    const merged = {};
    sources.forEach(source => Object.entries(source || {}).forEach(([id, at]) => {
      if (Date.parse(at) > cutoff && (!merged[id] || merged[id] < at)) merged[id] = at;
    }));
    return merged;
  }

  function mergeStates(localRaw, cloudRaw) {
    const local = normalizeBackup(localRaw);
    const cloud = normalizeBackup(cloudRaw);
    const cloudNewer = Date.parse(cloud.lastSaved || 0) > Date.parse(local.lastSaved || 0);
    const deleted = mergeDeleted(cloud.deletedIds, local.deletedIds);
    const logs = { ...cloud.logs };
    for (const [date, localLog] of Object.entries(local.logs || {})) {
      const cloudLog = logs[date] || {};
      logs[date] = { ...cloudLog, ...localLog };
    }
    // 클라우드에만 있는 날짜를 포함해 모든 날짜에서 지운 항목을 빼고 합친다.
    for (const date of Object.keys(logs)) {
      const cloudLog = cloud.logs?.[date] || {};
      const localLog = local.logs?.[date] || {};
      logs[date].meals = mergeItems(cloudLog.meals, localLog.meals, deleted);
      logs[date].workouts = mergeItems(cloudLog.workouts, localLog.workouts, deleted);
    }
    const inbodyMap = new Map();
    [...(cloud.inbody || []), ...(local.inbody || [])].forEach(item => {
      inbodyMap.set(`${item.date || ''}:${item.weight || ''}:${item.pbf || item.bodyFat || ''}`, item);
    });
    const merged = {
      ...(cloudNewer ? local : cloud),
      ...(cloudNewer ? cloud : local),
      profile: cloudNewer ? cloud.profile : local.profile,
      logs,
      inbody: [...inbodyMap.values()],
      deletedIds: deleted
    };
    const newestAi = [local.settings?.ai, cloud.settings?.ai]
      .filter(Boolean)
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))[0];
    if (local.settings || cloud.settings) {
      merged.settings = { ...(cloud.settings || {}), ...(local.settings || {}) };
      if (newestAi) merged.settings.ai = newestAi;
    }
    const savedAt = [local.lastSaved, cloud.lastSaved]
      .filter(Boolean)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    if (savedAt) merged.lastSaved = savedAt;
    delete merged.syncedAt;
    return merged;
  }

  async function request(config, method, path, body, extraHeaders = {}) {
    const origin = new URL(config.url).origin;
    const response = await fetch(`${origin}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.jwt || config.key}`,
        'Content-Type': 'application/json',
        ...extraHeaders
      },
      body: body == null ? undefined : JSON.stringify(body)
    });
    if (!response.ok) {
      let message = '';
      try { message = (await response.json()).message || ''; } catch {}
      const table = path.split('?')[0];
      if (/does not exist|could not find the table/i.test(message) || response.status === 404) throw new Error(`${table} 테이블을 찾지 못했어요. 설정 SQL을 실행했는지 확인해 주세요.`);
      if (response.status === 401 || response.status === 403) throw new Error(config.jwt ? '로그인이 만료됐어요. 다시 로그인해 주세요.' : 'anon public 키가 올바르지 않아요.');
      throw new Error(message || `동기화 요청 실패 (${response.status})`);
    }
    return response;
  }

  async function readCloud(config) {
    const response = await request(config, 'GET', 'fitlog_kv?select=key,value,updated_at');
    const rows = await response.json();
    const dashboard = rows.find(row => row.key === 'dashboard-v3');
    if (dashboard) return safeJson(dashboard.value, null);
    const legacy = { profile: {}, logs: {}, inbody: [] };
    for (const row of rows) {
      const value = safeJson(row.value, null);
      if (row.key === 'profile' && value) legacy.profile = value;
      if (row.key === 'inbody' && Array.isArray(value)) legacy.inbody = value;
      if (row.key.startsWith('log:') && value) legacy.logs[row.key.slice(4)] = value;
    }
    return Object.keys(legacy.logs).length || Object.keys(legacy.profile).length ? legacy : null;
  }

  async function writeCloud(config, state) {
    await request(
      config,
      'POST',
      'fitlog_kv?on_conflict=key',
      [{ key: 'dashboard-v3', value: JSON.stringify(state), updated_at: new Date().toISOString() }],
      { Prefer: 'resolution=merge-duplicates,return=minimal' }
    );
  }

  // 로그인한 사용자 전용 행. RLS로 본인 행만 읽고 쓸 수 있다.
  async function userCloud() {
    const jwt = await getAccessToken();
    if (!jwt) throw new Error('로그인이 만료됐어요. 다시 로그인해 주세요.');
    return { ...projectConfig(), jwt };
  }

  async function readUserCloud(config) {
    const response = await request(config, 'GET', 'fitlog_user_state?select=state,updated_at&limit=1');
    const rows = await response.json();
    return rows[0]?.state || null;
  }

  async function writeUserCloud(config, state) {
    await request(
      config,
      'POST',
      'fitlog_user_state?on_conflict=user_id',
      [{ user_id: readSession()?.user?.id, state, updated_at: new Date().toISOString() }],
      { Prefer: 'resolution=merge-duplicates,return=minimal' }
    );
  }

  function setStatus(text, tone = '') {
    const el = $('#syncStatus');
    if (!el) return;
    el.textContent = text;
    el.dataset.tone = tone;
  }

  function showSyncNotice(message) {
    const toast = $('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showSyncNotice.timer);
    showSyncNotice.timer = setTimeout(() => toast.classList.remove('show'), 3200);
  }

  function applyMergedState(state) {
    const serialized = JSON.stringify(state);
    nativeSetItem.call(localStorage, STATE_KEY, serialized);
    window.dispatchEvent(new StorageEvent('storage', {
      key: STATE_KEY,
      newValue: serialized,
      storageArea: localStorage
    }));
    window.dispatchEvent(new CustomEvent('fitlog:state-updated'));
  }

  function describeState(state) {
    const logs = Object.values(state.logs || {});
    return {
      days: logs.length,
      meals: logs.reduce((sum, log) => sum + (log.meals || []).length, 0),
      workouts: logs.reduce((sum, log) => sum + (log.workouts || []).length, 0)
    };
  }

  function renderArchive() {
    const target = $('#archiveList');
    if (!target) return;
    const state = normalizeBackup(readState());
    const dates = Object.keys(state.logs || {}).sort().reverse();
    $('#archiveSummary').textContent = dates.length ? `${dates.length}일의 기록이 보관되어 있어요.` : '보관된 기록이 아직 없어요.';
    target.innerHTML = dates.length ? dates.map(date => {
      const log = state.logs[date] || {};
      const kcal = (log.meals || []).reduce((sum, item) => sum + (+item.kcal || 0), 0);
      return `<div class="sync-history-row"><div><strong>${date}</strong><span>식사 ${(log.meals || []).length}개 · 운동 ${(log.workouts || []).length}개</span></div><b>${Math.round(kcal).toLocaleString()} kcal</b></div>`;
    }).join('') : '<p class="sync-help">백업을 복원하면 이전 날짜가 여기에 표시돼요.</p>';
  }

  const canSync = () => signedIn() || validSync();

  async function syncNow({ reload = false } = {}) {
    if (!canSync() || syncing) return false;
    syncing = true;
    setStatus('동기화하는 중…');
    try {
      const local = seedAiPrefs(readState());
      let config, cloud, write, rowMissing = false;
      if (signedIn()) {
        config = await userCloud();
        cloud = await readUserCloud(config);
        rowMissing = !cloud;
        write = state => writeUserCloud(config, state);
        // 처음 로그인하면 예전 공용 저장소(fitlog_kv)의 기록도 한 번 가져와 합친다.
        if (!cloud && validSync()) cloud = await readCloud(readSync()).catch(() => null);
      } else {
        config = readSync();
        cloud = await readCloud(config);
        write = state => writeCloud(config, state);
      }
      // 로그인 후 첫 동기화에서 계정에 이미 기록이 있으면(새 기기) 프로필·목표는 계정 쪽을 따른다.
      const firstOnDevice = signedIn() && !rowMissing && !readSession().synced;
      const base = firstOnDevice ? { ...local, lastSaved: undefined } : local;
      const merged = cloud ? mergeStates(base, cloud) : normalizeBackup(local);
      const localChanged = stateSignature(readState()) !== stateSignature(merged);
      const cloudChanged = !cloud || stateSignature(cloud) !== stateSignature(merged);
      if (localChanged) applyMergedState(merged);
      applyAiPrefs(merged);
      if (cloudChanged || rowMissing) await write(merged);
      if (signedIn() && !readSession().synced) nativeSetItem.call(localStorage, AUTH_KEY, JSON.stringify({ ...readSession(), synced: true }));
      setStatus(`동기화됨 · ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`, 'ok');
      renderArchive();
      renderAccount();
      if (reload && localChanged) showSyncNotice('다른 기기의 기록을 조용히 반영했어요.');
      return true;
    } catch (error) {
      setStatus(error.message || '동기화하지 못했어요.', 'bad');
      return false;
    } finally {
      syncing = false;
    }
  }

  function scheduleSync() {
    if (!canSync() || syncing) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow(), 900);
  }

  function renderAiStatus() {
    const settings = safeJson(localStorage.getItem(AI_KEY), {}) || {};
    const model = settings.model || 'gpt-5.6-luna';
    let text = '로그인하거나 아래 고급 설정에 AI 연결 토큰을 넣어 주세요.';
    let tone = '';
    if (signedIn()) { text = `로그인으로 AI 사용 중 · ${model} · 토큰 입력 필요 없음`; tone = 'ok'; }
    else if (settings.token && validSync()) { text = `AI 연결 토큰으로 사용 중 · ${model}`; tone = 'ok'; }
    $('#aiStatus').textContent = text;
    $('#aiStatus').dataset.tone = tone;
    $('#aiModel').value = model;
    $('#aiFunction').value = settings.functionName || 'smart-endpoint';
    $('#aiToken').value = settings.token || '';
  }

  let authMode = 'login'; // login | signup | reset

  function renderAccount() {
    const box = $('#accountBox');
    if (!box) return;
    const session = readSession();
    $('#loginBanner')?.classList.toggle('hidden', signedIn() || localStorage.getItem('fitlog:loginBannerOff') === '1');
    if (session?.refresh_token && recoveryMode) {
      box.innerHTML = `
        <p class="sync-help"><b>${session.user?.email || ''}</b> 계정의 새 비밀번호를 정해 주세요.</p>
        <label class="field"><span>새 비밀번호 <small>6자 이상</small></span><input class="input" id="newPassword" type="password" autocomplete="new-password"></label>
        <button class="primary mint full" id="savePassword">비밀번호 저장</button>`;
      $('#savePassword').onclick = async () => {
        const password = $('#newPassword').value;
        if (password.length < 6) return setStatus('비밀번호는 6자 이상으로 정해 주세요.', 'bad');
        try {
          await updatePassword(password);
          recoveryMode = false;
          setStatus('새 비밀번호를 저장했어요.', 'ok');
          renderAccount();
          syncNow({ reload: true });
        } catch (error) {
          setStatus(error.message, 'bad');
        }
      };
      return;
    }
    if (session?.refresh_token) {
      box.innerHTML = `
        <div class="account-on"><span class="account-dot"></span><div><strong>${session.user?.email || '로그인됨'}</strong><small>기록·AI 설정이 이 계정으로 자동 동기화돼요.</small></div></div>
        <div class="sync-actions"><button class="primary mint" id="syncNow">지금 동기화</button><button class="primary ghost" id="logoutBtn">로그아웃</button></div>`;
      $('#syncNow').onclick = () => syncNow({ reload: true });
      $('#logoutBtn').onclick = async () => {
        if (!confirm('로그아웃할까요? 이 기기의 기록은 그대로 남고, 동기화만 멈춰요.')) return;
        await signOut();
        setStatus('로그아웃했어요.');
        renderAccount();
        renderAiStatus();
      };
      return;
    }
    const email = $('#loginEmail')?.value || '';
    const titles = {
      login: ['한 번 로그인하면 휴대폰을 바꾸거나 다른 기기에서 열어도 기록과 AI 설정이 그대로 이어져요.', '로그인'],
      signup: ['처음이면 이메일과 비밀번호를 정해 가입해요. 확인 메일의 링크를 한 번 누르면 끝나요.', '가입하기'],
      reset: ['가입한 이메일로 비밀번호 재설정 링크를 보내드려요.', '재설정 메일 보내기']
    };
    const [help, action] = titles[authMode];
    box.innerHTML = `
      <p class="sync-help">${help}</p>
      <label class="field"><span>이메일</span><input class="input" id="loginEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com"></label>
      ${authMode === 'reset' ? '' : `<label class="field"><span>비밀번호${authMode === 'signup' ? ' <small>6자 이상</small>' : ''}</span><input class="input" id="loginPassword" type="password" autocomplete="${authMode === 'signup' ? 'new-password' : 'current-password'}"></label>`}
      <button class="primary mint full" id="authSubmit">${action}</button>
      <div class="auth-links">${authMode === 'login'
        ? '<button class="link" data-auth-mode="signup">처음이에요 · 가입</button><button class="link" data-auth-mode="reset">비밀번호를 잊었어요</button>'
        : '<button class="link" data-auth-mode="login">로그인으로 돌아가기</button>'}</div>`;
    $('#loginEmail').value = email;
    box.querySelectorAll('[data-auth-mode]').forEach(button => {
      button.onclick = () => { authMode = button.dataset.authMode; setStatus(''); renderAccount(); };
    });
    const submit = async () => {
      const mail = $('#loginEmail').value.trim().toLowerCase();
      const password = $('#loginPassword')?.value || '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return setStatus('이메일 주소를 확인해 주세요.', 'bad');
      if (authMode !== 'reset' && password.length < 6) return setStatus('비밀번호는 6자 이상이에요.', 'bad');
      const button = $('#authSubmit');
      button.disabled = true;
      try {
        if (authMode === 'reset') {
          setStatus('메일을 보내는 중…');
          await requestReset(mail);
          setStatus('재설정 메일을 보냈어요. 메일 속 링크를 이 기기에서 눌러 주세요.', 'ok');
          return;
        }
        if (authMode === 'signup') {
          setStatus('가입하는 중…');
          const result = await signUp(mail, password);
          if (result.needsConfirm) {
            authMode = 'login';
            renderAccount();
            $('#loginEmail').value = mail;
            setStatus('확인 메일을 보냈어요. 메일 속 링크를 누른 뒤 여기서 로그인해 주세요.', 'ok');
            return;
          }
        } else {
          setStatus('로그인하는 중…');
          await signIn(mail, password);
        }
        authMode = 'login';
        setStatus('로그인했어요. 기록을 합치는 중…', 'ok');
        renderAccount();
        renderAiStatus();
        await syncNow({ reload: true });
        window.dispatchEvent(new CustomEvent('fitlog:state-updated'));
      } catch (error) {
        setStatus(error.message, 'bad');
      } finally {
        if ($('#authSubmit')) $('#authSubmit').disabled = false;
      }
    };
    $('#authSubmit').onclick = submit;
    box.querySelectorAll('input').forEach(input => input.addEventListener('keydown', event => { if (event.key === 'Enter') submit(); }));
  }

  // 홈 상단: 로그인 전에만 한 줄 안내를 띄운다.
  function installLoginBanner() {
    const home = $('[data-view="home"] .content');
    if (!home || $('#loginBanner')) return;
    const banner = document.createElement('div');
    banner.id = 'loginBanner';
    banner.className = 'login-banner hidden';
    banner.innerHTML = '<span>🔐 로그인하면 기기를 바꿔도 기록·AI 설정이 그대로예요.</span><button type="button" class="link" data-login-go>로그인</button><button type="button" class="link close" data-login-off aria-label="닫기">×</button>';
    const header = home.querySelector('header');
    header ? header.after(banner) : home.prepend(banner);
    banner.addEventListener('click', event => {
      if (event.target.closest('[data-login-go]')) {
        location.hash = 'more';
        setTimeout(() => $('#accountBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 250);
      }
      if (event.target.closest('[data-login-off]')) {
        nativeSetItem.call(localStorage, 'fitlog:loginBannerOff', '1');
        banner.classList.add('hidden');
      }
    });
  }

  function installUi() {
    const more = $('[data-view="more"] .content');
    if (!more || $('#syncPanel')) return;
    const heads = [...more.querySelectorAll('.section-head')];
    const dataHeading = heads.find(el => el.textContent.includes('저장과 백업')) || heads.find(el => el.textContent.includes('데이터 관리'));
    const panel = document.createElement('div');
    panel.id = 'syncPanel';
    panel.innerHTML = `
      <div class="section-head"><h2>로그인 · 자동 동기화</h2></div>
      <section class="card sync-card">
        <div id="accountBox"></div>
        <p id="syncStatus" class="sync-status" role="status"></p>
        <details class="sync-advanced"><summary>고급: Supabase 직접 연결</summary>
          <p class="sync-help">로그인을 쓰면 필요 없어요. 예전 방식(공용 저장소)으로 연결하거나, 이 기기에 anon public 키가 없을 때 한 번 입력해요.</p>
          <label class="field"><span>Supabase 프로젝트 URL</span><input class="input" id="syncUrl" inputmode="url" placeholder="https://프로젝트.supabase.co"></label>
          <label class="field"><span>anon public 키</span><input class="input" id="syncKeyInput" type="password" autocomplete="off" placeholder="eyJ…"></label>
          <button class="primary full" id="saveSync">연결 저장</button>
        </details>
      </section>
      <div class="section-head"><h2>OpenAI GPT 연결</h2></div>
      <section class="card sync-card">
        <p id="aiStatus" class="sync-status"></p>
        <label class="field"><span>모델 <small>음식 분석·식단 추천에 사용 · 계정에 저장돼요</small></span><select class="select" id="aiModel"><option value="gpt-5.6-luna">GPT-5.6 Luna · 추천/절약형</option><option value="gpt-5.6-terra">GPT-5.6 Terra · 균형형</option><option value="gpt-5.6-sol">GPT-5.6 Sol · 고성능</option></select></label>
        <details class="sync-advanced"><summary>고급: 함수 이름 · 연결 토큰</summary>
          <label class="field"><span>Supabase 함수 이름</span><input class="input" id="aiFunction" value="smart-endpoint" placeholder="예: smart-endpoint"></label>
          <label class="field"><span>AI 연결 토큰 <small>로그인하면 비워 둬도 돼요</small></span><input class="input" id="aiToken" type="password" autocomplete="off" placeholder="Supabase 함수에 설정한 토큰"></label>
        </details>
        <button class="primary mint full" id="saveAi">GPT 설정 저장</button>
        <p class="sync-help">OpenAI API 키는 휴대폰에 저장하지 않고 Supabase 함수에만 보관합니다.</p>
      </section>
      <div class="section-head"><h2>기록 보관함</h2></div>
      <section class="card sync-card"><p id="archiveSummary" class="sync-help"></p><div id="archiveList"></div></section>`;
    more.insertBefore(panel, dataHeading || null);

    const style = document.createElement('style');
    style.textContent = `.sync-card{padding:15px}.sync-help{margin:0 0 12px;color:var(--sub);font-size:12px;line-height:1.55}.sync-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.sync-status{min-height:20px;margin:10px 0 0;color:var(--sub);font-size:12px}.sync-status:empty{min-height:0;margin:0}.sync-status[data-tone="ok"]{color:#2f8467}.sync-status[data-tone="bad"]{color:#b05243}.sync-history-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)}.sync-history-row:last-child{border-bottom:0}.sync-history-row strong,.sync-history-row span{display:block}.sync-history-row strong{font-size:13px}.sync-history-row span{margin-top:2px;color:var(--sub);font-size:12px}.sync-history-row b{font-size:12px;white-space:nowrap}
      .account-on{display:flex;align-items:center;gap:10px;margin-bottom:12px}.account-on strong{display:block;font-size:14px;word-break:break-all}.account-on small{display:block;margin-top:2px;color:var(--sub);font-size:12px}.account-dot{flex:none;width:10px;height:10px;border-radius:50%;background:#3fb68b;box-shadow:0 0 0 4px #3fb68b22}
      .primary.ghost{background:transparent;color:var(--ink,#222);border:1px solid var(--line)}.auth-links{display:flex;justify-content:center;gap:6px;margin-top:8px}.auth-links .link{padding:4px 6px;font-size:12px}
      .sync-advanced{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}.sync-advanced summary{cursor:pointer;color:var(--sub);font-size:12px;font-weight:700;margin-bottom:8px}.sync-advanced[open] summary{margin-bottom:12px}
      .login-banner{display:flex;align-items:center;gap:6px;margin:0 0 12px;padding:10px 12px;border-radius:14px;background:#eef7f3;font-size:12.5px;line-height:1.45}.login-banner span{flex:1}.login-banner .link{padding:4px 6px;font-size:12.5px;font-weight:800;white-space:nowrap}.login-banner .close{color:var(--sub);font-weight:400;font-size:16px}.login-banner.hidden{display:none}`;
    document.head.appendChild(style);

    const config = readSync();
    $('#syncUrl').value = config.url || '';
    $('#syncKeyInput').value = config.key || '';
    if (!signedIn() && validSync(config)) setStatus('지금은 예전 방식으로 동기화 중이에요. 로그인하면 계정 전용 저장소로 옮겨져요.');
    installLoginBanner();
    renderAccount();
    renderArchive();
    renderAiStatus();

    $('#saveSync').onclick = async () => {
      const next = { url: normalizeProjectUrl($('#syncUrl').value) || PROJECT_URL, key: $('#syncKeyInput').value.trim() };
      if (!next.key) return setStatus('anon public 키를 입력해 주세요.', 'bad');
      nativeSetItem.call(localStorage, SYNC_KEY, JSON.stringify(next));
      setStatus('저장했어요. 이제 이메일로 로그인할 수 있어요.', 'ok');
      if (signedIn()) await syncNow({ reload: true });
    };
    $('#saveAi').onclick = () => {
      const current = safeJson(localStorage.getItem(AI_KEY), {}) || {};
      const next = {
        ...current,
        provider: 'openai',
        functionName: $('#aiFunction').value.trim() || 'smart-endpoint',
        model: $('#aiModel').value,
        token: $('#aiToken').value.trim()
      };
      delete next.proxyUrl;
      localStorage.setItem(AI_KEY, JSON.stringify(next));
      renderAiStatus();
      sessionStorage.setItem('fitlog:notice', 'GPT 설정을 저장했어요.');
      location.reload();
    };
  }

  function installRestoreFix() {
    const input = $('#restore');
    if (!input) return;
    input.onchange = async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const incoming = normalizeBackup(JSON.parse(await file.text()));
        if (!incoming.profile || !incoming.logs) throw new Error('형식 오류');
        const merged = mergeStates(readState(), incoming);
        nativeSetItem.call(localStorage, STATE_KEY, JSON.stringify(merged));
        const info = describeState(merged);
        sessionStorage.setItem('fitlog:notice', `복원 완료 · ${info.days}일 · 식사 ${info.meals}개 · 운동 ${info.workouts}개`);
        if (canSync()) await syncNow();
        location.hash = 'more';
        location.reload();
      } catch {
        sessionStorage.setItem('fitlog:notice', '백업 파일 형식을 확인해 주세요.');
        location.reload();
      } finally {
        event.target.value = '';
      }
    };
  }

  Storage.prototype.setItem = function(key, value) {
    nativeSetItem.call(this, key, value);
    if (this !== localStorage) return;
    if (key === STATE_KEY) scheduleSync();
    // 모델·함수 이름을 바꾸면 기록에도 적어 두어 다른 기기로 넘어가게 한다.
    if (key === AI_KEY) {
      const prefs = aiPrefsFrom(safeJson(value, {}));
      const state = readState();
      const { updatedAt, ...saved } = state.settings?.ai || {};
      if (stableJson(prefs) === stableJson(saved)) return;
      state.settings = { ...(state.settings || {}), ai: { ...prefs, updatedAt: new Date().toISOString() } };
      applyMergedState(state);
      scheduleSync();
    }
  };

  installUi();
  installRestoreFix();
  const notice = sessionStorage.getItem('fitlog:notice');
  if (notice) {
    sessionStorage.removeItem('fitlog:notice');
    setTimeout(() => {
      const toast = $('#toast');
      if (!toast) return;
      toast.textContent = notice;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 4200);
    }, 100);
  }
  const linkHandled = consumeAuthLink().then(() => {
    renderAccount();
    renderAiStatus();
    if (!linkNotice) return;
    setStatus(linkNotice, /못했|만료/.test(linkNotice) ? 'bad' : 'ok');
    showSyncNotice(linkNotice);
    setTimeout(() => {
      window.FitLogCore?.goTo?.('more');
      $('#accountBox')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 300);
  });
  linkHandled.then(() => { if (canSync()) syncNow({ reload: true }); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && canSync()) syncNow({ reload: true }); });
  setInterval(() => { if (!document.hidden && canSync()) syncNow({ reload: true }); }, 60000);
})();
