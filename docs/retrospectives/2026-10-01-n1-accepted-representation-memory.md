# Retrospective: N1 accepted representation memory

Expected: repeated request decisions might justify a positive memory fact.
Actual: production history showed repeated decisions and same-release outcomes,
but source metadata mixed household, scheduler, and proof traffic, and one
explicit E01 request still ranked 88 candidates despite the exact fact.

- GO decision: enough repeated same-release work exists to make a trustworthy
  fact useful for later bounded experiments; no ranking behavior was changed.
- Fact: `accepted_torrent_files` is exact LibraryItem + TorrentFile evidence
  written only after Plex-confirmed visible playback. It has no provider,
  route, compatibility, confidence, or TTL semantics.
- Production proof: E01 playback passed and the corrected reuse confirmation
  path wrote and exposed the exact accepted fact.
- Limitation: N1 has not yet reduced request latency or ranking work. The fact
  is currently observational/read-only; selection consumption is intentionally
  deferred until a separate value gate.
