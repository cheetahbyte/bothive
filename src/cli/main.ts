import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { createDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  createUser,
  issueApiToken,
  listUsers,
  revokeApiToken,
  userNameSchema,
} from "../identity/users.ts";

const usage = `Usage:
  cli migrate
  cli user create <name>
  cli user list
  cli token issue <user-name>
  cli token revoke <token-id>`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseCliArgs() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: { help: { type: "boolean", short: "h" } },
    });
  } catch {
    return fail(usage);
  }
}

const { values, positionals } = parseCliArgs();
const [group, action, arg] = positionals;

if (values.help) {
  console.log(usage);
  process.exit(0);
}
if (!group) fail(usage);

const config = loadConfig(process.env);
const { db, close } = createDb(config.DATABASE_URL);

try {
  if (group === "migrate" && !action) {
    await runMigrations(db);
    console.log("Migrations applied");
  } else if (group === "user" && action === "create" && arg) {
    const name = userNameSchema.safeParse(arg);
    if (!name.success) fail(`Invalid user name: ${name.error.issues[0]?.message}`);
    const user = await createUser(db, name.data);
    console.log(`${user.id}\t${user.name}`);
  } else if (group === "user" && action === "list") {
    for (const user of await listUsers(db)) console.log(`${user.id}\t${user.name}`);
  } else if (group === "token" && action === "issue" && arg) {
    const issued = await issueApiToken(db, arg);
    if (!issued) fail(`Unknown user: ${arg}`);
    console.log(`Token ID: ${issued.id}`);
    console.log(`Token (shown once): ${issued.token}`);
  } else if (group === "token" && action === "revoke" && arg) {
    if (!(await revokeApiToken(db, arg))) fail(`No active token with ID: ${arg}`);
    console.log("Token revoked");
  } else {
    fail(usage);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  await close();
}
