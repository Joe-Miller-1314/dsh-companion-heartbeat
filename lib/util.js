// Small filesystem and math helpers shared by the runtime modules.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function ensureDir(dir) {
  if (!dir) return;
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

export function readJson(file, fallback = null) {
  if (!file) return fallback;
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  if (!file) return false;
  try {
    ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export function readText(file, fallback = '') {
  if (!file) return fallback;
  try { return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch { return fallback; }
}

export function writeText(file, text) {
  if (!file) return false;
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, text, 'utf8');
    return true;
  } catch {
    return false;
  }
}

// Append-only log. Keeps one rotated copy so a long-running install cannot
// grow the file without bound.
export function appendLog(file, text, maxBytes = 512 * 1024) {
  if (!file) return;
  try {
    ensureDir(path.dirname(file));
    try {
      if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
    } catch {}
    fs.appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
  } catch {}
}

export function clamp(value, lo = 0, hi = 1) {
  return Math.min(hi, Math.max(lo, value));
}

// Numbers from config files are frequently strings, or garbage after a typo.
export function num(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Accepts either a number or a [min, max] pair.
export function pickRange(range, rand = Math.random) {
  if (Array.isArray(range)) {
    const [lo, hi] = range;
    return lo + rand() * (hi - lo);
  }
  return Number(range) || 0;
}

export function expandPath(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let out = value.trim();
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = path.join(os.homedir(), out.slice(1));
  }
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => process.env[name] ?? whole);
  return path.resolve(out);
}
