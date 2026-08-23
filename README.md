# HashSucker

**Evidence-driven media discovery and acquisition intelligence.**

HashSucker is a media candidate intelligence layer designed to bridge the gap between torrent discovery, provider reality, and reliable acquisition decisions.

It does not treat a torrent index, filename match, or historical availability as truth.

Instead, HashSucker separates:

- what was discovered
- what was ranked
- what providers currently report
- what action is justified

into explicit, testable boundaries.

---

## The Problem

Modern media automation often collapses several different problems into one:

```
Find a release
      |
      v
Assume it is valid
      |
      v
Assume it is available
      |
      v
Attempt acquisition
```

This works until it does not.

Real-world media sources contain:

- duplicate releases
- weak metadata associations
- stale hashes
- ambiguous file identities
- unavailable provider state
- inconsistent provider APIs

HashSucker treats these as separate concerns.

---

# Architecture

```
                    Discovery Sources
                          |
                          v

                 Candidate Corpus
                          |
                          v

              Identity + Metadata Layer
                          |
                          v

                 Stage 3 Ranking
                          |
                          v

          Provider Observation Layer
                          |
                          v

             Acquisition Decision Layer
                          |
                          v

              Provider Execution Layer
```

Each stage has a defined responsibility.

---

# Core Principles

## Discovery is not truth

A torrent appearing in a database does not prove:

- it is the correct release
- it contains the desired file
- it is available from a provider
- it should be acquired

Discovery provides candidates.

---

## Ranking and availability are separate

Candidate quality and provider reality are different questions.

HashSucker does not fold provider state into search ranking.

Instead:

```
Candidate quality
        +
Provider evidence
        |
        v
Explainable decision
```

This prevents provider state from corrupting search quality.

---

## Provider observations are evidence

Provider information is modeled explicitly:

```
cached
uncached
unknown
error
```

with:

- provider identity
- account scope
- observation time
- expiration
- authority level
- evidence source

Unknown is not uncached.

Failure is not absence.

Prediction is not truth.

---

# Identity Model

HashSucker treats exact identity as a first-class concern.

Primary identity:

```
(infoHash, fileIndex)
```

or:

```
releaseKey
```

Important distinctions:

```
fileIndex = null
```

is not:

```
fileIndex = 0
```

Torrent-level evidence cannot silently authorize a file-level candidate.

---

# Provider Model

Providers expose independent capabilities.

Examples:

```
CACHE_OBSERVATION
PLACEMENT_CREATE
FILE_INVENTORY
EXPOSURE
REPAIR
```

A provider supporting one capability does not imply support for another.

This avoids pretending providers have identical behavior.

---

# Current Implementation Status

## Completed

### Stage 3 — Candidate Intelligence

- discovery corpus
- metadata normalization
- ranked candidate generation
- deterministic ranking behavior

### Stage 4 Foundation

- provider-neutral observations
- observation history/current projection
- exact candidate projection
- TorBox cache observation
- TorBox placement creation boundary
- bounded provider observation collection
- decision contracts

---

## Intentionally Incomplete

HashSucker does not currently attempt to:

- replace every media automation tool
- scrape every ecosystem
- predict provider state as fact
- maintain a global cache oracle
- blindly automate destructive actions

The goal is correctness before convenience.

---

# Design Philosophy

HashSucker follows a simple rule:

> Store enough information to make a good decision. Do not pretend incomplete information is certainty.

The system prefers:

```
deferred
```

over:

```
wrong
```

and:

```
explainable uncertainty
```

over:

```
false confidence
```

---

# Why Not Just Use Existing Indexers?

Existing systems are excellent at:

- library management
- monitoring
- metadata workflows
- generic indexing

HashSucker focuses on a different problem:

```
Given these possible candidates,
what is actually the correct and actionable choice?
```

It is designed as an intelligence layer, not a replacement for every existing component.

---

# Roadmap Direction

Future work:

- additional provider integrations
- richer observation sources
- lifecycle reconciliation
- cache reputation modeling
- external compatibility APIs
- deeper execution workflows

while preserving the core separation:

```
Evidence
    |
    v
Decision
    |
    v
Action
```

---

# Status

Early-stage infrastructure project.

Currently focused on building reliable boundaries before expanding automation.