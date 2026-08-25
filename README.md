# Hashsucker

## Media release discovery, indexing, and ranking system

Hashsucker is an experimental system for discovering and ranking media
release candidates from multiple external sources.

It focuses on the engineering problems involved in:

-   Aggregating release candidate data
-   Normalizing inconsistent release metadata
-   Resolving candidate identity
-   Ranking results using multiple signals
-   Maintaining historical observations

The system is designed around a separation between:

-   **Media metadata** --- what the requested title represents
-   **Release candidates** --- individual files/releases associated with
    that media
-   **Availability sources** --- external services that report candidate
    availability

------------------------------------------------------------------------

# Core Problem

Media release discovery is difficult because the available signals are
incomplete and sometimes contradictory.

A candidate may have:

-   A matching title but incorrect identity
-   Excellent quality but uncertain provenance
-   Confirmed identity but unavailable sources
-   Provider availability but weak metadata

Hashsucker explores how to represent and rank these conflicting signals.

------------------------------------------------------------------------

# Corpus

The corpus is an internal index of previously observed release
candidates.

It contains:

-   Release identifiers
-   Hashes
-   Filenames
-   Parsed attributes
-   Media associations
-   Historical observations

The corpus is not a replacement for general media metadata databases.

Instead, it represents accumulated knowledge about release candidates
encountered by the system.

------------------------------------------------------------------------

# Identity and Ranking

A central design goal is avoiding the assumption:

> "A source returned this candidate, therefore it is correct."

Candidates are evaluated using evidence such as:

-   Explicit media associations
-   Filename parsing
-   Title matching
-   Season/episode information
-   Historical observations
-   Availability information

The system currently models multiple confidence levels:

    Verified
        |
    ProviderConfirmed
        |
    ProviderScoped
        |
    Probable
        |
    TextOnly

------------------------------------------------------------------------

# Current Status

## Implemented

-   Canonical candidate pipeline
-   Multi-source ingestion
-   Release metadata parsing
-   Identity classification
-   Tier-aware ranking
-   Ranking diagnostics
-   Shadow ranking analysis
-   Operator tracing

## In Progress

-   Improved identity validation
-   Historical candidate reputation
-   Long-term corpus growth strategies
-   Production observability
