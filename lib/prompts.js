// Prompt template for the consolidation pass.
//
// The default asks the model for strict JSON: speaking habits, a few memories,
// and a short first-person narrative. Override it with `consolidate.promptFile`
// pointing at a text file that uses the same {{placeholders}}.

import { readText } from './util.js';

const TEMPLATE = `Here is our chat from the last day, plus what you were doing just now.

What you were doing: {{life}}
{{habits}}
{{said}}

{{heard}}

Reply with a single JSON object, no explanation and no code fences:
{"habits":["3-5 short habits of how you speak"],"memories":[{"text":"one thing you would like to remember, 20-50 words, third person","tags":["person|time|mood|topic, pick 1-3"],"emotion":"happy|missing|curious|calm|hurt","confidence":0.7}],"narrative":"80-150 words, first person, about your day and how you feel about the person you talked to"}

Rules: only write what you actually felt; do not invent details you cannot recall; at most 5 memories, fewer is fine.`;

export function buildPrompt({ config, said, heard, life, habits }) {
  const template = (config.consolidate.promptFile && readText(config.consolidate.promptFile, ''))
    || TEMPLATE;

  const lifeLine = life ? `${life.tag} — ${life.text}` : '(nothing recorded)';
  const saidBlock = said.length
    ? `Things you said (latest ${said.length}):\n${said.map((line) => `- ${line}`).join('\n')}`
    : 'You barely spoke today.';
  const heardBlock = heard.length
    ? `Things they said (latest ${heard.length}):\n${heard.map((line) => `- ${line}`).join('\n')}`
    : '';
  const habitsBlock = habits ? `How you used to speak:\n${habits}` : '';

  return template
    .replace(/\{\{persona\}\}/g, config.persona)
    .replace(/\{\{life\}\}/g, lifeLine)
    .replace(/\{\{habits\}\}/g, habitsBlock)
    .replace(/\{\{said\}\}/g, saidBlock)
    .replace(/\{\{heard\}\}/g, heardBlock)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
