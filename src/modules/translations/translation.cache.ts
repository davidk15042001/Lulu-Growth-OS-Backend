type CacheEntry = {
  value: string;
  expiresAt: number;
};

export type TranslationCache = {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
};

export class BoundedTranslationCache implements TranslationCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly maxEntries = 20_000,
    private readonly ttlMs = 24 * 60 * 60 * 1_000
  ) {}

  get(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    // Reinserting keeps recently used entries at the end of the Map.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string) {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
  }
}

export const translationCache = new BoundedTranslationCache();
