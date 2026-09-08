export class WidgetCache {
  private store = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(private readonly ttlMs: number = 60_000) {}

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set(key: string, value: unknown): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /**
   * Drop every entry for one board.
   *
   * Exists because saving a Focus stage map otherwise changes nothing visible
   * for up to the TTL: the bars keep their old numbers, and the honest reading
   * of that is "the setting does not work". Matching on the `boardId:` PREFIX —
   * separator included — is what keeps `board-1` from taking out `board-10`.
   */
  invalidateBoard(boardId: string): void {
    const prefix = `${boardId}:`;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  static makeKey(boardId: string, widgetType: string, config: Record<string, unknown>): string {
    return `${boardId}:${widgetType}:${JSON.stringify(config)}`;
  }
}
