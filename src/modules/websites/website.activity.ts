export type WebsiteGenerationActivityTone = 'info' | 'success' | 'warning' | 'error';

export type WebsiteGenerationActivity = {
  id: string;
  code: string;
  tone: WebsiteGenerationActivityTone;
  params: Record<string, string | number>;
  createdAt: string;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function generationActivities(preview: Record<string, unknown> | undefined): WebsiteGenerationActivity[] {
  const values = Array.isArray(preview?.activity) ? preview.activity : [];
  return values.map(objectValue).map((value) => ({
    id: String(value.id ?? ''),
    code: String(value.code ?? ''),
    tone: ['success', 'warning', 'error'].includes(String(value.tone)) ? String(value.tone) as WebsiteGenerationActivityTone : 'info',
    params: Object.fromEntries(Object.entries(objectValue(value.params)).filter(([, item]) => typeof item === 'string' || typeof item === 'number')) as Record<string, string | number>,
    createdAt: String(value.createdAt ?? ''),
  })).filter((event) => event.id && event.code);
}

export function appendGenerationActivity(
  preview: Record<string, unknown> | undefined,
  event: Omit<WebsiteGenerationActivity, 'createdAt'> & { createdAt?: string },
) {
  const current = generationActivities(preview);
  if (current.some((item) => item.id === event.id)) return { ...(preview ?? {}), activity: current };
  const activity = [...current, { ...event, createdAt: event.createdAt ?? new Date().toISOString() }].slice(-100);
  return { ...(preview ?? {}), activity };
}
