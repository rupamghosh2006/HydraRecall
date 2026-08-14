import { createHash, timingSafeEqual } from "node:crypto";

const roles = new Set(["reader", "writer", "admin"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeHashMatch(left, right) {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseRoles(value) {
  const parsed = String(value || "")
    .split("+")
    .map((role) => role.trim().toLowerCase())
    .filter((role) => roles.has(role));
  return new Set(parsed);
}

export function parseApiKeyEntries(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, roleList, hash] = entry.split(":");
      const permissions = parseRoles(roleList);
      if (!/^[a-zA-Z0-9._-]{3,80}$/.test(id || "") || !permissions.size || !/^[a-f0-9]{64}$/i.test(hash || "")) {
        throw new Error("Invalid HYDRARECALL_API_KEY_HASHES entry. Use key-id:reader+writer:sha256hex.");
      }
      return { id, roles: permissions, hash: hash.toLowerCase() };
    });
}

function parseOrigins(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );
}

function clientAddress(request) {
  const forwarded = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || request.socket.remoteAddress || "unknown";
}

function roleAllows(principal, requiredRole) {
  if (!requiredRole) return true;
  if (principal.roles.has("admin")) return true;
  if (requiredRole === "reader") return principal.roles.has("reader") || principal.roles.has("writer");
  return principal.roles.has(requiredRole);
}

export function createAuth(options = {}) {
  const mode = String(options.mode || "disabled").toLowerCase();
  const apiKeys = parseApiKeyEntries(options.apiKeyHashes);
  const allowedOrigins = parseOrigins(options.corsOrigins);
  const maxPerMinute = Math.max(1, Number(options.maxPerMinute || 120));
  const buckets = new Map();
  const setupError = mode !== "disabled" && mode !== "api-key"
    ? "AUTH_MODE must be disabled or api-key."
    : mode === "api-key" && !apiKeys.length
      ? "AUTH_MODE=api-key requires HYDRARECALL_API_KEY_HASHES."
      : null;

  function authenticate(request) {
    if (setupError) return { ok: false, status: 503, code: "auth_misconfigured", message: "Authentication is not configured correctly." };
    if (mode === "disabled") {
      return { ok: true, principal: { id: "development", roles: new Set(["admin"]), mode: "disabled" } };
    }

    const authorization = String(request.headers.authorization || "");
    const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    const apiKey = String(request.headers["x-api-key"] || bearer || "").trim();
    if (!apiKey || apiKey.length > 512) {
      return { ok: false, status: 401, code: "authentication_required", message: "Provide an API key." };
    }

    const candidateHash = sha256(apiKey);
    const entry = apiKeys.find((item) => safeHashMatch(item.hash, candidateHash));
    if (!entry) return { ok: false, status: 401, code: "invalid_api_key", message: "Invalid API key." };
    return { ok: true, principal: { id: entry.id, roles: entry.roles, mode: "api-key" } };
  }

  function consumeRateLimit(key) {
    const now = Date.now();
    const current = buckets.get(key);
    const bucket = !current || now - current.startedAt >= 60_000 ? { startedAt: now, count: 0 } : current;
    bucket.count += 1;
    buckets.set(key, bucket);
    if (buckets.size > 10_000) {
      for (const [bucketKey, item] of buckets) if (now - item.startedAt >= 60_000) buckets.delete(bucketKey);
    }
    return { allowed: bucket.count <= maxPerMinute, retryAfter: Math.max(1, Math.ceil((60_000 - (now - bucket.startedAt)) / 1_000)) };
  }

  function authorize(request, requiredRole) {
    const auth = authenticate(request);
    if (auth.ok && mode === "disabled") return auth;
    const rateKey = `${auth.ok ? auth.principal.id : "anonymous"}:${clientAddress(request)}`;
    const rate = consumeRateLimit(rateKey);
    if (!rate.allowed) return { ok: false, status: 429, code: "rate_limited", message: "Too many requests.", retryAfter: rate.retryAfter };
    if (!auth.ok) return auth;
    if (!roleAllows(auth.principal, requiredRole)) {
      return { ok: false, status: 403, code: "insufficient_scope", message: "This API key does not have the required permission." };
    }
    return auth;
  }

  function headers(request = { headers: {}, socket: {} }) {
    const origin = String(request.headers.origin || "").replace(/\/$/, "");
    const result = {
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=()",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'self'; base-uri 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
    };
    if (origin && allowedOrigins.has(origin)) {
      result["Access-Control-Allow-Origin"] = origin;
      result["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-API-Key";
      result["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
      result.Vary = "Origin";
    }
    if (request.headers["x-forwarded-proto"] === "https" || request.socket.encrypted) {
      result["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
    }
    return result;
  }

  return {
    mode,
    setupError,
    headers,
    authenticate,
    authorize,
    publicStatus: () => ({ enabled: mode !== "disabled", mode, ready: !setupError }),
  };
}

export function hashApiKey(value) {
  return sha256(value);
}
