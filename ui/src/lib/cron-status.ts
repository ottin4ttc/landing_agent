// Control UI module implements cron status behavior.
import type { CronJob, CronRunStatus } from "../api/types.ts";

export type CronJobLastRunStatus = CronRunStatus | "unknown";

export function resolveCronJobLastRunStatus(job: CronJob): CronJobLastRunStatus {
  return job.state?.lastRunStatus ?? job.state?.lastStatus ?? "unknown";
}
