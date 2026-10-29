const KEY = 'iptv-player:v1';

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && Array.isArray(s.playlists)) {
        return { playlists: s.playlists, activeId: s.activeId || null };
      }
    }
  } catch {
    /* 忽略损坏的数据 */
  }
  return { playlists: [], activeId: null };
}

/** @returns {boolean} 是否保存成功 */
export function saveState(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}
