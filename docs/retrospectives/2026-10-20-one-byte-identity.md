# Retrospective: one byte identity

## Expected vs actual

Expected to find one stale row and repair it. Found that the row was not
stale — it was the AUTHORITY, and the Binding was the stale copy. The
production specimen had been diverged for two days: the byte path served
one release, the Binding named another, and Plex reported a third size.
Nothing had noticed, because the two facts live in two databases and
every writer believed it was writing the truth.

## Surprises

1. **The divergence was invisible to every surface.** The library listing
   reported the item as published; the Plex item existed; the bytes
   served. The only symptom was a Part.size that did not match the
   Binding — and the projection audit had classified it as "the consumer
   is stale", because the audit read the Binding as the authority.
2. **The drift was created by a ROUTE-level decision.** The routine
   reconciler rebound the intent to a different RELEASE (not merely a
   different provider file) — the specimen's Binding v2 was created that
   way, days after the divergence, and it happened to make the two agree
   again. The class of "a route change moves the representation" is
   still open; only its consequences are now bounded.
3. **The failure that opened the window was already documented.** The
   binding activation refuses to authorize through a stale provider
   inventory observation; the code even says so, and even has a fallback
   path for it. But the VFS row had ALREADY moved by then, and the retry
   state was process-local — so a container restart lost the retry
   entirely.
4. **The consumer's Part.size was the only witness.** The Plex Part
   reported the VFS row's size (9 573 001 343) while the Binding said
   9 385 232 547. Reading the Part against the Binding, rather than
   against the row, is what made the divergence visible at all.

## Disproved assumptions

- "A VFS row and a Binding are two views of one fact." They were two
  facts, written by two writers, in two databases, with no rule saying
  which wins.
- "The row is durable, so it cannot drift." It was durable AND wrong.
- "A failed binding activation is harmless." It was harmless until a
  publication had already moved the row.
- "The reconciler only re-points routes." It re-pointed the RELEASE.

## Wasted effort / cause

- Started by looking for a repair function. The repair was the last
  thing needed: the rule (the Binding projects onto the row) had to be
  written first, and only then did "which rows are wrong" have a
  meaning.
- Tried to make the projection atomic by ordering the writes, and ran
  into the pre-existing contract that a failed activation removes the
  orphaned row. The order (Binding settles, then the row follows) is
  right, but the row is still written first — the projection afterwards
  is what makes it consistent, and the reconciliation is what makes it
  durable across a crash.
- Spent time on the consumer's stale size before checking whether OUR
  truth was stale. Checking the Binding first would have classified it
  correctly in one query.

## Most useful test

`a Binding replacement moves the VFS row with it`
(test/byte-authority.test.js). It pins the transition that matters: the
representation changes, the Binding version changes, the VFS row follows
— and the presentation path does not move. Every other property of the
invariant is a corollary of that one.

## Lying / overconstraining test

`O1 — failed binding activation removes the orphaned TV row` pinned the
create-then-delete dance. That behaviour was right (a modern row needs
its Binding) but the mechanism was incidental; the projection made the
same guarantee without the dance, and the test had to be re-read rather
than deleted.

## Automation that should disappear

The per-process retry map for failed binding activations. It is
process-local, so a restart loses it, and the durable retry (the
reconciliation) now covers the same ground with a durable state.

## Guidance change

- A durable fact that is written by two owners is two facts. Name the
  owner.
- Write the authority before its projection, and make the projection
  repairable: the projection is the one that can be stale, because
  nothing else is derived from it.
- A failed write that leaves the derived copy ahead of the authority is
  worse than a failed write: the derived copy is what the consumer sees.

## Complexity to remove

- The VFS row's `torrent_file_id`, `info_hash` and `size` are a copy of
  the Binding's TorrentFile, kept in a different database, for the
  convenience of the byte path. The invariant makes the copy safe, but
  the copy is still a second thing to keep correct.
- The routine reconciler decides the representation from the provider's
  current file. That is a route decision with representation authority,
  and it is the last remaining way for a route to move bytes.
