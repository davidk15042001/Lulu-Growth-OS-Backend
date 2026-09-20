import { AppError } from '../../utils/app-error.js';

function jsonObjectCandidates(text: string) {
  const candidates = new Set<string>();
  const cleaned = text
    .replace(/^\uFEFF/, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  if (cleaned) candidates.add(cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());

  for (let start = 0; start < cleaned.length; start += 1) {
    if (cleaned[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < cleaned.length; index += 1) {
      const character = cleaned[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === '{') depth += 1;
      if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.add(cleaned.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return [...candidates].filter(Boolean);
}

export function parseKnowledgeActivationJson(text: string): Record<string, unknown> {
  for (const candidate of jsonObjectCandidates(text)) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // Try the next bounded candidate. The provider response is untrusted input.
    }
  }
  throw new AppError(502, 'KNOWLEDGE_AI_RESPONSE_INVALID', 'AI could not return a valid company knowledge structure.');
}
