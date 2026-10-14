import { execFile } from "node:child_process";

export const databaseUrl = process.env.TEST_DATABASE_URL ?? "";

export type CliResult = { code: number; stdout: string; stderr: string };

export function runProcess(
  entry: string,
  args: string[],
  env: Record<string, string>,
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [entry, ...args],
      { env: { PATH: process.env.PATH, ...env } },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

export function runCli(args: string[]) {
  return runProcess("src/cli/main.ts", args, { DATABASE_URL: databaseUrl });
}
