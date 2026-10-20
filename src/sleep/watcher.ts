import type { DeployQueue } from "../gate/queue.ts";
import type { GitHubClient } from "../github/workflow.ts";
import type { SleepTracker } from "./tracker.ts";
import type { SleepState } from "./types.ts";

const DEFAULT_POLL_MS = 2 * 60 * 1000; // 2 minutes

export class WakeWatcher {
  private tracker: SleepTracker;
  private queue: DeployQueue;
  private github: GitHubClient;
  private engineer: string;
  private pollMs: number;
  private lastState: SleepState | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private onDrain?: (count: number) => void;
  private timeoutMinutes?: number;
  private now: () => Date;

  constructor(options: {
    tracker: SleepTracker;
    queue: DeployQueue;
    github: GitHubClient;
    engineer: string;
    pollMs?: number;
    onDrain?: (count: number) => void;
    /** Queued deploys older than this are dropped and marked failed. */
    timeoutMinutes?: number;
    now?: () => Date;
  }) {
    this.tracker = options.tracker;
    this.queue = options.queue;
    this.github = options.github;
    this.engineer = options.engineer;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.onDrain = options.onDrain;
    this.timeoutMinutes = options.timeoutMinutes;
    this.now = options.now ?? (() => new Date());
  }

  async poll(): Promise<number> {
    await this.expireStale();

    const status = await this.tracker.getStatus(this.engineer);
    const currentState = status?.state ?? null;
    const wasAsleep =
      this.lastState !== null && this.lastState !== "awake" && this.lastState !== "light";
    const isAwake = currentState === "awake" || currentState === "light";
    this.lastState = currentState;

    if (wasAsleep && isAwake) {
      return await this.drainQueue();
    }

    return 0;
  }

  private async expireStale(): Promise<void> {
    if (this.timeoutMinutes === undefined) return;
    const cutoff = new Date(this.now().getTime() - this.timeoutMinutes * 60 * 1000);
    for (const deploy of this.queue.expireOlderThan(cutoff)) {
      try {
        await this.github.postCommitStatus(
          deploy.repo,
          deploy.sha,
          "failure",
          `Deploy expired after ${this.timeoutMinutes} minutes in the queue.`,
        );
      } catch (err) {
        console.error("Failed to post expiry commit status:", err);
      }
    }
  }

  private async drainQueue(): Promise<number> {
    const deploys = this.queue.peek();
    let drained = 0;

    for (const deploy of deploys) {
      // workflow_dispatch needs the workflow ID, not the run ID we queued.
      const workflowId = await this.github.getWorkflowIdForRun(deploy.repo, deploy.workflow_run_id);
      if (workflowId === null) continue;

      const ok = await this.github.retriggerWorkflow(deploy.repo, workflowId, deploy.branch);
      if (ok) {
        await this.github.postCommitStatus(
          deploy.repo,
          deploy.sha,
          "success",
          "Engineer is awake. Deploy re-triggered.",
        );
        this.queue.remove(deploy.id);
        drained++;
      }
    }

    this.onDrain?.(drained);
    return drained;
  }

  start(): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => {
      this.poll().catch((err) => console.error("Wake watcher poll failed:", err));
    }, this.pollMs);
  }

  isRunning(): boolean {
    return this.intervalId !== null;
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
