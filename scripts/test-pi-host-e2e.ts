import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main() {
  process.env.AGENT_RUNTIME = process.env.AGENT_RUNTIME || 'pi';
  process.env.PI_CONTAINER_IMAGE =
    process.env.PI_CONTAINER_IMAGE || 'nanoclaw-agent-pi:latest';

  const provider = process.env.PI_PROVIDER || 'llamabarn';
  process.env.PI_PROVIDER = provider;
  if (!process.env.PI_MODEL) {
    process.env.PI_MODEL =
      provider === 'openai-codex' ? 'gpt-5.2-codex' : 'glm-4.7-flash-q4';
  }
  if (!process.env.PI_BASE_URL && provider !== 'openai-codex') {
    process.env.PI_BASE_URL = 'http://host.docker.internal:2276/v1';
  }
  if (!process.env.PI_API_KEY && provider !== 'openai-codex') {
    process.env.PI_API_KEY = 'no-key';
  }

  const [
    { runContainerAgent },
    { resolveGroupIpcPath, resolveGroupFolderPath },
  ] = await Promise.all([
    import('../src/container-runner.js'),
    import('../src/group-folder.js'),
  ]);

  const unique = `pi-e2e-${Date.now()}`;
  const group = {
    name: 'Pi E2E Test',
    folder: unique,
    trigger: '@Andy',
    added_at: new Date().toISOString(),
  };

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  const ipcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });

  const outputs: Array<string | null> = [];
  let followUpSent = false;
  let closeSent = false;
  let successEventsAfterFollowUp = 0;

  const writeIpcMessage = (text: string) => {
    const inputDir = path.join(ipcDir, 'input');
    const file = path.join(
      inputDir,
      `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`,
    );
    fs.writeFileSync(file, JSON.stringify({ type: 'message', text }));
  };

  const result = await runContainerAgent(
    group,
    {
      prompt: 'Reply with exactly first',
      groupFolder: group.folder,
      chatJid: 'test@g.us',
      isMain: false,
    },
    () => {},
    async (output) => {
      outputs.push(output.result ?? null);
      if (
        !followUpSent &&
        output.status === 'success' &&
        output.result !== null
      ) {
        followUpSent = true;
        writeIpcMessage('Reply with exactly second');
        return;
      }
      if (followUpSent && output.status === 'success') {
        successEventsAfterFollowUp += 1;
        if (!closeSent && successEventsAfterFollowUp >= 2) {
          closeSent = true;
          fs.writeFileSync(path.join(ipcDir, 'input', '_close'), '');
        }
      }
    },
  );

  assert.equal(result.status, 'success');

  const transcriptPath = path.join(
    groupDir,
    'conversations',
    'pi-transcript.jsonl',
  );
  assert.equal(fs.existsSync(transcriptPath), true);
  const transcript = fs.readFileSync(transcriptPath, 'utf8');
  assert.match(transcript, /Reply with exactly first/);
  assert.match(transcript, /Reply with exactly second/);

  const scheduledTaskScript = path.join(
    os.tmpdir(),
    `pi-task-${Date.now()}.sh`,
  );
  fs.writeFileSync(
    scheduledTaskScript,
    '#!/bin/bash\necho \'{"wakeAgent":true,"data":{"answer":"banana"}}\'\n',
    { mode: 0o755 },
  );

  let taskCloseSent = false;
  let taskOutput: string | null = null;
  const taskResult = await runContainerAgent(
    group,
    {
      prompt: 'Reply with the answer field only.',
      groupFolder: group.folder,
      chatJid: 'test@g.us',
      isMain: false,
      isScheduledTask: true,
      script: fs.readFileSync(scheduledTaskScript, 'utf8'),
    },
    () => {},
    async (output) => {
      if (output.result) {
        taskOutput = output.result;
      }
      if (!taskCloseSent && output.status === 'success') {
        taskCloseSent = true;
        fs.writeFileSync(path.join(ipcDir, 'input', '_close'), '');
      }
    },
  );

  assert.equal(taskResult.status, 'success');
  assert.equal(taskOutput, 'banana');
  fs.unlinkSync(scheduledTaskScript);

  console.log('Pi host E2E test passed');
  console.log(
    JSON.stringify(
      {
        outputs,
        finalSessionId: result.newSessionId,
        scheduledTaskSessionId: taskResult.newSessionId,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
