import { parseM3U, serializeM3U } from './m3u.js';
import { loadState, saveState } from './store.js';

/* ---------------- 状态 ---------------- */
let state = loadState();
let activeGroup = '';
let searchKw = '';
let currentTab = 'url';
let current = { playlistId: null, index: -1 }; // 正在播放
let hls = null;
let mediaRecoverTried = false;
let currentStreamUrl = '';
let deferredPrompt = null;

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ---------------- 工具 ---------------- */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function toast(msg, type = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toastWrap').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function activePlaylist() {
  return state.playlists.find((p) => p.id === state.activeId) || null;
}
function persist() {
  if (!saveState(state)) {
    toast('保存失败：浏览器 Local Storage 空间不足，请删除部分播放列表', 'err', 5000);
  }
}
function mixedContentBlocked(url) {
  return location.protocol === 'https:' && /^http:/i.test(url);
}

/* ---------------- 数据视图 ---------------- */
function visibleChannels() {
  const pl = activePlaylist();
  if (!pl) return [];
  const kw = searchKw.toLowerCase();
  return pl.channels
    .map((ch, index) => ({ ch, index }))
    .filter(({ ch }) => {
      if (activeGroup) {
        const groups = (ch.group || '').split(';').map((g) => g.trim()).filter(Boolean);
        if (!groups.includes(activeGroup)) return false;
      }
      if (kw && !(ch.name || '').toLowerCase().includes(kw)) return false;
      return true;
    });
}

function groupStats() {
  const pl = activePlaylist();
  const map = new Map();
  if (pl) {
    for (const ch of pl.channels) {
      const groups = (ch.group || '').split(';').map((g) => g.trim()).filter(Boolean);
      if (!groups.length) groups.push('未分组');
      for (const g of groups) map.set(g, (map.get(g) || 0) + 1);
    }
  }
  return map;
}

/* ---------------- 渲染 ---------------- */
function renderPlaylistSelect() {
  const sel = $('#playlistSelect');
  sel.innerHTML = '';
  if (!state.playlists.length) {
    const opt = document.createElement('option');
    opt.textContent = '（无播放列表）';
    sel.appendChild(opt);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const p of state.playlists) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name}（${p.channels.length}）`;
    sel.appendChild(opt);
  }
  sel.value = state.activeId || state.playlists[0].id;
}

function renderGroups() {
  const wrap = $('#groupList');
  wrap.innerHTML = '';
  const pl = activePlaylist();
  if (!pl) return;
  const stats = groupStats();

  const allBtn = document.createElement('button');
  allBtn.className = 'group-item' + (activeGroup === '' ? ' active' : '');
  allBtn.innerHTML = `<span class="group-name">全部频道</span><span class="g-count">${pl.channels.length}</span>`;
  allBtn.onclick = () => { activeGroup = ''; renderGroups(); renderChannels(); };
  wrap.appendChild(allBtn);

  for (const [g, count] of [...stats.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const btn = document.createElement('button');
    btn.className = 'group-item' + (activeGroup === g ? ' active' : '');
    btn.innerHTML = `<span class="group-name" title="${esc(g)}">${esc(g)}</span><span class="g-count">${count}</span>`;
    btn.onclick = () => { activeGroup = g; renderGroups(); renderChannels(); };
    wrap.appendChild(btn);
  }
}

function badgesOf(ch) {
  const badges = [];
  const q = (ch.name || '').match(/\((\d{3,4}p)\)/);
  if (q) badges.push({ text: q[1], cls: 'quality' });
  const tags = (ch.name || '').match(/\[([^\]]+)\]/g) || [];
  for (const t of tags) badges.push({ text: t.replace(/[[\]]/g, ''), cls: 'warn' });
  const firstGroup = (ch.group || '').split(';')[0]?.trim();
  if (firstGroup) badges.push({ text: firstGroup, cls: '' });
  return badges;
}

function renderChannels() {
  const grid = $('#channelGrid');
  const list = visibleChannels();
  const pl = activePlaylist();

  $('#channelCount').textContent = pl ? `${list.length} / ${pl.channels.length} 个频道` : '';
  $('#emptyState').classList.toggle('hidden', state.playlists.length > 0);
  grid.innerHTML = '';
  if (!pl) return;

  if (!list.length) {
    grid.innerHTML = '<div class="empty"><p>没有匹配的频道</p></div>';
    return;
  }

  const frag = document.createDocumentFragment();
  for (const { ch, index } of list) {
    const card = document.createElement('div');
    const isPlaying = current.playlistId === pl.id && current.index === index;
    card.className = 'channel-card' + (isPlaying ? ' playing' : '');
    card.dataset.index = index;
    const badges = badgesOf(ch)
      .map((b) => `<span class="badge ${b.cls}">${esc(b.text)}</span>`)
      .join('');
    card.innerHTML = `
      <div class="channel-logo">
        ${ch.logo
          ? `<img loading="lazy" src="${esc(ch.logo)}" alt="" onerror="this.parentElement.innerHTML='<span class=&quot;fallback&quot;>📺</span>'">`
          : '<span class="fallback">📺</span>'}
      </div>
      <div class="channel-info">
        <div class="channel-name">${esc(ch.name)}</div>
        <div class="channel-badges">${badges}</div>
      </div>`;
    frag.appendChild(card);
  }
  grid.appendChild(frag);
}

function renderManageList() {
  const wrap = $('#manageList');
  wrap.innerHTML = '';
  if (!state.playlists.length) {
    wrap.innerHTML = '<div class="manage-empty">暂无播放列表</div>';
    return;
  }
  const sourceLabel = { url: '在线 URL', file: '本地文件', paste: '剪贴板' };
  for (const p of state.playlists) {
    const item = document.createElement('div');
    item.className = 'manage-item' + (p.id === state.activeId ? ' active' : '');
    const srcText = p.source?.type === 'url'
      ? `在线 URL · ${esc(p.source.url || '')}`
      : p.source?.type === 'file'
        ? `本地文件 · ${esc(p.source.fileName || '')}`
        : sourceLabel[p.source?.type] || '未知来源';
    item.innerHTML = `
      <div class="manage-info">
        <div class="manage-name">
          <span>${esc(p.name)}</span>
          ${p.id === state.activeId ? '<span class="active-tag">当前</span>' : ''}
        </div>
        <div class="manage-meta">${srcText} · ${p.channels.length} 个频道 · 更新于 ${fmtTime(p.updatedAt)}</div>
      </div>
      <div class="manage-actions">
        ${p.id !== state.activeId ? '<button class="btn small" data-act="switch">切换</button>' : ''}
        ${p.source?.type === 'url' ? '<button class="btn small ghost" data-act="refresh">刷新</button>' : ''}
        <button class="btn small ghost" data-act="rename">重命名</button>
        <button class="btn small ghost" data-act="export">导出</button>
        <button class="btn small danger" data-act="delete">删除</button>
      </div>`;
    item.querySelector('[data-act="rename"]').onclick = () => renamePlaylist(p.id);
    item.querySelector('[data-act="delete"]').onclick = () => deletePlaylist(p.id);
    item.querySelector('[data-act="export"]').onclick = () => exportPlaylist(p.id);
    const sw = item.querySelector('[data-act="switch"]');
    if (sw) sw.onclick = () => switchPlaylist(p.id);
    const rf = item.querySelector('[data-act="refresh"]');
    if (rf) rf.onclick = () => refreshPlaylist(p.id, rf);
    wrap.appendChild(item);
  }
}

function renderAll() {
  renderPlaylistSelect();
  renderGroups();
  renderChannels();
  renderManageList();
}

/* ---------------- 播放 ---------------- */
function destroyHls() {
  if (hls) {
    try { hls.destroy(); } catch { /* ignore */ }
    hls = null;
  }
  mediaRecoverTried = false;
}

function showPlayerError(msg) {
  $('#playerErrorMsg').textContent = msg;
  $('#playerError').classList.remove('hidden');
}
function hidePlayerError() {
  $('#playerError').classList.add('hidden');
}

function startPlayback(url) {
  const video = $('#video');
  currentStreamUrl = url;
  destroyHls();
  hidePlayerError();
  video.pause();
  video.removeAttribute('src');
  video.load();

  if (mixedContentBlocked(url)) {
    showPlayerError(
      '无法播放：当前页面为 HTTPS，浏览器禁止加载不安全的 HTTP 流。\n' + url +
      '\n\n这是浏览器安全限制，可尝试在本地 (http://localhost) 部署本应用后播放该频道。'
    );
    return;
  }

  const isM3U8 = /\.m3u8?(\?|$)/i.test(url);
  if (isM3U8 && window.Hls && window.Hls.isSupported()) {
    hls = new window.Hls({ enableWorker: true, backBufferLength: 60 });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => { });
    });
    hls.on(window.Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        showPlayerError('网络错误：无法加载该流（可能源站离线、地域限制或 CORS 限制）。\n可尝试上一个 / 下一个频道。');
      } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        if (!mediaRecoverTried) {
          mediaRecoverTried = true;
          hls.recoverMediaError();
        } else {
          showPlayerError('媒体解码错误，无法播放该频道。');
        }
      } else {
        showPlayerError('播放失败：' + (data.details || '未知错误'));
      }
    });
  } else {
    // Safari 原生 HLS 或其它直链媒体
    video.src = url;
    video.play().catch(() => { });
  }
}

function playChannel(index) {
  const pl = activePlaylist();
  if (!pl || !pl.channels[index]) return;
  current = { playlistId: pl.id, index };
  const ch = pl.channels[index];

  $('#playerName').textContent = ch.name;
  $('#playerMeta').textContent = [
    (ch.group || '').split(';').map((g) => g.trim()).filter(Boolean).join(' / '),
    ch.tvgId,
  ].filter(Boolean).join(' · ');
  const logo = $('#playerLogo');
  logo.src = ch.logo || '';
  logo.classList.toggle('hidden', !ch.logo);

  $('#playerOverlay').classList.remove('hidden');
  startPlayback(ch.url);
  renderChannels();
  updateBanner();
}

function stepChannel(dir) {
  const list = visibleChannels();
  if (!list.length) return;
  const pl = activePlaylist();
  const pos = list.findIndex(({ index }) => current.playlistId === pl?.id && index === current.index);
  const next = pos === -1 ? 0 : (pos + dir + list.length) % list.length;
  playChannel(list[next].index);
}

function minimizePlayer() {
  $('#playerOverlay').classList.add('hidden');
  updateBanner();
}

function stopPlayback() {
  destroyHls();
  const video = $('#video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  current = { playlistId: null, index: -1 };
  $('#playerOverlay').classList.add('hidden');
  updateBanner();
  renderChannels();
}

function updateBanner() {
  const banner = $('#playerBanner');
  const playing = current.index >= 0 && state.playlists.some((p) => p.id === current.playlistId);
  banner.classList.toggle('hidden', !playing || !$('#playerOverlay').classList.contains('hidden'));
  if (playing) {
    const pl = state.playlists.find((p) => p.id === current.playlistId);
    $('#bannerName').textContent = pl?.channels[current.index]?.name || '';
  }
}

/* ---------------- 播放列表操作 ---------------- */
function switchPlaylist(id) {
  if (state.activeId === id) return;
  state.activeId = id;
  activeGroup = '';
  searchKw = '';
  $('#searchInput').value = '';
  persist();
  renderAll();
  toast('已切换播放列表', 'ok', 1600);
}

function renamePlaylist(id) {
  const p = state.playlists.find((x) => x.id === id);
  if (!p) return;
  const name = prompt('输入新的播放列表名称：', p.name);
  if (name && name.trim()) {
    p.name = name.trim();
    p.updatedAt = Date.now();
    persist();
    renderAll();
  }
}

function deletePlaylist(id) {
  const p = state.playlists.find((x) => x.id === id);
  if (!p) return;
  if (!confirm(`确定删除播放列表「${p.name}」吗？`)) return;
  state.playlists = state.playlists.filter((x) => x.id !== id);
  if (state.activeId === id) state.activeId = state.playlists[0]?.id || null;
  if (current.playlistId === id) stopPlayback();
  activeGroup = '';
  persist();
  renderAll();
  toast('已删除', 'ok', 1600);
}

function exportPlaylist(id) {
  const p = state.playlists.find((x) => x.id === id);
  if (!p) return;
  const blob = new Blob([serializeM3U(p)], { type: 'audio/x-mpegurl;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${p.name.replace(/[\\/:*?"<>|]/g, '_')}.m3u`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function refreshPlaylist(id, btn) {
  const p = state.playlists.find((x) => x.id === id);
  if (!p || p.source?.type !== 'url') return;
  btn.disabled = true;
  btn.textContent = '刷新中…';
  try {
    const text = await fetchPlaylistText(p.source.url);
    const parsed = parseM3U(text);
    if (!parsed.channels.length) throw new Error('未解析到任何频道');
    p.channels = parsed.channels;
    p.updatedAt = Date.now();
    persist();
    renderAll();
    toast(`「${p.name}」已刷新：${parsed.channels.length} 个频道`, 'ok');
  } catch (err) {
    toast('刷新失败：' + (err.message || err), 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '刷新';
  }
}

/* ---------------- 获取远程列表 ---------------- */
async function fetchPlaylistText(url) {
  const attempts = [
    { label: 'direct', target: url },
    { label: 'allorigins', target: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url) },
    { label: 'corsproxy', target: 'https://corsproxy.io/?url=' + encodeURIComponent(url) },
  ];
  let lastErr = null;
  for (const { target } of attempts) {
    try {
      const res = await fetch(target, { redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (!text || !text.trim()) throw new Error('内容为空');
      return text;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error('获取失败（' + (lastErr?.message || lastErr) + '），请检查地址或稍后重试');
}

/* ---------------- 添加列表 ---------------- */
function defaultName(source) {
  if (source.type === 'url') {
    try { return new URL(source.url).hostname; } catch { return '在线列表'; }
  }
  if (source.type === 'file') {
    return (source.fileName || '本地文件').replace(/\.[^.]+$/, '');
  }
  return '剪贴板导入 ' + new Date().toLocaleString('zh-CN', { hour12: false });
}

function setStatus(text) {
  $('#addStatus').textContent = text || '';
}

async function confirmAdd() {
  const customName = $('#nameInput').value.trim();
  const btn = $('#btnConfirmAdd');
  btn.disabled = true;
  try {
    let text = '';
    let source = null;
    if (currentTab === 'url') {
      const url = $('#urlInput').value.trim();
      if (!url) throw new Error('请输入播放列表地址');
      setStatus('正在获取…');
      text = await fetchPlaylistText(url);
      source = { type: 'url', url };
    } else if (currentTab === 'file') {
      const f = $('#fileInput').files[0];
      if (!f) throw new Error('请选择一个文件');
      text = await f.text();
      source = { type: 'file', fileName: f.name };
    } else {
      text = $('#pasteInput').value;
      if (!text.trim()) throw new Error('请粘贴播放列表内容');
      source = { type: 'paste' };
    }

    setStatus('正在解析…');
    const parsed = parseM3U(text);
    if (!parsed.channels.length) throw new Error('未解析到任何频道，请确认内容为 M3U 格式');

    const pl = {
      id: uid(),
      name: customName || parsed.name || defaultName(source),
      source,
      channels: parsed.channels,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    state.playlists.push(pl);
    state.activeId = pl.id;
    activeGroup = '';
    persist();
    closeAddModal();
    renderAll();
    toast(`已添加「${pl.name}」（${pl.channels.length} 个频道）`, 'ok');
  } catch (err) {
    setStatus('');
    toast(err.message || String(err), 'err', 4500);
  } finally {
    btn.disabled = false;
  }
}

function resetAddForm() {
  $('#urlInput').value = '';
  $('#fileInput').value = '';
  $('#pasteInput').value = '';
  $('#nameInput').value = '';
  setStatus('');
}

function openAddModal() {
  resetAddForm();
  $('#addModal').classList.remove('hidden');
}
function closeAddModal() {
  $('#addModal').classList.add('hidden');
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  $('#btnAdd').onclick = openAddModal;
  $('#emptyAdd').onclick = openAddModal;
  $('#btnManage').onclick = () => { renderManageList(); $('#manageModal').classList.remove('hidden'); };
  $('#btnConfirmAdd').onclick = confirmAdd;

  $('#playlistSelect').onchange = (e) => switchPlaylist(e.target.value);

  $('#searchInput').oninput = (e) => { searchKw = e.target.value.trim(); renderChannels(); };

  $('#channelGrid').onclick = (e) => {
    const card = e.target.closest('.channel-card');
    if (card && card.dataset.index !== undefined) playChannel(Number(card.dataset.index));
  };

  // 播放器
  $('#btnPrev').onclick = () => stepChannel(-1);
  $('#btnNext').onclick = () => stepChannel(1);
  $('#btnMinimize').onclick = minimizePlayer;
  $('#btnClosePlayer').onclick = stopPlayback;
  $('#bannerOpen').onclick = () => { $('#playerOverlay').classList.remove('hidden'); updateBanner(); };
  $('#bannerStop').onclick = stopPlayback;
  $('#btnOpenStreamTab').onclick = () => {
    if (currentStreamUrl) window.open(currentStreamUrl, '_blank', 'noopener');
  };
  $('#video').addEventListener('error', () => {
    const video = $('#video');
    if (video.src && !hls) {
      showPlayerError('播放失败：无法加载该媒体（源站离线或格式不受支持）。');
    }
  });

  // 模态框关闭
  $$('.modal-close').forEach((btn) => {
    btn.onclick = () => document.getElementById(btn.dataset.close).classList.add('hidden');
  });
  $$('.modal').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
  });

  // Tabs
  $$('.tab').forEach((tab) => {
    tab.onclick = () => {
      currentTab = tab.dataset.tab;
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $$('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== currentTab));
    };
  });

  // 剪贴板读取
  $('#btnReadClipboard').onclick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) throw new Error('剪贴板为空');
      $('#pasteInput').value = text;
      toast('已从剪贴板读取', 'ok', 1600);
    } catch {
      toast('无法读取剪贴板，请在输入框中手动粘贴（Ctrl+V）', 'err', 4000);
    }
  };

  // 键盘：播放器打开时 ← → 切台，Esc 收起
  document.addEventListener('keydown', (e) => {
    if (!$('#playerOverlay').classList.contains('hidden')) {
      if (e.key === 'ArrowLeft') stepChannel(-1);
      else if (e.key === 'ArrowRight') stepChannel(1);
      else if (e.key === 'Escape') minimizePlayer();
    }
  });

  // PWA 安装
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $('#btnInstall').classList.remove('hidden');
  });
  $('#btnInstall').onclick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('#btnInstall').classList.add('hidden');
  };
}

/* ---------------- 启动 ---------------- */
function init() {
  if (!state.activeId || !state.playlists.some((p) => p.id === state.activeId)) {
    state.activeId = state.playlists[0]?.id || null;
  }
  bindEvents();
  renderAll();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(() => { });
    });
  }
}

init();
