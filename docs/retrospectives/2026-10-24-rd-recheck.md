# Retrospective — RD acquisition recheck (2026-10-24)

Template: expected vs actual, surprises, disproved assumptions, wasted
effort + cause, most useful test, lying/overconstraining test, automation
that should disappear, guidance change, complexity to remove.

- Expected: confirm premium, re-run addMagnet, hopefully watch a download.
- Actual: premium confirmed; 403 moved to 451 (filter visible underneath);
  5/5 media hashes filter-blocked; Ubuntu ISO downloaded fully in
  7.1 min with live tree + select + verified delete; helper path proven
  through mapping/cleanup. Verdict RESTORED with filter caveat.
- Surprises:
  1. The refusal class moved EXACTLY one layer down across the renewal
     (403/permission_denied → 451/infringing_file, same shape, 0.6 s) —
     the cleanest entitlement-vs-content separation observable.
  2. A 1916 Chaplin short and a 1942 fishing documentary are
     infringing-blocked. The filter is effectively blanket for catalog
     media; only the Ubuntu ISO passed. Content policy, not seeds.
  3. The helper's `absent` mapping on the ISO looked like a bug for one
     step — it was fail-closed working correctly (non-video extension).
     The 30-second info re-probe distinguishing "bad input size" from
     "extension filter" was the cheapest disproof available.
  4. RD delete verifies immediately (404); TorBox delete does not (stale
     35 min+). Hygiene checks must be provider-specific; a uniform
     "verify by re-list" would false-alarm on TorBox and pass on RD.
  5. Premium RD is FASTER to first observability than TorBox was
     (tree +16 s vs metaDL ≤36 s; select 204 immediate) — but TorBox's
     number carries a 600 s read-granularity caveat, so no ranking.
- Disproved assumptions: "TorBox-only" as standing claim (withdrawn —
  scoped to the expired window); "125 failures = RD unreliable" (8
  unique + cascade, all under free tier); "mapping absent = bug" (design).
- Wasted effort + cause: none significant. Capped the hash hunt at 5+1
  instead of surveying the filter's shape — correctly, since filter
  cartography is unbounded and verdict-irrelevant.
- Most useful test: no repo test (forensic slice). Most useful evidence:
  the Ubuntu full-cycle log (add/tree/select/progress/delete in one
  bounded run) + the /user call that preceded everything.
- Lying/overconstraining test: n/a. Baseline failure untouched.
- Automation that should disappear: none. Scratch observers deleted at
  close; procedure + sanitized timelines live in the build log.
- Guidance change: (1) when an account state changes, re-run the control
  BEFORE re-reading history — the old failures were reclassified, not
  relitigated; (2) `infringing_file` on benign content means "filter,
  stop probing content, probe mechanism with known-clean bytes" (Ubuntu
  ISO pattern); (3) fail-closed mapping refusals need a 30-second
  info-level check before being called bugs.
- Complexity to remove: none taken. Rejected: account-state guard
  (reported, unimplemented per bounds), .m2ts extension addition
  (drive-by, out of bounds), any classification change.
