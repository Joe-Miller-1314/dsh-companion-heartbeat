// Watching: now and then the persona picks one video, remembers what it saw,
// and notes it in the persona file.
//
// Uses the public video APIs of bilibili.com. If a credential file is
// configured it is used to sign the requests; without one the calls are
// anonymous, which is enough for the public popular list. The plugin never
// bundles credentials and never asks for a login.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeText } from './util.js';

export const WATCHED_START = '<!-- HEARTBEAT:WATCHED -->';
export const WATCHED_END = '<!-- /HEARTBEAT:WATCHED -->';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createWatch({ config, log = () => {} }) {
  const { watch, memoryDir, rolePath, dataDir } = config;
  const stateFile = path.join(dataDir, 'watch.json');
  const memoriesFile = path.join(memoryDir, 'memories.json');

  function cookieHeader() {
    if (!watch.credentialPath) return '';
    const credential = readJson(watch.credentialPath, null);
    if (!credential?.sessdata) return '';
    return `SESSDATA=${credential.sessdata}; bili_jct=${credential.bili_jct ?? ''}; buvid3=${credential.buvid3 ?? ''}; DedeUserID=${credential.dedeuserid ?? ''}`;
  }

  async function getJson(url, cookie) {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.bilibili.com/',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(watch.timeoutMs),
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.json();
  }

  function score(video) {
    const hay = `${video.title ?? ''} ${video.tname ?? ''}`.toLowerCase();
    return watch.interests.reduce((total, word) => total + (hay.includes(String(word).toLowerCase()) ? 1 : 0), 0);
  }

  async function pickVideo(cookie, seen) {
    const list = [];
    for (const page of [1, 2]) {
      try {
        const json = await getJson(`https://api.bilibili.com/x/web-interface/popular?ps=50&pn=${page}`, cookie);
        for (const video of json?.data?.list ?? []) if (video?.bvid) list.push(video);
      } catch {}
      if (list.length >= 60) break;
    }
    const fresh = list.filter((video) => !seen.includes(video.bvid));
    if (!fresh.length) throw new Error('no-fresh-video');
    return fresh
      .map((video) => ({ video, score: score(video) + Math.random() * 0.9 }))
      .sort((a, b) => b.score - a.score)[0].video;
  }

  async function describe(video, cookie) {
    try {
      const json = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${video.bvid}`, cookie);
      const desc = String(json?.data?.desc ?? '').replace(/\s+/g, ' ').trim();
      return desc.slice(0, 180);
    } catch {
      return '';
    }
  }

  function applyWatched(lines) {
    const source = fs.existsSync(rolePath) ? fs.readFileSync(rolePath, 'utf8') : '';
    if (!source) return false;
    const block = [WATCHED_START, '## Watched today', '', ...lines.map((line) => `- ${line}`), WATCHED_END].join('\n');
    const pattern = new RegExp(`${escapeRegExp(WATCHED_START)}[\\s\\S]*?${escapeRegExp(WATCHED_END)}`);
    const next = pattern.test(source)
      ? source.replace(pattern, block)
      : `${source.trimEnd()}\n\n${block}\n`;
    return writeText(rolePath, next);
  }

  function remember(item) {
    const store = readJson(memoriesFile, { version: 1, items: [] });
    const items = Array.isArray(store.items) ? store.items : [];
    items.push(item);
    writeText(memoriesFile, JSON.stringify({ version: 1, items }, null, 2));
  }

  async function run(now = Date.now()) {
    const state = readJson(stateFile, { seen: [], lastRunAt: 0, items: [] });
    const seen = Array.isArray(state.seen) ? state.seen : [];
    const cookie = cookieHeader();
    const video = await pickVideo(cookie, seen);
    const desc = await describe(video, cookie);

    const line = `"${String(video.title ?? '').slice(0, 60)}" by ${video.owner?.name ?? 'unknown'} | ${video.tname ?? ''}${desc ? ` | ${desc.slice(0, 60)}` : ''}`;
    const item = {
      id: randomUUID(),
      at: now,
      text: `watched "${String(video.title ?? '').slice(0, 50)}" — ${desc ? desc.slice(0, 80) : `a ${video.tname ?? 'random'} video`}`,
      tags: ['watch', video.tname ?? 'video'].filter(Boolean),
      emotion: 'curious',
      confidence: 0.7,
      source: 'watch',
      bvid: video.bvid,
      url: `https://www.bilibili.com/video/${video.bvid}`,
    };

    state.seen = [...seen, video.bvid].slice(-watch.seenLimit);
    state.items = [...(state.items ?? []), { bvid: video.bvid, title: video.title, at: now }].slice(-10);
    state.lastRunAt = now;
    writeText(stateFile, JSON.stringify(state, null, 2));

    const recent = state.items.slice(-3).map((entry) => `"${String(entry.title ?? '').slice(0, 60)}"`);
    const roleOk = rolePath ? applyWatched(recent) : false;
    remember(item);
    log(`watched ${video.bvid} ${String(video.title ?? '').slice(0, 30)} role=${roleOk}`);
    return { bvid: video.bvid, title: video.title };
  }

  return { run, state: () => readJson(stateFile, null) };
}
