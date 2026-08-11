# Upstream relationship

This repository is an unofficial community reliability fork of
[`yctimlin/mcp_excalidraw`](https://github.com/yctimlin/mcp_excalidraw).

It is not the official Excalidraw MCP and it does not claim original authorship of the upstream
server, CLI, agent skill, frontend, or tool surface. The inherited work remains under its existing
MIT license and copyright notice. This fork is maintained by
[`IndelibleVivi`](https://github.com/IndelibleVivi) and focuses on reliability changes derived from
hands-on use.

## Current fork delta

The first maintained delta is based on upstream commit
`6ddbe98093eba9c8c0606ca40bc4f3a41495d8d8` (upstream release 2.0.0) and adds:

- optional restart-safe canvas checkpoints through `EXCALIDRAW_DATA_DIR`;
- a fixed versioned checkpoint schema and single-owner data-directory lock;
- state epochs and monotonic scene revisions;
- compare-and-swap protection for full-scene browser synchronization;
- authoritative empty-scene propagation and WebSocket revision-gap recovery;
- local draft preservation and explicit restoration after stale-tab conflicts;
- focused integration coverage for restart, conflict, lock, rollback, file, snapshot, and schema
  behavior.

The implementation commit is kept separately on
[`fix/durable-canvas-state`](https://github.com/IndelibleVivi/mcp_excalidraw/tree/fix/durable-canvas-state)
without fork-specific branding so it can be reviewed or proposed upstream cleanly.

## Distribution status

There is currently no fork-specific npm package or container image. The unscoped
`mcp-excalidraw-server` npm package and `ghcr.io/yctimlin/*` images remain upstream artifacts. Build
this fork from source until a separately named and tested distribution is published.

The fork's `package.json` is marked `private` to prevent accidental publication under the upstream
package name. Inherited npm and container publishing jobs are also repository-gated to
`yctimlin/mcp_excalidraw`, so a fork push cannot mint packages or images. A future fork package
must use its own scoped identity and release notes.

## Maintenance policy

- `upstream` refers to `https://github.com/yctimlin/mcp_excalidraw.git`.
- Upstream changes are reviewed before integration; this fork does not rewrite upstream history or
  remove inherited attribution.
- Fork-specific reliability bugs belong in this repository's issue tracker.
- General feature requests that reproduce on unmodified upstream should also be reported upstream.
- A GitHub fork, an upstream pull request, an npm release, and a container release are separate
  publication decisions.
