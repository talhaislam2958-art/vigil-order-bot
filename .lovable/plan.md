# Remove internal server-function traffic

## Outcome
- The browser dashboard will no longer call `/_serverFn/...`.
- Dashboard administration will use one secured raw `/api/admin` endpoint.
- The scheduled 24/7 poll handler will continue invoking the polling engine inside the cloud worker.
- Order listing and claiming will continue as direct cloud-to-`h5.parttime.mobi` `fetch` calls, with no Lovable application endpoint between the worker and target.

## Changes
1. Add a secured `/api/admin` route for setup, login, users, settings, logs, manual cycles, and Telegram actions.
2. Add a browser-safe dashboard client that calls `/api/admin` with ordinary JSON requests.
3. Replace all dashboard server-function calls with that client, then remove the obsolete server-function module.
4. Preserve the direct list URL and exact parameters: `pageNum=1`, `pageSize=15`, `orderByColumn=createTime asc, receiverName asc`, and `isAsc=asc`.
5. Preserve immediate Sniper Mode claims and the independent scheduled cloud trigger.

## Verification
- Confirm no dashboard source imports or calls `createServerFn` or `/_serverFn`.
- Confirm the scheduled handler imports the engine directly.
- Confirm list and receive calls target the external p2p API directly.
- Exercise the dashboard and inspect browser traffic for `/api/admin` rather than `/_serverFn`.
