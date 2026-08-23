# Candidate Granularity Policy

**Date:** 2026-08-23
**Scope:** When torrent-level vs. file-level observations are sufficient, and how granularity mismatches behave in decision evaluation.
**Status:** Documentation only — no code, no wiring, no provider changes.

---

## 1. When torrent-level observations are sufficient

A torrent-level observation (`scope: 'torrent'`, `fileIndex: null`) is **sufficient** when:

- **The candidate is torrent-level** (`fileIndex: null`, `releaseKey = '<hash>:torrent'`).
- **The observation is authoritative and fresh** (not stale, unbounded, future, or malformed).
- **The decision context accepts torrent-level resolution** (e.g., the intent is to acquire the entire torrent or any file within it).

In this case, the Slice 1A projection accepts the observation, and the Stage 4 decision logic can select the candidate based on the torrent-level cache state. This is the **only TorBox-native path** to a `projected` result, since `checkcached` is torrent-level only.

**Example:**
- Candidate: `{ infoHash: 'abc...', fileIndex: null }`
- Observation: `{ scope: 'torrent', infoHash: 'abc...', fileIndex: null, state: 'cached' }`
- Projection: `projected`
- Decision: candidate is `available` (if no higher-ranked file-level candidates block it)

---

## 2. When exact file-level observations are required

A file-level observation (`scope: 'candidate'`, `fileIndex: <number>`) is **required** when:

- **The candidate is file-level** (`fileIndex: 0`, `releaseKey = '<hash>:0'`).
- **The decision context requires a specific file** (e.g., the intent is to acquire a particular episode or quality variant).
- **The provider can confirm availability of that specific file**, not just the torrent.

In this case, a torrent-level observation is **insufficient**. The Slice 1A projection **rejects** it with reason `torrent-scope-file-candidate`. The observation never authorizes the file-level candidate.

**Example:**
- Candidate: `{ infoHash: 'abc...', fileIndex: 0 }`
- Observation: `{ scope: 'torrent', infoHash: 'abc...', fileIndex: null, state: 'cached' }`
- Projection: `rejected` (`torrent-scope-file-candidate`)
- Decision: observation is treated as **missing** for this candidate → candidate is `unresolved`

---

## 3. Are torrent candidates valid acquisition candidates?

**Yes**, torrent-level candidates (`fileIndex: null`) are valid acquisition candidates, but only when:

- The decision context allows torrent-level resolution (e.g., no specific file is required).
- A torrent-level observation can project onto them (i.e., authoritative, fresh, same `infoHash`).

**No**, torrent-level candidates are **not valid** as a substitute for file-level candidates. A torrent-level candidate and a file-level candidate are distinct identities. The projection layer enforces this: a torrent-level observation cannot authorize a file-level candidate, and vice versa.

**Physical import note:** The `torbox-importer` and filesystem queue historically operate on torrent-level identity (protocol-v1 handoff with `fileIndex` optional). A torrent-level candidate may trigger a torrent-level import, but this does not guarantee a specific file is selected or available unless a validated file-mapping contract exists. Currently, no such contract is implemented.

---

## 4. How deferred decisions behave when evidence is coarser than candidate identity

When provider evidence is **coarser** than the candidate identity (e.g., torrent-level observation for a file-level candidate), the behavior is:

### 4.1 Projection rejects the mismatch

The Slice 1A projection returns:
```js
{
  status: 'rejected',
  reason: 'torrent-scope-file-candidate',
  candidate: { infoHash, fileIndex: 0 },
  observation: { scope: 'torrent', fileIndex: null },
}
```

The observation is **not** silently dropped or merged. It is explicitly rejected and the reason is preserved.

### 4.2 Decision treats rejected observations as missing

In `decideAcquisition`, a rejected observation is treated as if no observation exists for that candidate. The target evaluation returns `missing-observation`, and the candidate status becomes `unresolved` (not `unavailable`).

### 4.3 Higher-ranked unresolved candidates cause deferral

If a higher-ranked file-level candidate has no resolvable observation (because its only evidence was torrent-level), the decision **defers** rather than falling through to a lower-ranked candidate. This is the correct behavior: unknown availability must not silently become unavailability.

**Example scenario:**
- Rank 0: file-level candidate `<hash>:0` — only evidence is torrent-level cached → **rejected** → **unresolved**
- Rank 1: file-level candidate `<hash>:1` — has fresh file-level cached → **available**
- Decision: `deferred` (not `selected` for rank 1, because rank 0 is unresolved)

### 4.4 Fallback requires authoritative unavailability for every higher rank

A lower-ranked candidate is selected **only when every higher-ranked candidate is authoritatively uncached** at every policy target. If any higher-ranked candidate has no resolvable observation (deferred), the decision remains `deferred`.

This means coarser evidence **cannot** be used to skip higher-ranked candidates. The decision waits for explicit file-level evidence before committing to a lower rank.

---

## 5. Summary table

| Candidate identity | Observation granularity | Projection result | Decision behavior |
|---|---|---|---|
| Torrent (`fileIndex: null`) | Torrent (`scope: 'torrent'`, `fileIndex: null`) | `projected` | Candidate is `available`/`unavailable` based on state |
| Torrent (`fileIndex: null`) | File (`scope: 'candidate'`, `fileIndex: 0`) | `rejected` (`wrong-fileIndex`) | Candidate `unresolved` |
| File (`fileIndex: 0`) | File (`scope: 'candidate'`, `fileIndex: 0`) | `projected` | Candidate is `available`/`unavailable` based on state |
| File (`fileIndex: 0`) | Torrent (`scope: 'torrent'`, `fileIndex: null`) | `rejected` (`torrent-scope-file-candidate`) | Candidate `unresolved` |

---

## 6. Policy invariants (enforced by projection + decision)

1. **Identity is exact.** `null` fileIndex is distinct from `0`. No fuzzy matching.
2. **Scope is validated.** Torrent scope cannot authorize file candidates. File scope cannot authorize torrent candidates.
3. **Coarser evidence defers.** When the only available observation is coarser than the candidate, the decision waits for better evidence rather than assuming unavailability.
4. **Finer evidence is not wasted.** A file-level observation for a torrent-level candidate is rejected (wrong scope), but the observation itself is preserved for its matching file-level candidate.
5. **No provider hacks.** The policy does not invent file-level signals from torrent-level data. The projection rejects mismatches; the decision defers.

---

## 7. Exit status

- Granularity policy is documented.
- No projection weakening, no provider hacks, no runtime wiring.
- Behavior is testable via existing Slice 1A projection tests and `decideAcquisition` tests.
