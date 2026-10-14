import { z } from "zod";

export const configSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WORKER_BOT_ID: z.uuid().optional(),
  JOB_LEASE_DURATION_MS: z.coerce.number().int().min(1).default(30_000),
  JOB_RENEW_INTERVAL_MS: z.coerce.number().int().min(1).default(10_000),
  JOB_BACKOFF_BASE_MS: z.coerce.number().int().min(1).default(1_000),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  RUN_TIMEOUT_MS: z.coerce.number().int().min(1).default(60_000),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    console.error(`Invalid configuration:\n${problems}`);
    process.exit(1);
  }
  return parsed.data;
}
