import type { SleepTracker } from "./tracker.ts";
import type { SleepState } from "./types.ts";
import { DeployQueue } from "../gate/queue.ts";
import { GitHubClient } from "../github/workflow.ts";

const DEFAULT_POLL_MS = 2 * 60 * 1000; // 2 minutes

export class WakeWatcher {
  private tracker: SleepTracker;
  private queue: DeployQueue;
  private github: GitHubClient;
  private engineer: string;
  private pollMs: number;
  private lastState: SleepState | null = null;
  private intervalId: number | null = null;
  private onDrain?: (count: number) => void;

  constructor(options: {
    tracker: SleepTracker;
    queue: DeployQueue;
    github: GitHubClient;
    engineer: string;
    pollMs?: number;
    onDrain?: (count: number) => void;
  }) {
    this.tracker = options.tracker;
    this.queue = options.queue;
    this.github = options.github;
    this.engineer = options.engineer;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.onDrain = options.onDrain;
  }

  async poll(): Promise<number> {
    const status = await this.tracker.getStatus(this.engineer);
    const currentState = status?.state ?? null;
    const wasAsleep = this.lastState !== null && this.lastState !== "awake" &&
      this.lastState !== "light";
    const isAwake = currentState === "awake" || currentState === "light";
    this.lastState = currentState;

    if (wasAsleep && isAwake) {
      return await this.drainQueue();
    }

    return 0;
  }

  private async drainQueue(): Promise<number> {
    const deploys = this.queue.peek();
    let drained = 0;

    for (const deploy of deploys) {
      const ok = await this.github.retriggerWorkflow(
        deploy.repo,
        deploy.workflow_run_id,
        deploy.branch,
      );
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
    this.intervalId = setInterval(() => this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
