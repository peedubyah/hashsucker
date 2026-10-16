# Retrospective: TorBox CDN reset attribution + blocked-item handling

Slice: TorBox delivery + blocked-item handling. Commit `1ca03e1`, incident
`artifacts/incident/torbox-cdn-sni-reset.md`.

## Expected vs actual

Expected (per the task framing and prior slices): the `nexus.erth.tb-cdn.earth`
reset was a TorBox/CDN edge fault, to be either worked around via a supported
alternative or packaged for TorBox. Actual: it is an **SNI-exact,
destination-independent reset on the operator's own WAN path** — proven by
resetting that one SNI against 8.8.8.8, 1.1.1.1 and Google while random SNIs on
the same IPs succeed. TorBox is not at fault.

## Surprises

- The prior "same IP, SNI `api.torbox.app` succeeds" test was read as an edge
  discriminator. It is not: the reset follows the SNI to ANY destination, which
  only a path middlebox does. One extra experiment (random SNI + foreign
  destination) flipped the attribution.
- 97% of the library (132/136 active bindings) is TorBox-only, so the network
  filter dominates the entire product.

## Disproved assumptions

- "The CDN is broken." The CDN edge serves other SNIs on the same IP fine.
- "A supported TorBox alternative exists." `requestdl` is the only delivery
  surface; regeneration is deterministic.
- "Blocked items recover via the follow-up intent." The intents existed but
  never ran — starved by a blocked P0 backlog.

## Wasted effort + cause

- Spent time on the provider-alternative search (endpoints, redirect,
  regeneration) before completing the destination-independence test. Cause:
  testing the hypothesis that fit the prior framing instead of falsifying it
  first.

## Most useful test

The SNI-vs-destination matrix (one exact SNI resets on Google/Cloudflare/8.8.8.8;
random SNIs succeed). It is cheap and unambiguous. The scheduler class-fairness
test is the most useful regression pin.

## Lying / overconstraining test

None added. The selection-bound evidence is small (3 requests), so no change was
made on thin data.

## Guidance change

- Attribution rule: an SNI-specific failure must be tested against a foreign
  destination before being called provider-side. Routed to `docs/BUILD-LOG.md`.
- A large same-class scheduler backlog must not monopolize a tick.

## Complexity to remove

- None removed. The class-fair drain is small and bounded.

## Open (recorded, not fixed)

- The WAN SNI filter is an operator/ISP action; TorBox-backed fresh requests are
  not playable until it is removed or bypassed.
- `maxServiceabilityAlternates=4` rests on 3 observed requests.
- The probe requests one 8 MiB grid chunk (cache-warming on success); a smaller
  probe would need a separate byte path.
