import { z } from "zod/v3";

type MakeOptional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export const ScheduledRun = z.object({
  schedule: z.string().default("*/5 * * * * *"),
  threadID: z.string().uuid().optional(),
  assistantID: z.string(),
  payload: z.object({
    input: z.record(z.any()).optional(),
    metadata: z.record(z.any()).optional(),
    config: z.record(z.any()).optional(),
  }),

  /**
   * If true, the scheduled run will only run once and unscheduled itself once it's done.
   */
  unscheduleOnIdle: z.boolean().default(false),
});

export type ScheduledRunType = z.infer<typeof ScheduledRun>;
export type ScheduledRunCreateType = MakeOptional<
  ScheduledRunType,
  "schedule" | "unscheduleOnIdle"
>;
