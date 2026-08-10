import type { Metadata } from 'next';
import Link from 'next/link';

import { EmptyState } from '@/components/EmptyState';
import { NotificationsList } from '@/components/NotificationsList';
import { Card, CardContent, cn } from '@/components/ui';
import { foldByRecency } from '@/lib/notify/group';
import { BADGE_CAP, DEFAULT_WINDOW, rivalMoves, unreadRivalMoves } from '@/lib/notify/rival-moves';
import { readSeen } from '@/lib/notify/seen';
import { getOwnShops } from '@/lib/queries';

/**
 * Which rivals moved their price on a set we also sell.
 *
 * This screen replaces a Telegram bot, and the single rule that shapes it is
 * that **the read marker never filters the list**. The page always renders the
 * rolling 14-day window; the marker only decides which rows are styled new and
 * what the bell counts.
 *
 * That rule is not a preference. The first design filtered on the marker, and
 * measured against the live database it would have shipped an empty page on day
 * one: the marker's seed is 22154, the highest qualifying event id is 22089, so
 * every single event sat below it. A filtered page would have rendered nothing,
 * and an empty page is indistinguishable from a broken one. Worse, a marker that
 * filters can only ever be read once — one glance on a phone would erase a
 * 56-item worklist that then exists nowhere, which is strictly worse than the
 * searchable Telegram scrollback being removed.
 *
 * So there are two tabs off one query, and **Semua is the landing view**: a first
 * load proves the query works. "Baru" is the same query with one extra
 * predicate, and it is allowed to be empty, because the reader got there by
 * asking a question whose answer can honestly be "nothing".
 *
 * **That extra predicate is an OR, and the reason is this page's own side
 * effect.** Rendering the list POSTs the marker to the window's ceiling, so
 * "above the marker" alone meant one refresh emptied "Baru" completely — a move
 * seen for three seconds was gone before it had been read. A move now leaves the
 * tab only once it has *both* been read and turned a day old
 * (`DEFAULT_GRACE_HOURS`).
 *
 * The bell was deliberately left strict, so the two disagree on purpose: the
 * badge clears the moment this page is opened, while the tab holds its rows for
 * another day. A badge that will not clear for a day is the kind of nagging that
 * makes people stop looking at it. The visible cost is that "Baru" can list rows
 * while the bell reads 0 and while those rows carry no "baru" label — both are
 * correct, and both are stated in the copy below rather than left to look like a
 * bug.
 *
 * Cross-marketplace by design, like `/products` and `/stores`: a rival's move
 * matters whichever marketplace it happens on, so this page is not `?kanal=`
 * scoped. It still carries the parameter through every link it builds, because
 * the screens it points at — and the shop switcher in the shell — are scoped.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Notifikasi',
  description: 'Gerakan harga rival pada set yang toko kita jual.',
};

const TAB_PARAM = 'tab';
type Tab = 'semua' | 'baru';
const DEFAULT_TAB: Tab = 'semua';

/**
 * How many rows are printed at once.
 *
 * A cap and no pager, and it is a **real** limit rather than a display detail.
 * The marker advances over the complete window (`rivalMovesCeiling`), never over
 * what was rendered — which is what keeps it moving forward through a list whose
 * order is not the marker's, but it also means a row ranked past this cap is
 * both unrendered *and* no longer counted as new once the page has been opened.
 * There is no second page to reach it from, so it comes back only when enough
 * rows above it age out of the 14-day window.
 *
 * The cap binds differently now that the list leads with the newest capture: it
 * cuts the oldest rows rather than the least consequential, so what a big sweep
 * pushes past the edge is last week's news rather than this week's smallest
 * moves.
 *
 * That trade is survivable at today's size and not beyond it: the whole window
 * is 56 rows, so the cap does not bind at all yet. It starts costing real rows
 * when the design's expected "hundreds and growing" arrives with the daily sweep
 * over the catalogue. Pagination is the fix, and it is not built.
 */
const PAGE_LIMIT = 200;

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const tab = readTab(params[TAB_PARAM]);

  const shops = await getOwnShops();

  // Every row on this page is a rival on a set *we* carry, so with no shop of
  // ours marked there is no scope for the query to have — and it would answer
  // an empty list that reads as "nothing is happening" rather than "nothing has
  // been asked". Same wording as the pricing worklist, because it is the same
  // missing fact.
  if (shops.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <EmptyState
          title="Belum ada toko yang ditandai sebagai toko kita"
          description={
            <>
              Halaman ini melaporkan gerakan harga rival pada set yang toko kita jual, jadi ia perlu
              tahu toko mana yang milik kita. Tandai sekali lewat terminal:
              <code className="mt-2 block rounded-md border border-line bg-surface-muted px-3 py-2 text-left font-mono text-xs text-foreground">
                ecom-scraper own-shop shopee i_bricks
              </code>
            </>
          }
        />
      </div>
    );
  }

  let seen: { id: string; clamped: boolean };
  try {
    seen = await readSeen();
  } catch (error) {
    // `notify_seen` has no row, which means migration 006 never reached this
    // database. Not a page that can be half-rendered: without a marker there is
    // no "new", and guessing 0 would announce the entire history as unread.
    return (
      <div className="space-y-6">
        <PageHeader />
        <EmptyState
          title="Penanda baca belum ada di database ini"
          description={
            <>
              {error instanceof Error ? error.message : String(error)}
              <code className="mt-2 block rounded-md border border-line bg-surface-muted px-3 py-2 text-left font-mono text-xs text-foreground">
                ecom-scraper initdb
              </code>
            </>
          }
        />
      </div>
    );
  }

  // One extra row, purely to find out whether the cap bound — cheaper and more
  // honest than a second `count(*)` that could disagree with the page it
  // describes.
  //
  // `graceHours` is left at its default, which is the day of grace "Baru" is
  // built around; the tab is over-inclusive by design, so the value that gets
  // used when nobody names one is the value this page wants.
  const fetched = await rivalMoves({
    ...DEFAULT_WINDOW,
    seenSnapshotId: tab === 'baru' ? seen.id : null,
    limit: PAGE_LIMIT + 1,
    offset: 0,
  });
  const truncated = fetched.length > PAGE_LIMIT;
  const moves = truncated ? fetched.slice(0, PAGE_LIMIT) : fetched;

  const unread = await unreadRivalMoves(DEFAULT_WINDOW, seen.id, BADGE_CAP);

  return (
    <div className="space-y-6">
      <PageHeader />

      {seen.clamped ? <ClampedNotice /> : null}

      <Card>
        <CardContent className="space-y-4">
          <nav aria-label="Saringan notifikasi" className="flex flex-wrap gap-2">
            <TabLink params={params} tab="semua" active={tab === 'semua'} label="Semua" />
            <TabLink
              params={params}
              tab="baru"
              active={tab === 'baru'}
              label="Baru"
              count={unread.count}
              capped={unread.capped}
            />
          </nav>

          <p className="text-xs text-muted">
            Gerakan harga rival minimal 5% pada set yang toko kita jual, 14 hari terakhir.
            {tab === 'semua'
              ? ' Tab ini tidak menyaring apa pun — penanda baca hanya menentukan mana yang ditandai baru.'
              : ' Tab ini menahan gerakan sampai dua-duanya terpenuhi: sudah lewat penanda baca' +
                ' dan sudah lebih dari sehari. Jadi yang sudah terbaca tapi belum genap sehari' +
                ' masih ada di sini — tanpa label “baru”, dan tidak lagi dihitung lonceng.'}
          </p>

          {moves.length === 0 ? (
            <Empty tab={tab} params={params} />
          ) : (
            <>
              <NotificationsList
                groups={foldByRecency(moves)}
                seenSnapshotId={seen.id}
                // Reading either tab is reading the window, and the marker
                // advances over the whole window either way — so the POST is not
                // conditional on which tab is open.
                markSeen
              />
              {truncated ? (
                <p className="rounded-md border border-line bg-surface-muted px-3 py-2 text-xs text-muted">
                  Menampilkan {PAGE_LIMIT} teratas; sisanya tidak ditampilkan dan belum ada halaman
                  berikutnya. Membuka halaman ini juga memajukan penanda baca ke{' '}
                  <em>seluruh</em> jendela 14 hari, bukan hanya ke yang tampil, jadi sisanya berhenti
                  dihitung sebagai baru meski belum pernah terlihat. Batas ini benar-benar membatasi:
                  baris di bawahnya baru muncul lagi kalau yang di atasnya keluar dari jendela.
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PageHeader() {
  return (
    <div className="space-y-1">
      <h1 className="text-lg font-semibold tracking-tight text-foreground">Notifikasi</h1>
      <p className="text-sm text-muted">
        Rival yang mengubah harga pada set yang kita jual, diurutkan dari yang paling menuntut
        keputusan.
      </p>
    </div>
  );
}

/**
 * The marker points past the end of the table, and the page says so.
 *
 * `scraper/sync.py mirror` TRUNCATEs the target and copies ids verbatim, so a
 * mirror can leave the target's `max(price_snapshots.id)` *below* a marker
 * inherited from the target's own, now discarded, id space. `readSeen` clamps
 * rather than obeying it, which is what keeps the list from rendering as though
 * everything were read — but a clamped reader and a genuinely caught-up reader
 * look identical from the outside, so the flag has to be shown rather than
 * quietly handled.
 */
function ClampedNotice() {
  return (
    <p className="rounded-md border border-negative/40 bg-negative/10 px-3 py-2 text-xs text-negative">
      Penanda baca menunjuk ke ID snapshot yang lebih tinggi daripada snapshot mana pun di database
      ini — biasanya sisa dari <code className="font-mono">ecom-scraper sync</code>, yang mengganti
      seluruh ID di database tujuan. Daftar di bawah tetap lengkap; yang tidak bisa dipercaya hanya
      penandaan “baru”, karena untuk sementara semuanya dianggap sudah dibaca.
    </p>
  );
}

function Empty({
  tab,
  params,
}: {
  tab: Tab;
  params: Record<string, string | string[] | undefined>;
}) {
  if (tab === 'baru') {
    return (
      <EmptyState
        title="Semuanya sudah terbaca, dan semuanya sudah lewat sehari"
        description={
          <>
            Satu gerakan keluar dari tab ini hanya kalau dua-duanya sudah terjadi — sudah ditandai
            terbaca dan sudah lebih dari sehari — jadi tab yang kosong berarti keduanya sudah lewat
            untuk seluruh jendela 14 hari. Daftarnya sendiri tidak hilang: tab Semua tidak pernah
            disaring oleh penanda baca.{' '}
            <Link href={tabHref(params, 'semua')} className="text-accent hover:underline">
              Lihat semua
            </Link>
            .
          </>
        }
      />
    );
  }

  return (
    <EmptyState
      title="Belum ada gerakan harga rival ≥5% dalam 14 hari terakhir"
      description={
        <>
          Perlu diingat: halaman ini juga terlihat seperti ini kalau scraper berhenti jalan atau
          mirror ke database ini berhenti — “tidak ada rival yang mengubah harga” dan “tidak ada data
          baru” tampil sama. Kalau sepi lebih lama dari biasanya, periksa scrape terakhir di{' '}
          <Link href="/stores" className="text-accent hover:underline">
            Toko
          </Link>
          .
        </>
      }
    />
  );
}

function TabLink({
  params,
  tab,
  active,
  label,
  count,
  capped,
}: {
  params: Record<string, string | string[] | undefined>;
  tab: Tab;
  active: boolean;
  label: string;
  count?: number;
  capped?: boolean;
}) {
  return (
    <Link
      href={tabHref(params, tab)}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors',
        active
          ? 'border-accent/40 bg-accent/10 text-foreground'
          : 'border-line bg-surface-muted text-muted hover:text-foreground',
      )}
    >
      {label}
      {count !== undefined && count > 0 ? (
        <span className="tabular-nums">
          {count}
          {capped ? '+' : ''}
        </span>
      ) : null}
    </Link>
  );
}

/**
 * The same URL with a different tab, and everything else left alone.
 *
 * Rebuilt from the incoming parameters rather than written as a literal, so a
 * `?kanal=` the visitor arrived with survives the click. This page ignores that
 * parameter itself — a rival's move is not scoped to one of our shops — but the
 * shell reads it to decide which shop chip is lit, and every screen this page
 * links on to is scoped by it. Dropping it here would silently switch shops on
 * the way out.
 *
 * The default tab is expressed by the parameter's *absence*, so `/notifications`
 * and `/notifications?tab=semua` are one URL rather than two.
 */
function tabHref(params: Record<string, string | string[] | undefined>, tab: Tab): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) search.append(key, item);
    else search.set(key, value);
  }

  if (tab === DEFAULT_TAB) search.delete(TAB_PARAM);
  else search.set(TAB_PARAM, tab);

  const query = search.toString();
  return query ? `/notifications?${query}` : '/notifications';
}

/** Anything that is not a tab is the default one. A bookmark never 404s here. */
function readTab(raw: string | string[] | undefined): Tab {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'baru' ? 'baru' : DEFAULT_TAB;
}
