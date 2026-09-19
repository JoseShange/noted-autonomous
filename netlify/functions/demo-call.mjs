// Noted Autonomous — live demo receptionist
// Mints a Retell web-call token for the tier the visitor clicked.
// Env: RETELL_API_KEY (required), RETELL_AGENT_ID (optional, falls back to the sales agent)

const AGENT_ID = process.env.RETELL_AGENT_ID || "agent_58644c4f880a49a49c65c7fba7";
const MAX_CALL_MS = 10 * 60 * 1000;          // hard 10-minute cap, enforced by Retell
const RATE_WINDOW_MS = 15 * 60 * 1000;       // per-IP window
const RATE_MAX = 3;                          // calls per IP per window
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;     // site-wide window
const GLOBAL_MAX = 40;                       // calls per hour across all visitors

const ALLOWED_HOSTS = [
  "notedautonomous.com",
  "www.notedautonomous.com",
  "noted-autonomous.netlify.app",
];

const TIERS = {
  starter: {
    label: "Starter",
    persona: "Sophie",
    voice_id: "retell-Willa",
    avatar: "avatar-sophie.png",
    price: "R1,950 a month",
    minutes: "200 call-minutes",
    highlights:
      "answering every call 24/7 including after hours and weekends, capturing the caller's name, number and what they want, and sending Jose an SMS, an email and the call recording the second the call ends",
  },
  business: {
    label: "Business",
    persona: "Nikita",
    voice_id: "retell-Grace",
    avatar: "avatar-nikita.png",
    price: "R3,950 a month",
    minutes: "600 call-minutes",
    highlights:
      "everything in Starter, plus booking appointments into the client's calendar, transferring live calls to the right person, screening and blocking spam callers, and a voice, name and accent of the client's choosing",
  },
  multisite: {
    label: "Multi-site",
    persona: "Davis",
    voice_id: "retell-Nico",
    avatar: "avatar-davis.png",
    price: "from R7,500 a month",
    minutes: "several numbers, branches or teams",
    highlights:
      "everything in Business, plus a separate receptionist for each branch or department, routing rules built around how the business actually works, integration with the systems they already use, and priority support",
  },
};

// Best-effort in-process limiters. Serverless instances are recycled, so these are
// a speed bump, not a guarantee — the real ceiling is the spend cap set in Retell.
const seen = new Map();
let globalHits = [];

function tooMany(ip) {
  const now = Date.now();
  globalHits = globalHits.filter((t) => now - t < GLOBAL_WINDOW_MS);
  if (globalHits.length >= GLOBAL_MAX) return "busy";

  const hits = (seen.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) return "rate";

  hits.push(now);
  seen.set(ip, hits);
  globalHits.push(now);
  if (seen.size > 5000) seen.clear();
  return null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const origin = req.headers.get("origin") || "";
  if (origin) {
    let host = "";
    try { host = new URL(origin).hostname; } catch { /* malformed */ }
    const ok = ALLOWED_HOSTS.includes(host) || host.endsWith(".netlify.app");
    if (!ok) return json({ error: "forbidden_origin" }, 403);
  }

  // Trim: a pasted key often carries a trailing newline or space, which Retell rejects as invalid.
  const apiKey = (process.env.RETELL_API_KEY || "").trim();
  if (!apiKey) return json({ error: "not_configured" }, 500);

  let tierKey = "business";
  try {
    const body = await req.json();
    if (body && typeof body.tier === "string") tierKey = body.tier.toLowerCase();
  } catch { /* fall through to default */ }

  const tier = TIERS[tierKey];
  if (!tier) return json({ error: "unknown_tier" }, 400);

  const ip =
    req.headers.get("x-nf-client-connection-ip") ||
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown";

  const limited = tooMany(ip);
  if (limited === "rate") return json({ error: "rate_limited" }, 429);
  if (limited === "busy") return json({ error: "demo_busy" }, 503);

  // The recording announcement is required (RICA/POPIA) and must survive this override.
  const greeting =
    `Hi, you've reached Noted Autonomous — I'm ${tier.persona}, ` +
    `and I look after our ${tier.label} clients. ` +
    `Just so you know, this call is recorded. What can I do for you?`;

  const payload = {
    agent_id: AGENT_ID,
    metadata: { source: "website_pricing", tier: tierKey },
    retell_llm_dynamic_variables: {
      demo_context:
        `This is a live demo from the pricing page of notedautonomous.com. ` +
        `The visitor clicked the ${tier.label} plan, so introduce yourself as ${tier.persona} ` +
        `and lead with what that plan does for a business like theirs. ` +
        `${tier.label} costs ${tier.price} and includes ${tier.minutes}: ${tier.highlights}. ` +
        `Setup is R4,500 once-off, it is month to month with no lock-in, and extra minutes are R8 each. ` +
        `If they ask about the other plans, explain them honestly and compare. ` +
        `Mention early and naturally that any voice, any accent and any name is available on every plan — ` +
        `you are simply the one they reached today. ` +
        `Still capture their name and number before the call ends so Jose can follow up.`,
      persona_name: tier.persona,
      tier_name: tier.label,
      tier_price: tier.price,
      tier_minutes: tier.minutes,
    },
    agent_override: {
      agent: {
        voice_id: tier.voice_id,
        max_call_duration_ms: MAX_CALL_MS,
      },
      retell_llm: { begin_message: greeting },
    },
  };

  async function mint(withGreetingOverride) {
    const body = structuredClone(payload);
    if (!withGreetingOverride) delete body.agent_override.retell_llm;
    const r = await fetch("https://api.retellai.com/v2/create-web-call", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return r;
  }

  let res = await mint(true);
  if (!res.ok && res.status >= 400 && res.status < 500) {
    // The greeting override is the only speculative field — drop it and try once more.
    res = await mint(false);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("retell create-web-call failed", res.status, detail.slice(0, 500));
    // Temporary: surface Retell's validation message so the wiring can be diagnosed.
    // Contains no credentials. Remove once the demo is confirmed working.
    return json({ error: "call_failed", upstream_status: res.status, upstream_detail: detail.slice(0, 400) }, 502);
  }

  const data = await res.json();
  return json({
    access_token: data.access_token,
    call_id: data.call_id,
    persona: tier.persona,
    label: tier.label,
    avatar: tier.avatar,
    max_seconds: MAX_CALL_MS / 1000,
  });
};

export const config = { path: "/api/demo-call" };
