# Pi runtime proof of concept

This is a **Phase 1 proof of concept** for running NanoClaw with the Pi coding agent in containers.

## Status

Implemented:

- runtime switch via `AGENT_RUNTIME=pi`
- separate Pi container image selection via `PI_CONTAINER_IMAGE`
- env-driven Pi model/provider bootstrap for OpenAI-compatible endpoints
- durable Pi session resume across container restarts using Pi session files
- long-lived Pi container loop with NanoClaw IPC input polling between prompts
- Pi-native NanoClaw tools: `send_message`, `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `update_task`, `register_group`
- basic transcript JSONL archive at `groups/<name>/conversations/pi-transcript.jsonl`

Not implemented yet:

- full NanoClaw-specific tool parity beyond the current task/message/group tool set
- Claude-style transcript/archive parity beyond the basic JSONL log

## Phase 2 / 4 validation

Validated directly against the Pi container runtime:

- first run creates a Pi session file
- second run with the returned `sessionId` reopens that session
- memory persisted across restarts in local-provider mode
- runner now stays alive after a prompt and waits for new IPC input files
- queued IPC messages are processed as subsequent prompts in the same live container session
- scheduled task mode now works, including pre-agent task scripts with `{ "wakeAgent": boolean, "data"?: any }` output
- custom Pi tools can now write NanoClaw IPC files for outbound messages, task management, and group registration
- each completed Pi prompt now appends user/assistant entries to `pi-transcript.jsonl`
- manual `/compact` prompts are intercepted and forwarded to Pi session compaction

## Runtime modes

The current PoC supports two Pi connection modes.

### 1. Local/custom OpenAI-compatible provider

Use this for llamabarn or another local OpenAI-compatible endpoint:

```bash
AGENT_RUNTIME=pi
PI_CONTAINER_IMAGE=nanoclaw-agent-pi:latest
PI_BASE_URL=http://host.docker.internal:2276/v1
PI_PROVIDER=llamabarn
PI_MODEL=my-model-id
PI_API_KEY=some-key
```

### 2. Built-in Pi provider: OpenAI Codex

Use this for a host Pi login with ChatGPT Plus/Pro credentials stored in `~/.pi/agent/auth.json`:

```bash
AGENT_RUNTIME=pi
PI_CONTAINER_IMAGE=nanoclaw-agent-pi:latest
PI_PROVIDER=openai-codex
PI_MODEL=gpt-5.2-codex
```

If `PI_MODEL` is omitted in Codex mode, the PoC defaults to `gpt-5.2-codex`.

Optional for either mode:

```bash
PI_CONTEXT_WINDOW=64000
PI_MAX_TOKENS=8192
PI_THINKING_LEVEL=medium
PI_REASONING=false
```

## Build the Pi image

```bash
./container/build-pi.sh
```

## End-to-end host/runtime smoke test

This exercises the real NanoClaw host-side `runContainerAgent()` path against the Pi container runtime:

```bash
npx tsx scripts/test-pi-host-e2e.ts
```

Default behavior uses the local `llamabarn` path. Override `PI_PROVIDER`, `PI_MODEL`, and related env vars if needed.

## Notes

- In local/custom mode, `PI_BASE_URL` should point to the API root ending in `/v1`.
- In Codex mode, NanoClaw mounts the host `~/.pi/agent/auth.json` into the Pi container read-only so the container can use the host's Pi login.
- The host runtime still uses NanoClaw's existing orchestration. Only the container-side agent engine is swapped.
- The Pi runtime now stores per-group session files under the mounted Pi agent directory and returns the session file path as NanoClaw's `sessionId` token.
- On the next container start, NanoClaw passes that path back into the Pi runner, which reopens the same Pi session file.
