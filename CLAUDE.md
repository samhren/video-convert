# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current State

This repository is in the **design/planning stage**. It currently contains only design docs (`docs/`) — there is no application code, build tooling, or tests yet. When scaffolding the project, follow the architecture and stack decided in `docs/`, and prefer the tools named there (Wrangler, AWS CDK, Docker, Vitest) over alternatives.

The authoritative design context lives in:

- `docs/purpose-and-stack.md` — goals and committed tech stack
- `docs/decisions.md` — architecture decisions with the reasoning and rejected alternatives behind them

## Intended Architecture

A distributed video conversion service that splits responsibilities across two cloud providers. The core idea is **edge coordination on Cloudflare, heavy processing on AWS**, with only three things crossing the provider boundary: the original video upload, completion pings to Cloudflare, and the final processed-video download.

Pipeline:

1. **Cloudflare Workers** (TypeScript) handle edge ingestion and coordination. The React web app talks to **Workers only** — never directly to AWS.
2. Videos are **chunked** rather than processed whole. Chunks process in parallel (faster for large files) and are fault-isolated (a failed chunk is retried without affecting the others).
3. **AWS** does the work: S3 stores the upload, chunks, and final output; SQS is the job queue; Fargate autoscales `ffmpeg` workers.
4. A **Durable Object** tracks how many of the N chunks have finished and triggers reassembly when all complete. Its single-threaded execution model is the reason it's used here — it is the single source of truth for job state, making the completion-counting race-free by design. Do not move this coordination state into a conventional DB.

### Constraints that drive the design (don't violate without revisiting `docs/decisions.md`)

- **Storage is S3, not R2.** Object storage sits next to Fargate to avoid cross-provider data movement, latency, and egress costs for the high-traffic chunk shuffling. Keep bulk video data on the AWS side.
- **The web app never calls AWS directly** — all client traffic goes through Cloudflare Workers.
- **Coordination/completion state lives in the Durable Object**, not a database, to preserve the race-free guarantee.

### Correctness invariants (these come from the failure modes — don't violate)

- **Completion state is a set of chunk IDs, never a counter.** SQS is at-least-once; the same chunk can ping "done" more than once. `done.add(id)` is idempotent; a counter would over-count on redelivery and trigger reassembly before all distinct chunks exist. "Finished" means `done.size === N`.
- **Workers confirm the S3 write before pinging the DO.** The ping must mean "the output already exists in S3." Order is: transcode → write to S3 → await confirm → ping DO. A worker that crashes before the S3 confirm must never have pinged, so the chunk gets retried rather than falsely counted as done.
- **Reassembly is order-independent and fires exactly once.** Workers finish out of order — reassembly sorts by chunk index, not arrival. A `reassemblyFired` guard inside the DO prevents a double-fire.
- **Chunk boundaries are keyframe-aligned; reassembly is a stream copy (concat demuxer), not a re-encode.** Splitting mid-GOP causes seams and A/V drift.
