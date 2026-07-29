// `server-only` throws when imported outside a Server Component, which is the
// entire point of the package and also why a test importing `queries.ts` needs
// this stand-in. Aliased in vitest.config.ts; never bundled by Next.
export {};
