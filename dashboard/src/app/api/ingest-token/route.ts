import { withSession } from '@/lib/api-session';

/**
 * The credential the extension needs to file into the hosted ingest server.
 *
 * A route rather than something the Panduan page renders, and that is a
 * security property rather than a preference: every protected page in this app
 * ships its rendered HTML **as the body of the 307 to `/login`**, so a token
 * printed into the page would be readable by anyone who ignores the redirect.
 * A handler answers 401 with nothing in it, and the page fetches this only
 * after the reader has asked for it.
 *
 * Hosted mode is the only mode this exists for. A laptop's own server hands its
 * token to the extension over loopback (`GET /pair`), which needs no login,
 * because "on this machine" is the whole check. Nothing off the machine can
 * make that claim, so a deployment refuses to pair and this takes over.
 *
 * Both values come from the environment. The dashboard never invents the token
 * — it is the same string the ingest deployment checks against, and if the two
 * are configured from different values the only symptom is a 401 the user
 * cannot explain.
 */

export const dynamic = 'force-dynamic';

const NOT_CONFIGURED =
  'Server ingest awan belum dikonfigurasi. Set INGEST_ENDPOINT dan INGEST_TOKEN ' +
  'di project ini, atau pakai server lokal.';

export const GET = withSession(async () => {
  const endpoint = process.env.INGEST_ENDPOINT?.trim();
  const token = process.env.INGEST_TOKEN?.trim();

  if (!endpoint || !token) {
    // 404, not 500: a deployment that only ever uses a local ingest server is a
    // supported arrangement, not a broken one.
    return Response.json({ error: NOT_CONFIGURED }, { status: 404 });
  }

  return Response.json(
    { endpoint, token },
    // Never a shared cache, and never a disk cache: this is a write credential
    // for the shared catalogue, scoped to the one reader who asked for it.
    { headers: { 'Cache-Control': 'private, no-store' } },
  );
});
