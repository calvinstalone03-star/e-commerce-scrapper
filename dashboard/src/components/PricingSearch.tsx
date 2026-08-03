'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';

import { CHANNEL_PARAM, withChannel, type Channel } from '@/lib/channel';
import { toSearchParams } from '@/lib/schemas';

/**
 * The search box on the price-position screen: types like a filter, renders like
 * a page.
 *
 * The results stay server-rendered — this navigates rather than fetching, so
 * every keystroke still produces a real URL, the back button walks the searches
 * you actually made, and the table is the same server component whether it was
 * reached by typing, by a bookmark or by a link someone sent you. Nothing about
 * the data path moves to the client; only the decision of when to ask.
 *
 * Three details are what make it feel immediate rather than twitchy:
 *
 *   - A debounce, because a navigation per keystroke would queue five requests
 *     to answer the fifth one.
 *   - `replace` rather than `push`, so a ten-character search leaves one history
 *     entry instead of ten to back out through.
 *   - An uncontrolled input. A controlled one re-rendered from the server round
 *     trip would fight whatever was typed while the response was in flight, and
 *     the cursor would jump.
 *
 * It is still a real form, so Enter searches immediately and the box works with
 * JavaScript disabled or not yet loaded.
 */

//: Long enough that ordinary typing produces one request rather than one per
//: letter, short enough that a pause reads as "it already answered".
const DEBOUNCE_MS = 250;

export function PricingSearch({
  q,
  carried,
  channel,
}: {
  /** The term currently in the URL. */
  q: string;
  /** Every other filter, so a search does not silently clear them. */
  carried: Record<string, unknown>;
  /** Which shop the results are about, so a search does not silently switch it. */
  channel: Channel | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [dirty, setDirty] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const go = (value: string) => {
    const params = toSearchParams({ ...carried, q: value.trim() || undefined, page: 1 });
    startTransition(() => {
      // `scroll: false`: the box is above the table, and jumping to the top of a
      // page you are already at the top of only makes the layout twitch.
      router.replace(withChannel(`/pricing?${params}`, channel), { scroll: false });
      setDirty(false);
    });
  };

  const onChange = (value: string) => {
    setDirty(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => go(value), DEBOUNCE_MS);
  };

  return (
    <form
      action="/pricing"
      method="get"
      onSubmit={(event) => {
        event.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        const input = event.currentTarget.elements.namedItem('q');
        go(input instanceof HTMLInputElement ? input.value : '');
      }}
      className="flex flex-1 flex-wrap items-center gap-2"
    >
      {/* Carried as hidden fields too, for the submit that happens before this
          component has hydrated. A GET form's query string comes entirely from
          its fields when it submits — the `action="/pricing"` above never
          contributes one of its own — so `kanal` needs its own hidden input
          exactly like every other carried param, or that native submit lands
          back on the default channel. */}
      {channel ? <input type="hidden" name={CHANNEL_PARAM} value={channel} /> : null}
      {[...toSearchParams(carried)].map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}

      {/* `flex-1` with a floor rather than `w-full`: full width inside a
          flex-wrap row pushes the button onto its own line at every viewport. */}
      <div className="relative min-w-[15rem] flex-1 basis-64 sm:max-w-md">
        <input
          type="search"
          name="q"
          defaultValue={q}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Cari nama produk atau nomor set — misal 42218"
          aria-label="Cari produk"
          autoComplete="off"
          className="h-9 w-full rounded-md border border-line bg-surface px-3 pr-20 text-sm text-foreground placeholder:text-muted focus:border-accent focus:outline-none"
        />
        {/* One word rather than a spinner: it says which of the two states this
            is — still typing, or waiting on the server — and a search that
            answers in 400ms would leave a spinner flickering. */}
        <span
          aria-live="polite"
          className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted"
        >
          {pending ? 'mencari…' : dirty ? 'ketik…' : ''}
        </span>
      </div>

      {/* Kept for the keyboard-free path and for anyone who has not hydrated;
          typing alone already searches. */}
      <button
        type="submit"
        className="h-9 rounded-md border border-line bg-surface px-3 text-sm text-muted transition-colors hover:text-foreground"
      >
        Cari
      </button>
    </form>
  );
}
