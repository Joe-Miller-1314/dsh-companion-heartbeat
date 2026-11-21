// Composing and delivering a first message through dsh-im.
//
// With the wechatagent adapter the host app decides *and* sends: the heartbeat
// only writes a policy. dsh-im is different — it is a delivery pipe, so the
// message text has to exist before it can be handed over. This module turns a
// "speak" decision into one short line:
//
//   session   ask the session controller to write it in character (default)
//   template  fill {life}, {tag}, {persona}, {chat} into a fixed string
//
// and then POSTs it to the host's delivery endpoint:
//
//   POST <baseUrl>/api/dsh-im/delivery/messages { botId, targetId, text, format }

import fs from 'node:fs';
import crypto from 'node:crypto';
import { readText } from './util.js';

const DEFAULT_TEMPLATE = '{life}';

const DEFAULT_PROMPT = `You are {{persona}}. You are about to speak first in a chat, unprompted.

Right now: {{life}}

Write ONE short message to the other person in this chat, in character and in the
language you normally use with them. At most {{maxChars}} characters. No quotes,
no stage directions, no explanation — return only the message text.`;

export function composeTemplate(template, vars = {}) {
  const source = String(template ?? '').trim() || DEFAULT_TEMPLATE;
  return source
    .replaceAll('{life}', String(vars.life ?? '').trim())
    .replaceAll('{tag}', String(vars.tag ?? '').trim())
    .replaceAll('{persona}', String(vars.persona ?? '').trim())
    .replaceAll('{chat}', String(vars.chat ?? '').trim())
    .trim();
}

export function buildPrompt({ template, persona, life, chatKey, maxChars }) {
  const source = String(template ?? '').trim() || DEFAULT_PROMPT;
  return source
    .replaceAll('{{persona}}', String(persona ?? 'companion'))
    .replaceAll('{{life}}', String(life ?? 'nothing in particular').trim())
    .replaceAll('{{chat}}', String(chatKey ?? ''))
    .replaceAll('{{maxChars}}', String(maxChars ?? 120));
}

/** Model answers arrive wrapped in quotes, fences and stray preamble; undo that. */
export function cleanReply(reply, maxChars = 120) {
  let text = String(reply ?? '').trim();
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  text = lines[0] ?? '';
  text = text.replace(/^["'“”‘’「『]/, '').replace(/["'“”‘’」』]$/, '').trim();
  if (text.length > maxChars) {
    const cut = text.slice(0, maxChars);
    const space = cut.lastIndexOf(' ');
    text = space > maxChars * 0.6 ? cut.slice(0, space) : cut;
  }
  return text.trim();
}

function controller(ctx) {
  if (!ctx) return null;
  return ctx.sessionController ?? (typeof ctx.get === 'function' ? ctx.get('sessionController') : null);
}

async function composeWithSession({ ctx, spec, config, chatKey, life, log }) {
  const sessions = controller(ctx);
  if (!sessions || typeof sessions.prompt !== 'function') {
    log('dshim: sessionController unavailable, using the template');
    return '';
  }

  const promptFile = spec.compose.promptFile;
  const template = promptFile ? readText(promptFile, '') : '';
  const text = buildPrompt({
    template,
    // A full role sheet is far too long for this prompt; the first lines carry
    // the voice well enough.
    persona: personaText(config).slice(0, 2400),
    life,
    chatKey,
    maxChars: spec.compose.maxChars,
  });

  const request = {
    requestId: crypto.randomUUID(),
    sessionId: spec.compose.sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
  };

  let reply;
  try {
    reply = await withTimeout(sessions.prompt(request), spec.compose.timeoutMs);
  } catch (error) {
    log(`dshim: compose failed (${String(error?.message ?? error).slice(0, 120)})`);
    return '';
  }
  return cleanReply(reply?.text ?? reply, spec.compose.maxChars);
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One text for one chat, or '' when nothing usable could be produced.
 * Template mode never touches the model; session mode falls back to it.
 */
export async function compose({ ctx, spec, config, chatKey, life, log = () => {} }) {
  const scene = typeof life === 'string' ? life : String(life?.text ?? '').trim();
  const tag = typeof life === 'string' ? '' : String(life?.tag ?? '').trim();
  const vars = { life: scene, tag, persona: config.persona, chat: chatKey };
  const templateText = spec.compose.template ? composeTemplate(spec.compose.template, vars) : '';
  if (spec.compose.mode === 'template') return templateText;

  const written = await composeWithSession({ ctx, spec, config, chatKey, life: scene, log });
  return written || templateText;
}

export async function send({ baseUrl, botId, targetId, text, format = 'plain', timeoutMs = 15000, fetchImpl = fetch }) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/api/dsh-im/delivery/messages`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ botId, targetId, text, format }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const raw = await response.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch {}

  if (!response.ok) {
    const code = body?.error?.code ?? `http-${response.status}`;
    throw new Error(String(code));
  }
  if (body && body.sent !== true) throw new Error(String(body?.error?.code ?? 'not-sent'));
  return body ?? { sent: true };
}

/** Read a persona/role file for the prompt, if one is configured. */
export function personaText(config) {
  if (!config.rolePath) return config.persona;
  try {
    if (!fs.existsSync(config.rolePath)) return config.persona;
    return readText(config.rolePath, config.persona);
  } catch {
    return config.persona;
  }
}
