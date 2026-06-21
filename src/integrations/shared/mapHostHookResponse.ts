import type { HarnessHookResponse, HarnessHookSource } from '../../harness';

export interface HostHookOutput {
  continue?: boolean;
  source?: HarnessHookSource;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
  };
}

const MISSING_CONTEXT_HINT =
  'dotcontext: no .context/ — run npx @dotcontext/mcp install and initialize context.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractResultData(response: Extract<HarnessHookResponse, { ok: true }>): unknown {
  if (response.result.kind === 'json') {
    return response.result.data;
  }
  return response.result;
}

function formatContextAdditionalContext(data: unknown): string {
  if (!isRecord(data) || !data.initialized) {
    return MISSING_CONTEXT_HINT;
  }

  const enabled: string[] = [];
  for (const key of ['docs', 'agents', 'skills', 'plans', 'workflow', 'harness'] as const) {
    if (data[key]) {
      enabled.push(key);
    }
  }

  if (enabled.length === 0) {
    return 'dotcontext: .context/ present. Run context init to populate scaffolding.';
  }

  return `dotcontext: scaffold ready (${enabled.join(', ')}). Use MCP context tools for navigation and workflow.`;
}

function formatWorkflowStatusAdditionalContext(data: unknown): string {
  if (!isRecord(data)) {
    return 'dotcontext: workflow status unavailable.';
  }

  if (data.active === false) {
    return 'dotcontext: no active PREVC workflow. Run workflow-init when starting planned work.';
  }

  const currentPhase = typeof data.currentPhase === 'string' ? data.currentPhase : undefined;
  const name = typeof data.name === 'string' ? data.name : undefined;

  if (currentPhase && name) {
    return `dotcontext: workflow "${name}" — phase ${currentPhase}.`;
  }

  if (currentPhase) {
    return `dotcontext: workflow phase ${currentPhase}.`;
  }

  return 'dotcontext: workflow active. Use workflow-status for details.';
}

function mapSuccessResponse(
  hostEventName: string,
  response: Extract<HarnessHookResponse, { ok: true }>
): HostHookOutput {
  const data = extractResultData(response);

  if (hostEventName === 'SessionStart' && response.tool === 'context') {
    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: formatContextAdditionalContext(data),
      },
    };
  }

  if (hostEventName === 'Stop' && response.tool === 'workflow-status') {
    return {
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: formatWorkflowStatusAdditionalContext(data),
      },
    };
  }

  return { continue: true };
}

/**
 * Map HarnessHookResponse to Claude/Codex stdout JSON control fields.
 */
export function mapHostHookResponse(
  hostEventName: string,
  response: HarnessHookResponse,
  options?: { source?: HarnessHookSource }
): HostHookOutput {
  const output: HostHookOutput = options?.source ? { source: options.source } : {};

  if (!response.ok) {
    return { ...output, continue: true };
  }

  return {
    ...output,
    ...mapSuccessResponse(hostEventName, response),
  };
}
