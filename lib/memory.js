// Consolidation: once in a while, turn the last day of conversation into
// long-term material — speaking habits, a few memories, and a short narrative.
//
// Everything is derived from the host app's message buffer; the pass asks a DSH
// session for strict JSON and writes three places:
//   <memoryDir>/memories.json        structured memories
//   <memoryDir>/self-narrative.md    first-person summary
//   <rolePath>                       the LEARNED block of the persona file

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildPrompt } from './prompts.js';
import { ensureDir, readJson, readText, writeText } from './util.js';

export const LEARNED_START = '<!-- HEARTBEAT:LEARNED -->';
export const LEARNED_END = '<!-- /HEARTBEAT:LEARNED -->';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createMemory({ config, bufferPath, log = () => {} }) {
  const { memoryDir, rolePath, consolidate } = config;
  const memoriesFile = path.join(memoryDir, 'memories.json');
  const narrativeFile = path.join(memoryDir, 'self-narrative.md');

  let pending = null;
  let installed = false;

  function install(ctx) {
    if (installed || !ctx || typeof ctx.on !== 'function') return;
    installed = true;
    ctx.on('agent/assistant-stream', (payload) => {
      if (pending === null) return;
      const frame = payload?.frame;
      if (typeof frame !== 'object' || frame === null) return;
      const sessionId = payload?.agent?.session?.id;
      if (typeof sessionId === 'string' && sessionId !== consolidate.sessionId) return;

      const chunk = frame.chunk;
      if (chunk && typeof chunk === 'object' && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        pending.text += chunk.text;
      }
      if (frame.type === 'end') {
        const job = pending;
        pending = null;
        job.resolve(job.text);
      }
    }, { global: true });
  }

  function gather(now) {
    const drive = readJson(bufferPath, null);
    const chats = drive?.chats && typeof drive.chats === 'object' ? drive.chats : drive;
    const since = now - 24 * 3600 * 1000;
    const said = [];
    const heard = [];
    if (chats && typeof chats === 'object') {
      for (const value of Object.values(chats)) {
        const rows = Array.isArray(value) ? value : (value?.messages ?? []);
        for (const row of rows) {
          const at = Number(row?.timestamp ?? 0) * 1000;
          if (!at || at < since) continue;
          const text = String(row?.text ?? '').trim();
          if (!text) continue;
          const outgoing = row?.outgoing === true || String(row?.message_id ?? '').startsWith('out-') || Number(row?.isSend) === 1;
          (outgoing ? said : heard).push(text);
        }
      }
    }
    return {
      said: said.slice(-consolidate.maxSaid),
      heard: heard.slice(-consolidate.maxHeard),
    };
  }

  function applyHabits(habits) {
    if (!Array.isArray(habits) || !habits.length || !rolePath) return false;
    const source = readText(rolePath, '');
    if (!source) return false;
    const block = [
      LEARNED_START,
      '## Speaking habits',
      '',
      ...habits.map((habit) => `- ${String(habit).trim()}`),
      LEARNED_END,
    ].join('\n');
    const pattern = new RegExp(`${escapeRegExp(LEARNED_START)}[\\s\\S]*?${escapeRegExp(LEARNED_END)}`);
    const next = pattern.test(source)
      ? source.replace(pattern, block)
      : `${source.trimEnd()}\n\n${block}\n`;
    return writeText(rolePath, next);
  }

  function saveMemories(memories) {
    if (!Array.isArray(memories) || !memories.length) return 0;
    const store = readJson(memoriesFile, { version: 1, items: [] });
    const items = Array.isArray(store.items) ? store.items : [];
    let added = 0;
    for (const item of memories.slice(0, consolidate.maxMemories)) {
      const text = String(item?.text ?? '').trim();
      if (!text || items.some((old) => old.text === text)) continue;
      items.push({
        id: randomUUID(),
        at: Date.now(),
        text,
        tags: Array.isArray(item?.tags) ? item.tags.map(String).slice(0, 4) : [],
        emotion: String(item?.emotion ?? ''),
        confidence: Number(item?.confidence ?? 0.6),
        source: 'consolidation',
      });
      added += 1;
    }
    if (added) writeText(memoriesFile, JSON.stringify({ version: 1, items }, null, 2));
    return added;
  }

  function habitsOf() {
    if (!rolePath) return '';
    const source = readText(rolePath, '');
    const pattern = new RegExp(`${escapeRegExp(LEARNED_START)}([\\s\\S]*?)${escapeRegExp(LEARNED_END)}`);
    return (source.match(pattern)?.[1] ?? '').trim();
  }

  async function ask(ctx, prompt) {
    const controller = ctx?.sessionController ?? ctx?.get?.('sessionController');
    if (!controller) throw new Error('sessionController unavailable');
    if (pending !== null) throw new Error('consolidation already running');

    const text = await new Promise((resolve, reject) => {
      pending = { text: '', resolve, reject };
      const timer = setTimeout(() => {
        if (pending !== null) { pending = null; reject(new Error('timeout')); }
      }, consolidate.timeoutMs);
      timer.unref?.();
      Promise.resolve()
        .then(() => controller.prompt({
          requestId: `consolidate-${randomUUID()}`,
          sessionId: consolidate.sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: prompt }],
        }, new AbortController().signal))
        .catch((error) => {
          if (pending !== null) { pending = null; clearTimeout(timer); reject(error); }
        });
    });

    return text;
  }

  async function run(ctx, { life, now = Date.now() }) {
    ensureDir(memoryDir);
    const { said, heard } = gather(now);
    if (!said.length && !heard.length) return { skipped: 'no-conversation' };

    const prompt = buildPrompt({ config, said, heard, life, habits: habitsOf() });

    let text;
    try {
      text = await ask(ctx, prompt);
    } catch (error) {
      // The helper session may not exist yet on a fresh profile.
      if (String(error?.message ?? '').includes('not found')) {
        const controller = ctx?.sessionController ?? ctx?.get?.('sessionController');
        await controller?.create?.({ sessionId: consolidate.sessionId, cwd: consolidate.cwd });
        text = await ask(ctx, prompt);
      } else {
        throw error;
      }
    }

    const cleaned = String(text).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no-json-in-reply');
    const parsed = JSON.parse(match[0]);

    const habitsOk = applyHabits(parsed.habits);
    const added = saveMemories(parsed.memories);
    if (parsed.narrative) {
      const header = `# My days\n\n> updated ${new Date(now).toISOString()}\n\n`;
      writeText(narrativeFile, header + String(parsed.narrative).trim() + '\n');
    }
    log(`consolidated habits=${habitsOk ? (parsed.habits ?? []).length : 0} memories=${added} said=${said.length}`);
    return { habits: habitsOk, memories: added };
  }

  return { install, run };
}
