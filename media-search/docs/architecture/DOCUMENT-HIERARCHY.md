# Document Hierarchy — HashSucker Architecture Canon

**Date:** 2026-08-23  
**Scope:** Canonical document index and overlap resolution for the HashSucker architecture documentation set  
**Constraints:** No code changes; no schema changes; documentation audit only

---

## 1. Purpose

This document is the **authoritative index** for the HashSucker architecture documentation set. It:

1. Defines which documents are canonical for each topic
2. Maps overlapping content to its canonical source
3. Provides a reading order for implementers
4. Documents what was consolidated and why

**Do not edit this document to add new architectural content.** It only indexes other documents.

---

## 2. Current Document Inventory

### 2.1 Architecture & Design (9 documents)

| Document | Lines | Status | Primary Topic |
|----------|-------|--------|---------------|
| `MATERIALIZATION-ARCHITECTURE.md` | 976 | **CANONICAL** | Architecture overview, requirements, phase structure |
| `MATERIALIZATION-REGISTRY-SCHEMA.md` | 1069 | **CANONICAL** | Registry schema, entities, query patterns |
| `PROVIDER-INTERFACE.md` | 269 | **CANONICAL** | Provider adapter contract, forbidden responsibilities |
| `RESOLVER-DESIGN.md` | 778 | **CANONICAL** | Resolver endpoint, HTTP contract, failure modes |
| `ZURG-INTEGRATION-ANALYSIS.md` | 486 | **CANONICAL** | Zurg concept mapping, reusable patterns |
| `ARCHITECTURE-BOUNDARIES.md` | 257 | **CANONICAL** | Layer ownership map, data flow |
| `CONTRACTS.md` | 623 | **CANONICAL** | Extracted stable contracts |
| `STATE-MACHINE-REFERENCE.md` | 307 | **CANONICAL** | Unified lifecycle state documentation |
| `ANTI-PATTERNS.md` | 313 | **CANONICAL** | Boundary violations to avoid |

### 2.2 Provider Research (2 documents)

| Document | Lines | Status | Primary Topic |
|----------|-------|--------|---------------|
| `REALDEBRID-CAPABILITY-RESEARCH.md` | ~200 | **REFERENCE** | RD API capability assessment |
| `REALDEBRID-EXECUTION-STRUCTURE.md` | ~250 | **REFERENCE** | RD API structures for adapter implementation |

### 2.3 Implementation Roadmap (1 document)

| Document | Lines | Status | Primary Topic |
|----------|-------|--------|---------------|
| `IMPLEMENTATION-ORDER.md` | 326 | **CANONICAL** | Phased implementation roadmap |

---

## 3. Topic-to-Document Map

When multiple documents cover the same topic, the **first** document listed is the canonical source. Others contain supplementary or derived information.

### 3.1 Identity Contract

| Order | Document | Section | What It Provides |
|-------|----------|---------|------------------|
| 1 | `CONTRACTS.md` | §1 | Canonical identity contract definition |
| 2 | `MATERIALIZATION-REGISTRY-SCHEMA.md` | §3.1 | Schema-level identity reference pattern |
| 3 | `PROVIDER-INTERFACE.md` | §3.3 | Identity as adapter input |
| 4 | `ARCHITECTURE-BOUNDARIES.md` | §2.2 | Corpus layer ownership of identity |

### 3.2 Ownership Boundaries

| Order | Document | Section | What It Provides |
|-------|----------|---------|------------------|
| 1 | `ARCHITECTURE-BOUNDARIES.md` | §2, §3 | Canonical layer definitions and data flow |
| 2 | `PROVIDER-INTERFACE.md` | §1 | Resolver vs adapter ownership split |
| 3 | `MATERIALIZATION-REGISTRY-SCHEMA.md` | §2 | Registry ownership boundary |
| 4 | `ANTI-PATTERNS.md` | §1-§7 | Explicit boundary violations to avoid |

### 3.3 State Machine

| Order | Document | Section | What It Provides |
|-------|----------|---------|------------------|
| 1 | `STATE-MACHINE-REFERENCE.md` | §2, §3, §4 | Canonical state machine definitions |
| 2 | `MATERIALIZATION-REGISTRY-SCHEMA.md` | §3.3, §5 | State storage schema and event logging |
| 3 | `RESOLVER-DESIGN.md` | §4, §5 | Resolver state transitions and events |
| 4 | `MATERIALIZATION-ARCHITECTURE.md` | §4.5, §6.1 | Architecture-level lifecycle discussion |

### 3.4 Provider Adapter Interface

| Order | Document | Section | What It Provides |
|-------|----------|---------|------------------|
| 1 | `PROVIDER-INTERFACE.md` | §3 | Canonical interface definition |
| 2 | `CONTRACTS.md` | §3 | PlayableSource contract |
| 3 | `RESOLVER-DESIGN.md` | §4.2, §5.2 | How resolver uses adapter |
| 4 | `ZURG-INTEGRATION-ANALYSIS.md` | §5 | Zurg as potential adapter |

### 3.5 Resolver Endpoint

| Order | Document | Section | What It Provides |
|-------|----------|---------|------------------|
| 1 | `RESOLVER-DESIGN.md` | §2, §3 | Canonical HTTP contract |
| 2 | `CONTRACTS.md` | §5 | Playback contract summary |
| 3 | `MATERIALIZATION-ARCHITECTURE.md` | §7.2 | Architecture-level resolver description |

### 3.6 Registry Schema

| Order | Document | Section | What It Provides |
|-------|----------|---------|------------------|
| 1 | `MATERIALIZATION-REGISTRY-SCHEMA.md` | §3, §9 | Canonical schema and entities |
| 2 | `CONTRACTS.md` | §2, §4, §7, §8 | Extracted contracts from schema |

### 3.7 Repair Lifecycle

| Order | Document | Section | What It Provides |
|-------|----------|---------|------------------|
| 1 | `STATE-MACHINE-REFERENCE.md` | §3.3, §3.4 | Canonical repair state transitions |
| 2 | `RESOLVER-DESIGN.md` | §5, §6 | Resolver repair implementation |
| 3 | `MATERIALIZATION-REGISTRY-SCHEMA.md` | §6.4 | Repair query patterns |
| 4 | `MATERIALIZATION-ARCHITECTURE.md` | §6.1 | Architecture-level repair flows |

### 3.8 Anti-Patterns

| Order | Document | Section | What It Provides |
|-------|----------|---------|------------------|
| 1 | `ANTI-PATTERNS.md` | §1-§7 | Canonical anti-pattern documentation |
| 2 | `PROVIDER-INTERFACE.md` | §2 | Adapter forbidden responsibilities |
| 3 | `ARCHITECTURE-BOUNDARIES.md` | §4 | Boundary rule summary |

### 3.9 Contracts

| Order | Document | Section | What It Provides |
|-------|----------|---------|------------------|
| 1 | `CONTRACTS.md` | §1-§10 | Canonical contract definitions |
| 2 | `MATERIALIZATION-REGISTRY-SCHEMA.md` | §3 | Entity definitions |
| 3 | `PROVIDER-INTERFACE.md` | §3 | Adapter interface |

### 3.10 Implementation Phases

| Order | Document | Section | What It Provides |
|-------|----------|---------|------------------|
| 1 | `IMPLEMENTATION-ORDER.md` | §2-§5 | Canonical phase definitions |
| 2 | `MATERIALIZATION-ARCHITECTURE.md` | §8 | Original phase structure |

---

## 4. Overlap Resolution

### 4.1 State Machine (5 documents → 1 canonical)

**Problem:** State machine definitions duplicated across 5 documents with slight variations.

**Resolution:**
- `STATE-MACHINE-REFERENCE.md` is the **single source of truth** for all lifecycle state definitions.
- Other documents may reference state names but must not redefine transitions.
- `RESOLVER-DESIGN.md` §5 is retained for resolver-specific event schema details.
- `MATERIALIZATION-REGISTRY-SCHEMA.md` §5 is retained for event storage schema.

**Consolidation:** No content removed. Canonical source designated.

### 4.2 Ownership Boundaries (4 documents → 1 canonical)

**Problem:** Layer ownership defined in 4 documents with overlapping lists.

**Resolution:**
- `ARCHITECTURE-BOUNDARIES.md` is the **single source of truth** for layer definitions.
- `PROVIDER-INTERFACE.md` §1 is retained for the specific resolver/adapter split.
- `ANTI-PATTERNS.md` is retained for explicit violation examples.
- `MATERIALIZATION-REGISTRY-SCHEMA.md` §2 is retained for registry-specific boundary.

**Consolidation:** No content removed. Canonical source designated.

### 3.3 Provider Adapter Interface (4 documents → 1 canonical)

**Problem:** Adapter interface defined in 4 documents with method signatures.

**Resolution:**
- `PROVIDER-INTERFACE.md` §3 is the **single source of truth** for the adapter interface.
- `CONTRACTS.md` §3 is retained for the PlayableSource data structure contract.
- `RESOLVER-DESIGN.md` §4.2 is retained for how the resolver invokes the adapter.

**Consolidation:** No content removed. Canonical source designated.

### 3.4 Identity Contract (4 documents → 1 canonical)

**Problem:** Identity semantics defined in 4 documents.

**Resolution:**
- `CONTRACTS.md` §1 is the **single source of truth** for the identity contract.
- `MATERIALIZATION-REGISTRY-SCHEMA.md` §3.1 is retained for schema reference pattern.
- `PROVIDER-INTERFACE.md` §3.3 is retained for adapter input structure.

**Consolidation:** No content removed. Canonical source designated.

### 3.5 Resolver Endpoint (3 documents → 1 canonical)

**Problem:** Resolver endpoint defined in 3 documents.

**Resolution:**
- `RESOLVER-DESIGN.md` §2, §3 is the **single source of truth** for the HTTP contract.
- `CONTRACTS.md` §5 is retained for the playback contract summary.
- `MATERIALIZATION-ARCHITECTURE.md` §7.2 is retained for architecture context.

**Consolidation:** No content removed. Canonical source designated.

### 3.6 Anti-Patterns (3 documents → 1 canonical)

**Problem:** Forbidden responsibilities listed in 3 documents.

**Resolution:**
- `ANTI-PATTERNS.md` is the **single source of truth** for boundary violations.
- `PROVIDER-INTERFACE.md` §2 is retained for adapter-specific forbidden list.
- `ARCHITECTURE-BOUNDARIES.md` §4 is retained for boundary rule summary.

**Consolidation:** No content removed. Canonical source designated.

---

## 5. Reading Order for Implementers

### 5.1 New to HashSucker?

Read in this order:

1. `MATERIALIZATION-ARCHITECTURE.md` — Understand the problem and solution
2. `ARCHITECTURE-BOUNDARIES.md` — Understand who owns what
3. `CONTRACTS.md` — Understand the stable contracts
4. `STATE-MACHINE-REFERENCE.md` — Understand lifecycle states
5. `PROVIDER-INTERFACE.md` — Understand the adapter contract
6. `RESOLVER-DESIGN.md` — Understand the resolver endpoint
7. `MATERIALIZATION-REGISTRY-SCHEMA.md` — Understand the persistence model
8. `ANTI-PATTERNS.md` — Understand what not to do
9. `IMPLEMENTATION-ORDER.md` — Understand the roadmap

### 5.2 Implementing a Specific Component?

| Component | Start With | Then Read |
|-----------|------------|-----------|
| Provider Adapter | `PROVIDER-INTERFACE.md` | `REALDEBRID-EXECUTION-STRUCTURE.md`, `ZURG-INTEGRATION-ANALYSIS.md` |
| Resolver | `RESOLVER-DESIGN.md` | `CONTRACTS.md` §5, `STATE-MACHINE-REFERENCE.md` |
| Registry | `MATERIALIZATION-REGISTRY-SCHEMA.md` | `CONTRACTS.md` §2, §4, §7, §8 |
| Consumer Adapter | `MATERIALIZATION-ARCHITECTURE.md` §7.3 | `ANTI-PATTERNS.md` §5 |
| Repair Orchestrator | `STATE-MACHINE-REFERENCE.md` §3 | `RESOLVER-DESIGN.md` §5, §6 |

### 5.3 Need to Understand a Contract?

| Contract | Canonical Source |
|----------|------------------|
| Identity | `CONTRACTS.md` §1 |
| Placement | `CONTRACTS.md` §2 |
| Playable Source | `CONTRACTS.md` §3 |
| Materialization State | `CONTRACTS.md` §4 |
| Playback | `CONTRACTS.md` §5 |
| .strm | `CONTRACTS.md` §6 |
| Event | `CONTRACTS.md` §7 |
| URL Cache | `CONTRACTS.md` §8 |
| Provider Error | `CONTRACTS.md` §9 |
| Persistence (2O) | `CONTRACTS.md` §2.1 |
| Topology (2P) | `CONTRACTS.md` §2.2 |
| Confidence (2Q) | `CONTRACTS.md` §2.3 |

---

## 6. Document Maintenance Rules

### 6.1 Adding New Content

1. **Check the topic map first.** If the topic already has a canonical source, add to that document.
2. **If no canonical source exists**, create a new document and register it in this index.
3. **Update this index** when adding new documents or changing canonical sources.

### 6.2 Modifying Existing Content

1. **Canonical documents** may be freely modified within their scope.
2. **Non-canonical documents** should not duplicate content from canonical sources. Replace with references.
3. **If a non-canonical document needs to diverge**, document the divergence reason in this index.

### 6.3 Deprecating Documents

1. **Do not delete documents.** Mark as deprecated in this index.
2. **Add deprecation notice** to the document header.
3. **Update all references** in other documents to point to the new canonical source.

---

## 7. Document Status Summary

| Document | Canonical For | Supplementary For |
|----------|---------------|-------------------|
| `MATERIALIZATION-ARCHITECTURE.md` | Architecture overview, requirements, phases | Resolver endpoint, lifecycle, repair |
| `MATERIALIZATION-REGISTRY-SCHEMA.md` | Registry schema, entities, query patterns | Identity, state machine, repair queries |
| `PROVIDER-INTERFACE.md` | Adapter contract, forbidden responsibilities | Ownership boundary, anti-patterns |
| `RESOLVER-DESIGN.md` | Resolver endpoint, HTTP contract, failure modes | State machine events, repair implementation |
| `ZURG-INTEGRATION-ANALYSIS.md` | Zurg concept mapping, reusable patterns | Provider adapter design reference |
| `ARCHITECTURE-BOUNDARIES.md` | Layer ownership, data flow | Anti-patterns, ownership |
| `CONTRACTS.md` | All stable contracts | — |
| `STATE-MACHINE-REFERENCE.md` | All lifecycle state definitions | — |
| `ANTI-PATTERNS.md` | All boundary violations | — |
| `IMPLEMENTATION-ORDER.md` | Phased roadmap | — |
| `REALDEBRID-CAPABILITY-RESEARCH.md` | RD capability assessment | Provider adapter implementation |
| `REALDEBRID-EXECUTION-STRUCTURE.md` | RD API structures | Provider adapter implementation |

---

## 8. Consolidation History

### 8.1 2026-08-23 — Initial Audit

**Findings:**
- 12 documents in `Docs/evaluation/`
- 6 topics with overlapping definitions across multiple documents
- No content conflicts — all documents agree on architecture
- Redundancy is documentation of the same contract from different perspectives

**Action taken:**
- Designated canonical sources for each topic
- Created this index document
- No content removed or rewritten
- All ownership boundaries preserved
- All phase separations preserved

**Overlaps resolved:**
1. State machine: 5 documents → 1 canonical (`STATE-MACHINE-REFERENCE.md`)
2. Ownership boundaries: 4 documents → 1 canonical (`ARCHITECTURE-BOUNDARIES.md`)
3. Provider adapter interface: 4 documents → 1 canonical (`PROVIDER-INTERFACE.md`)
4. Identity contract: 4 documents → 1 canonical (`CONTRACTS.md` §1)
5. Resolver endpoint: 3 documents → 1 canonical (`RESOLVER-DESIGN.md`)
6. Anti-patterns: 3 documents → 1 canonical (`ANTI-PATTERNS.md`)

---

## 9. References

All documents in `Docs/evaluation/` are part of the architecture canon. See the topic map above for cross-references.
