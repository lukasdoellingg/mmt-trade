# Runbook: Rotate MMT WebSocket Token

## When to rotate

- Token exposed in logs, screenshots, or commits
- Supabase session revoked
- Scheduled rotation (recommended: 90 days)

## Steps

1. Obtain a fresh JWT from MMT.gg (authenticated session).
2. Update deployment secret `MMT_WS_TOKEN` — never commit to git.
3. Restart backend: `npm --workspace web/backend run start`
4. Verify heatmap WS connects:

   ```bash
   # Check backend logs — URLs must show token=REDACTED
   ```

5. Invalidate old token at source if platform supports it.

## Verification

- No `token=` literals in application logs
- `redactTokensInUrl()` applied on all URL logging paths
- Heatmap stream delivers CBOR frames within 30s of subscribe

## Incident

If token was committed to git:

1. Rotate immediately
2. `git filter-repo` or BFG to purge history (force-push requires team approval)
3. File post-incident note in sprint retro

## Related

- [`SECURITY.md`](../../SECURITY.md)
- [`web/backend/lib/security.js`](../../web/backend/lib/security.js)
