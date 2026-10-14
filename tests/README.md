Run from the repository root (Node only; no dependencies or build step):

```text
node tests/check-scripts.js
node tests/game.test.js
```

The checks extract the actual inline scripts. The regression suite executes them in
a VM with a minimal DOM, controllable clock, local storage, and mocked Supabase
responses. It covers escaping, card validation/imports, cache isolation, failed
loads, retries, debounce limits, stale boot/moderation responses, score catch-up,
and nonblocking gate initialization. It also checks that the migration matches
the fresh-install SQL. These checks do not execute PostgreSQL or replace browser
and live Supabase integration testing.

Deploy `supabase/002_hardening.sql` before the updated HTML. Old clients cannot
write through the obsolete RPC signatures and should reload the page.
