import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { readFileSync, readdirSync } from "fs"
import path from "path"

function createTestDb() {
  const sqlite = new Database(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON")

  const dir = path.join(import.meta.dirname, "../../migration")
  const entries = readdirSync(dir, { withFileTypes: true })
  const migrations = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      sql: readFileSync(path.join(dir, entry.name, "migration.sql"), "utf-8"),
      timestamp: Number(entry.name.split("_")[0]),
      name: entry.name,
    }))
    .sort((a, b) => a.timestamp - b.timestamp)

  migrate(drizzle({ client: sqlite }), migrations)
  return sqlite
}

describe("pending_message schema migration", () => {
  test("creates the pending_message table with queue indexes", () => {
    const sqlite = createTestDb()

    try {
      const columns = sqlite
        .query("PRAGMA table_info('pending_message')")
        .all() as Array<{ name: string }>
      const indexes = sqlite
        .query("PRAGMA index_list('pending_message')")
        .all() as Array<{ name: string }>
      const foreignKeys = sqlite
        .query("PRAGMA foreign_key_list('pending_message')")
        .all() as Array<{ table: string; from: string; on_delete: string }>

      expect(columns.map((item) => item.name)).toEqual([
        "id",
        "session_id",
        "position",
        "mode",
        "status",
        "payload",
        "source",
        "created_against_execution_id",
        "supersedes_execution_id",
        "error",
        "time_created",
        "time_updated",
      ])
      expect(indexes.map((item) => item.name)).toEqual(
        expect.arrayContaining(["pending_message_session_position_idx", "pending_message_session_status_idx"]),
      )
      expect(foreignKeys).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: "session",
            from: "session_id",
            on_delete: "CASCADE",
          }),
        ]),
      )
    } finally {
      sqlite.close()
    }
  })
})
