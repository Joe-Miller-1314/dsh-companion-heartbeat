// "Who should the persona keep in mind?" — a tiny settings panel.
//
// The plugin serves one local page listing the chats it knows about (host
// whitelist + message buffer), where the user ticks the ones the heartbeat
// may reach out to. The selection is stored in <dataDir>/config.json so the
// running loop picks it up on the next tick; no restart, no host app edit.
//
// The page is only bound to 127.0.0.1 and requires a per-install token, which
// the plugin writes to <dataDir>/panel-token.txt and prints in its log.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { readJson, writeJson } from './util.js';

function token(config) {
  const file = path.join(config.dataDir, 'panel-token.txt');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 16) return saved;
  } catch {}
  const fresh = crypto.randomBytes(18).toString('hex');
  try { fs.writeFileSync(file, fresh, { mode: 0o600 }); } catch {}
  return fresh;
}

function chatMeta(config) {
  const meta = new Map();
  const buffer = readJson(config.bufferPath, null);
  const chats = buffer?.chats && typeof buffer.chats === 'object' ? buffer.chats : {};
  for (const [key, list] of Object.entries(chats)) {
    const messages = Array.isArray(list) ? list : [];
    const last = messages[messages.length - 1] ?? {};
    meta.set(key, {
      label: String(last.conversation_name ?? last.sender_name ?? ''),
      lastAt: Number(last.timestamp ?? 0) * 1000,
      messages: messages.length,
    });
  }
  return meta;
}

function hostKeys(config) {
  if (config.adapter?.type !== 'wechatagent') return [];
  const host = readJson(config.adapter.configPath, null);
  const whitelist = host?.wechat?.whitelist ?? {};
  const out = [];
  for (const id of whitelist.private ?? []) out.push(`wechat:private:${id}`);
  for (const id of whitelist.groups ?? []) out.push(`wechat:group:${id}`);
  return out;
}

function selectedKeys(config) {
  const live = readJson(config.tuningPath, null) ?? {};
  if (Array.isArray(live.chats)) return live.chats.map(String);
  if (config.chats.length) return config.chats.map(String);
  // Before the first save the adapter's own chats are what the loop uses.
  return hostKeys(config);
}

function describe(config) {
  const meta = chatMeta(config);
  const selected = new Set(selectedKeys(config));
  const keys = new Set([...hostKeys(config), ...meta.keys(), ...selected]);
  const state = readJson(config.statePath, null) ?? {};
  const rows = [];
  for (const key of keys) {
    const parts = key.split(':');
    const info = meta.get(key) ?? {};
    const last = Number(state.chats?.[key]?.lastSpokeAt ?? 0);
    rows.push({
      key,
      kind: parts[1] ?? '',
      id: parts.slice(2).join(':'),
      label: info.label || parts.slice(2).join(':'),
      selected: selected.has(key),
      lastMessageAt: info.lastAt || 0,
      lastSpokeAt: last,
      daily: Number(state.chats?.[key]?.dailyCount ?? 0),
    });
  }
  rows.sort((a, b) => b.lastMessageAt - a.lastMessageAt || a.label.localeCompare(b.label));
  return { port: config.panelPort, chats: rows };
}

function saveSelection(config, keys) {
  const list = (Array.isArray(keys) ? keys : [])
    .map((value) => String(value).trim())
    .filter((value) => /^[a-z]+:[a-z]+:.+$/i.test(value));
  const live = readJson(config.tuningPath, null);
  const tuning = live && typeof live === 'object' ? live : {};
  if (!writeJson(config.tuningPath, { ...tuning, chats: [...new Set(list)] })) {
    return { ok: false, reason: 'write-failed' };
  }
  return { ok: true };
}

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Heartbeat · 惦记名单</title>
<style>
:root{color-scheme:light dark;--bg:#faf9f7;--fg:#1f1d1b;--muted:#6b6560;--line:#e4e0db;--card:#fff;--accent:#2f6f5e}
@media (prefers-color-scheme:dark){:root{--bg:#171614;--fg:#f0ece7;--muted:#a39d96;--line:#2c2a27;--card:#201e1b;--accent:#7fc4b0}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 20px 72px}
h1{font-size:22px;font-weight:600;margin:0 0 6px}
p.lead{margin:0 0 26px;color:var(--muted)}
ul{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-radius:14px;background:var(--card);overflow:hidden}
li{display:flex;gap:14px;align-items:flex-start;padding:14px 16px;border-top:1px solid var(--line)}
li:first-child{border-top:0}
label{display:flex;gap:12px;align-items:flex-start;cursor:pointer;flex:1}
input[type=checkbox]{width:18px;height:18px;margin-top:2px;accent-color:var(--accent)}
.name{font-weight:600}
.meta{color:var(--muted);font-size:13px}
footer{display:flex;gap:12px;align-items:center;margin-top:18px}
button{font:inherit;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:9px 18px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.5;cursor:default}
#status{color:var(--muted);font-size:13px}
.add{margin-top:26px;border-top:1px solid var(--line);padding-top:18px}
.add input{font:inherit;padding:9px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg);width:280px}
</style></head>
<body><main>
<h1>惦记名单</h1>
<p class="lead">勾选想让 TA 主动惦记的聊天。没勾的聊天不会被主动打扰。</p>
<ul id="list"><li class="meta">读取中…</li></ul>
<footer><button class="primary" id="save">保存</button><span id="status"></span></footer>
<div class="add"><input id="manual" placeholder="wechat:private:123456"><button id="addBtn">添加</button></div>
</main>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
let state = {chats: []};
function fmt(t){ if(!t) return '还没有消息'; const d=new Date(t); const m=Math.round((Date.now()-t)/60000); if(m<1) return '刚刚有消息'; if(m<60) return m+' 分钟前有消息'; if(m<1440) return Math.round(m/60)+' 小时前有消息'; return d.toLocaleDateString(); }
function render(){
  const list = document.getElementById('list');
  if(!state.chats.length){ list.innerHTML = '<li class="meta">这个账号还没有可选的聊天，先在微信里聊一句就会出现。</li>'; return; }
  list.innerHTML = '';
  for(const chat of state.chats){
    const li=document.createElement('li');
    const label=document.createElement('label');
    const box=document.createElement('input'); box.type='checkbox'; box.checked=chat.selected; box.dataset.key=chat.key;
    const wrap=document.createElement('div');
    const name=document.createElement('div'); name.className='name'; name.textContent=chat.label;
    const meta=document.createElement('div'); meta.className='meta';
    meta.textContent = chat.key + ' · ' + fmt(chat.lastMessageAt) + (chat.lastSpokeAt ? ' · 上次主动 '+new Date(chat.lastSpokeAt).toLocaleTimeString() : '');
    wrap.append(name, meta); label.append(box, wrap); li.append(label); list.append(li);
  }
}
async function load(){
  const r = await fetch('/api/state?token='+encodeURIComponent(token));
  if(!r.ok){ document.getElementById('status').textContent='读取失败：'+r.status; return; }
  state = await r.json(); render();
}
async function save(){
  const keys=[...document.querySelectorAll('input[type=checkbox]')].filter(b=>b.checked).map(b=>b.dataset.key);
  const btn=document.getElementById('save'); btn.disabled=true;
  const r = await fetch('/api/selection?token='+encodeURIComponent(token), {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({keys})});
  btn.disabled=false;
  document.getElementById('status').textContent = r.ok ? '已保存，下一次心跳就按新名单来。' : '保存失败（'+r.status+'）';
  await load();
}
document.getElementById('save').onclick=save;
document.getElementById('addBtn').onclick=()=>{
  const value=document.getElementById('manual').value.trim();
  if(!value) return;
  if(!state.chats.some(c=>c.key===value)){ state.chats.unshift({key:value,label:value,selected:true,lastMessageAt:0,lastSpokeAt:0}); render(); }
  document.querySelectorAll('input[type=checkbox]').forEach(b=>{ if(b.dataset.key===value) b.checked=true; });
};
load();
</script></body></html>`;

export function startPanel({ config, log }) {
  if (!config.panelEnabled) return () => {};
  const secret = token(config);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const given = url.searchParams.get('token') ?? req.headers['x-panel-token'] ?? '';
    if (given !== secret) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(describe(config)));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/selection') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; if (body.length > 64 * 1024) req.destroy(); });
      req.on('end', () => {
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch {}
        const result = saveSelection(config, payload.keys);
        res.writeHead(result.ok ? 200 : 500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        if (result.ok) log(`panel selection saved (${(payload.keys ?? []).length} chats)`);
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  let retried = false;
  server.on('error', (error) => {
    const code = error?.code ?? '';
    log(`panel unavailable on port ${config.panelPort}: ${String(error?.message ?? error).slice(0, 120)}`);
    // A reload can briefly overlap the previous instance's server; retry once.
    if (code === 'EADDRINUSE' && !retried) {
      retried = true;
      setTimeout(() => { try { server.listen(config.panelPort, '127.0.0.1'); } catch {} }, 1500).unref?.();
    }
  });
  server.listen(config.panelPort, '127.0.0.1', () => {
    log(`panel ready at http://127.0.0.1:${config.panelPort}/?token=${secret}`);
  });
  server.unref?.();

  return () => {
    try { server.close(); } catch {}
  };
}
