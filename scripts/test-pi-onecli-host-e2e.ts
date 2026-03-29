import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OneCLI } from '@onecli-sh/sdk';

async function main() {
  process.env.AGENT_RUNTIME = 'pi';
  process.env.PI_AUTH_MODE = 'onecli';
  process.env.PI_CONTAINER_IMAGE =
    process.env.PI_CONTAINER_IMAGE || 'nanoclaw-agent-pi:latest';
  process.env.PI_PROVIDER = process.env.PI_PROVIDER || 'anthropic';
  process.env.PI_MODEL = process.env.PI_MODEL || 'claude-sonnet-4-20250514';

  const onecli = new OneCLI();
  const config = await onecli.getContainerConfig();
  assert.ok(Object.keys(config.env).length > 0, 'OneCLI returned no env vars');

  const [
    { runContainerAgent },
    { cleanupOrphans },
    { resolveGroupIpcPath, resolveGroupFolderPath },
  ] = await Promise.all([
    import('../src/container-runner.js'),
    import('../src/container-runtime.js'),
    import('../src/group-folder.js'),
  ]);

  cleanupOrphans();

  const unique = `pi-onecli-e2e-${Date.now()}`;
  const group = {
    name: 'Pi OneCLI E2E Test',
    folder: unique,
    trigger: '@Andy',
    added_at: new Date().toISOString(),
  };

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  const ipcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });

  const outputs: Array<string | null> = [];
  let closeSent = false;
  let scheduledTaskScript: string | null = null;

  try {
    const result = await runContainerAgent(
      group,
      {
        prompt: 'Reply with exactly: onecli-ok',
        groupFolder: group.folder,
        chatJid: 'test@g.us',
        isMain: false,
      },
      () => {},
      async (output) => {
        outputs.push(output.result ?? null);
        if (!closeSent && output.status === 'success') {
          closeSent = true;
          fs.writeFileSync(path.join(ipcDir, 'input', '_close'), '');
        }
      },
    );

    assert.equal(result.status, 'success');
    assert.ok(result.result);

    const transcriptPath = path.join(
      groupDir,
      'conversations',
      'pi-transcript.jsonl',
    );
    assert.equal(fs.existsSync(transcriptPath), true);

    scheduledTaskScript = path.join(
      os.tmpdir(),
      `pi-onecli-task-${Date.now()}.sh`,
    );
    fs.writeFileSync(
      scheduledTaskScript,
      '#!/bin/bash\necho \'{"wakeAgent":false}\'\n',
      { mode: 0o755 },
    );

    let taskCloseSent = false;
    const taskResult = await runContainerAgent(
      group,
      {
        prompt: 'This should not be executed',
        groupFolder: group.folder,
        chatJid: 'test@g.us',
        isMain: false,
        isScheduledTask: true,
        script: fs.readFileSync(scheduledTaskScript, 'utf8'),
      },
      () => {},
      async () => {
        if (!taskCloseSent) {
          taskCloseSent = true;
          fs.writeFileSync(path.join(ipcDir, 'input', '_close'), '');
        }
      },
    );

    assert.equal(taskResult.status, 'success');
    assert.equal(taskResult.result, null);

    console.log('Pi OneCLI host E2E test passed');
    console.log(
      JSON.stringify(
        {
          envKeys: Object.keys(config.env).sort(),
          outputs,
          finalSessionId: result.newSessionId,
          scheduledTaskSessionId: taskResult.newSessionId,
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      fs.writeFileSync(path.join(ipcDir, 'input', '_close'), '');
    } catch {}
    if (scheduledTaskScript && fs.existsSync(scheduledTaskScript)) {
      fs.unlinkSync(scheduledTaskScript);
    }
    cleanupOrphans();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
