# AGENTS.md

This repository is a production-oriented media acquisition application built around
a web frontend and a TorBox -> Arr import worker.

The next major project phase is to unify the existing `media-search` application and
`torbox-importer` stack into one cohesive, documented, distributable project suitable
for GitHub publication and eventual Unraid Community Applications distribution.

## Read this before doing anything

Before any non-trivial change, inspect:

1. `CODEX.md`
   - Current implementation details.
   - Proven live behavior.
   - Important historical decisions.

2. `ai-handover.md`
   - Most recent work.
   - Current deployment state.
   - Outstanding tasks and known problems.

3. Relevant files under `docs/`.
   - Architecture.
   - Request/import lifecycle.
   - Deployment.
   - Safety invariants.

Do not reconstruct project behavior from assumptions when these files or the existing
implementation contain the answer.

---

# Product boundaries

The application currently consists of two major runtime responsibilities.

## media-search

Responsible for:

- Media discovery/search.
- Stremio/addon discovery.
- Provider cache enrichment.
- Explicit user intent.
- Creating request handoff documents.
- Showing request lifecycle/progress.

It is the request producer and user-facing application.

It MUST NOT:

- Directly mutate importer state.
- Directly delete provider resources.
- Read importer SQLite as an application API.
- Parse importer logs to infer structured state.
- Reimplement importer selection/import logic.

## torbox-importer

Responsible for:

- Consuming explicit request handoffs.
- Linking or creating TorBox resources.
- Selecting exact physical files.
- Downloading requested files.
- Interacting with Sonarr/Radarr.
- Verifying successful imports.
- Updating authoritative import state.
- Performing provider cleanup only when safe.

It owns importer state and destructive provider operations.

---

# Architectural objective

We are moving toward ONE distributable project.

That does NOT mean collapsing all responsibilities into one process or one source file.

The desired result is:

- One Git repository.
- One documented installation.
- One coherent configuration surface.
- One Compose/project deployment.
- Clear service boundaries internally.
- Shared versioning.
- Shared documentation.
- Shared release process.
- Suitable packaging for Unraid Community Applications.

Prefer a clean multi-service application over merging unrelated responsibilities into
one monolithic process.

Preserve working boundaries unless there is a concrete reason to change them.

---

# Safety invariants

These rules are NON-NEGOTIABLE.

## Provider deletion

Never delete TorBox/provider-side media unless ALL relevant conditions are proven.

For request-created resources:

1. The provider object is proven to belong to the request.
2. Provider ID and expected hash/identity match.
3. Downstream import is verified, OR an explicit already-present condition has been
   safely verified.
4. No other active request depends on the provider resource.

For pre-existing provider resources:

- Retain them by default.
- Do not auto-delete them merely because an import completed.

Ambiguous ownership MUST fail closed.

## Import identity

Never weaken identity validation just to make an import succeed.

Movies:

- Explicit request identity must match the Radarr-classified movie identity.
- IMDb/TMDB mapping must be proven where required.

TV:

- Explicit season/episode intent controls file selection.
- No explicit episode request => do not guess.
- Mixed requested/unrequested physical files must fail ambiguous unless explicitly
  supported.

## Failure behavior

Unexpected processor errors must become terminal failures where appropriate.

Do not leave request-associated jobs in hot retry loops.

Failure must preserve:

- Provider resource when cleanup is not proven safe.
- Downloaded/staged media where useful for diagnosis/resume.
- Useful `last_error` information.

## Secrets

Never print, log, commit, echo, screenshot, or expose:

- API keys
- OAuth tokens
- cookies
- provider credentials
- Arr API keys
- encryption keys

Use `.env`, secret storage, or documented runtime configuration.

Never commit live credentials.

---

# Production environment

The current live deployment is on Unraid.

Treat Tower as production.

Do not casually mutate production to make local tests pass.

Preferred workflow:

1. Inspect existing implementation.
2. Reproduce or test locally where possible.
3. Make the smallest correct change.
4. Run syntax/static/tests.
5. Show the diff.
6. Back up live files.
7. Deploy atomically.
8. Verify live behavior.
9. Backport any emergency live fix into the repository immediately.

Live fixes MUST NOT remain Tower-only.

---

# Development rules

## General

- Inspect before editing.
- Prefer small, reviewable changes.
- Preserve proven working behavior.
- Do not rewrite functioning subsystems without an explicit reason.
- Do not introduce speculative abstractions.
- Do not silently change external behavior.
- Avoid unnecessary dependencies.
- Do not commit or push unless explicitly requested.

## Shell

The importer contains safety-sensitive shell code.

For modified shell scripts:

```sh
bash -n path/to/script.sh
sh -n path/to/script.sh