# Test strategy

How this suite is organized, what each layer is allowed to prove, and the rules
that keep it a stability contract rather than a decoration.

The governing principle: **a test earns its maintenance cost only if it can
fail when the product breaks.** Every rule below exists because a green suite
once hid a real defect.

## Layers

| Layer | What it proves | What it may mock | Entry point |
|---|---|---|---|
| Unit / pure policy | One decision function's output for given inputs | Nothing (pure inputs) | The function |
| State-machine | A transition happens when its gate allows it | Store/clock (never the gate) | The real gate (`tickOnce`, `searchByMedia`, handler) |
| Persistence / store | Durable truth survives reopen, is idempotent, fails closed | Filesystem only (real SQLite) | The store's own API |
| API contract | Route shape, status semantics, auth, idempotency | Lower layers behind narrow interfaces | `createRequestHandler` |
| Provider contract | Provider responses map to durable observations; cache-only boundary | The provider client boundary | The real production call site |
| Publication / VFS | Identity, VFS, STRM, consumer projection invariants | Provider/merge boundaries only | `searchByMedia` / `materializeVfsEntry` / `publication.js` |
| Scheduler lifecycle | Reachability, priority, cost bounds, restart durability | HTTP + clock (never classifier/due) | `tickOnce` |
| Plex integration | Refresh coalescing, ingest seam semantics, scanner stability | The PMS HTTP boundary | Real modules over a local stub server |
| Data-plane | Range/coalesce/recovery contract with Rust | The Rust HTTP boundary | Real modules over stubs |
| Canary / acceptance | **Real** PMS session, libmpv, byte reads, teardown | Nothing | The production path itself |

## Rules that came from real defects

1. **No unreachable-state tests.** If the classifier/due selector cannot send a
   row into the state under test, a direct `processIntent(X)` call proves
   nothing. Drive `tickOnce` and assert the workload was actually selected.
2. **No seam that production does not inject.** `liveDiscoveryFn` and
   `confirmPlexFn` are real (defaulted to production implementations); anything
   else that replaces a boundary must be a boundary production also has.
3. **Count calls only where the count is the contract.** "No provider
   acquisition", "one bounded fanout", "one idempotent republish per retry".
   Never count internal helper invocations.
4. **Assert durable state, not labels.** A status of `published` means nothing
   without the Binding, VFS row, and STRM behind it. Check the rows.
5. **Every async branch settles with a diagnostic.** Fire-and-forget work must
   log its failure; a test must be able to observe that it ran at all.
6. **Mocks stop at the boundary they name.** A provider double must not also
   fake the control-plane semantics the production seam enforces.
7. **Restart tests re-open the real store.** No "reconstruct an equivalent
   object" — open the same files with a fresh handle.

## Mutation-verified invariants

The suite is mutation-tested: each invariant below has been proven to *fail*
when the behavior is deliberately broken (local patches only, never committed).

| Mutation | Caught by |
|---|---|
| TV collection mtime → `now()` (scanner churn) | `plex-scanner-pressure.test.js` |
| Future release-wake made non-actionable | `future-release-retry.test.js`, `scheduler-restart.test.js` |
| Prepare window ignored (future never actionable) | `scheduler-restart.test.js`, `autonomous-core-hardening.test.js` |
| `addOnlyIfCached: true → false` (uncached acquisition) | `torbox-cache-only-callsite.test.js` |
| Orphan VFS cleanup skipped after failed activation | `vfs-orphan-cleanup.test.js`, `publication-contract.test.js` |
| Corpus-pipeline Bloodhound re-entry removed | `recent-release-bloodhound.test.js` (incl. the corpus-sourced completion test) |
| Unreleased gate removed | `recent-release-bloodhound.test.js` (future-gate) |
| Republish ingest-confirm branch removed | `publication-contract.test.js` (P5/P6) |
| Stale handoff allowed to override active Binding | `vfs-authoritative-invariants.test.js`, `binding-authority-slice.test.js` |

Rust-side mutations (proved with the data-plane's own suite):

| Mutation | Caught by |
|---|---|
| `addOnlyIfCached: true → false` (uncached acquisition) | `capability::retry_after_tests` + `torbox-cache-only-callsite.test.js` |
| Retry-After horizon unbounded (a bogus header wedges a capability) | `capability::retry_after_tests::delta_seconds_are_bounded_...` |
| Backoff evidence keyed too widely (provider-only, ignoring account scope) | `manager::retry_after_scope_tests::a_directive_blocks_only_its_own_scope` |
| Retry-After evidence never expiring | `retry_after::tests::evidence_expires_automatically_and_reads_as_absent` |

Run the mutation harness to re-verify after any change to these paths.

## What only the production canary proves

Do not mock these into "equivalence":

- a real PMS session created and played (`dev-canary`);
- real libmpv progression and teardown;
- exact fresh backend byte reads through the real provider chain;
- real client/Plex interaction under load.

Lower-level tests protect the canary's *helper* logic (`plex-htpc-canary-seam.test.js`),
never the canary's outcome.

## Skips and live tests

Skipped tests must carry an explicit reason in the `skip:` field. Current skips:

Exactly **3** skipped tests, each with a reason. Reconcile this table against
the runner's `skipped` count whenever it changes:

| Skip | Reason | Revisit when |
|---|---|---|
| `stage3-fixture-harness` ranking fixture | External Stage 3 artifact; gated by `STAGE3_RANKING_FIXTURE=1` | the artifact is published |
| `server.test.js` stream-404 | Requires live provider credentials | not planned |
| `rd-acquisition` 1M benchmark | Opt-in (`RD_BENCH=1`) | performance work |

(A10 and A11 were `unbuilt:` skips documenting data-plane reliability gaps;
both behaviors are now implemented with Rust-native tests, and the Node-side
durable-evidence contract tests are live. The skips no longer exist.)

(`stage3-fixture-harness` also contains a conditional `t.skip` for the
functional fixture that only fires when that artifact is absent; it does not
contribute to the count while the fixture is present.)

No test may be left failing "because it is familiar": a failing test is either
fixed, rewritten around the real contract, or deleted with its reason recorded.

## Failure quality

A failing test must name the violated contract: media coordinate, intent id,
state transition, expected vs actual authoritative TorrentFile, retry class.
Prefer a one-line semantic assertion over an object diff.
