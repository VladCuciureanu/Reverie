export type SleepState = "awake" | "light" | "deep" | "rem";

export interface SleepStatus {
  state: SleepState;
  since: Date;
}
