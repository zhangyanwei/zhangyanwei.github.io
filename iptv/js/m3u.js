/**
 * M3U / M3U8 播放列表解析与序列化
 */

/**
 * 解析 #EXTINF 行，提取属性与频道名称。
 * 兼容部分列表生成器产生的脏数据（例如属性中混入未闭合引号）。
 */
function parseExtInf(line) {
  const body = line.slice(line.indexOf(':') + 1);
  const attrs = {};
  const attrRe = /([A-Za-z0-9-]+)="([^"]*)"/g;
  let m;
  while ((m = attrRe.exec(body)) !== null) {
    attrs[m[1].toLowerCase()] = m[2];
  }
  // 去掉成对属性与时长，剩余部分提取频道名
  let rest = body.replace(attrRe, '').replace(/^\s*-?\d+(\.\d+)?\s*/, '');

  let name = '';
  const ci = rest.indexOf(',');
  if (ci >= 0) {
    let candidate = rest.slice(ci + 1).trim();
    // 若候选名中仍残留属性碎片 / 未闭合引号，取最后一个逗号段
    if (/["=]/.test(candidate)) {
      const segs = rest.split(',').map((s) => s.trim()).filter(Boolean);
      candidate = segs.length ? segs[segs.length - 1] : '';
    }
    name = candidate.replace(/^[\s"']+|[\s"']+$/g, '');
  } else {
    name = rest.replace(/^[\s,"']+|[\s,"']+$/g, '');
  }
  return { attrs, name };
}

/**
 * 解析 M3U 文本。
 * @returns {{ name: string, channels: Array<{name:string,url:string,logo:string,group:string,tvgId:string}> }}
 */
export function parseM3U(text) {
  const lines = String(text || '').split(/\r?\n/);
  const channels = [];
  let playlistName = '';
  let pending = null;
  let pendingGroup = '';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      if (/^#PLAYLIST:/i.test(line)) {
        playlistName = line.slice(line.indexOf(':') + 1).trim();
      } else if (/^#EXTINF:/i.test(line)) {
        pending = parseExtInf(line);
      } else if (/^#EXTGRP:/i.test(line)) {
        pendingGroup = line.slice(line.indexOf(':') + 1).trim();
      }
      continue;
    }

    // 媒体行（频道地址）
    const url = line;
    channels.push({
      name: (pending && pending.name) || url,
      url,
      logo: (pending && pending.attrs['tvg-logo']) || '',
      group: (pending && pending.attrs['group-title']) || pendingGroup || '',
      tvgId: (pending && pending.attrs['tvg-id']) || '',
    });
    pending = null;
    pendingGroup = '';
  }

  return { name: playlistName, channels };
}

/** 序列化为 M3U 文本（用于导出） */
export function serializeM3U(playlist) {
  const lines = ['#EXTM3U'];
  if (playlist.name) lines.push(`#PLAYLIST:${playlist.name}`);
  for (const ch of playlist.channels) {
    const attrs = [];
    if (ch.tvgId) attrs.push(`tvg-id="${ch.tvgId}"`);
    if (ch.logo) attrs.push(`tvg-logo="${ch.logo}"`);
    if (ch.group) attrs.push(`group-title="${ch.group}"`);
    lines.push(`#EXTINF:-1${attrs.length ? ' ' + attrs.join(' ') : ''},${ch.name}`);
    lines.push(ch.url);
  }
  return lines.join('\n') + '\n';
}
