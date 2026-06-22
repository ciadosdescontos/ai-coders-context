import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';

import { runHookDispatch } from '../hookDispatchService';
import {
  getHookHarnessSessionId,
  saveHookHarnessSession,
} from '../../../integrations/shared/hookSessionStore';
import { WorkflowService } from '../../../harness';

describe('HookDispatchService session lifecycle', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dotcontext-hook-dispatch-'));
    await fs.ensureDir(path.join(tempDir, '.context', 'runtime', 'sessions'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('binds host session on SessionStart and appends trace on PostToolUse', async () => {
    const sessionId = 'host-session-abc';

    const startStdin = PassThrough.from([
      JSON.stringify({
        session_id: sessionId,
        cwd: tempDir,
        hook_event_name: 'SessionStart',
      }),
    ]);
    const startStdout = new PassThrough();
    startStdout.on('data', () => {});

    const startResult = await runHookDispatch({
      source: 'claude-code',
      repoPath: tempDir,
      stdin: startStdin,
      stdout: startStdout,
    });

    expect(startResult.exitCode).toBe(0);

    const harnessSessionId = await getHookHarnessSessionId({
      repoPath: tempDir,
      source: 'claude-code',
      hostSessionId: sessionId,
    });
    expect(harnessSessionId).toBeDefined();

    const postStdin = PassThrough.from([
      JSON.stringify({
        session_id: sessionId,
        cwd: tempDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: 'README.md' },
      }),
    ]);
    const postStdout = new PassThrough();
    postStdout.on('data', () => {});

    const postResult = await runHookDispatch({
      source: 'claude-code',
      repoPath: tempDir,
      stdin: postStdin,
      stdout: postStdout,
    });

    expect(postResult.exitCode).toBe(0);
    expect(postResult.output).toEqual({ continue: true });

    const tracePath = path.join(
      tempDir,
      '.context',
      'runtime',
      'sessions',
      harnessSessionId!,
      'trace.jsonl'
    );
    expect(await fs.pathExists(tracePath)).toBe(true);
    const traceContent = await fs.readFile(tracePath, 'utf8');
    expect(traceContent).toContain('tool.use');
  });

  it('runs context check before binding SessionStart sessions in uninitialized repos', async () => {
    await fs.remove(path.join(tempDir, '.context'));

    const sessionId = 'host-session-uninitialized';
    const startStdin = PassThrough.from([
      JSON.stringify({
        session_id: sessionId,
        cwd: tempDir,
        hook_event_name: 'SessionStart',
      }),
    ]);
    const startStdout = new PassThrough();
    startStdout.on('data', () => {});

    const startResult = await runHookDispatch({
      source: 'claude-code',
      repoPath: tempDir,
      stdin: startStdin,
      stdout: startStdout,
    });

    expect(startResult.exitCode).toBe(0);
    await expect(getHookHarnessSessionId({
      repoPath: tempDir,
      source: 'claude-code',
      hostSessionId: sessionId,
    })).resolves.toBeUndefined();
    expect(await fs.pathExists(path.join(tempDir, '.context', 'runtime'))).toBe(false);
  });

  it('recreates stale PostToolUse session bindings and keeps hooks non-blocking', async () => {
    const sessionId = 'host-session-stale';
    await saveHookHarnessSession({
      harnessSessionId: 'missing-harness-session',
      hostSessionId: sessionId,
      source: 'claude-code',
      repoPath: tempDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const postStdin = PassThrough.from([
      JSON.stringify({
        session_id: sessionId,
        cwd: tempDir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: 'README.md' },
      }),
    ]);
    const postStdout = new PassThrough();
    postStdout.on('data', () => {});

    const postResult = await runHookDispatch({
      source: 'claude-code',
      repoPath: tempDir,
      stdin: postStdin,
      stdout: postStdout,
    });

    expect(postResult.exitCode).toBe(0);
    expect(postResult.output).toEqual({ continue: true });

    const recreatedSessionId = await getHookHarnessSessionId({
      repoPath: tempDir,
      source: 'claude-code',
      hostSessionId: sessionId,
    });
    expect(recreatedSessionId).toBeDefined();
    expect(recreatedSessionId).not.toBe('missing-harness-session');

    const tracePath = path.join(
      tempDir,
      '.context',
      'runtime',
      'sessions',
      recreatedSessionId!,
      'trace.jsonl'
    );
    const traceContent = await fs.readFile(tracePath, 'utf8');
    expect(traceContent).toContain('tool.use');
  });

  it('maps accepted hook event aliases to canonical response event names', async () => {
    const startStdin = PassThrough.from([
      JSON.stringify({
        session_id: 'host-session-alias',
        cwd: tempDir,
        hook_event_name: 'session_start',
      }),
    ]);
    const startStdout = new PassThrough();
    startStdout.on('data', () => {});

    const startResult = await runHookDispatch({
      source: 'codex',
      repoPath: tempDir,
      stdin: startStdin,
      stdout: startStdout,
    });

    expect(startResult.exitCode).toBe(0);
    expect(startResult.output).toMatchObject({
      source: 'codex',
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
      },
    });
  });

  it('keeps Stop hooks silent when no PREVC workflow is active', async () => {
    const stopStdin = PassThrough.from([
      JSON.stringify({
        session_id: 'host-session-no-workflow',
        cwd: tempDir,
        hook_event_name: 'Stop',
      }),
    ]);
    const stopStdout = new PassThrough();
    stopStdout.on('data', () => {});

    const stopResult = await runHookDispatch({
      source: 'claude-code',
      repoPath: tempDir,
      stdin: stopStdin,
      stdout: stopStdout,
    });

    expect(stopResult.exitCode).toBe(0);
    expect(stopResult.output).toEqual({ continue: true });
  });

  it('keeps Stop hooks silent when workflow state is malformed', async () => {
    const workflowPath = path.join(tempDir, '.context', 'runtime', 'workflows', 'prevc.json');
    await fs.ensureDir(path.dirname(workflowPath));
    await fs.writeFile(workflowPath, '{malformed', 'utf8');

    const stopStdin = PassThrough.from([
      JSON.stringify({
        session_id: 'host-session-malformed-workflow',
        cwd: tempDir,
        hook_event_name: 'Stop',
      }),
    ]);
    const stopStdout = new PassThrough();
    stopStdout.on('data', () => {});

    const stopResult = await runHookDispatch({
      source: 'claude-code',
      repoPath: tempDir,
      stdin: stopStdin,
      stdout: stopStdout,
    });

    expect(stopResult.exitCode).toBe(0);
    expect(stopResult.output).toEqual({ continue: true });
  });

  it('emits Stop workflow guidance when a PREVC workflow is active', async () => {
    const workflowService = await WorkflowService.create(tempDir);
    await workflowService.init({
      name: 'feature-x',
      scale: 'SMALL',
    });

    const stopStdin = PassThrough.from([
      JSON.stringify({
        session_id: 'host-session-active-workflow',
        cwd: tempDir,
        hook_event_name: 'Stop',
      }),
    ]);
    const stopStdout = new PassThrough();
    stopStdout.on('data', () => {});

    const stopResult = await runHookDispatch({
      source: 'codex',
      repoPath: tempDir,
      stdin: stopStdin,
      stdout: stopStdout,
    });

    expect(stopResult.exitCode).toBe(0);
    expect(stopResult.output).toMatchObject({
      source: 'codex',
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: expect.stringContaining('feature-x'),
      },
    });
  });
});
