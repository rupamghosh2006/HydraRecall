import { randomBytes } from "node:crypto";
import { hashApiKey } from "../lib/security.mjs";

const keyId = process.argv[2] || "production-app";
const roleList = process.argv[3] || "reader+writer";

if (!/^[a-zA-Z0-9._-]{3,80}$/.test(keyId)) throw new Error("Key id must contain 3-80 letters, digits, dots, underscores, or dashes.");
if (!/^(reader|writer|admin)(\+(reader|writer|admin))*$/.test(roleList)) throw new Error("Roles must be reader, writer, admin, joined by +.");

const apiKey = `hr_${randomBytes(32).toString("base64url")}`;
console.log("Copy the API key now; it cannot be recovered from its hash:");
console.log(apiKey);
console.log("\nStore only this entry in your secret manager:");
console.log(`${keyId}:${roleList}:${hashApiKey(apiKey)}`);
