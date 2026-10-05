import { createClient } from '@supabase/supabase-js';

// Keeps the Supabase project from pausing due to inactivity (free-tier
// projects pause after a period of no database activity). Vercel's cron
// scheduler hits this once a day — see the "crons" entry in vercel.json.
//
// Anon key, same reasoning as api/og.js and api/sitemap.js: the service
// role key is deliberately kept out of Vercel entirely and lives only in
// Supabase Edge Function secrets. A plain anon-readable read is enough to
// register as activity; this never needs to write anything.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const expected = process.env.CRON_SECRET;
  const auth = req.headers.authorization;
  if (!expected || auth !== `Bearer ${expected}`) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    console.error('[cron/keep-alive] missing Supabase env vars');
    res.status(500).json({ ok: false, error: 'Missing Supabase env vars' });
    return;
  }

  try {
    const supabase = createClient(supabaseUrl, anonKey);
    const { error } = await supabase.from('businesses_public').select('id').limit(1);
    if (error) throw error;
    res.status(200).json({ ok: true, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('[cron/keep-alive] query failed:', error);
    res.status(500).json({ ok: false, error: error.message || 'Query failed' });
  }
}
