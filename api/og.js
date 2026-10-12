import { createClient } from '@supabase/supabase-js';

// This function is only ever reached for requests vercel.json's rewrites
// route here — the bot user-agent regex that gates that routing lives in
// TWO places in vercel.json (the original "/" + ?business= rule, and the
// "/:slug" rule that makes this file reachable for real shared links).
// vercel.json is strict JSON and can't hold a comment there, so: if that
// regex ever changes, it must change identically in both rewrite rules,
// or one of the two entry points silently stops being crawler-gated.
const SITE_URL = 'https://danda.ng';

// Real app routes that are single path segments, same shape as a business
// slug — a crawler requesting one of these must not get a 404 (they're
// legitimate pages) or a fabricated "business" (they aren't one). Generic
// site metadata is the correct answer for all of them.
// KEEP IN SYNC WITH KNOWN_PATHS IN src/App.jsx (minus '' and '/', which
// :slug in vercel.json's rewrite never captures — only a non-empty segment
// reaches this function).
const RESERVED_SLUGS = new Set(['marketplace', 'terms', 'privacy', 'signup', 'login']);

const GENERIC_TITLE = 'Danda — Booking Pages for Nigerian Professionals';
const GENERIC_DESCRIPTION = 'Get your own booking page, client dashboard, and earnings tracker. Danda helps Nigerian professionals look professional and get booked.';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sendHtml(res, status, html, { cache = true } = {}) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (cache) res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  res.status(status).send(html);
}

// Generic Danda metadata — used for the reserved-path allowlist above.
// Not a redirect target for real browsers since they never reach this
// function (the rewrite that sends traffic here is bot-gated), but a
// static site-wide canonical is still correct to include.
function renderGeneric(res) {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(GENERIC_TITLE)}</title>
    <meta name="description" content="${escapeHtml(GENERIC_DESCRIPTION)}" />
    <meta property="og:title" content="${escapeHtml(GENERIC_TITLE)}" />
    <meta property="og:description" content="${escapeHtml(GENERIC_DESCRIPTION)}" />
    <meta property="og:url" content="${SITE_URL}/" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Danda" />
    <meta property="og:image" content="${SITE_URL}/og-image.jpg" />
    <meta property="og:image:type" content="image/jpeg" />
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${escapeHtml(GENERIC_TITLE)}" />
    <meta name="twitter:description" content="${escapeHtml(GENERIC_DESCRIPTION)}" />
    <link rel="canonical" href="${SITE_URL}/" />
  </head>
  <body></body>
</html>`;
  sendHtml(res, 200, html);
}

// A real HTTP 404 — the slug matched no business and isn't a reserved
// app route. noindex is redundant with the 404 status for a compliant
// crawler, but costs nothing and protects against one that indexes
// non-200 responses anyway.
function renderNotFound(res, slug) {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Page Not Found — Danda</title>
    <meta name="robots" content="noindex" />
  </head>
  <body><p>No business found for "${escapeHtml(slug ?? '')}".</p></body>
</html>`;
  sendHtml(res, 404, html, { cache: false });
}

export default async function handler(req, res) {
  const { business: businessId } = req.query;
  const slugParam = Array.isArray(req.query.slug) ? req.query.slug[0] : req.query.slug;

  if (!businessId && !slugParam) {
    res.status(400).send('Missing business or slug parameter');
    return;
  }

  if (slugParam && RESERVED_SLUGS.has(slugParam)) {
    renderGeneric(res);
    return;
  }

  // Anon key, same as api/sitemap.js — deliberately not the service role.
  // That key is kept out of Vercel entirely (it lives only in Supabase
  // Edge Function secrets); everything this function reads is already
  // public on the booking page itself, so businesses_public (anon-
  // readable, RLS-safe) is the right source, not the base table.
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;

  // A missing env var is our misconfiguration, not evidence the business
  // doesn't exist — degrade to generic metadata, don't 500 a crawler.
  if (!supabaseUrl || !anonKey) {
    console.error('[og] missing env vars — serving generic metadata');
    renderGeneric(res);
    return;
  }

  const supabase = createClient(supabaseUrl, anonKey);

  // Legacy id-based lookup (nothing generates a `?business=` link today,
  // but nothing should break it either) or the real path: by slug, which
  // is what a shared /:slug link actually carries. businesses_public
  // exposes id, name, tagline, avatar_url, slug, and a precomputed
  // is_active (subscription_status = 'active' and plan_expires_at in
  // the future — see fix_payment_verification.sql) — everything below,
  // no base-table access needed.
  let query = supabase
    .from('businesses_public')
    .select('name, tagline, avatar_url, slug, is_active');
  query = businessId ? query.eq('id', businessId) : query.eq('slug', slugParam);

  // maybeSingle, not single — a miss here is an ordinary not-found, not
  // an error. slug has a unique constraint (businesses_slug_key) so this
  // can never resolve to more than one row.
  const { data: biz, error: bizError } = await query.maybeSingle();

  // A failed lookup (network blip, Supabase hiccup) is not the same
  // claim as "this business doesn't exist" — only an actually-empty,
  // error-free result earns the real 404 below. Anything else degrades
  // to generic metadata: a recoverable, honest-enough preview beats
  // telling Google every business page is broken.
  if (bizError) {
    console.error('[og] supabase query error:', JSON.stringify(bizError));
    renderGeneric(res);
    return;
  }

  if (!biz) {
    renderNotFound(res, slugParam ?? businessId);
    return;
  }

  const isActive = biz.is_active === true;
  const name = biz.name ?? 'Danda';

  // Mirrors the two real states PublicView.jsx renders for a visitor:
  // the live booking page (loadAll(), PublicView.jsx) when active, or
  // the "temporarily unavailable" gate (PublicView.jsx's subscription
  // gate) when not. The preview must not promise a booking flow the
  // page won't actually offer.
  const title = isActive ? `${name} — Book on Danda` : `${name} — Danda`;
  const description = isActive
    ? (biz.tagline?.trim() || `Book with ${name} on Danda — fast, easy online booking.`)
    : `${name} is temporarily unavailable right now. Check back soon or contact them directly.`;

  const canonicalPath = biz.slug ? `/${biz.slug}` : `/?business=${encodeURIComponent(businessId)}`;
  const canonicalUrl = `${SITE_URL}${canonicalPath}`;
  const ogImage = biz.avatar_url || `${SITE_URL}/og-image.jpg`;
  // image:type is only known for our own fallback asset — a business's own
  // uploaded avatar_url can be any format (png/jpg/webp), so it's omitted
  // rather than guessed when that's what's being served.
  const ogImageType = biz.avatar_url ? '' : '<meta property="og:image:type" content="image/jpeg" />';

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Danda" />
    <meta property="og:image" content="${escapeHtml(ogImage)}" />
    ${ogImageType}
    <meta name="twitter:card" content="summary" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
  </head>
  <body>
    <script>window.location.replace(${JSON.stringify(canonicalUrl)});</script>
    <p>Redirecting to ${escapeHtml(name)}&hellip;</p>
  </body>
</html>`;

  sendHtml(res, 200, html);
}
