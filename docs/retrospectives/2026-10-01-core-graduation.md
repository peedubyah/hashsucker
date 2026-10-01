# Retrospective: core graduation and consumer-neutral republication

Expected: reliability hardening would continue until every theoretical edge was
closed. Actual: real request/publication/playback, exact identity, provider
reacquisition, lifecycle evidence, and the host canary meet the boring-normal-
operation bar. Remaining imperfections do not currently require manual repair.

- Decision: graduate core reliability and stop treating partial PMS lifecycle
  evidence, non-reproduced long-run churn, and isolated latency tails as
  primary work.
- Product slice earned: retained exact durable truth already supports cheap
  reuse, but consumer-neutral republication had no narrow explicit seam.
  `/api/library/republish` delegates to the existing exact reuse predicate and
  fails closed rather than rediscovering.
- Guardrail: the route never selects another Release or provider coordinate;
  it only accepts `reuseMode` values produced by exact durable reuse.
- Verification: 13 focused library/fulfillment/VFS tests passed, including
  fail-closed and delegated-republish route tests.
- Remaining: replacement-consumer integration and broader preservation policy
  are not implemented and are not implied by this slice.
