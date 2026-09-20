function jsonValueCandidates(text: string) {
  const candidates = new Set<string>();
  const cleaned = text
    .replace(/^\uFEFF/, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  if (cleaned) candidates.add(cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim());

  for (let start = 0; start < cleaned.length; start += 1) {
    const opener = cleaned[start];
    if (opener !== '{' && opener !== '[') continue;
    const stack: string[] = [];
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
      if (character === '{' || character === '[') {
        stack.push(character === '{' ? '}' : ']');
        continue;
      }
      if (character === '}' || character === ']') {
        if (stack.pop() !== character) break;
        if (stack.length === 0) {
          candidates.add(cleaned.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return [...candidates].filter(Boolean);
}

function normalizeKnowledgeValue(value: unknown, depth = 0): Record<string, unknown> | null {
  if (typeof value === 'string' && depth < 3) {
    for (const candidate of jsonValueCandidates(value)) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        const normalized = normalizeKnowledgeValue(parsed, depth + 1);
        if (normalized) return normalized;
      } catch {
        // Try the next bounded candidate.
      }
    }
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const nestedText = record.text ?? record.content;
      if (typeof nestedText === 'string') {
        const normalized = normalizeKnowledgeValue(nestedText, depth + 1);
        if (normalized) return normalized;
      }
    }
    return { items: value };
  }

  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['companyKnowledge', 'knowledge', 'classification', 'result', 'data']) {
    const nested = normalizeKnowledgeValue(record[key], depth + 1);
    if (nested) return nested;
  }
  return record;
}

export function parseKnowledgeActivationJson(text: string): Record<string, unknown> {
  for (const candidate of jsonValueCandidates(text)) {
    try {
      const value = JSON.parse(candidate) as unknown;
      const normalized = normalizeKnowledgeValue(value);
      if (normalized) return normalized;
    } catch {
      // Try the next bounded candidate. The provider response is untrusted input.
    }
  }
  return {};
}
