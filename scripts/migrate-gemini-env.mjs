import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");
if (!existsSync(envPath)) throw new Error("No .env file was found. Copy .env.example, then add GEMINI_API_KEY.");

const entries = [];
const values = new Map();
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
  if (!match) continue;
  entries.push(match[1]);
  values.set(match[1], match[2]);
}

const geminiKey = values.get("GEMINI_API_KEY") || values.get("LLM_API_KEY") || "";
const geminiModel = values.get("GEMINI_MODEL") || values.get("LLM_MODEL") || "gemini-3.5-flash";
if (!geminiKey.trim()) throw new Error("No Gemini key found in GEMINI_API_KEY or LLM_API_KEY.");

for (const key of ["GROQ_API_KEY", "GROQ_MODEL", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "GEMINI_API_KEY", "GEMINI_MODEL"]) values.delete(key);
const retained = entries.filter((key, index) => entries.indexOf(key) === index && values.has(key));
const migrated = [
  "# Gemini Flash is the sole application model provider.",
  `GEMINI_API_KEY=${geminiKey}`,
  `GEMINI_MODEL=${geminiModel}`,
  ...retained.map((key) => `${key}=${values.get(key)}`),
].join("\n");
writeFileSync(envPath, `${migrated}\n`, { mode: 0o600 });
console.log("Migrated local LLM configuration to GEMINI_API_KEY/GEMINI_MODEL without displaying secrets.");
