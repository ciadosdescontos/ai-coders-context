import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

import {
  buildCodexHooksDocument,
  buildCodexTomlHookBlocks,
  CODEX_HOOK_TEMPLATES,
  CODEX_HOOK_TRUST_REMINDER,
  isDotcontextCodexHookCommand,
  isCurrentCodexHookCommand,
  type CodexHookMatcherEntry,
  type CodexHookTemplate,
} from '../hooks/codexHookTemplates';

export type CodexHookInstallFormat = 'json' | 'toml';

export interface CodexHookInstallOptions {
  global?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  repoPath?: string;
  format?: CodexHookInstallFormat;
}

export interface CodexHookInstallResult {
  configPath: string;
  action: 'created' | 'updated' | 'skipped';
  dryRun: boolean;
  format: CodexHookInstallFormat;
  trustReminder: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveJsonConfigPath(options: CodexHookInstallOptions): string {
  if (options.global === true) {
    return path.join(os.homedir(), '.codex', 'hooks.json');
  }

  const repoPath = path.resolve(options.repoPath ?? process.cwd());
  return path.join(repoPath, '.codex', 'hooks.json');
}

function resolveTomlConfigPath(options: CodexHookInstallOptions): string {
  if (options.global === true) {
    return path.join(os.homedir(), '.codex', 'config.toml');
  }

  const repoPath = path.resolve(options.repoPath ?? process.cwd());
  return path.join(repoPath, '.codex', 'config.toml');
}

function entryUsesDotcontextCommand(entry: CodexHookMatcherEntry): boolean {
  return entry.hooks.some((hook) => isDotcontextCodexHookCommand(hook.command));
}

function entryUsesCurrentDotcontextCommand(entry: CodexHookMatcherEntry): boolean {
  return entry.hooks.some((hook) => isCurrentCodexHookCommand(hook.command));
}

function mergeHookTemplates(
  existing: CodexHookTemplate | undefined,
  incoming: CodexHookTemplate
): CodexHookTemplate {
  const preserved = (existing ?? []).filter((entry) => !entryUsesDotcontextCommand(entry));
  return [...preserved, ...incoming];
}

function mergeHooksDocument(existing: unknown): { hooks: Record<string, CodexHookTemplate> } {
  const document = isRecord(existing) ? existing : {};
  const existingHooks: Record<string, CodexHookTemplate> = isRecord(document.hooks)
    ? { ...(document.hooks as Record<string, CodexHookTemplate>) }
    : {};
  const fragment = buildCodexHooksDocument().hooks;

  for (const [eventName, template] of Object.entries(fragment)) {
    existingHooks[eventName] = mergeHookTemplates(
      existingHooks[eventName],
      template
    );
  }

  return { hooks: existingHooks };
}

function hooksUpToDate(document: unknown): boolean {
  if (!isRecord(document) || !isRecord(document.hooks)) {
    return false;
  }

  for (const eventName of Object.keys(CODEX_HOOK_TEMPLATES)) {
    const entries = document.hooks[eventName] as CodexHookTemplate | undefined;
    if (!entries?.some(entryUsesCurrentDotcontextCommand)) {
      return false;
    }
  }

  return true;
}

function hooksInstalled(document: unknown): boolean {
  if (!isRecord(document) || !isRecord(document.hooks)) {
    return false;
  }

  for (const eventName of Object.keys(CODEX_HOOK_TEMPLATES)) {
    const entries = document.hooks[eventName] as CodexHookTemplate | undefined;
    if (!entries?.some(entryUsesDotcontextCommand)) {
      return false;
    }
  }

  return true;
}

interface ParsedCodexTomlHookBlock {
  eventName: string;
  matcher?: string;
  commands: string[];
}

function parseTomlStringAssignment(line: string, key: string): string | undefined {
  const match = line.trim().match(new RegExp(`^${key}\\s*=\\s*(.+)$`));
  if (!match) {
    return undefined;
  }

  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return match[1].replace(/^["']|["']$/g, '');
  }
}

function parseTomlCommandLine(line: string): string | undefined {
  return parseTomlStringAssignment(line, 'command');
}

function parseTomlMatcherLine(line: string): string | undefined {
  return parseTomlStringAssignment(line, 'matcher');
}

function parseCodexTomlHookBlocks(content: string): ParsedCodexTomlHookBlock[] {
  const blocks: ParsedCodexTomlHookBlock[] = [];
  let current: ParsedCodexTomlHookBlock | undefined;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    const hookHeader = trimmed.match(/^\[\[hooks\.(SessionStart|PostToolUse|Stop)\]\]$/);

    if (hookHeader) {
      if (current) {
        blocks.push(current);
      }
      current = {
        eventName: hookHeader[1],
        commands: [],
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (trimmed.startsWith('[')) {
      blocks.push(current);
      current = undefined;
      continue;
    }

    const matcher = parseTomlMatcherLine(line);
    if (matcher !== undefined) {
      current.matcher = matcher;
    }

    const command = parseTomlCommandLine(line);
    if (command !== undefined) {
      current.commands.push(command);
    }
  }

  if (current) {
    blocks.push(current);
  }

  return blocks;
}

function tomlHooksFeatureEnabled(content: string): boolean {
  let inFeatures = false;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (trimmed === '[features]') {
      inFeatures = true;
      continue;
    }

    if (trimmed.startsWith('[')) {
      inFeatures = false;
      continue;
    }

    if (inFeatures && /^hooks\s*=\s*true$/.test(trimmed)) {
      return true;
    }
  }

  return false;
}

function tomlBlockMatchesTemplate(
  block: ParsedCodexTomlHookBlock,
  template: CodexHookMatcherEntry
): boolean {
  return block.matcher === template.matcher
    && block.commands.some((command) => isCurrentCodexHookCommand(command));
}

function tomlUpToDate(content: string): boolean {
  if (!tomlHooksFeatureEnabled(content)) {
    return false;
  }

  const blocks = parseCodexTomlHookBlocks(content);

  for (const [eventName, templates] of Object.entries(CODEX_HOOK_TEMPLATES)) {
    for (const template of templates) {
      const hasCurrentBlock = blocks.some((block) => (
        block.eventName === eventName && tomlBlockMatchesTemplate(block, template)
      ));

      if (!hasCurrentBlock) {
        return false;
      }
    }
  }

  return true;
}

function tomlHasDotcontextHooks(content: string): boolean {
  return content.split('\n').some((line) => {
    const command = parseTomlCommandLine(line);
    return Boolean(command && isDotcontextCodexHookCommand(command));
  });
}

function ensureTomlHooksFeatureEnabled(content: string): string {
  const lines = content.split('\n');
  const featuresIndex = lines.findIndex((line) => line.trim() === '[features]');

  if (featuresIndex === -1) {
    const base = content.trimEnd();
    return base ? `${base}\n\n[features]\nhooks = true\n` : '[features]\nhooks = true\n';
  }

  let insertIndex = featuresIndex + 1;
  for (let index = featuresIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith('[')) {
      break;
    }

    if (/^hooks\s*=/.test(trimmed)) {
      lines[index] = 'hooks = true';
      return lines.join('\n').trimEnd() + '\n';
    }

    insertIndex = index + 1;
  }

  lines.splice(insertIndex, 0, 'hooks = true');
  return lines.join('\n').trimEnd() + '\n';
}

function appendTomlHooks(existing: string): string {
  if (tomlUpToDate(existing)) {
    return existing;
  }

  const withoutDotcontextHooks = tomlHasDotcontextHooks(existing)
    ? removeDotcontextTomlHooks(existing)
    : existing.trimEnd();
  const base = ensureTomlHooksFeatureEnabled(withoutDotcontextHooks).trimEnd();
  const block = buildCodexTomlHookBlocks({ includeFeatures: false });
  return base ? `${base}\n\n${block}` : block;
}

async function installJsonHooks(
  options: CodexHookInstallOptions
): Promise<CodexHookInstallResult> {
  const configPath = resolveJsonConfigPath(options);
  const exists = await fs.pathExists(configPath);
  const existing = exists ? await fs.readJson(configPath) : {};
  const merged = mergeHooksDocument(existing);
  const alreadyConfigured = hooksUpToDate(existing);
  const action: CodexHookInstallResult['action'] =
    !exists ? 'created' : alreadyConfigured ? 'skipped' : 'updated';

  if (options.verbose) {
    process.stderr.write(`[dotcontext] Codex hooks target: ${configPath}\n`);
  }

  if (!options.dryRun && action !== 'skipped') {
    await fs.ensureDir(path.dirname(configPath));
    await fs.writeJson(configPath, merged, { spaces: 2 });
  }

  return {
    configPath,
    action,
    dryRun: Boolean(options.dryRun),
    format: 'json',
    trustReminder: 'After install, run /hooks in Codex and trust project hooks when prompted.',
  };
}

async function installTomlHooks(
  options: CodexHookInstallOptions
): Promise<CodexHookInstallResult> {
  const configPath = resolveTomlConfigPath(options);
  const exists = await fs.pathExists(configPath);
  const existing = exists ? await fs.readFile(configPath, 'utf8') : '';
  const alreadyConfigured = tomlUpToDate(existing);
  const action: CodexHookInstallResult['action'] =
    !exists ? 'created' : alreadyConfigured ? 'skipped' : 'updated';

  if (options.verbose) {
    process.stderr.write(`[dotcontext] Codex TOML hooks target: ${configPath}\n`);
  }

  if (!options.dryRun && action !== 'skipped') {
    await fs.ensureDir(path.dirname(configPath));
    await fs.writeFile(configPath, appendTomlHooks(existing), 'utf8');
  }

  return {
    configPath,
    action,
    dryRun: Boolean(options.dryRun),
    format: 'toml',
    trustReminder: 'After install, run /hooks in Codex and trust project hooks when prompted.',
  };
}

export async function installCodexHooks(
  options: CodexHookInstallOptions = {}
): Promise<CodexHookInstallResult> {
  const format = options.format ?? 'json';
  return format === 'toml' ? installTomlHooks(options) : installJsonHooks(options);
}

function removeDotcontextJsonHooks(document: unknown): { hooks: Record<string, CodexHookTemplate> } {
  const root = isRecord(document) ? document : {};
  const existingHooks = isRecord(root.hooks) ? root.hooks : {};
  const hooks: Record<string, CodexHookTemplate> = {};

  for (const [eventName, entries] of Object.entries(existingHooks)) {
    if (!Array.isArray(entries)) {
      continue;
    }

    hooks[eventName] = (entries as CodexHookTemplate)
      .map((entry) => ({
        ...entry,
        hooks: entry.hooks.filter((hook) => !isDotcontextCodexHookCommand(hook.command)),
      }))
      .filter((entry) => entry.hooks.length > 0);
  }

  return { hooks };
}

function removeDotcontextTomlHooks(content: string): string {
  const lines = content.split('\n');
  const filtered: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (/^\[\[hooks\.(SessionStart|PostToolUse|Stop)\]\]$/.test(trimmed)) {
      const blockLines: string[] = [];
      let blockHasDotcontextHook = false;

      while (index < lines.length) {
        const blockLine = lines[index];
        const blockTrimmed = blockLine.trim();

        if (blockLines.length > 0 && blockTrimmed.startsWith('[')) {
          break;
        }

        blockLines.push(blockLine);
        const command = parseTomlCommandLine(blockLine);
        if (command && isDotcontextCodexHookCommand(command)) {
          blockHasDotcontextHook = true;
        }
        index += 1;
      }

      if (!blockHasDotcontextHook) {
        filtered.push(...blockLines);
      }
      continue;
    }

    filtered.push(line);
    index += 1;
  }

  const withoutFeatureHook: string[] = [];
  let inFeatures = false;

  for (const line of filtered) {
    const trimmed = line.trim();

    if (trimmed === '[features]') {
      inFeatures = true;
      withoutFeatureHook.push(line);
      continue;
    }

    if (trimmed.startsWith('[')) {
      inFeatures = false;
    }

    if (inFeatures && /^hooks\s*=\s*true$/.test(trimmed)) {
      continue;
    }

    withoutFeatureHook.push(line);
  }

  return withoutFeatureHook.join('\n').trimEnd() + (withoutFeatureHook.length > 0 ? '\n' : '');
}

export async function uninstallCodexHooks(
  options: CodexHookInstallOptions = {}
): Promise<CodexHookInstallResult> {
  const format = options.format ?? 'json';

  if (format === 'toml') {
    const configPath = resolveTomlConfigPath(options);
    if (!await fs.pathExists(configPath)) {
      return {
        configPath,
        action: 'skipped',
        dryRun: Boolean(options.dryRun),
        format,
        trustReminder: CODEX_HOOK_TRUST_REMINDER,
      };
    }

    const existing = await fs.readFile(configPath, 'utf8');
    if (!tomlHasDotcontextHooks(existing)) {
      return {
        configPath,
        action: 'skipped',
        dryRun: Boolean(options.dryRun),
        format,
        trustReminder: CODEX_HOOK_TRUST_REMINDER,
      };
    }

    if (!options.dryRun) {
      await fs.writeFile(configPath, removeDotcontextTomlHooks(existing), 'utf8');
    }

    return {
      configPath,
      action: 'updated',
      dryRun: Boolean(options.dryRun),
      format,
      trustReminder: CODEX_HOOK_TRUST_REMINDER,
    };
  }

  const configPath = resolveJsonConfigPath(options);
  if (!await fs.pathExists(configPath)) {
    return {
      configPath,
      action: 'skipped',
      dryRun: Boolean(options.dryRun),
      format,
      trustReminder: CODEX_HOOK_TRUST_REMINDER,
    };
  }

  const existing = await fs.readJson(configPath);
  if (!hooksInstalled(existing)) {
    return {
      configPath,
      action: 'skipped',
      dryRun: Boolean(options.dryRun),
      format,
      trustReminder: CODEX_HOOK_TRUST_REMINDER,
    };
  }

  const merged = removeDotcontextJsonHooks(existing);

  if (!options.dryRun) {
    await fs.writeJson(configPath, merged, { spaces: 2 });
  }

  return {
    configPath,
    action: 'updated',
    dryRun: Boolean(options.dryRun),
    format,
    trustReminder: CODEX_HOOK_TRUST_REMINDER,
  };
}

export async function previewCodexHooks(
  options: CodexHookInstallOptions = {}
): Promise<string | Record<string, unknown>> {
  const format = options.format ?? 'json';

  if (format === 'toml') {
    const configPath = resolveTomlConfigPath(options);
    const existing = (await fs.pathExists(configPath))
      ? await fs.readFile(configPath, 'utf8')
      : '';
    return appendTomlHooks(existing);
  }

  const configPath = resolveJsonConfigPath(options);
  const existing = (await fs.pathExists(configPath))
    ? await fs.readJson(configPath)
    : {};

  return mergeHooksDocument(existing);
}
