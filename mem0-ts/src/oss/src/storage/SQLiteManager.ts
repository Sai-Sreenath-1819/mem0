import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { HistoryManager } from "./base";
import { ensureSQLiteDirectory } from "../utils/sqlite";

export class SQLiteManager implements HistoryManager {
  private db: Database.Database;
  private stmtInsert!: Database.Statement;
  private stmtSelect!: Database.Statement;

  constructor(dbPath: string) {
    ensureSQLiteDirectory(dbPath);
    this.db = new Database(dbPath);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id TEXT NOT NULL,
        previous_value TEXT,
        new_value TEXT,
        action TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT,
        is_deleted INTEGER DEFAULT 0
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_scope TEXT,
        role TEXT,
        content TEXT,
        name TEXT,
        created_at TEXT
      )
    `);
    this.stmtInsert = this.db.prepare(
      `INSERT INTO memory_history
      (memory_id, previous_value, new_value, action, created_at, updated_at, is_deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.stmtSelect = this.db.prepare(
      "SELECT * FROM memory_history WHERE memory_id = ? ORDER BY id DESC",
    );
  }

  async addHistory(
    memoryId: string,
    previousValue: string | null,
    newValue: string | null,
    action: string,
    createdAt?: string,
    updatedAt?: string,
    isDeleted: number = 0,
  ): Promise<void> {
    this.stmtInsert.run(
      memoryId,
      previousValue,
      newValue,
      action,
      createdAt ?? null,
      updatedAt ?? null,
      isDeleted,
    );
  }

  async getHistory(memoryId: string): Promise<any[]> {
    return this.stmtSelect.all(memoryId) as any[];
  }

  async saveMessages(
    messages: Array<{ role: string; content: string; name?: string }>,
    sessionScope: string,
  ): Promise<void> {
    if (!messages.length) return;

    const insertMsg = this.db.prepare(
      `INSERT INTO messages (id, session_scope, role, content, name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const evict = this.db.prepare(
      `DELETE FROM messages WHERE session_scope = ? AND id NOT IN (
         SELECT id FROM (
           SELECT id FROM messages WHERE session_scope = ? ORDER BY created_at DESC LIMIT 10
         )
       )`,
    );

    const txn = this.db.transaction(() => {
      const now = new Date().toISOString();
      for (const msg of messages) {
        insertMsg.run(
          randomUUID(),
          sessionScope,
          msg.role,
          msg.content,
          msg.name ?? null,
          now,
        );
      }
      evict.run(sessionScope, sessionScope);
    });

    txn();
  }

  async deleteMessages(filters: Record<string, any>): Promise<void> {
    /**
     * Deletes messages from the database based on the provided filters.
     */
    const allowedKeys = new Set(["user_id", "agent_id", "run_id"]);
    if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
      throw new Error("Expected a nonempty mapping of supported entity keys");
    }
    const filterKeys = Object.keys(filters);
    if (filterKeys.length === 0 || filterKeys.some(k => !allowedKeys.has(k))) {
      throw new Error("Expected a nonempty mapping of supported entity keys");
    }
    for (const key of filterKeys) {
      const value = filters[key];
      if (typeof value !== "string" || !value) {
        throw new Error("Expected nonempty string entity IDs");
      }
    }

    const escapeScopeValue = (val: string) =>
      val.replace(/%/g, "%25").replace(/&/g, "%26").replace(/=/g, "%3D");

    const txn = this.db.transaction(() => {
      // Fetch only scopes that contain the required filter keys and values to narrow down the session_scope retrieval results.
      const likeConditions = filterKeys.map(() => "session_scope LIKE ?").join(" AND ");
      const likeParams = filterKeys.map((k) => `%${k}=${escapeScopeValue(String(filters[k]))}%`);
      const distinctScopes = this.db
        .prepare(`SELECT DISTINCT session_scope FROM messages WHERE ${likeConditions}`)
        .all(...likeParams) as { session_scope: string }[];

      // Now filter to exact matches and add to scopesToDelete if the filters are a subset of the session_scope values.
      const scopesToDelete: string[] = [];
      for (const row of distinctScopes) {
        if (!row.session_scope) continue;

        try {
          const decoded: Record<string, string> = {};
          for (const component of row.session_scope.split("&")) {
            if (!component) continue;
            const parts = component.split("=");
            if (parts.length !== 2) throw new Error("malformed");
            const [key, value] = parts;
            if (!allowedKeys.has(key) || key in decoded || !value) throw new Error("malformed");
            decoded[key] = decodeURIComponent(value);
          }

          let isMatch = true;
          for (const [k, v] of Object.entries(filters)) {
            if (decoded[k] !== String(v)) {
              isMatch = false;
              break;
            }
          }
          if (isMatch) scopesToDelete.push(row.session_scope);
        } catch {
          // invalid scope — skip it
        }
      }

      if (scopesToDelete.length > 0) {
        const stmt = this.db.prepare("DELETE FROM messages WHERE session_scope = ?");
        for (const scope of scopesToDelete) {
          stmt.run(scope);
        }
      }
    });

    try {
      txn();
    } catch (e) {
      console.error(`Failed to delete messages: ${e}`);
      throw e;
    }
  }

  async getLastMessages(
    sessionScope: string,
    limit = 10,
  ): Promise<
    Array<{ role: string; content: string; name?: string; createdAt: string }>
  > {
    const rows = this.db
      .prepare(
        `SELECT role, content, name, created_at FROM (
           SELECT role, content, name, created_at
           FROM messages
           WHERE session_scope = ?
           ORDER BY created_at DESC
           LIMIT ?
         ) ORDER BY created_at ASC`,
      )
      .all(sessionScope, limit) as Array<{
        role: string;
        content: string;
        name: string | null;
        created_at: string;
      }>;

    return rows.map((r) => ({
      role: r.role,
      content: r.content,
      ...(r.name != null ? { name: r.name } : {}),
      createdAt: r.created_at,
    }));
  }

  async batchAddHistory(
    records: Array<{
      memoryId: string;
      previousValue: string | null;
      newValue: string | null;
      action: string;
      createdAt?: string;
      updatedAt?: string;
      isDeleted?: number;
    }>,
  ): Promise<void> {
    const txn = this.db.transaction(() => {
      for (const record of records) {
        this.stmtInsert.run(
          record.memoryId,
          record.previousValue,
          record.newValue,
          record.action,
          record.createdAt ?? null,
          record.updatedAt ?? null,
          record.isDeleted ?? 0,
        );
      }
    });
    txn();
  }

  async reset(): Promise<void> {
    this.db.exec("DROP TABLE IF EXISTS memory_history");
    this.db.exec("DROP TABLE IF EXISTS messages");
    this.init();
  }

  close(): void {
    this.db.close();
  }
}
