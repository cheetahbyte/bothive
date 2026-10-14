import pg from "pg";
import { runCli } from "./cli.ts";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is required");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await client.query("DROP SCHEMA public CASCADE");
  await client.query("CREATE SCHEMA public");
  await client.end();
  const result = await runCli(["migrate"]);
  if (result.code !== 0) throw new Error(`migrate failed: ${result.stderr}`);
}
