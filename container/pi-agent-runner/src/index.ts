import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { Type } from '@sinclair/typebox';
import { CronExpressionParser } from 'cron-parser';
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';

interface ContainerInput {
  prompt: string;
  images?: Array<{
    type: 'image';
    data: string;
    mimeType: string;
  }>;
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
const DEFAULT_ONECLI_PROVIDER = 'anthropic';
const DEFAULT_THINKING_LEVEL = 'medium' as const;
const IPC_DIR = '/workspace/ipc';
const IPC_INPUT_DIR = path.join(IPC_DIR, 'input');
const IPC_MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const IPC_TASKS_DIR = path.join(IPC_DIR, 'tasks');
const IPC_CURRENT_TASKS_FILE = path.join(IPC_DIR, 'current_tasks.json');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
type PiAuthMode = 'native' | 'onecli';

interface ScriptResult {
  wakeAgent: boolean;
  data?: unknown;
}

const SCRIPT_TIMEOUT_MS = 30_000;
const TRANSCRIPTS_DIR = '/workspace/group/conversations';

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

function getPiAuthMode(): PiAuthMode {
  return process.env.PI_AUTH_MODE === 'onecli' ? 'onecli' : 'native';
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

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filePath = path.join(dir, filename);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
  return filename;
}

function appendTranscriptEntry(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
    const filePath = path.join(TRANSCRIPTS_DIR, 'pi-transcript.jsonl');
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    log(
      `Failed to append transcript entry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseCompactCommand(prompt: string): {
  isCompact: boolean;
  instructions?: string;
} {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith('/compact')) {
    return { isCompact: false };
  }
  const instructions = trimmed.slice('/compact'.length).trim();
  return {
    isCompact: true,
    instructions: instructions || undefined,
  };
}

function getOneCliDummyApiKeyEnv(
  provider: string,
): { envName: string; value: string } | undefined {
  switch (provider) {
    case 'anthropic':
      return { envName: 'ANTHROPIC_API_KEY', value: 'onecli-proxy' };
    case 'openai':
      return { envName: 'OPENAI_API_KEY', value: 'onecli-proxy' };
    case 'google':
      return { envName: 'GEMINI_API_KEY', value: 'onecli-proxy' };
    case 'mistral':
      return { envName: 'MISTRAL_API_KEY', value: 'onecli-proxy' };
    case 'groq':
      return { envName: 'GROQ_API_KEY', value: 'onecli-proxy' };
    case 'cerebras':
      return { envName: 'CEREBRAS_API_KEY', value: 'onecli-proxy' };
    case 'xai':
      return { envName: 'XAI_API_KEY', value: 'onecli-proxy' };
    case 'openrouter':
      return { envName: 'OPENROUTER_API_KEY', value: 'onecli-proxy' };
    default:
      return undefined;
  }
}

function createNanoclawTools(input: ContainerInput): ToolDefinition[] {
  const sendMessageTool: ToolDefinition = {
    name: 'send_message',
    label: 'Send Message',
    description:
      'Send a message to the user or group immediately while you are still running.',
    parameters: Type.Object({
      text: Type.String({ description: 'The message text to send' }),
      sender: Type.Optional(
        Type.String({
          description:
            'Optional sender or role identity to attach to the message',
        }),
      ),
    }),
    execute: async (_toolCallId, params: any) => {
      writeIpcFile(IPC_MESSAGES_DIR, {
        type: 'message',
        chatJid: input.chatJid,
        text: params.text,
        sender: params.sender || undefined,
        groupFolder: input.groupFolder,
        timestamp: new Date().toISOString(),
      });
      return {
        content: [{ type: 'text', text: 'Message sent.' }],
        details: {},
      };
    },
  };

  const scheduleTaskTool: ToolDefinition = {
    name: 'schedule_task',
    label: 'Schedule Task',
    description:
      'Schedule a recurring or one-time task to run later as a NanoClaw task.',
    parameters: Type.Object({
      prompt: Type.String({
        description: 'Instructions for the scheduled task',
      }),
      schedule_type: Type.Union([
        Type.Literal('cron'),
        Type.Literal('interval'),
        Type.Literal('once'),
      ]),
      schedule_value: Type.String({
        description:
          'cron expression, interval milliseconds, or local timestamp',
      }),
      context_mode: Type.Optional(
        Type.Union([Type.Literal('group'), Type.Literal('isolated')]),
      ),
      target_group_jid: Type.Optional(
        Type.String({ description: 'Target group JID (main group only)' }),
      ),
      script: Type.Optional(
        Type.String({
          description:
            'Optional bash script. Last stdout line must be JSON with wakeAgent boolean.',
        }),
      ),
    }),
    execute: async (_toolCallId, params: any) => {
      if (params.schedule_type === 'cron') {
        try {
          CronExpressionParser.parse(params.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid cron: "${params.schedule_value}".`,
              },
            ],
            isError: true,
            details: {},
          };
        }
      } else if (params.schedule_type === 'interval') {
        const ms = parseInt(params.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid interval: "${params.schedule_value}".`,
              },
            ],
            isError: true,
            details: {},
          };
        }
      } else {
        const date = new Date(params.schedule_value);
        if (isNaN(date.getTime())) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid timestamp: "${params.schedule_value}".`,
              },
            ],
            isError: true,
            details: {},
          };
        }
      }

      const targetJid =
        input.isMain && params.target_group_jid
          ? params.target_group_jid
          : input.chatJid;
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      writeIpcFile(IPC_TASKS_DIR, {
        type: 'schedule_task',
        taskId,
        prompt: params.prompt,
        script: params.script || undefined,
        schedule_type: params.schedule_type,
        schedule_value: params.schedule_value,
        context_mode: params.context_mode || 'group',
        targetJid,
        createdBy: input.groupFolder,
        timestamp: new Date().toISOString(),
      });
      return {
        content: [
          {
            type: 'text',
            text: `Task ${taskId} scheduled: ${params.schedule_type} - ${params.schedule_value}`,
          },
        ],
        details: {},
      };
    },
  };

  const listTasksTool: ToolDefinition = {
    name: 'list_tasks',
    label: 'List Tasks',
    description: 'List all scheduled tasks visible to this group.',
    parameters: Type.Object({}),
    execute: async () => {
      try {
        if (!fs.existsSync(IPC_CURRENT_TASKS_FILE)) {
          return {
            content: [{ type: 'text', text: 'No scheduled tasks found.' }],
            details: {},
          };
        }
        const tasks = JSON.parse(
          fs.readFileSync(IPC_CURRENT_TASKS_FILE, 'utf8'),
        ) as Array<Record<string, unknown>>;
        if (tasks.length === 0) {
          return {
            content: [{ type: 'text', text: 'No scheduled tasks found.' }],
            details: {},
          };
        }
        const formatted = tasks
          .map(
            (t) =>
              `- [${String(t.id)}] ${String(t.prompt).slice(0, 50)}... (${String(t.schedule_type)}: ${String(t.schedule_value)}) - ${String(t.status)}, next: ${String(t.next_run || 'N/A')}`,
          )
          .join('\n');
        return {
          content: [{ type: 'text', text: `Scheduled tasks:\n${formatted}` }],
          details: {},
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error reading tasks: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
          details: {},
        };
      }
    },
  };

  const taskMutationTool = (
    name: 'pause_task' | 'resume_task' | 'cancel_task',
    description: string,
  ): ToolDefinition => ({
    name,
    label: name.replace('_', ' '),
    description,
    parameters: Type.Object({
      task_id: Type.String({ description: 'The task ID' }),
    }),
    execute: async (_toolCallId, params: any) => {
      writeIpcFile(IPC_TASKS_DIR, {
        type: name,
        taskId: params.task_id,
        groupFolder: input.groupFolder,
        isMain: input.isMain,
        timestamp: new Date().toISOString(),
      });
      return {
        content: [
          { type: 'text', text: `Task ${params.task_id} ${name} requested.` },
        ],
        details: {},
      };
    },
  });

  const updateTaskTool: ToolDefinition = {
    name: 'update_task',
    label: 'Update Task',
    description:
      'Update an existing scheduled task. Only provided fields are changed.',
    parameters: Type.Object({
      task_id: Type.String({ description: 'The task ID to update' }),
      prompt: Type.Optional(Type.String({ description: 'New prompt' })),
      schedule_type: Type.Optional(
        Type.Union([
          Type.Literal('cron'),
          Type.Literal('interval'),
          Type.Literal('once'),
        ]),
      ),
      schedule_value: Type.Optional(
        Type.String({ description: 'New schedule value' }),
      ),
      script: Type.Optional(
        Type.String({ description: 'New script, or empty string to clear it' }),
      ),
    }),
    execute: async (_toolCallId, params: any) => {
      if (
        params.schedule_type === 'cron' ||
        (!params.schedule_type && params.schedule_value)
      ) {
        if (params.schedule_value) {
          try {
            CronExpressionParser.parse(params.schedule_value);
          } catch {
            return {
              content: [
                {
                  type: 'text',
                  text: `Invalid cron: "${params.schedule_value}".`,
                },
              ],
              isError: true,
              details: {},
            };
          }
        }
      }
      if (params.schedule_type === 'interval' && params.schedule_value) {
        const ms = parseInt(params.schedule_value, 10);
        if (isNaN(ms) || ms <= 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid interval: "${params.schedule_value}".`,
              },
            ],
            isError: true,
            details: {},
          };
        }
      }

      const data: Record<string, string | boolean | undefined> = {
        type: 'update_task',
        taskId: params.task_id,
        groupFolder: input.groupFolder,
        isMain: input.isMain,
        timestamp: new Date().toISOString(),
      };
      if (params.prompt !== undefined) data.prompt = params.prompt;
      if (params.script !== undefined) data.script = params.script;
      if (params.schedule_type !== undefined)
        data.schedule_type = params.schedule_type;
      if (params.schedule_value !== undefined)
        data.schedule_value = params.schedule_value;

      writeIpcFile(IPC_TASKS_DIR, data);
      return {
        content: [
          { type: 'text', text: `Task ${params.task_id} update requested.` },
        ],
        details: {},
      };
    },
  };

  const registerGroupTool: ToolDefinition = {
    name: 'register_group',
    label: 'Register Group',
    description:
      'Register a new chat/group so the agent can respond there. Main group only.',
    parameters: Type.Object({
      jid: Type.String({ description: 'The target chat JID' }),
      name: Type.String({ description: 'Display name for the group' }),
      folder: Type.String({ description: 'Channel-prefixed folder name' }),
      trigger: Type.String({ description: 'Trigger word like @Andy' }),
    }),
    execute: async (_toolCallId, params: any) => {
      if (!input.isMain) {
        return {
          content: [
            {
              type: 'text',
              text: 'Only the main group can register new groups.',
            },
          ],
          isError: true,
          details: {},
        };
      }
      writeIpcFile(IPC_TASKS_DIR, {
        type: 'register_group',
        jid: params.jid,
        name: params.name,
        folder: params.folder,
        trigger: params.trigger,
        timestamp: new Date().toISOString(),
      });
      return {
        content: [{ type: 'text', text: `Group "${params.name}" registered.` }],
        details: {},
      };
    },
  };

  return [
    sendMessageTool,
    scheduleTaskTool,
    listTasksTool,
    taskMutationTool('pause_task', 'Pause a scheduled task.'),
    taskMutationTool('resume_task', 'Resume a paused task.'),
    taskMutationTool('cancel_task', 'Cancel a scheduled task.'),
    updateTaskTool,
    registerGroupTool,
  ];
}

async function runScript(script: string): Promise<ScriptResult | null> {
  const scriptPath = '/tmp/task-script.sh';
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  return new Promise((resolve) => {
    execFile(
      'bash',
      [scriptPath],
      {
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: process.env,
      },
      (error, stdout, stderr) => {
        if (stderr) {
          log(`Script stderr: ${stderr.slice(0, 500)}`);
        }

        if (error) {
          log(`Script error: ${error.message}`);
          return resolve(null);
        }

        const lines = stdout.trim().split('\n');
        const lastLine = lines[lines.length - 1];
        if (!lastLine) {
          log('Script produced no output');
          return resolve(null);
        }

        try {
          const result = JSON.parse(lastLine) as ScriptResult;
          if (typeof result.wakeAgent !== 'boolean') {
            log(
              `Script output missing wakeAgent boolean: ${lastLine.slice(0, 200)}`,
            );
            return resolve(null);
          }
          resolve(result);
        } catch {
          log(`Script output is not valid JSON: ${lastLine.slice(0, 200)}`);
          resolve(null);
        }
      },
    );
  });
}

function writePiConfig(): {
  authMode: PiAuthMode;
  provider: string;
  model: string;
  agentDir: string;
  sessionsDir: string;
  modelsPath?: string;
  thinkingLevel: ThinkingLevel;
  mode: 'custom-base-url' | 'builtin-provider' | 'onecli-builtin-provider';
  dummyApiKeyEnv?: { envName: string; value: string };
} {
  const authMode = getPiAuthMode();
  const provider =
    getOptionalEnv('PI_PROVIDER') ||
    (authMode === 'onecli' ? DEFAULT_ONECLI_PROVIDER : DEFAULT_PROVIDER);
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

  if (authMode === 'onecli') {
    if (baseUrl) {
      throw new Error(
        'PI_AUTH_MODE=onecli does not support PI_BASE_URL; use PI_AUTH_MODE=native for custom endpoints',
      );
    }

    if (provider === 'openai-codex') {
      throw new Error(
        'PI_AUTH_MODE=onecli does not currently support PI_PROVIDER=openai-codex; use an API-key provider like anthropic/openai or switch to PI_AUTH_MODE=native',
      );
    }

    const dummyApiKeyEnv = getOneCliDummyApiKeyEnv(provider);
    if (!dummyApiKeyEnv) {
      throw new Error(
        `PI_AUTH_MODE=onecli does not support provider ${provider}; use a supported API-key provider or switch to PI_AUTH_MODE=native`,
      );
    }

    process.env[dummyApiKeyEnv.envName] = dummyApiKeyEnv.value;

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
      authMode,
      provider,
      model,
      agentDir,
      sessionsDir,
      thinkingLevel,
      mode: 'onecli-builtin-provider',
      dummyApiKeyEnv,
    };
  }

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
      authMode,
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
    authMode,
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
      authMode,
      provider,
      model,
      agentDir,
      sessionsDir,
      modelsPath,
      mode,
      thinkingLevel,
      dummyApiKeyEnv,
    } = writePiConfig();

    log(`Pi auth mode: ${authMode}`);

    if (input.isScheduledTask) {
      log('Running in scheduled task mode');
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
    if (dummyApiKeyEnv) {
      authStorage.setRuntimeApiKey(provider, dummyApiKeyEnv.value);
    }

    if (mode === 'onecli-builtin-provider') {
      log(
        `Using OneCLI-backed Pi provider ${provider} with model ${model} (dummy credential via ${dummyApiKeyEnv?.envName})`,
      );
    } else if (mode === 'builtin-provider') {
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
      customTools: createNanoclawTools(input),
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

    if (input.script && input.isScheduledTask) {
      log('Running task script...');
      const scriptResult = await runScript(input.script);

      if (!scriptResult || !scriptResult.wakeAgent) {
        const reason = scriptResult
          ? 'wakeAgent=false'
          : 'script error/no output';
        log(`Script decided not to wake agent: ${reason}`);
        writeOutput({
          status: 'success',
          result: null,
          newSessionId: session.sessionFile || session.sessionId,
        });
        return;
      }

      log('Script wakeAgent=true, enriching prompt with data');
      prompt = `[SCHEDULED TASK]\n\nScript output:\n${JSON.stringify(scriptResult.data, null, 2)}\n\nInstructions:\n${input.prompt}`;
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

      const compactCommand = parseCompactCommand(prompt);
      let resultText: string | null = null;
      if (compactCommand.isCompact) {
        const compaction = await session.compact(compactCommand.instructions);
        resultText = `Context compacted. Summary:\n\n${compaction.summary}`;
        currentText = resultText;
      } else {
        await session.prompt(
          prompt,
          input.images ? { images: input.images } : undefined,
        );
        resultText = currentText || null;
      }

      appendTranscriptEntry({
        timestamp: new Date().toISOString(),
        sessionId: session.sessionFile || session.sessionId,
        role: 'user',
        content: prompt,
        isScheduledTask: Boolean(input.isScheduledTask),
      });
      appendTranscriptEntry({
        timestamp: new Date().toISOString(),
        sessionId: session.sessionFile || session.sessionId,
        role: 'assistant',
        content: resultText,
      });

      writeOutput({
        status: 'success',
        result: resultText,
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
