---
name: add-telegram-image-support
description: Add Telegram image support. Lets Telegram chats send photos to the agent and receive outbound images back. Requires Telegram channel support to already be installed.
---

# Add Telegram Image Support

This skill adds Telegram-specific image handling on top of the core image plumbing already present in this fork.

It enables:
- inbound Telegram photo attachments to be stored as image attachments
- downloading Telegram photos for multimodal agent input
- outbound Telegram image sending via `sendPhoto`

## Phase 1: Pre-flight

### Check prerequisites

Confirm Telegram support is already installed:

```bash
test -f src/channels/telegram.ts
```

If that file is missing, stop and install Telegram first with `/add-telegram`.

### Check if already applied

If `src/channels/telegram.ts` already contains both `downloadAttachment(` and `sendImage(`, the code changes are likely already present. In that case skip to Phase 3 (Verify / Restart if needed).

## Phase 2: Apply Code Changes

### Fetch the skill branch

This fork ships the code on the `skill/telegram-image-support` branch. Fetch it from `origin`:

```bash
git fetch origin skill/telegram-image-support
```

### Merge the skill branch

```bash
git merge origin/skill/telegram-image-support
```

If the merge reports conflicts, resolve them by reading the conflicted files and preserving both the existing Telegram behavior and the image-specific additions.

### Validate code changes

```bash
npm run build
npx vitest run src/channels/telegram.test.ts src/bridge/images/inbound.test.ts src/db.test.ts src/ipc-auth.test.ts
```

All tests must pass and the build must be clean before proceeding.

## Phase 3: Restart

Restart NanoClaw so the updated Telegram channel code is loaded.

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test inbound image understanding

Tell the user:

> Send a photo to a registered Telegram chat.
>
> Then ask the assistant something about the photo, for example:
> `@Andy what is in this image?`
>
> The agent should respond using the uploaded photo as multimodal input.

### Test outbound image sending

Tell the user:

> Ask the assistant to send an image back to the Telegram chat.
>
> If you're using the Pi runtime path with image-capable tools enabled, the bot should send the image as a Telegram photo.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Telegram photo is stored as plain text only

Check that the branch actually merged:

```bash
rg -n "message:photo|downloadAttachment|sendImage" src/channels/telegram.ts
```

### Agent does not appear to see the image

Check that core image support is present:

```bash
test -f src/bridge/images/inbound.ts
```

If it is missing, this fork's `main` is too old. Update from the fork's `main` branch first.

### Outbound image sending does not work

Check whether the active runtime/tooling is actually producing image output. The Telegram skill only adds Telegram channel support for sending images; it does not itself force the model to generate or fetch images.
