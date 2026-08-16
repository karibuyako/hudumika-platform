/* Mock backend storage.
 * A small typed table store with write-through persistence.
 * - Persisted to localStorage (web) so reload ≠ reset.
 * - Broadcasts mutations to other tabs via the storage event = simulated
 *   multi-device sync across browser windows.
 * - Not a real database: no transactions/joins. Schema and flows mimic a
 *   production service boundary; the transport is mocked by MSW.
 */

export interface Entity {
  id: string;
}

/** Default row type for untyped tables: permissive, like a real ORM's any-row. */
export type AnyRow = Record<string, any> & Entity;

const STORAGE_KEY = 'mockdb.v4';

export class Table<T extends Entity = AnyRow> {
  rows: T[] = [];

  constructor(private name: string, private db: Db) {}

  insert(row: T): T {
    this.rows.push(row);
    this.db.touch(this.name, row.id);
    return row;
  }

  insertMany(rows: T[]): T[] {
    for (const r of rows) {
      this.rows.push(r);
      this.db.touch(this.name, r.id);
    }
    return rows;
  }

  find(id: string): T | undefined {
    return this.rows.find((r) => r.id === id);
  }

  where(pred: (r: T) => boolean): T[] {
    return this.rows.filter(pred);
  }

  all(): T[] {
    return [...this.rows];
  }

  update(id: string, patch: Partial<T>): T | undefined {
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx < 0) return undefined;
    this.rows[idx] = { ...this.rows[idx], ...patch };
    this.db.touch(this.name, id);
    return this.rows[idx];
  }

  remove(id: string): boolean {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    if (this.rows.length !== before) {
      this.db.touch(this.name, id);
      return true;
    }
    return false;
  }

  /** Fast-forward mutations stored in the event log (cross-tab replay). */
  apply(id: string, mut: (row: T) => T) {
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx >= 0) {
      this.rows[idx] = mut(this.rows[idx]);
      this.db.touch(this.name, id);
    }
  }
}

export class Db {
  private tables = new Map<string, Table<Entity>>();

  table<T extends Entity = AnyRow>(name: string): Table<T> {
    if (!this.tables.has(name)) {
      this.tables.set(name, new Table<Entity>(name, this));
    }
    return this.tables.get(name) as Table<Entity> as Table<T>;
  }

  /** Persist + broadcast (cross-tab) so another window can replay. */
  touch(name: string, id: string) {
    this.persist();
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(`${STORAGE_KEY}.log`, `${Date.now()}:${name}:${id}`);
      } catch {
        /* quota / privacy mode — ignore */
      }
    }
  }

  persist() {
    if (typeof localStorage === 'undefined') return;
    try {
      const dump: Record<string, unknown[]> = {};
      for (const [name, t] of this.tables) {
        if (t.rows.length) dump[name] = t.rows;
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(dump));
    } catch {
      /* ignore persistence failures (privacy mode) */
    }
  }

  load(): boolean {
    if (typeof localStorage === 'undefined') return false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const dump = JSON.parse(raw) as Record<string, Entity[]>;
      for (const [name, rows] of Object.entries(dump)) {
        const t = this.table<Entity>(name);
        if (!t.rows.length) t.rows = rows;
      }
      return true;
    } catch {
      return false;
    }
  }

  reset() {
    for (const t of this.tables.values()) t.rows = [];
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(`${STORAGE_KEY}.log`);
    }
  }

  get lastLog(): string | null {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(`${STORAGE_KEY}.log`);
  }
}

export const db = new Db();

export const uid = (prefix = 'id'): string =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
