import { createHash, randomBytes } from "node:crypto";

const TOKEN_PREFIX = "bh_";

export function generateApiToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
