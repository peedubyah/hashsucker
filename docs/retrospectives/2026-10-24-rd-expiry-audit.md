# Retrospective — RD expiry audit (2026-10-24)

Template: expected vs actual, surprises, disproved assumptions, wasted
effort + cause, most useful test, lying/overconstraining test, automation
that should disappear, guidance change, complexity to remove.

- Expected: find what the expired account broke; likely some doc fixes.
- Actual: MODERATE contamination, zero code changes required. Five
  annotations on the uncached entry + two on live guidance files; every
  production change verified independent; one fresh proof (unrestrict
  200 under premium) closed a prior open nuance.
- Surprises:
  1. The expiry audit's strongest result is a NEGATIVE universal: the
     durability layer provably cannot persist account-global failure as
     route death (403 → temporary → 5-min TTL → never suppresses;
     durable terminal requires 404/410/protocol-invalid). The design
     absorbed a multi-day account outage with zero durable damage — that
     is the evidence-driven architecture working, not luck.
  2. Usable-delivery evidence cannot bound account windows (it proves
     bytes flowed on attribution, not which tier authorized them). Any
     future "when did X's tier change" question needs billing-side
     facts, not delivery rows.
  3. Resolver-safe 429s are structurally log-invisible — the audit could
     neither confirm nor exclude rate limiting in the transient storm,
     and had to report an inference with its uncertainty labeled. A
     one-line message retention would have closed it; not added (bounds).
  4. START FAST already knew "free tier" on Oct 21 — the expiry was
     contemporaneously observed, just never promoted to a first-class
     fact. The knowledge existed; the synthesis didn't.
- Disproved assumptions: "125 failures = RD unreliable" (reaffirmed as
  8 + cascade); "route-health fix might encode dead-RD" (symmetric by
  construction+test); "something must have been persisted wrongly"
  (nothing live; TTLs did their job).
- Wasted effort + cause: ~10% of the uncached slice's RD framing needs
  the annotations made here; zero code rework; zero mandatory reruns.
  Cheap as contamination goes — because TTLs are short and the fix keys
  on positive evidence.
- Most useful test: none earnable (forensic audit). Most useful evidence:
  the single unrestrict-200 call (closed two open items at once: premium
  delivery seam + route-health 403 reclassification) and the empty live
  evidence table (proved no repair needed in one query).
- Lying/overconstraining test: n/a. Baseline failure untouched.
- Automation that should disappear: none. Scratch observers deleted at
  close.
- Guidance change: (1) count unique failure units before sizing provider
  problems (now canonical twice — make it reflex); (2) short-TTLed
  positive-evidence orderings are inherently expiry-proof — prefer them
  over failure-driven exclusion wherever possible; (3) annotate
  superseded provider-scope claims at every live surface in the same
  slice (done here across BUILD-LOG/PLANS/CURRENT).
- Complexity to remove: none taken. Rejected: account-guard memo
  (still reported-only), SLOW_DOWN dead-ref cleanup (drive-by),
  retrospective-body rewrites (history stays).
