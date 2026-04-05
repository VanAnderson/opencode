import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { readFileSync, readdirSync } from "fs"
import path from "path"

function loadMigrations() {
  const dir = path.join(import.meta.dirname, "../../migration")
  const entries = readdirSync(dir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      sql: readFileSync(path.join(dir, entry.name, "migration.sql"), "utf-8"),
      timestamp: Number(entry.name.split("_")[0]),
      name: entry.name,
    }))
    .sort((a, b) => a.timestamp - b.timestamp)
}

function applyMigrations(sqlite: Database, input?: { upToTimestamp?: number }) {
  const migrations = loadMigrations().filter((item) =>
    input?.upToTimestamp ? item.timestamp <= input.upToTimestamp : true,
  )
  migrate(drizzle({ client: sqlite }), migrations)
}

function createTestDb(input?: { upToTimestamp?: number }) {
  const sqlite = new Database(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON")

  applyMigrations(sqlite, input)
  return sqlite
}

describe("pending_message schema migration", () => {
  const pendingMessageMigrationTimestamp = 20260405120000

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

  test("applies cleanly on a populated pre-queue database", () => {
    const sqlite = createTestDb({
      upToTimestamp: pendingMessageMigrationTimestamp - 1,
    })

    try {
      sqlite
        .query(
          `
            INSERT INTO project (
              id, worktree, vcs, name, icon_url, icon_color, time_created, time_updated, time_initialized, sandboxes, commands
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run("pro_1", "/tmp/project", "git", "Queue Project", null, null, 1, 1, 1, "[]", null)

      sqlite
        .query(
          `
            INSERT INTO session (
              id, project_id, parent_id, slug, directory, title, version, share_url,
              summary_additions, summary_deletions, summary_files, summary_diffs,
              revert, permission, time_created, time_updated, time_compacting, time_archived, workspace_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          "ses_1",
          "pro_1",
          null,
          "queue-session",
          "/tmp/project",
          "Queue Session",
          "1",
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          1,
          1,
          null,
          null,
          null,
        )

      applyMigrations(sqlite)

      sqlite
        .query(
          `
            INSERT INTO pending_message (
              id, session_id, position, mode, status, payload, source,
              created_against_execution_id, supersedes_execution_id, error, time_created, time_updated
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          "pnd_1",
          "ses_1",
          0,
          "queue",
          "queued",
          JSON.stringify({
            kind: "prompt",
            agent: "default",
            model: { providerID: "openai", modelID: "gpt-4.1" },
            parts: [{ type: "text", text: "queued after migrate" }],
          }),
          "app",
          null,
          null,
          null,
          1,
          1,
        )

      const project = sqlite
        .query("SELECT id, worktree, commands FROM project WHERE id = ?")
        .get("pro_1") as { id: string; worktree: string; commands: string | null } | null
      const session = sqlite
        .query("SELECT id, project_id, title FROM session WHERE id = ?")
        .get("ses_1") as { id: string; project_id: string; title: string } | null
      const pending = sqlite
        .query("SELECT id, session_id, status FROM pending_message WHERE id = ?")
        .get("pnd_1") as { id: string; session_id: string; status: string } | null

      expect(project).toEqual({
        id: "pro_1",
        worktree: "/tmp/project",
        commands: null,
      })
      expect(session).toEqual({
        id: "ses_1",
        project_id: "pro_1",
        title: "Queue Session",
      })
      expect(pending).toEqual({
        id: "pnd_1",
        session_id: "ses_1",
        status: "queued",
      })
    } finally {
      sqlite.close()
    }
  })
})
