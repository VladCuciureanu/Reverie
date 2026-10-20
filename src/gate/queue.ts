import { DatabaseSync } from "node:sqlite";

export interface QueuedDeploy {
  id: number;
  repo: string;
  branch: string;
  sha: string;
  workflow_run_id: string;
  queued_at: string;
}

export class DeployQueue {
  private db: DatabaseSync;

  constructor(dbPath: string = "reverie.db") {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deploy_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        sha TEXT NOT NULL,
        workflow_run_id TEXT NOT NULL,
        queued_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  enqueue(
    repo: string,
    branch: string,
    sha: string,
    workflowRunId: string,
  ): void {
    // Supersede earlier deploys on the same repo+branch, atomically so a
    // failed insert never loses the previously queued deploy.
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("DELETE FROM deploy_queue WHERE repo = ? AND branch = ?")
        .run(repo, branch);
      this.db
        .prepare(
          "INSERT INTO deploy_queue (repo, branch, sha, workflow_run_id) VALUES (?, ?, ?, ?)",
        )
        .run(repo, branch, sha, workflowRunId);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  peek(): QueuedDeploy[] {
    return this.db
      .prepare(
        "SELECT id, repo, branch, sha, workflow_run_id, queued_at FROM deploy_queue ORDER BY queued_at ASC",
      )
      .all() as unknown as QueuedDeploy[];
  }

  remove(id: number): void {
    this.db.prepare("DELETE FROM deploy_queue WHERE id = ?").run(id);
  }

  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM deploy_queue")
      .get() as unknown as { count: number };
    return row.count;
  }

  close(): void {
    this.db.close();
  }
}
