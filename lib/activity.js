// Reading chat activity from a host app's message buffer.
//
// The engine only needs two numbers per chat: when the other person last spoke
// and when the persona last sent a proactive message. The accepted JSON shapes
// are deliberately loose so a host app does not have to reshape its data:
//
//   { "chats": { "key": [row, ...] } }
//   { "chats": { "key": { "messages": [row, ...] } } }
//   { "key": [row, ...] }                      (no "chats" wrapper)
//
// A row is { timestamp (seconds), outgoing, proactive }. `isSend: 1` and
// `message_id` starting with "out-" are also understood as outgoing markers.

import { readJson } from './util.js';

function rowsOf(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.messages)) return value.messages;
  if (value && typeof value === 'object') return Object.values(value).filter((row) => row && typeof row === 'object');
  return [];
}

function isOutgoing(row) {
  if (typeof row?.outgoing === 'boolean') return row.outgoing;
  if (Number(row?.isSend) === 1) return true;
  return String(row?.message_id ?? '').startsWith('out-');
}

/**
 * Read per-chat activity.
 * @returns {Record<string, { lastIncomingAt: number, lastProactiveAt: number }> | null}
 *          null when the buffer cannot be read, so callers can tell "no data"
 *          apart from "nothing happened".
 */
export function readActivity(bufferPath, format = 'auto') {
  const data = readJson(bufferPath, null);
  if (!data) return null;

  const chats = data.chats && typeof data.chats === 'object' ? data.chats : data;
  if (!chats || typeof chats !== 'object') return {};

  const activity = {};
  for (const [key, value] of Object.entries(chats)) {
    let lastIncomingAt = 0;
    let lastProactiveAt = 0;
    for (const row of rowsOf(value)) {
      const seconds = Number(row?.timestamp ?? 0);
      const at = seconds * 1000;
      if (!Number.isFinite(at) || at <= 0) continue;
      if (!isOutgoing(row)) {
        if (at > lastIncomingAt) lastIncomingAt = at;
      } else if (format === 'auto' || format === 'outgoing') {
        if (row?.proactive === true && at > lastProactiveAt) lastProactiveAt = at;
        else if (format === 'outgoing' && at > lastProactiveAt) lastProactiveAt = at;
      }
    }
    activity[key] = { lastIncomingAt, lastProactiveAt };
  }
  return activity;
}
