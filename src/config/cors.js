const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://disabilitymne-admin-dashboard.vercel.app",
];

const CORS_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const CORS_ALLOWED_HEADERS = ["Content-Type", "Authorization", "X-Refresh-Token", "x-refresh-token"];

const normalizeOrigin = (value) => String(value || "").trim().replace(/\/$/, "");

const escapeRegex = (value) => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");

const wildcardToRegex = (value) => {
  const normalized = normalizeOrigin(value);
  if (!normalized.includes("*")) return null;
  const escaped = escapeRegex(normalized).replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
};

const parseOriginsFromEnv = () => {
  const raw = normalizeOrigin(process.env.CORS_ORIGIN);
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;
  return raw
    .split(",")
    .map((item) => normalizeOrigin(item))
    .filter(Boolean);
};

const buildOriginMatcher = () => {
  const configuredOrigins = parseOriginsFromEnv();
  const allowAll = configuredOrigins.includes("*");
  const exactOrigins = new Set();
  const wildcardRegexes = [];

  for (const value of configuredOrigins) {
    if (value === "*") continue;
    const maybeRegex = wildcardToRegex(value);
    if (maybeRegex) {
      wildcardRegexes.push(maybeRegex);
      continue;
    }
    exactOrigins.add(value);
  }

  return { allowAll, exactOrigins, wildcardRegexes };
};

const isOriginAllowed = (requestOrigin, matcher) => {
  // Non-browser clients (curl, postman, server-to-server) do not send Origin header.
  if (!requestOrigin) return true;
  if (matcher.allowAll) return true;

  const normalized = normalizeOrigin(requestOrigin);
  if (matcher.exactOrigins.has(normalized)) return true;

  return matcher.wildcardRegexes.some((regex) => regex.test(normalized));
};

export const buildCorsOptions = () => {
  const matcher = buildOriginMatcher();

  return {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin, matcher)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: !matcher.allowAll,
    methods: CORS_METHODS,
    allowedHeaders: CORS_ALLOWED_HEADERS,
    optionsSuccessStatus: 204,
    maxAge: 86400,
  };
};

export const getSocketCorsOptions = () => {
  const corsOptions = buildCorsOptions();
  return {
    origin: corsOptions.origin,
    credentials: corsOptions.credentials,
    methods: ["GET", "POST"],
    allowedHeaders: CORS_ALLOWED_HEADERS,
  };
};

