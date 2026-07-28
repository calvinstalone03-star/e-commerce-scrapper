'use client';

import Image from 'next/image';
import { useState } from 'react';

import { imageUrl } from '@/lib/image';
import { cn } from '@/components/ui/cn';

type ProductImageProps = {
  /** Stored CDN base URL from `products.image`. */
  src: string | null | undefined;
  alt: string | null | undefined;
  /** Fixed box in px, for table rows. Omit to fill the parent's width 1:1. */
  size?: number;
  /** Override when the rendered width is not what `size` implies. */
  sizes?: string;
  priority?: boolean;
  className?: string;
};

/**
 * Product thumbnail.
 *
 * Two failure modes get a designed answer instead of a browser default. A null
 * `image` column is common, and a stored URL can 404 once the marketplace rotates
 * its CDN — both render the same neutral tile, never the browser's broken-image
 * glyph, which reads as the app being broken rather than the row lacking a photo.
 *
 * The box is sized before the image loads, so a grid does not reflow row by row
 * as thumbnails arrive.
 */
export function ProductImage({
  src,
  alt,
  size,
  sizes,
  priority,
  className,
}: ProductImageProps) {
  // Always thumbnailed: the full-size Shopee asset is ~467KB against ~28KB for
  // the `_tn.webp` variant, and a 50-row page would fetch that fifty times.
  const resolved = imageUrl(src, 'thumb');

  // The failed URL rather than a boolean — a recycled component instance that
  // receives a different product would otherwise stay stuck on the placeholder.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const broken = resolved !== null && failedSrc === resolved;

  return (
    <div
      className={cn(
        'relative aspect-square shrink-0 overflow-hidden rounded-md border border-line bg-surface-muted',
        className,
      )}
      style={size ? { width: size, height: size } : undefined}
    >
      {resolved && !broken ? (
        <Image
          src={resolved}
          alt={alt ?? ''}
          fill
          sizes={sizes ?? (size ? `${size}px` : '(min-width: 1024px) 220px, 45vw')}
          priority={priority}
          className="object-cover"
          onError={() => setFailedSrc(resolved)}
        />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center text-muted">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            aria-hidden
            className="size-1/3 max-h-6 min-h-3.5"
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="m4 16 4.5-4.5 4 4 3-3L20 16" strokeLinejoin="round" />
            <circle cx="9" cy="9" r="1.25" />
          </svg>
        </span>
      )}
    </div>
  );
}
