# Retrospective — Real-Debrid acquisition autopsy (2026-10-24)

Template: expected vs actual, surprises, disproved assumptions, wasted
effort + cause, most useful test, lying/overconstraining test, automation
that should disappear, guidance change, complexity to remove.

- Expected: determine whether RD acquisition is broken-by-us or
  blocked-by-them; rule on provider-neutral prepare.
- Actual: ACCOUNT CAPABILITY BLOCKED — free-tier account, 403 exactly
  per contract, request shape correct, single credential, 8 unique
  attempts behind "125 failures". No code changed. Prepare stays
  provider-neutral.
- Surprises:
  1. `GET /user` answered the whole slice in one call (`type:free`,
     premium 0). The cheapest probe should always be first.
  2. "125 failures" collapsed to 8 unique hashes + a storm cascade.
     Counting entries instead of units inflated the problem 15×.
  3. Resolver-safe 429s leave NO cooldown log lines (fail-fast path) —
     96 h of logs with zero `entering global cooldown` coexists with a
     rate-limit-driven transient storm. Absence-of-log ≠ absence-of-cause
     in that mode; message-level proof simply isn't retained.
  4. unrestrict on an EXISTING downloaded link also 403s (code 20,
     hoster_not_free) — the execution seam is refused wholesale, yet
     usable-delivery evidence exists from hours earlier. Stated as an
     open nuance, not chased (acquisition scope).
  5. The benign-hash control reproduced the app result byte-for-byte
     (403/9/167 ms) — the fastest possible application-bug killer.
- Disproved assumptions: "RD is slow" (it is refused); "125 independent
  samples" (8 + cascade); "maybe our request is malformed" (contract-
  correct, entitlement-coded refusal); "maybe a stale token" (single
  client, reads 200); "TorBox-only needs no qualification" (it does:
  scoped to this account/config, RD seam stays wired).
- Wasted effort + cause: none significant. Resisted re-deriving RD docs
  from memory; used live docs + live calls instead.
- Most useful test: not a repo test (forensic slice, none earnable) —
  most useful EVIDENCE was the 4-op control battery (list/info/
  unrestrict/addMagnet in one run separated every seam at once).
- Lying/overconstraining test: n/a. Pre-existing baseline failure
  untouched.
- Automation that should disappear: none. Scratch observers deleted at
  close; procedure + sanitized results live in the build log.
- Guidance change: (1) count unique failure units (hashes/requests),
  not log entries, before sizing any provider problem; (2) a 403 with a
  documented entitlement code + valid-auth reads working = stop
  debugging the request, start reading the account; (3) resolver-safe
  mode converts 429s into unlogged fail-fast transients — anyone
  auditing "transient" storms must know this or they will misread log
  silence.
- Complexity to remove: none taken. Rejected: account-level refusal
  memo (fails this slice's fix gate — reported only), SLOW_DOWN dead-ref
  cleanup (drive-by, out of bounds), any classification/policy change.
