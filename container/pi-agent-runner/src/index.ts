import fs from 'fs';
import path from 'path';

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const DEFAULT_PROVIDER = 'nanoclaw';
const DEFAULT_THINKING_LEVEL = 'medium' as const;
const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[pi-agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}

function getThinkingLevel(): ThinkingLevel {
  const value = process.env.PI_THINKING_LEVEL;
  switch (value) {
    case 'off':
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value;
    default:
      return DEFAULT_THINKING_LEVEL;
  }
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      // ignore cleanup failure
    }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const fullPath = path.join(IPC_INPUT_DIR, file);
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as {
          type?: string;
          text?: string;
        };
        if (parsed.type === 'message' && typeof parsed.text === 'string') {
          messages.push(parsed.text);
        }
      } catch (error) {
        log(
          `Failed to parse IPC input ${file}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        try {
          fs.unlinkSync(fullPath);
        } catch {
          // ignore cleanup failure
        }
      }
    }

    return messages;
  } catch (error) {
    log(
      `IPC drain error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

function writePiConfig(): {
  provider: string;
  model: string;
  agentDir: string;
  sessionsDir: string;
  modelsPath?: string;
  thinkingLevel: ThinkingLevel;
  mode: 'custom-base-url' | 'builtin-provider';
} {
  const provider = getOptionalEnv('PI_PROVIDER') || DEFAULT_PROVIDER;
  const baseUrl = getOptionalEnv('PI_BASE_URL');
  const model =
    getOptionalEnv('PI_MODEL') ||
    (provider === 'openai-codex' ? 'gpt-5.2-codex' : undefined);
  if (!model) {
    throw new Error(
      'Missing required environment variable: PI_MODEL (or set PI_PROVIDER=openai-codex to use the default Codex model)',
    );
  }

  const contextWindow = parseInt(process.env.PI_CONTEXT_WINDOW || '64000', 10);
  const maxTokens = parseInt(process.env.PI_MAX_TOKENS || '8192', 10);
  const reasoning = (process.env.PI_REASONING || 'false') === 'true';
  const thinkingLevel = getThinkingLevel();
  const agentDir = '/home/node/.pi/agent';
  const sessionsDir = path.join(agentDir, 'sessions');
  const settingsPath = path.join(agentDir, 'settings.json');

  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  if (baseUrl) {
    const modelsPath = path.join(agentDir, 'models.json');
    const modelsConfig = {
      providers: {
        [provider]: {
          baseUrl,
          api: 'openai-completions',
          apiKey: 'PI_API_KEY',
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
          models: [
            {
              id: model,
              reasoning,
              contextWindow,
              maxTokens,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    };

    const settingsConfig = {
      defaultProvider: provider,
      defaultModel: model,
      defaultThinkingLevel: thinkingLevel,
      lastChangelogVersion: 'phase-1-poc',
      compaction: { enabled: false },
    };

    fs.writeFileSync(modelsPath, JSON.stringify(modelsConfig, null, 2) + '\n');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(settingsConfig, null, 2) + '\n',
    );

    return {
      provider,
      model,
      agentDir,
      sessionsDir,
      modelsPath,
      thinkingLevel,
      mode: 'custom-base-url',
    };
  }

  const settingsConfig = {
    defaultProvider: provider,
    defaultModel: model,
    defaultThinkingLevel: thinkingLevel,
    lastChangelogVersion: 'phase-1-poc',
    compaction: { enabled: false },
  };

  fs.writeFileSync(
    settingsPath,
    JSON.stringify(settingsConfig, null, 2) + '\n',
  );

  return {
    provider,
    model,
    agentDir,
    sessionsDir,
    thinkingLevel,
    mode: 'builtin-provider',
  };
}

function resolveSessionManager(
  sessionId: string | undefined,
  cwd: string,
  sessionsDir: string,
): ReturnType<typeof SessionManager.open> {
  if (sessionId) {
    if (fs.existsSync(sessionId)) {
      log(`Resuming Pi session from ${sessionId}`);
      return SessionManager.open(sessionId, sessionsDir);
    }
    log(`Stored Pi session not found, starting a new session: ${sessionId}`);
  }

  return SessionManager.continueRecent(cwd, sessionsDir);
}

async function main(): Promise<void> {
  try {
    const stdinData = await readStdin();
    const input: ContainerInput = JSON.parse(stdinData);
    const {
      provider,
      model,
      agentDir,
      sessionsDir,
      modelsPath,
      mode,
      thinkingLevel,
    } = writePiConfig();

    if (input.isScheduledTask) {
      log('Scheduled tasks are not yet supported by the Pi runtime');
    }
    if (input.script) {
      log('Task scripts are not yet supported by the Pi runtime');
    }

    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      // ignore stale sentinel cleanup failure
    }

    const authStorage = AuthStorage.create(path.join(agentDir, 'auth.json'));
    if (process.env.PI_API_KEY) {
      authStorage.setRuntimeApiKey(provider, process.env.PI_API_KEY);
    }

    if (mode === 'builtin-provider') {
      log(`Using built-in Pi provider ${provider} with model ${model}`);
    } else {
      log(
        `Using custom Pi provider ${provider} via ${process.env.PI_BASE_URL}`,
      );
    }

    const modelRegistry = modelsPath
      ? new ModelRegistry(authStorage, modelsPath)
      : new ModelRegistry(authStorage);
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: provider,
      defaultModel: model,
      defaultThinkingLevel: thinkingLevel,
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 1 },
    });

    const cwd = '/workspace/group';
    const sessionManager = resolveSessionManager(
      input.sessionId,
      cwd,
      sessionsDir,
    );

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      authStorage,
      modelRegistry,
      settingsManager,
      sessionManager,
    });

    let currentText = '';
    session.subscribe((event) => {
      if (
        event.type === 'message_update' &&
        event.assistantMessageEvent.type === 'text_delta'
      ) {
        currentText += event.assistantMessageEvent.delta;
      }
    });

    let prompt = input.prompt;
    if (input.isScheduledTask) {
      prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
    }

    const pending = drainIpcInput();
    if (pending.length > 0) {
      log(
        `Draining ${pending.length} pending IPC messages into initial prompt`,
      );
      prompt += `\n${pending.join('\n')}`;
    }

    while (true) {
      currentText = '';
      log(
        `Starting Pi prompt (session: ${session.sessionFile || session.sessionId})`,
      );
      await session.prompt(prompt);

      writeOutput({
        status: 'success',
        result: currentText || null,
        newSessionId: session.sessionFile || session.sessionId,
      });

      const closedAfterPrompt = shouldClose();
      if (closedAfterPrompt) {
        log('Close sentinel received after prompt, exiting');
        break;
      }

      writeOutput({
        status: 'success',
        result: null,
        newSessionId: session.sessionFile || session.sessionId,
      });

      const queuedMessages = drainIpcInput();
      if (queuedMessages.length > 0) {
        prompt = queuedMessages.join('\n');
        log(`Processing ${queuedMessages.length} queued IPC messages`);
        continue;
      }

      log('Prompt ended, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received while idle, exiting');
        break;
      }

      log(`Got new IPC message (${nextMessage.length} chars)`);
      prompt = nextMessage;
    }
  } catch (error) {
    writeOutput({
      status: 'error',
      result: null,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

main();
