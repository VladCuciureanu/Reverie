import { DEFAULT_GATE, type GateConfig } from "../config.ts";
import { checkGate } from "../gate/gate.ts";
import type { DeployQueue, QueuedDeploy } from "../gate/queue.ts";
import type { GitHubClient } from "../github/workflow.ts";
import type { SleepTracker } from "./tracker.ts";

const DEFAULT_POLL_MS = 2 * 60 * 1000; // 2 minutes

export class WakeWatcher {
  private tracker: SleepTracker;
  private queue: DeployQueue;
  private github: GitHubClient;
  private engineer: string;
  private pollMs: number;
  private gate: GateConfig;
  /** Whether the gate was closed at the previous poll. */
  private wasBlocked = false;
  /** Whether the last drain left deploys queued because dispatching them failed. */
  private retryPending = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private onDrain?: (count: number) => void;
  private timeoutMinutes?: number;
  private now: () => Date;

  constructor(options: {
    tracker: SleepTracker;
    queue: DeployQueue;
    github: GitHubClient;
    engineer: string;
    /** Decides when the engineer counts as asleep; defaults to DEFAULT_GATE. */
    gate?: GateConfig;
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
    this.gate = options.gate ?? DEFAULT_GATE;
    this.onDrain = options.onDrain;
    this.timeoutMinutes = options.timeoutMinutes;
    this.now = options.now ?? (() => new Date());
  }

  async poll(): Promise<number> {
    await this.expireStale();

    // "Waking up" means the gate goes from closed to open, by the same
    // rules /gate/check uses to block deploys.
    const status = await this.tracker.getStatus(this.engineer);
    const blocked = !checkGate(status, this.gate).allowed;

    // An unknown stage (e.g. a failed Oura read) can close the gate when the
    // fallback blocks, but it never counts as waking up, whatever the fallback.
    if (status === null) {
      this.wasBlocked ||= blocked;
      return 0;
    }

    const woke = this.wasBlocked && !blocked;
    this.wasBlocked = blocked;

    // Deploys whose dispatch failed are retried on each poll while the gate
    // stays open; timeoutMinutes eventually expires one that keeps failing.
    const retry = this.retryPending && !blocked;
    return woke || retry ? await this.drainQueue() : 0;
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
      if (!(await this.dispatch(deploy))) continue;

      // Dequeue as soon as the dispatch succeeds, so a failed status post
      // can't get the deploy dispatched again on the next wake.
      this.queue.remove(deploy.id);
      drained++;
      try {
        await this.github.postCommitStatus(
          deploy.repo,
          deploy.sha,
          "success",
          "Engineer is awake. Deploy re-triggered.",
        );
      } catch (err) {
        console.error("Failed to post re-trigger commit status:", err);
      }
    }

    this.retryPending = drained < deploys.length;
    this.onDrain?.(drained);
    return drained;
  }

  /** Re-dispatches a deploy's workflow; false (deploy stays queued) on any failure. */
  private async dispatch(deploy: QueuedDeploy): Promise<boolean> {
    try {
      // workflow_dispatch needs the workflow ID, not the run ID we queued.
      const workflowId = await this.github.getWorkflowIdForRun(deploy.repo, deploy.workflow_run_id);
      if (workflowId === null) return false;
      return await this.github.retriggerWorkflow(deploy.repo, workflowId, deploy.branch);
    } catch (err) {
      console.error(`Failed to re-trigger queued deploy for ${deploy.repo}@${deploy.branch}:`, err);
      return false;
    }
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
