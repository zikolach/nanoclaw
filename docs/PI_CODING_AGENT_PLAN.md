# Pi coding agent integration plan

## Goal

Integrate [pi coding agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) into NanoClaw without losing NanoClaw's core runtime guarantees:

- per-group isolation
- durable multi-turn sessions
- scheduled task support
- IPC-based host/container coordination
- container-side customization
- safe secret handling

This document is a **design and migration plan**, not an implementation record.

## Current repository state

Before writing this plan, local Pi migration work was stashed, upstream `origin/main` was merged into local `main`, and the stashed work was reapplied.

### What upstream changed

Recent upstream changes materially affect a Pi migration:

- NanoClaw now leans on **OneCLI** for credential injection into containers.
- `src/credential-proxy.ts` was removed upstream.
- `src/container-runner.ts` now configures containers around the OneCLI gateway model.
- Core docs and setup/debug flows were updated.

### What the local Pi migration attempt already changed

The local work-in-progress attempted to:

- replace Claude SDK dependencies in `container/agent-runner/package.json`
- install `@mariozechner/pi-coding-agent` in `container/Dockerfile`
- rewrite `container/agent-runner/src/index.ts` from Claude SDK `query()` to Pi SDK `createAgentSession()`
- reintroduce a Pi-aware credential path using `PI_BASE_URL` and `PI_API_KEY`
- add `.pi/` config files and shell scripts for local testing

### Assessment of the current attempt

The attempt is useful as exploration, but it is incomplete and not aligned with upstream yet.

Main gaps:

1. **Credential architecture conflict**
   - upstream uses OneCLI
   - local Pi branch reintroduced a custom credential proxy model

2. **Session persistence not solved**
   - the draft Pi code used `SessionManager.inMemory()`
   - NanoClaw needs session continuity across container lifetimes

3. **Resource loading is too minimal**
   - the draft Pi code used a custom near-empty `ResourceLoader`
   - that would skip most of Pi's native discovery for skills, prompts, extensions, and context files

4. **Tooling parity is incomplete**
   - draft code only wired basic tools
   - NanoClaw-specific IPC behaviors still need a Pi-native integration strategy

5. **Model/provider configuration is underspecified**
   - the draft used direct runtime configuration rather than a stable Pi-native provider/model strategy

## Non-goals

This migration should **not**:

- weaken group isolation
- expose real host credentials directly to containers
- require invasive forks of Pi internals
- block future upstream NanoClaw merges behind a permanent hard fork

## Recommended architectural direction

## 1. Use Pi natively inside the container, not as a Claude drop-in

Do not treat Pi as a thin replacement for the Claude SDK.

Instead:

- keep NanoClaw's host/container orchestration model
- replace the container-side agent runtime with a Pi-native session layer
- adapt NanoClaw's IPC and scheduling semantics to Pi concepts

This avoids a fragile hybrid where NanoClaw still behaves as if the Claude SDK were underneath.

## 2. Prefer Pi-native provider/model configuration over reviving the deleted proxy path

Primary direction:

- configure Pi through `.pi` settings and/or Pi provider configuration
- use Pi-supported provider routing for Anthropic, OpenAI-compatible local models, or custom endpoints
- only add a NanoClaw-specific proxy layer if there is a clearly proven gap that Pi provider configuration cannot cover

Rationale:

- aligns with Pi's documented extension/provider model
- reduces conflict with upstream OneCLI-based NanoClaw changes
- makes local-model support more natural

## 3. Keep NanoClaw orchestration on the host

The host should continue to own:

- group routing
- container lifecycle
- idle timeout handling
- IPC task files
- output framing and parsing
- per-group mount policy

Pi should only replace the **container-side conversational engine**.

## 4. Expose NanoClaw-specific capabilities as Pi-native tools/extensions

Instead of preserving the old Claude/MCP structure by default, map NanoClaw runtime features into Pi-native tools and extensions where possible.

Candidates:

- send outbound message
- schedule task
- inspect group status
- access task metadata
- optionally bridge existing IPC commands through a compatibility layer during migration

## Target architecture

```text
Host NanoClaw process
  -> spawns isolated container
  -> mounts group/project/ipc/session resources
  -> passes runtime config

Container runtime
  -> Pi SDK session factory
  -> Pi resource loader
  -> Pi tools/extensions for NanoClaw integration
  -> persistent session storage per group

Model/provider layer
  -> Pi provider configuration (.pi/models.json and settings)
  -> optional custom Pi provider extension if needed
```

## Key design decisions to make before implementation

## Decision A: authentication path

Choose one of these explicitly.

### Option A1: OneCLI remains the only credential transport

Use OneCLI to route requests and let Pi talk through that route.

Pros:

- closest to upstream NanoClaw direction
- fewer custom moving parts

Cons:

- only good if OneCLI integrates cleanly with Pi's provider expectations
- may be awkward for local OpenAI-compatible model servers

### Option A2: Pi-native provider config is primary

Use Pi provider/model config directly inside the container.

Pros:

- cleaner Pi integration
- best for local/OpenAI-compatible providers
- simpler model selection story

Cons:

- requires careful secret-handling design
- may diverge from current upstream OneCLI assumptions

**Recommendation:** start with **A2** for the Pi path, while keeping the design open to A1 if OneCLI proves to be a clean fit.

## Decision B: session persistence strategy

Pi sessions must be durable across container restarts.

Required outcome:

- one durable session namespace per NanoClaw group
- host can continue a prior session by ID or by group-local default
- session persistence must not allow cross-group access

Recommended direction:

- store Pi session files in a per-group path under NanoClaw-managed session storage
- use Pi `SessionManager.create(...)`, `continueRecent(...)`, or `open(...)` against that per-group path
- avoid `SessionManager.inMemory()` except in tests

## Decision C: resource loading strategy

Recommended direction:

- use Pi `DefaultResourceLoader`
- set `cwd` to `/workspace/group`
- provide a group-specific `agentDir` inside mounted group-scoped session storage
- explicitly mount and load project `.pi` only when intended
- verify what context files are discovered from:
  - `/workspace/group`
  - `/workspace/project`
  - mounted `.pi`
  - injected AGENTS/context files

Avoid a handcrafted minimal `ResourceLoader` unless there is a proven need.

## Decision D: NanoClaw IPC integration shape

Two realistic approaches:

### Option D1: compatibility bridge first

Keep the existing IPC/MCP-like behavior and wrap it for Pi.

Pros:

- lower initial migration risk
- easier parity testing

Cons:

- preserves legacy abstractions longer

### Option D2: Pi-native tools first

Rebuild NanoClaw container actions as Pi custom tools/extensions.

Pros:

- cleaner long-term architecture
- better alignment with Pi docs

Cons:

- more design work up front

**Recommendation:** use **D1 for the first milestone**, then move toward **D2** after parity is reached.

## Functional parity checklist

The Pi path is not complete until all of these work:

- [x] first-turn prompt execution
- [x] follow-up turns delivered over IPC
- [x] host idle timeout and close sentinel behavior
- [x] scheduled task execution
- [x] scheduled task `script` pre-processing
- [x] per-group session continuity across container restarts
- [x] outbound message/tool actions
- [ ] full group/project/global context isolation review
- [~] transcript parity (basic JSONL transcript archive implemented, Claude-style archive/compaction parity still missing)
- [ ] compaction parity or documented replacement
- [x] Pi container build + startup reliability for the PoC

## Migration progress snapshot

Implemented on `feat/pi-runtime-poc`:

- [x] separate experimental Pi container image and build script
- [x] runtime switch with `AGENT_RUNTIME=pi`
- [x] local/custom provider mode via `PI_BASE_URL`
- [x] built-in `openai-codex` provider mode via mounted Pi auth
- [x] persistent Pi sessions stored per group
- [x] long-lived container loop waiting on NanoClaw IPC input
- [x] scheduled task prompt execution
- [x] scheduled task pre-script execution with `wakeAgent`
- [x] Pi-native NanoClaw tools for messaging and task management
- [x] basic transcript JSONL append in `groups/<name>/conversations/pi-transcript.jsonl`

Still pending:

- [ ] confirm end-to-end host integration in normal NanoClaw message loop
- [ ] verify all task mutation paths end to end (`update_task`, `pause_task`, `resume_task`, `cancel_task`)
- [ ] review context/resource loading strategy against Pi `DefaultResourceLoader`
- [ ] decide final auth architecture vs OneCLI
- [ ] replace or document missing Claude-specific compaction/archive behavior
- [ ] add tests around the Pi runtime path

## Implementation phases

## Phase 0 — freeze and document the exploratory work

Deliverables:

- this plan document
- a list of exploratory files and diffs
- a clean conflict-free baseline branch

Notes:

- do not keep half-migrated runtime files in a deployable state without feature flags
- preserve exploratory local files for reference, but do not rely on them as final design

## Phase 1 — prove the credential/model path

Goal:

Establish a minimal containerized Pi session that can answer a single prompt using the chosen provider strategy.

Tasks:

- decide between OneCLI-backed Pi or Pi-native provider configuration
- define required env vars and mounted config files
- verify a container can create a Pi session and complete a single response
- document how model selection works

Exit criteria:

- one reproducible single-turn container test passes

## Phase 2 — persistent sessions per group

Goal:

Replace in-memory Pi sessions with durable group-scoped sessions.

Tasks:

- define on-disk session directory layout
- wire Pi `SessionManager` to group-local storage
- map NanoClaw `sessionId` to Pi session semantics
- verify resume after container restart

Exit criteria:

- a second container process can continue the same group conversation

## Phase 3 — resource loading and context behavior

Goal:

Make Pi load the right context, skills, and settings in a NanoClaw group container.

Tasks:

- use `DefaultResourceLoader`
- define `cwd` and `agentDir`
- test loading of:
  - group-local context files
  - project-level `.pi`
  - NanoClaw container skills if still needed
- document any deliberate exclusions

Exit criteria:

- Pi sees the expected context and no unintended cross-group context

## Phase 4 — IPC loop integration

Goal:

Restore NanoClaw's multi-turn container lifecycle with Pi.

Tasks:

- keep NanoClaw output framing markers
- adapt Pi events to current host output parsing
- support repeated prompt/wait/prompt cycles
- preserve close sentinel behavior
- verify no duplicate/partial final outputs

Exit criteria:

- host can run a normal multi-turn chat with Pi in a container

## Phase 5 — scheduled tasks and scripts

Goal:

Restore scheduled task semantics.

Tasks:

- preserve task script execution before agent wake-up
- keep `wakeAgent` contract
- inject script output into prompt in a stable format
- test no-op scheduled tasks vs wake-agent tasks

Exit criteria:

- scheduled tasks behave the same as the current runtime from the host's perspective

## Phase 6 — NanoClaw tools integration

Goal:

Expose NanoClaw-specific capabilities to Pi.

Tasks:

- identify all container-side actions currently available through MCP/IPC
- implement a compatibility bridge or Pi custom tools
- add tests for each tool path

Exit criteria:

- container agent can perform NanoClaw-specific actions required for daily use

## Phase 7 — compaction, transcripts, and migration polish

Goal:

Handle the remaining Claude-specific behaviors that do not have a direct Pi equivalent.

Tasks:

- review current transcript archiving logic
- decide whether to:
  - reimplement around Pi session files/events, or
  - adopt Pi-native session/compaction behavior and update expectations
- document differences from Claude-based behavior

Exit criteria:

- long-running sessions are operationally safe and behavior is documented

## Phase 8 — rollout strategy

Goal:

Avoid breaking existing users while introducing Pi support.

Recommended rollout:

1. add a runtime switch, e.g. `AGENT_RUNTIME=claude|pi`
2. keep Claude as the default until Pi reaches parity
3. test Pi on one group or one local installation first
4. only change defaults after parity and docs are complete

## Proposed file-level work map

### Host-side

- `src/container-runner.ts`
  - runtime selection
  - container env/config injection for Pi
  - per-group session/resource mounts

- `src/index.ts`
  - likely minimal changes unless runtime selection must surface here

- `src/ipc.ts`
  - verify compatibility only; avoid broad changes unless Pi requires them

### Container-side

- `container/agent-runner/src/index.ts`
  - split into:
    - NanoClaw wrapper layer
    - Pi session bootstrap
    - event/output adapter

- `container/agent-runner/package.json`
  - Pi dependencies

- `container/Dockerfile`
  - Pi runtime install and config layout

### Config/docs/tests

- project `.pi` config strategy
- provider/model configuration docs
- integration smoke tests
- session persistence tests
- scheduled task tests

## Risks

1. **upstream drift**
   - NanoClaw upstream is evolving quickly around OneCLI and runtime setup

2. **session model mismatch**
   - Pi sessions are not a drop-in replacement for Claude SDK session handling

3. **context loading surprises**
   - incorrect `cwd`/`agentDir` or mounts could silently change behavior

4. **tool parity gaps**
   - a naive Pi migration may lose essential NanoClaw actions

5. **local model quirks**
   - OpenAI-compatible servers often require provider `compat` tuning in Pi

## Acceptance criteria for calling the migration done

A Pi runtime can be considered ready when:

- NanoClaw can run Pi in a container for a real group conversation
- session continuity works across restarts
- scheduled tasks work
- required NanoClaw tools work
- secrets are not exposed directly to containers beyond the chosen acceptable runtime contract
- the implementation can be rebased on upstream without carrying a permanent invasive fork

## Immediate next steps

1. clean up the exploratory branch into a non-broken baseline
2. choose the credential/model path
3. implement a minimal single-turn Pi container proof of concept
4. add persistent sessions
5. restore IPC multi-turn behavior
6. restore scheduled tasks
7. restore NanoClaw-specific tools
8. add runtime flag and rollout plan

## Appendix: exploratory local artifacts worth reviewing

These local artifacts from the initial migration attempt may still be useful as references:

- `MIGRATION_TO_PI.md`
- `.pi/settings.json`
- `container/.pi/agent/models.json`
- `container/.pi/agent/settings.json`
- `test-pi-migration.sh`
- `test-docker-run.sh`

They should be treated as exploration notes, not final implementation.
