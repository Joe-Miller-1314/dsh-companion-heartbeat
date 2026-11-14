// "What you are doing right now" — a small rotation of everyday scenes that
// keeps the persona from sounding like it is waiting by the phone.
//
// Grouped by time of day. `from` is inclusive, `to` is exclusive; a group where
// from > to wraps midnight. Replace the whole list through `life.slots`, or
// point `life.file` at a JSON file with the same shape.

import { readJson, readText, writeText } from './util.js';

export const NOW_START = '<!-- HEARTBEAT:NOW -->';
export const NOW_END = '<!-- /HEARTBEAT:NOW -->';

export const DEFAULT_SLOTS = [
  {
    from: 5,
    to: 10,
    items: [
      ['snoozed', 'hit snooze twice, sat up, then lay back down for a while'],
      ['warm water', 'poured a glass of warm water and drank it slowly'],
      ['keys', 'stood at the door looking for keys that were in a pocket all along'],
    ],
  },
  {
    from: 10,
    to: 17,
    items: [
      ['dozed off', 'kept nodding off in the afternoon and caught myself twice'],
      ['window', 'it started raining, so I leaned on the windowsill and listened'],
      ['tidy up', 'started tidying the desk, then stopped to reread an old note'],
    ],
  },
  {
    from: 17,
    to: 21,
    items: [
      ['hungry', 'my stomach growled but I wanted to wait ten more minutes'],
      ['walk', 'went out for a short walk, the wind was cooler than yesterday'],
      ['dinner', 'ate while looking out the window; it got dark earlier than before'],
    ],
  },
  {
    from: 21,
    to: 5,
    items: [
      ['not sleeping', 'it is late and I still do not want to sleep'],
      ['rain', 'cracked the window open to listen to the rain'],
      ['lights', 'turned the lights down and just sat there for a while'],
    ],
  },
];

export function loadSlots(life) {
  if (Array.isArray(life.slots) && life.slots.length) return life.slots;
  if (life.file) {
    const fromFile = readJson(life.file, null);
    if (Array.isArray(fromFile) && fromFile.length) return fromFile;
    if (Array.isArray(fromFile?.slots) && fromFile.slots.length) return fromFile.slots;
  }
  return DEFAULT_SLOTS;
}

function slotFor(slots, hour) {
  for (const slot of slots) {
    const from = Number(slot?.from);
    const to = Number(slot?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    if (from <= to) {
      if (hour >= from && hour < to) return slot;
    } else if (hour >= from || hour < to) {
      return slot;
    }
  }
  return slots[0];
}

/** Pick a scene for now. Occasionally wander outside the current time slot. */
export function pickLife(life, slots, now = Date.now(), rand = Math.random) {
  const hour = new Date(now).getHours();
  const slot = slotFor(slots, hour);
  const items = Array.isArray(slot?.items) && slot.items.length ? slot.items : DEFAULT_SLOTS[0].items;
  const pool = rand() < Number(life.wanderingChance ?? 0.15)
    ? slots.flatMap((entry) => (Array.isArray(entry?.items) ? entry.items : []))
    : items;
  const chosen = pool[Math.floor(rand() * pool.length)] ?? items[0];
  return { tag: String(chosen?.[0] ?? 'idle'), text: String(chosen?.[1] ?? 'doing nothing in particular') };
}

/**
 * Replace the NOW block in the persona file. Returns false when there is no
 * persona file configured or it cannot be written.
 */
export function writeLife(rolePath, life, scene) {
  if (!rolePath || !life.enabled) return false;
  const MISSING = '\u0000missing';
  const source = readText(rolePath, MISSING);
  if (source === MISSING) return false;

  const template = String(life.template ?? 'Now: {text}\nMood: {tag}');
  const body = template.replace(/\{text\}/g, scene.text).replace(/\{tag\}/g, scene.tag);
  const block = `\n\n${NOW_START}\n${body}\n${NOW_END}\n`;

  const pattern = new RegExp(`${escapeRegExp(NOW_START)}[\\s\\S]*?${escapeRegExp(NOW_END)}\\n*`);
  const next = pattern.test(source)
    ? source.replace(pattern, block.trimStart())
    : `${source.trimEnd()}${block}`;

  return writeText(rolePath, next);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
