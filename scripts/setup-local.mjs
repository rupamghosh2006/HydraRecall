import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hydraDir = path.join(root, ".hydradb");
const tokenPath = path.join(hydraDir, "auth-token");
const envPath = path.join(root, ".env");

mkdirSync(path.join(hydraDir, "store"), { recursive: true });
mkdirSync(path.join(hydraDir, "cache"), { recursive: true });

let token;
if (existsSync(tokenPath)) {
  token = readFileSync(tokenPath, "utf8");
} else {
  token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
}

const defaults = {
  HYDRADB_AUTH_TOKEN: token.trim(),
  HYDRADB_HTTP_URL: "http://localhost:8443",
  HYDRADB_GRAPH_ID: "hydrarecall",
  HYDRADB_NAMESPACE: "hydrarecall",
  HYDRADB_CELL_ID: "cell-0",
  GROQ_API_KEY: "",
  GROQ_MODEL: "openai/gpt-oss-20b",
  PORT: "3000",
};

const original = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const existing = new Map();
for (const line of original.split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
  if (match) existing.set(match[1], match[2]);
}
for (const [key, value] of Object.entries(defaults)) {
  if (!existing.has(key) || !existing.get(key).trim()) existing.set(key, value);
}
writeFileSync(envPath, `${[...existing.entries()].map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });

console.log("HydraRecall local storage and credentials are ready.");
console.log("Next: docker compose up --build");
