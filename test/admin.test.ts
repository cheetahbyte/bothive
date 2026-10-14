import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runCli, runProcess } from "./cli.ts";
import { app, createUserWithToken, request } from "./helpers.ts";

describe("boot configuration", () => {
  it("API exits with a clear error when DATABASE_URL is missing", async () => {
    const result = await runProcess("src/api/main.ts", [], {});
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Invalid configuration");
    expect(result.stderr).toContain("DATABASE_URL");
  });

  it("API exits with a clear error when configuration is invalid", async () => {
    const result = await runProcess("src/api/main.ts", [], {
      DATABASE_URL: "not-a-url",
      PORT: "abc",
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL");
    expect(result.stderr).toContain("PORT");
  });

  it("CLI exits with a clear error when configuration is missing", async () => {
    const result = await runProcess("src/cli/main.ts", ["user", "list"], {});
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Invalid configuration");
  });
});

describe("CLI arguments", () => {
  it("prints usage and exits 0 for --help and -h", async () => {
    for (const flag of ["--help", "-h"]) {
      const result = await runCli([flag]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Usage:");
    }
  });

  it("prints usage and exits 1 for unknown options", async () => {
    const result = await runCli(["user", "list", "--bogus"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });
});

describe("migrations", () => {
  it("are an explicit CLI step and are idempotent", async () => {
    const result = await runCli(["migrate"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Migrations applied");
  });
});

describe("users", () => {
  it("are created and listed by the CLI", async () => {
    const name = `user-${randomUUID()}`;
    expect((await runCli(["user", "create", name])).code).toBe(0);
    const list = await runCli(["user", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(name);
  });

  it("cannot be created twice with the same name", async () => {
    const name = `user-${randomUUID()}`;
    await runCli(["user", "create", name]);
    expect((await runCli(["user", "create", name])).code).toBe(1);
  });

  it("are rejected with a blank, overlong or control-character name", async () => {
    for (const name of ["   ", "x".repeat(101), "a\tb", "a\nb"]) {
      const result = await runCli(["user", "create", name]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Invalid user name");
    }
  });
});

describe("API tokens", () => {
  it("authenticate the User they were issued for", async () => {
    const { token } = await createUserWithToken();
    expect((await request(token, "/bots")).status).toBe(200);
  });

  it("are shown once and never listed again", async () => {
    const { name, token } = await createUserWithToken();
    const list = await runCli(["user", "list"]);
    expect(list.stdout).not.toContain(token);
    const second = await runCli(["token", "issue", name]);
    expect(second.stdout).not.toContain(token);
  });

  it("cannot be issued for an unknown User", async () => {
    const result = await runCli(["token", "issue", `missing-${randomUUID()}`]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unknown user");
  });

  it("are rejected when missing, malformed, unknown or revoked", async () => {
    const { token, tokenId } = await createUserWithToken();
    expect((await request(null, "/bots")).status).toBe(401);
    expect((await request("bh_unknown", "/bots")).status).toBe(401);
    const malformed = await app.request("/bots", {
      headers: { authorization: `Basic ${token}` },
    });
    expect(malformed.status).toBe(401);

    expect((await request(token, "/bots")).status).toBe(200);
    expect((await runCli(["token", "revoke", tokenId])).code).toBe(0);
    expect((await request(token, "/bots")).status).toBe(401);
  });

  it("accept the Bearer scheme case-insensitively", async () => {
    const { token } = await createUserWithToken();
    for (const header of [`bearer ${token}`, `BEARER  ${token}`]) {
      const response = await app.request("/bots", { headers: { authorization: header } });
      expect(response.status).toBe(200);
    }
  });

  it("cannot be revoked twice", async () => {
    const { tokenId } = await createUserWithToken();
    expect((await runCli(["token", "revoke", tokenId])).code).toBe(0);
    expect((await runCli(["token", "revoke", tokenId])).code).toBe(1);
  });

  it("reject a malformed token ID with a clear error", async () => {
    const result = await runCli(["token", "revoke", "invalid-id"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No active token with ID: invalid-id");
  });
});
