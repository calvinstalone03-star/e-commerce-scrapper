'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { Choice, type ChoiceOption } from '@/components/ui/Choice';

/**
 * A `Choice` whose state is the URL.
 *
 * Every filter on the server-rendered screens works this way: choosing an option
 * replaces the query string, the server renders the answer, and the address bar
 * is the whole of the state. That is what keeps those pages Server Components,
 * makes each filter combination a link somebody can send, and means the back
 * button walks the filters you actually tried.
 *
 * One component rather than one per screen: pricing, products and anything
 * added later differ only in which parameter they set.
 */
export function UrlChoice<T extends string>({
  label,
  param,
  value,
  options,
  className,
  /** Parameters to clear when this one changes — a filter change belongs on page 1. */
  resets = ['page'],
}: {
  label: string;
  param: string;
  value: T;
  options: ChoiceOption<T>[];
  className?: string;
  resets?: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const onChange = (next: T) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set(param, next);
    for (const key of resets) params.delete(key);
    params.sort();

    startTransition(() => {
      // `replace`, not `push`: flipping through four filters should not leave
      // four entries to back out through.
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    });
  };

  return (
    <Choice label={label} value={value} options={options} onChange={onChange} className={className} />
  );
}
