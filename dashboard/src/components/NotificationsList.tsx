'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui';
import { cn } from '@/components/ui/cn';
import { MARKETPLACE_LABELS, formatDateTime, formatPrice } from '@/lib/format';
import { groupUndercutsUs, type FoldedMoveGroup } from '@/lib/notify/group';
import { priceChangeLink } from '@/lib/notify/links';
import type { RivalMove } from '@/lib/notify/rival-moves';

/**
 * The feed, and the one side effect on this screen.
 *
 * A client component for exactly two reasons: it has to POST the read marker
 * after the page has painted, and a folded group has to expand. Everything that
 * decides *what* is in the list — the window, the tab's predicate, the folding,
 * the ordering — happened on the server before this was handed its props. That
 * split is deliberate rather than incidental: it means this file cannot
 * accidentally become a second place where the feed is defined.
 *
 * **Nothing here reads the clock.** Every label is derived from two stored
 * timestamps or from one, formatted absolutely. A "3 jam lalu" computed here
 * would be computed twice — once in the server render that produces the HTML,
 * once on hydration — and the two would disagree by however long the request
 * took, which React reports as a hydration mismatch. The comparison age *is*
 * relative, but it is relative to the other snapshot, not to now, so it is the
 * same string in both renders forever.
 */

/** Matches the pricing worklist's own local formatter rather than adding to `format.ts`. */
const percent = new Intl.NumberFormat('id-ID', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  signDisplay: 'exceptZero',
});

const count = new Intl.NumberFormat('id-ID');

const HOUR = 3600 * 1000;

export type NotificationsListProps = {
  groups: FoldedMoveGroup[];
  /**
   * The read marker as the server saw it when this page was built. Rows above it
   * are styled new — and only styled: the list they sit in was chosen without
   * consulting this value at all.
   */
  seenSnapshotId: string;
  /**
   * Whether to mark the window read on arrival. False on the "Baru" tab is not
   * an option this offers — both tabs mark read, because both render the same
   * window and reading either one is reading it.
   */
  markSeen: boolean;
};

export function NotificationsList({ groups, seenSnapshotId, markSeen }: NotificationsListProps) {
  const failed = useMarkSeen(markSeen);
  const seen = BigInt(seenSnapshotId);

  return (
    <div className="space-y-3">
      {failed ? (
        <p className="rounded-md border border-negative/40 bg-negative/10 px-3 py-2 text-xs text-negative">
          Gagal menandai notifikasi terbaca, jadi lonceng masih akan menghitung yang di bawah ini.
          Muat ulang halaman untuk mencoba lagi.
        </p>
      ) : null}

      {groups.map((entry) =>
        entry.kind === 'folded' ? (
          <FoldedRow key={groupKey(entry)} entry={entry} seen={seen} />
        ) : (
          <MoveRow key={entry.move.snapshotId} move={entry.move} seen={seen} />
        ),
      )}
    </div>
  );
}

/**
 * Tell the server the window has been read — once, after paint, never during
 * render.
 *
 * During render it would fire on React's double invoke in development and on
 * every re-render after; as a `GET` it would fire on link prefetch. Either way
 * the badge clears itself before anyone has looked, and because the marker only
 * moves forward there is no record that it happened.
 *
 * The POST carries no body. The id it advances to is the server's to decide —
 * see `api/notifications/seen/route.ts` for the measurement that settled that.
 *
 * **No `router.refresh()` on success, deliberately.** Refreshing would re-run
 * this page against the marker that was just advanced: the "new" marks would
 * vanish from under the reader mid-sentence, and on the "Baru" tab the list they
 * are reading would empty itself. The bell is left to correct on the next
 * navigation, which is the first moment the reader is done with this page.
 */
function useMarkSeen(enabled: boolean): boolean {
  const [failed, setFailed] = useState(false);
  // Survives React's development double-invoke of effects. The POST is
  // idempotent — the marker is a `GREATEST` — so this is tidiness rather than
  // correctness, but a duplicated write is still a duplicated write.
  const posted = useRef(false);

  useEffect(() => {
    if (!enabled || posted.current) return;
    posted.current = true;

    const abort = new AbortController();
    fetch('/api/notifications/seen', { method: 'POST', signal: abort.signal })
      .then((response) => {
        if (!response.ok) setFailed(true);
      })
      .catch(() => {
        // An aborted fetch is the reader navigating away, not a failure.
        if (!abort.signal.aborted) setFailed(true);
      });

    return () => abort.abort();
  }, [enabled]);

  return failed;
}

/** Stable across renders without an index: one store, one delta, one group. */
function groupKey(entry: Extract<FoldedMoveGroup, { kind: 'folded' }>): string {
  return `${entry.members[0].storeId ?? 'null'}|${entry.delta}|${groupUndercutsUs(entry)}`;
}

function MoveRow({ move, seen }: { move: RivalMove; seen: bigint }) {
  return (
    <article className={cn('rounded-lg border bg-surface p-4', rowBorder(move, seen))}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {isNew(move, seen) ? <Badge>baru</Badge> : null}
            <UndercutBadge undercutsUs={move.undercutsUs} />
            <span className="text-xs text-muted">
              {MARKETPLACE_LABELS[move.marketplace] ?? move.marketplace}
              {move.username ? ` · ${move.username}` : ''}
              {move.setCode ? ` · set ${move.setCode}` : ''}
            </span>
          </div>

          <Link
            href={priceChangeLink(move)}
            className="block truncate text-sm font-medium text-foreground hover:text-accent"
          >
            {move.name ?? 'Tanpa nama'}
          </Link>

          <p className="text-xs text-muted">
            {formatPrice(move.previousPrice)} → {formatPrice(move.price)}
            {move.ourPrice ? ` · harga kita ${formatPrice(move.ourPrice)}` : ''}
          </p>
        </div>

        <div className="shrink-0 text-right">
          <p className={cn('text-lg font-semibold tabular-nums', changeTone(move))}>
            {changeLabel(move)}
          </p>
          {/*
            The real comparison window, per row, rather than a blanket "24 jam".
            The query takes the newest capture at least `gapHours` older with no
            upper bound short of `maxLookbackDays`, and measured against the
            scraper's database the comparison actually chosen runs 78 to 140
            hours old — the 24-hour floor almost never binds. Running the query
            at 1, 6, 12, 24, 48 and 72 hours returned the same 56 rows every
            time. What a row really says is "moved this much since whenever we
            last saw this listing", so it says that.
          */}
          <p className="text-xs text-muted">vs harga {comparisonAge(move)} sebelumnya</p>
          <p className="text-xs text-muted">terpantau {formatDateTime(move.scrapedAt.toISOString())}</p>
        </div>
      </div>
    </article>
  );
}

/**
 * A store's one decision, printed once.
 *
 * `<details>` rather than a click handler: the members are already in the
 * payload, expanding is a native affordance, and it keeps this working before
 * hydration and with JavaScript off.
 */
function FoldedRow({
  entry,
  seen,
}: {
  entry: Extract<FoldedMoveGroup, { kind: 'folded' }>;
  seen: bigint;
}) {
  const lead = entry.members[0];
  const fresh = entry.members.filter((move) => isNew(move, seen)).length;

  return (
    <article className={cn('rounded-lg border bg-surface', rowBorder(lead, seen))}>
      <details>
        <summary className="cursor-pointer list-none p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                {fresh > 0 ? <Badge>{fresh === entry.members.length ? 'baru' : `${count.format(fresh)} baru`}</Badge> : null}
                <UndercutBadge undercutsUs={groupUndercutsUs(entry)} />
                <span className="text-xs text-muted">
                  {MARKETPLACE_LABELS[entry.marketplace] ?? entry.marketplace}
                  {entry.username ? ` · ${entry.username}` : ''}
                </span>
              </div>

              <p className="text-sm font-medium text-foreground">
                {entry.username ?? 'Toko tanpa nama'}{' '}
                {entry.delta < 0 ? 'menurunkan' : 'menaikkan'}{' '}
                {count.format(entry.members.length)} listing sebesar{' '}
                {formatPrice(Math.abs(entry.delta))}
              </p>
              <p className="text-xs text-muted">Klik untuk melihat semuanya</p>
            </div>

            <div className="shrink-0 text-right">
              <p className={cn('text-lg font-semibold tabular-nums', changeTone(lead))}>
                {changeLabel(lead)}
              </p>
              <p className="text-xs text-muted">vs harga {comparisonAge(lead)} sebelumnya</p>
            </div>
          </div>
        </summary>

        <ul className="space-y-2 border-t border-line px-4 py-3">
          {entry.members.map((move) => (
            <li key={move.snapshotId} className="flex flex-wrap items-baseline justify-between gap-2">
              <Link
                href={priceChangeLink(move)}
                className="min-w-0 flex-1 truncate text-xs text-muted hover:text-accent"
              >
                {isNew(move, seen) ? <span className="mr-1 text-accent">•</span> : null}
                {move.name ?? 'Tanpa nama'}
                {move.setCode ? ` · set ${move.setCode}` : ''}
              </Link>
              <span className="shrink-0 text-xs tabular-nums text-muted">
                {formatPrice(move.previousPrice)} → {formatPrice(move.price)}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}

/**
 * Whether we have been gone under, said in three states rather than two.
 *
 * `null` is a set we have never had a price for. Rendering that as "aman" would
 * be a claim the data does not support, and rendering nothing at all would make
 * it look identical to a set we are winning.
 */
function UndercutBadge({ undercutsUs }: { undercutsUs: boolean | null }) {
  if (undercutsUs === null) return <Badge variant="muted">harga kita tidak diketahui</Badge>;
  if (undercutsUs) return <Badge variant="shopee">di bawah harga kita</Badge>;
  return <Badge variant="muted">masih di atas kita</Badge>;
}

function isNew(move: RivalMove, seen: bigint): boolean {
  return BigInt(move.snapshotId) > seen;
}

function rowBorder(move: RivalMove, seen: bigint): string {
  return isNew(move, seen) ? 'border-accent/40' : 'border-line';
}

/**
 * The move as a percentage of where it started.
 *
 * A previous price of zero is not an infinite fall; it is a price that was never
 * real. `group.ts` ranks those last for the same reason, and here they simply do
 * not get a percentage.
 */
function changeLabel(move: RivalMove): string {
  const from = Number(move.previousPrice);
  if (!Number.isFinite(from) || from === 0) return '–';
  return percent.format((Number(move.price) - from) / from);
}

function changeTone(move: RivalMove): string {
  // A rival cutting is the bad news on this page, and a rival raising is the
  // good news — the opposite of the sign convention on a price chart, so the
  // colours are keyed to the consequence rather than to the arithmetic.
  const delta = Number(move.price) - Number(move.previousPrice);
  if (delta < 0) return 'text-negative';
  if (delta > 0) return 'text-positive';
  return 'text-muted';
}

/** How much older the comparison capture is than the move — never "ago". */
function comparisonAge(move: RivalMove): string {
  const hours = (move.scrapedAt.getTime() - move.previousScrapedAt.getTime()) / HOUR;
  if (!Number.isFinite(hours) || hours <= 0) return 'sebelumnya';
  if (hours < 48) return `${Math.round(hours)} jam`;
  return `${Math.round(hours / 24)} hari`;
}
