/**
 * Content-Security-Policy built at BUILD time from the environment (next.config.ts headers()).
 *
 * Tradeoff: no nonce. A per-request nonce forces every page to render dynamically, and this template promises
 * static public pages (CDN-cached, fast, cheap). So scripts are an allowlist of origins plus 'unsafe-inline'
 * (Next.js inlines its bootstrap scripts). What it still blocks: scripts, frames and fetches to any origin not
 * listed (exfiltration, injected third-party scripts), <base> hijacking, plugins, framing (clickjacking) and form
 * posts to other sites. What it does NOT block: an inline <script> injected into our own HTML (XSS) — that
 * protection comes from React escaping and never using dangerouslySetInnerHTML with user data.
 * If a project needs strict CSP, switch to nonces in proxy.ts and accept dynamic rendering.
 */
export type CspOptions = {
  supabaseUrl?: string;
  sentryDsn?: string;
  siteUrl?: string;
  /** VERCEL_ENV: "preview" adds the Vercel toolbar (comments) origins. */
  vercelEnv?: string;
  /** `next dev`: React Refresh needs eval and the HMR websocket. */
  dev?: boolean;
};

const TURNSTILE = "https://challenges.cloudflare.com";
const STRIPE_FRAMES = ["https://js.stripe.com", "https://hooks.stripe.com"];
const STRIPE_FORMS = ["https://checkout.stripe.com", "https://billing.stripe.com"];

const originOf = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

/** Sentry DSN `https://<key>@o123.ingest.sentry.io/456` -> `https://o123.ingest.sentry.io`. */
const sentryOrigin = (dsn: string | undefined) => {
  const origin = originOf(dsn);
  return origin ? origin.replace(/\/\/[^@/]*@/, "//") : null;
};

export function buildCsp({ supabaseUrl, sentryDsn, siteUrl, vercelEnv, dev = false }: CspOptions): string {
  const supabase = originOf(supabaseUrl);
  const supabaseRealtime = supabase?.replace(/^http/, "ws") ?? null;
  const sentry = sentryOrigin(sentryDsn);
  const preview = vercelEnv === "preview";
  const vercelLive = preview ? ["https://vercel.live"] : [];

  const directives: Record<string, Array<string | null>> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      "'unsafe-inline'",
      ...(dev ? ["'unsafe-eval'", "https://va.vercel-scripts.com"] : []),
      TURNSTILE,
      ...vercelLive,
    ],
    "style-src": ["'self'", "'unsafe-inline'", ...vercelLive],
    "img-src": [
      "'self'",
      "data:",
      "blob:",
      supabase,
      ...(preview ? ["https://vercel.live", "https://vercel.com"] : []),
    ],
    "font-src": ["'self'", "data:", ...(preview ? ["https://vercel.live", "https://assets.vercel.com"] : [])],
    "connect-src": [
      "'self'",
      supabase,
      supabaseRealtime,
      TURNSTILE,
      sentry,
      ...(dev ? ["ws:"] : []),
      ...(preview ? ["https://vercel.live", "wss://ws-us3.pusher.com"] : []),
    ],
    "frame-src": [TURNSTILE, ...STRIPE_FRAMES, ...vercelLive],
    "media-src": ["'self'", "blob:", supabase],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "form-action": ["'self'", ...STRIPE_FORMS],
    "base-uri": ["'self'"],
    "object-src": ["'none'"],
    "frame-ancestors": ["'none'"],
  };

  const policy = Object.entries(directives).map(([name, sources]) =>
    [name, ...new Set(sources.filter((source): source is string => Boolean(source)))].join(" "),
  );
  if (!dev && siteUrl?.startsWith("https://")) policy.push("upgrade-insecure-requests");
  return policy.join("; ");
}
