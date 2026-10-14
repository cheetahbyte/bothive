import { describe, expect, it } from "vitest";
import { configSchema, loadConfig } from "../src/config.ts";

describe("configuration", () => {
  it("provides default timing and retry values when only DATABASE_URL is set", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://bothive:bothive@localhost:5432/bothive",
    });

    expect(config.JOB_LEASE_DURATION_MS).toBe(30_000);
    expect(config.JOB_RENEW_INTERVAL_MS).toBe(10_000);
    expect(config.JOB_BACKOFF_BASE_MS).toBe(1_000);
    expect(config.JOB_MAX_ATTEMPTS).toBe(3);
    expect(config.RUN_TIMEOUT_MS).toBe(60_000);
    expect(config.SHUTDOWN_TIMEOUT_MS).toBe(10_000);
    expect(config.USER_CONCURRENCY_LIMIT).toBe(8);
  });

  it("parses custom timing and retry values from environment", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://bothive:bothive@localhost:5432/bothive",
      JOB_LEASE_DURATION_MS: "5000",
      JOB_RENEW_INTERVAL_MS: "1500",
      JOB_BACKOFF_BASE_MS: "250",
      JOB_MAX_ATTEMPTS: "5",
      RUN_TIMEOUT_MS: "10000",
      SHUTDOWN_TIMEOUT_MS: "3000",
      USER_CONCURRENCY_LIMIT: "4",
    });

    expect(config.JOB_LEASE_DURATION_MS).toBe(5000);
    expect(config.JOB_RENEW_INTERVAL_MS).toBe(1500);
    expect(config.JOB_BACKOFF_BASE_MS).toBe(250);
    expect(config.JOB_MAX_ATTEMPTS).toBe(5);
    expect(config.RUN_TIMEOUT_MS).toBe(10_000);
    expect(config.SHUTDOWN_TIMEOUT_MS).toBe(3000);
    expect(config.USER_CONCURRENCY_LIMIT).toBe(4);
  });

  it("rejects invalid timing values", () => {
    const invalidLease = configSchema.safeParse({
      DATABASE_URL: "postgresql://bothive:bothive@localhost:5432/bothive",
      JOB_LEASE_DURATION_MS: "0",
    });
    expect(invalidLease.success).toBe(false);

    const invalidAttempts = configSchema.safeParse({
      DATABASE_URL: "postgresql://bothive:bothive@localhost:5432/bothive",
      JOB_MAX_ATTEMPTS: "-1",
    });
    expect(invalidAttempts.success).toBe(false);

    const nonNumericTimeout = configSchema.safeParse({
      DATABASE_URL: "postgresql://bothive:bothive@localhost:5432/bothive",
      RUN_TIMEOUT_MS: "not-a-number",
    });
    expect(nonNumericTimeout.success).toBe(false);

    const invalidShutdown = configSchema.safeParse({
      DATABASE_URL: "postgresql://bothive:bothive@localhost:5432/bothive",
      SHUTDOWN_TIMEOUT_MS: "-1",
    });
    expect(invalidShutdown.success).toBe(false);

    const invalidUserConcurrency = configSchema.safeParse({
      DATABASE_URL: "postgresql://bothive:bothive@localhost:5432/bothive",
      USER_CONCURRENCY_LIMIT: "0",
    });
    expect(invalidUserConcurrency.success).toBe(false);
  });
});
