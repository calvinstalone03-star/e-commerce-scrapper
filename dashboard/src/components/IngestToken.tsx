'use client';

import { useState } from 'react';

/**
 * Reveal-on-demand for the hosted ingest credential.
 *
 * Fetched rather than rendered into the page, and asked for rather than shown:
 * protected pages here ship their HTML as the body of the 307 to `/login`, so
 * anything printed server-side into this page is readable by a client that
 * ignores the redirect. `/api/ingest-token` answers 401 with nothing in it.
 *
 * The button also makes the secret a deliberate act. A page that displays a
 * write credential every time it loads is a page nobody can open over someone's
 * shoulder, and this one is otherwise the first thing a new user reads.
 */

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; endpoint: string; token: string }
  | { kind: 'error'; message: string };

export function IngestToken() {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [copied, setCopied] = useState(false);

  async function reveal() {
    setState({ kind: 'loading' });
    try {
      const response = await fetch('/api/ingest-token');
      const body = await response.json();
      if (!response.ok) {
        setState({ kind: 'error', message: body?.error ?? `HTTP ${response.status}` });
        return;
      }
      setState({ kind: 'ready', endpoint: body.endpoint, token: body.token });
    } catch {
      setState({ kind: 'error', message: 'Tidak bisa menghubungi dashboard.' });
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // A clipboard the browser refuses is not an error worth a banner: the
      // value is on screen and can be selected by hand.
    }
  }

  if (state.kind === 'ready') {
    return (
      <div className="space-y-3">
        <Field label="server" value={state.endpoint} onCopy={copy} />
        <Field label="token" value={state.token} onCopy={copy} mono />
        <p className="text-xs text-muted">
          {copied ? 'Tersalin.' : 'Tempel keduanya di popup extension → ⚙ → Simpan.'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={reveal}
        disabled={state.kind === 'loading'}
        className="rounded-md border border-line px-3 py-2 text-sm font-medium text-foreground hover:bg-surface-muted disabled:opacity-50"
      >
        {state.kind === 'loading' ? 'Mengambil…' : 'Tampilkan token'}
      </button>
      {state.kind === 'error' ? (
        <p className="text-xs text-negative">{state.message}</p>
      ) : null}
    </div>
  );
}

function Field({
  label,
  value,
  onCopy,
  mono = false,
}: {
  label: string;
  value: string;
  onCopy: (value: string) => void;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-xs text-muted">{label}</span>
      <code
        className={`min-w-0 flex-1 truncate rounded border border-line bg-canvas px-2 py-1.5 text-xs text-foreground${
          mono ? ' font-mono' : ''
        }`}
      >
        {value}
      </code>
      <button
        type="button"
        onClick={() => onCopy(value)}
        className="shrink-0 rounded border border-line px-2 py-1.5 text-xs text-muted hover:text-foreground"
      >
        Salin
      </button>
    </div>
  );
}
