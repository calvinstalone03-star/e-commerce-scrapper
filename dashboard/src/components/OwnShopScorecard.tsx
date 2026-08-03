import Link from 'next/link';

import { Card, CardContent, Stat } from '@/components/ui';
import { MARKETPLACE_LABELS, formatPrice } from '@/lib/format';
import { withChannel } from '@/lib/channel';
import type { OwnShopScorecard as Scorecard } from '@/lib/schemas';

/**
 * Where we stand in one channel, as four numbers and a spread.
 *
 * The overview used to open on the size of the database — 32 shops, 12,502
 * products — which is true and answers a question nobody asks daily. These are
 * the four figures that decide whether to touch a price today, and every one of
 * them is about one shop of ours, named in the heading so it can never be read
 * as both.
 */

const count = new Intl.NumberFormat('id-ID');

export function OwnShopScorecard({ scorecard }: { scorecard: Scorecard }) {
  const { position } = scorecard;
  const pricing = withChannel('/pricing', scorecard.channel);

  return (
    <Card>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Listing kita" value={count.format(scorecard.listings)} hint={`${MARKETPLACE_LABELS[scorecard.channel]} · ${scorecard.shopUsername}`} />
          <Stat label="Punya rival" value={count.format(scorecard.withRivals)} hint="produk yang bisa dibandingkan" />
          <Stat label="Termurah" value={count.format(position.cheapest)} hint="tidak ada yang di bawah kita" />
          <Stat label="Uang di meja" value={formatPrice(scorecard.atStake)} hint="selisih ke rival termurah" />
        </div>

        <p className="text-xs text-muted">
          Sebaran posisi{' '}
          <Link href={`${pricing}&stance=under`} className="underline-offset-4 hover:text-foreground hover:underline">
            termurah {count.format(position.cheapest)}
          </Link>
          {' · '}tengah {count.format(position.middle)}
          {' · '}
          <Link href={`${pricing}&stance=over`} className="underline-offset-4 hover:text-foreground hover:underline">
            termahal {count.format(position.dearest)}
          </Link>
          {' · '}
          <Link href={`${pricing}&matched=none`} className="underline-offset-4 hover:text-foreground hover:underline">
            tanpa rival {count.format(position.unmatched)}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
