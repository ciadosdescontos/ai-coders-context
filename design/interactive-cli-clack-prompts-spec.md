# Interactive CLI prompt migration to `@clack/prompts`

Status: Implemented  
Baseline date: 2026-06-27  
Target package: `@clack/prompts@^1.6.0`

## Summary

Migrate dotcontext's operator-facing interactive CLI prompts from the current Inquirer stack to `@clack/prompts`.

The current codebase has two prompt paths:

- `src/utils/themedPrompt.ts` wraps `@inquirer/prompts`.
- `src/bin/dotcontext.ts` still calls `inquirer.prompt()` directly for Quick Sync, Reverse Sync, and legacy interactive sync prompts.

The target state is one shared Clack-backed prompt adapter used by the CLI entrypoint and the direct MCP package install prompt. Command behavior, translations, and non-interactive behavior should stay the same.

The interactive CLI must also become the operator path for integration lifecycle management:

- install MCP config
- install lifecycle hooks
- install or guide Pi extension setup
- uninstall MCP config
- uninstall lifecycle hooks
- uninstall or guide Pi extension removal

## Goals

- Use `@clack/prompts` for all interactive prompt components in the CLI surface.
- Remove runtime dependencies on `inquirer`, `@inquirer/prompts`, and `@types/inquirer`.
- Preserve the existing menu topology:
  - project-state detection first
  - new project menu
  - full menu
  - `Synchronize my context` customization
  - `Import my context` import flow
  - integration install and uninstall flows
  - settings language selector
- Add first-class interactive entries for:
  - MCP install
  - MCP uninstall
  - Hook install
  - Hook uninstall
  - Pi extension install guidance
  - Pi extension uninstall guidance
- Keep non-interactive command behavior unchanged.
- Keep all user-facing strings routed through `src/utils/i18n.ts`.
- Rename the interactive action labels:
  - Quick Sync -> `Synchronize my context`
  - Reverse Sync -> `Import my context`
- Handle `Ctrl+C` and prompt cancellation consistently with a clean exit.
- Keep reusable execution logic out of this change. Prompt code belongs in `src/utils` and CLI callsites, not in `src/harness`.

## Non-goals

- Do not redesign the command surface.
- Do not change MCP installer config output.
- Do not silently uninstall third-party packages or tool state outside dotcontext-owned config entries. For Pi extension removal, prefer clear command guidance unless Pi exposes a stable, non-interactive uninstall command this project can safely call.
- Do not move CLI business logic into `src/services`; that directory is outside the target architecture.
- Do not replace all `CLIInterface` output, progress bars, or reporting UI in this migration. Clack spinners/logs can be considered after prompts are migrated.
- Do not change docs unless visible CLI behavior or engine requirements change.

## Current state

Dependencies in `package.json`:

- `@inquirer/prompts`
- `inquirer`
- `@types/inquirer`

Prompt wrapper:

- `src/utils/themedPrompt.ts`
  - exports `themedSelect`, `themedConfirm`, `themedInput`, `themedPassword`, `themedCheckbox`, and `Separator`
  - applies `promptTheme` from `src/utils/theme.ts`

Direct prompt usage:

- `src/bin/dotcontext.ts`
  - imports `inquirer`
  - uses `inquirer.prompt()` in:
    - `runInteractiveSync`
    - `runQuickSync`
    - `runReverseSync`

Shared prompt adapter usage:

- `src/bin/dotcontext.ts`
  - MCP hook recommendation prompts
  - MCP install tool selection
  - hook install host selection
  - locale selection
  - top-level interactive menus
- `src/mcp/bin.ts`
  - direct `@dotcontext/mcp install` interactive tool selection
- `src/utils/prompts/index.ts`
  - older prompt helpers still used by CLI flows

Integration lifecycle support:

- `src/bin/dotcontext.ts`
  - has visible `mcp:install`
  - has visible `hook install`
  - has visible `hook uninstall`
  - does not currently expose hook install/uninstall from the top-level interactive menu
  - does not currently expose a standalone interactive integration management submenu
- `src/cli/services/mcpInstallService.ts`
  - installs MCP config for supported tools
  - does not currently provide an MCP uninstall service
- `src/cli/services/hookInstallService.ts`
  - installs and uninstalls Claude Code and Codex hook config
  - for Pi install, displays `pi install npm:@dotcontext/pi` guidance and can write the local `.mcp.json` snippet unless suppressed by the MCP combined flow
  - for Pi uninstall, displays extension removal guidance

Pi uninstall command consistency gap:

- `src/utils/i18n.ts` currently says `pi uninstall npm:@dotcontext/pi`.
- `docs/src/content/docs/en/guides/using-with-pi.md` currently says `pi uninstall @dotcontext/pi`.
- Before shipping interactive Pi extension uninstall, choose the canonical Pi command and update CLI output, README, and docs to match.

## Package and runtime decisions

### Adopt Clack 1.6.x

Use `@clack/prompts@^1.6.0` as the migration baseline. As of 2026-06-27, the registry reports:

- latest: `1.6.0`
- package type: ESM
- runtime engine: `node >=20.12.0`
- exports: `dist/index.mjs`

### Update Node engine

Because Clack 1.6.0 declares `node >=20.12.0`, update dotcontext's package engine from:

```json
{ "node": ">=20.0.0" }
```

to:

```json
{ "node": ">=20.12.0" }
```

This avoids publishing a CLI that claims support for Node versions below a dependency's declared runtime floor.

### Keep CommonJS output for this migration

The repo currently compiles TypeScript with `"module": "commonjs"`. Do not convert the package to ESM as part of this prompt migration.

Because `@clack/prompts` is ESM-only, the prompt adapter must avoid static runtime imports that TypeScript would compile into `require("@clack/prompts")`.

Recommended adapter loading pattern:

```ts
type ClackPrompts = typeof import('@clack/prompts');

const importEsm = new Function(
  'specifier',
  'return import(specifier)'
) as (specifier: string) => Promise<ClackPrompts>;

let clackPromise: Promise<ClackPrompts> | null = null;

function loadClack(): Promise<ClackPrompts> {
  clackPromise ??= importEsm('@clack/prompts');
  return clackPromise;
}
```

Use type-only imports where useful. The first implementation step must prove this with `npm run build` before migrating every callsite.

## Target prompt adapter

Keep the existing public wrapper names initially to reduce churn:

- `themedSelect`
- `themedConfirm`
- `themedInput`
- `themedPassword`
- `themedCheckbox`

Internally, rewrite `src/utils/themedPrompt.ts` to call Clack.

Add a first-class cancellation error:

```ts
export class PromptCancelledError extends Error {
  constructor() {
    super('Prompt cancelled');
    this.name = 'PromptCancelledError';
  }
}

export function isPromptCancelled(error: unknown): boolean {
  return error instanceof PromptCancelledError;
}
```

Every wrapper must check `isCancel(result)` and throw `PromptCancelledError`. The entrypoint then handles it like the current Inquirer `ExitPromptError`.

Do not call `process.exit()` inside the prompt adapter. Exiting remains an entrypoint concern.

## API mapping

| Current wrapper | Current provider | Clack provider | Mapping |
| --- | --- | --- | --- |
| `themedSelect` | `@inquirer/prompts.select` | `select` | `choices` -> `options`, `name` -> `label`, `description` -> `hint`, `default` -> `initialValue`, `pageSize` -> `maxItems` |
| `themedCheckbox` | `@inquirer/prompts.checkbox` | `multiselect` | `choices` -> `options`, checked choices -> `initialValues`, return `Value[]`, `required: false` |
| `themedConfirm` | `@inquirer/prompts.confirm` | `confirm` | `default` -> `initialValue` |
| `themedInput` | `@inquirer/prompts.input` | `text` | `default` -> `defaultValue`; use `initialValue` only when editable prefill is intended |
| `themedPassword` | `@inquirer/prompts.password` | `password` | preserve `mask` and `validate` |
| `Separator` | Inquirer separator | none | remove from callsites; use grouped labels, hints, or menu ordering instead |

Clack options should use this project-level shape:

```ts
type PromptChoice<Value> = {
  value: Value;
  name?: string;
  label?: string;
  description?: string;
  hint?: string;
  disabled?: boolean | string;
  checked?: boolean;
};
```

The adapter converts it to Clack's option shape:

```ts
{
  value: choice.value,
  label: choice.label ?? choice.name ?? String(choice.value),
  hint: choice.hint ?? choice.description,
  disabled: Boolean(choice.disabled)
}
```

If a previous disabled reason string matters, append it to `hint`; Clack's `disabled` field is boolean.

## UX rules

- Keep the existing splash screen from `src/utils/splashScreen.ts`.
- Keep colorized labels from `src/utils/theme.ts` in caller-provided text where already used.
- Do not add Clack `intro()` to the main interactive entrypoint while the splash screen exists.
- Use Clack `cancel()` only when the user cancels a prompt. The normal `Exit` menu action should keep using the existing localized goodbye message.
- Do not mix `ora` and Clack spinners for the same long-running operation. Keep `CLIInterface` spinners for this migration.
- Preserve current default selections.
- Keep keyboard-only flows working with arrows, space, enter, and `Ctrl+C`.

## Interactive naming

Rename the main interactive menu labels without requiring a service rename in the same change:

| Current user-facing label | New user-facing label | Internal flow |
| --- | --- | --- |
| `Quick Sync` | `Synchronize my context` | `runQuickSync()` / `QuickSyncService` |
| `Reverse Sync` | `Import my context` | `runReverseSync()` / `ReverseQuickSyncService` |

The implementation may keep `quickSync`, `reverseSync`, `runQuickSync()`, and `runReverseSync()` internally for a smaller migration. If the internal names are later changed, do it as a separate refactor after the prompt and lifecycle behavior is stable.

Update these labels anywhere they appear as user-facing menu copy:

- `src/utils/i18n.ts` English messages
- `src/utils/i18n.ts` Brazilian Portuguese messages, using either the English product labels or localized equivalents chosen by the project
- README interactive CLI section
- docs interactive CLI sections in both locales
- changelog entry if this ships in a release

## Interactive integration flows

Add a dedicated `Integrations` entry to the full interactive menu. The current direct `MCP Install` menu item can remain as a shortcut, but the full lifecycle must be reachable through `Integrations`.

Recommended full menu:

- `Synchronize my context`
- `Import my context`
- `Integrations`
- `Settings`
- `Exit`

When the project is unfilled, keep `View Pending` first.

Recommended new-project menu:

- `Integrations`
- `Import my context`
- `Settings`
- `Exit`

The `Integrations` submenu should offer:

- `Install MCP`
- `Uninstall MCP`
- `Install Hooks`
- `Uninstall Hooks`
- `Install Pi Extension`
- `Uninstall Pi Extension`
- `Back`

### Install MCP

Use the existing `runMcpInstallFlow()` path.

Behavior:

- If no tool is supplied, prompt with detected tools first, same as `mcp:install`.
- Keep existing hook recommendation behavior after MCP install.
- For Pi, preserve the existing rule: `mcp:install pi --with-hooks` lets the MCP installer own the `.mcp.json` snippet and prevents the Pi hook step from duplicating it.

### Uninstall MCP

Add a new CLI command and service method:

- command: `dotcontext mcp:uninstall [tool]`
- service: `MCPInstallService.runUninstall()` or a sibling `MCPUninstallService` in `src/cli/services`

Prefer adding uninstall behavior to `src/cli/services/mcpInstallService.ts` only if the file stays readable; otherwise create `src/cli/services/mcpUninstallService.ts` and export it from `src/cli/services/index.ts`.

The uninstall service must use the same supported tool registry and config paths as install.

Required behavior:

- support `[tool]`, `all`, `--global`, `--local`, `--dry-run`, and `--verbose`
- in interactive mode, prompt with supported/detected tools using the same selection resolver pattern as install
- remove only the dotcontext server entry
- preserve unrelated MCP servers and unrelated config keys
- skip when the config file does not exist or dotcontext is not configured
- delete a standalone dotcontext-only file only when the file format is dedicated to dotcontext, such as `.continue/mcpServers/dotcontext.json`
- do not delete shared config files just because their dotcontext entry was removed
- for Codex TOML, remove the `[mcp_servers.dotcontext]` table and its `[mcp_servers.dotcontext.env]` table without touching other TOML content

Config entry removal rules:

| Config shape | Install examples | Uninstall operation |
| --- | --- | --- |
| `mcpServers.dotcontext` | Claude, Cursor, Windsurf, Roo, Amazon Q, Gemini, Trae, Copilot CLI, Pi | delete `mcpServers.dotcontext` |
| `servers.dotcontext` | VS Code | delete `servers.dotcontext` |
| `context_servers.dotcontext` | Zed | delete `context_servers.dotcontext` |
| `servers[]` with `name: "dotcontext"` | JetBrains | filter out matching server |
| `mcp.dotcontext` | Kilo Code | delete `mcp.dotcontext` |
| standalone dotcontext file | Continue | remove the file or dry-run that removal |
| Codex TOML table | Codex | remove dotcontext TOML table block(s) |

### Install Hooks

Use the existing `HookInstallService.runInstall()` path.

Behavior:

- prompt for `claude-code`, `codex`, `pi`, or all detected/supported hosts
- preserve `--format json|toml` behavior for Codex
- local project config remains the default
- for Pi, show the Pi extension install guidance and write the MCP snippet only when this is a standalone hook install, not the post-MCP combined flow

### Uninstall Hooks

Use the existing `HookInstallService.runUninstall()` path.

Behavior:

- prompt for `claude-code`, `codex`, `pi`, or all detected/supported hosts
- preserve `--format json|toml` behavior for Codex
- local project config remains the default
- for Pi, show Pi extension uninstall guidance

### Install Pi Extension

This can initially call the existing Pi branch of `HookInstallService.runInstall({ host: "pi" })`, but the UI label should say `Install Pi Extension` rather than `Install Hooks`.

The output must include:

```bash
pi install npm:@dotcontext/pi
```

If the flow also installs MCP for Pi, it must use the MCP installer and write the same config as `mcp:install pi`. Do not hand-write a second Pi MCP snippet from the extension flow after MCP install has already handled it.

### Uninstall Pi Extension

This can initially call the existing Pi branch of `HookInstallService.runUninstall({ host: "pi" })`, but the UI label should say `Uninstall Pi Extension`.

The output must include the exact canonical Pi uninstall command once the supported command is confirmed. Until then, use explicit guidance rather than executing an inferred command. The command must be identical across `src/utils/i18n.ts`, README, and docs.

The flow should also offer MCP config cleanup for Pi:

- `Remove Pi MCP config too?`
- if accepted, call the MCP uninstall path with `tool: "pi"`

### Combined setup and teardown

Add optional guided flows after the individual operations are available:

- `Install recommended setup`
  - choose a tool
  - install MCP
  - offer matching hooks when eligible
  - for Pi, show extension install guidance
- `Uninstall dotcontext from a tool`
  - choose a tool/host mapping
  - remove MCP config when present
  - remove hook config when supported
  - for Pi, show extension uninstall guidance

Mappings:

| MCP tool | Hook host / extension |
| --- | --- |
| `claude` | `claude-code` |
| `codex` | `codex` |
| `pi` | `pi` extension |

Other MCP tools should only uninstall MCP config unless a hook host is later added.

## Implementation plan

### Phase 1: Dependency and compatibility spike

1. Add `@clack/prompts@^1.6.0`.
2. Update `engines.node` to `>=20.12.0`.
3. Rewrite only `src/utils/themedPrompt.ts` to use the ESM dynamic import bridge.
4. Keep wrapper signatures compatible enough for existing callsites.
5. Run `npm run build`.

Exit criteria:

- Build succeeds with CommonJS output.
- No runtime `ERR_REQUIRE_ESM` from the prompt adapter in a smoke invocation.

### Phase 2: Replace direct Inquirer calls

Replace every `inquirer.prompt()` call in `src/bin/dotcontext.ts` with the shared prompt wrappers.

Expected flow changes:

- `runInteractiveSync`
  - `list` -> `themedSelect`
  - `input` -> `themedInput`
- `runQuickSync`
  - sync mode `list` -> `themedSelect`
  - component and target `checkbox` -> `themedCheckbox`
- `runReverseSync`
  - component `checkbox` -> `themedCheckbox`
  - merge strategy `list` -> `themedSelect`

Remove:

- `import inquirer from 'inquirer';`
- `new Separator()` callsites

Then remove dependencies:

- `inquirer`
- `@inquirer/prompts`
- `@types/inquirer`

### Phase 3: Cancellation behavior

Update `src/bin/dotcontext.ts`:

- `isUserInterrupt()` recognizes `PromptCancelledError` via `isPromptCancelled()`.
- `handleGracefulExit()` remains the single graceful exit path.

Update `src/mcp/bin.ts`:

- If direct MCP install prompt is cancelled, exit with code `0` after printing a concise cancellation message or reusing the same prompt-cancel handling helper.

### Phase 4: Interactive integration lifecycle

After the Clack prompt adapter and direct prompt migration are complete, expose integration lifecycle actions in interactive mode.

Implementation tasks:

1. Add `Integrations` to the interactive menus in `src/bin/dotcontext.ts`.
2. Add an `runIntegrationsMenu()` function that loops until `Back`.
3. Route install actions to existing install functions/services.
4. Add `mcp:uninstall [tool]` and the matching uninstall service path.
5. Route uninstall actions to the new MCP uninstall path and existing hook uninstall path.
6. Add i18n keys in both English and Brazilian Portuguese.
7. Update README and docs if command surface or interactive menu descriptions change.

Exit criteria:

- all install/uninstall actions are reachable from `dotcontext` with no arguments
- direct commands still work for scripts
- non-interactive defaults remain command-driven and do not prompt

### Phase 5: Tests

Add focused tests for prompt migration behavior without trying to drive a real terminal UI.

Recommended tests:

- adapter maps select choices to Clack options correctly
- adapter maps checked checkbox choices to `initialValues`
- adapter converts Clack cancel symbols into `PromptCancelledError`
- CLI no longer imports `inquirer` or `@inquirer/prompts`
- `resolveMcpInstallToolSelection` and `resolveHookInstallHostSelection` still receive prompt functions with unchanged choice values
- interactive menu includes integration lifecycle choices
- `mcp:uninstall` removes only dotcontext config entries and preserves unrelated MCP config
- `mcp:uninstall codex` removes only the dotcontext TOML block
- `mcp:uninstall pi --local` removes the local `.mcp.json` dotcontext entry
- hook install and uninstall remain reachable through both command and interactive flows
- Pi extension install/uninstall menu choices show guidance and do not duplicate MCP snippets

Existing tests to keep green:

```bash
npm run build
npm test -- --runInBand
```

For packaging confidence after dependency changes:

```bash
npm run build:packages
npm run smoke:packages
```

## Acceptance criteria

- `rg "from 'inquirer'|from \"inquirer\"|inquirer\\.prompt|@inquirer/prompts" src package.json` returns no matches.
- `package.json` contains `@clack/prompts` and no Inquirer dependencies.
- Interactive CLI menus render through Clack-backed wrappers.
- `Synchronize my context` and `Import my context` produce the same service options as Quick Sync and Reverse Sync did before for equivalent selections.
- The old `Quick Sync` and `Reverse Sync` labels no longer appear in interactive user-facing copy, except in migration notes or tests that intentionally reference previous behavior.
- Interactive mode exposes install and uninstall paths for MCP, hooks, and Pi extension.
- `dotcontext mcp:uninstall [tool]` exists and supports `--global`, `--local`, `--dry-run`, and `--verbose`.
- MCP uninstall removes only dotcontext entries and preserves unrelated tool configuration.
- Hook install/uninstall remains available from direct commands and the interactive integrations menu.
- Pi extension install/uninstall guidance is available from the interactive integrations menu.
- MCP install prompt selection still defaults to `all` in non-interactive mode.
- `Ctrl+C` exits cleanly without a stack trace.
- `npm run build` passes.
- `npm test -- --runInBand` passes.
- Package smoke tests pass if the lockfile or package build output changes.

## Rollback plan

The migration keeps callsites behind the existing wrapper names, so rollback is limited to:

1. Revert `src/utils/themedPrompt.ts`.
2. Restore Inquirer dependencies.
3. Revert callsite changes that replaced direct `inquirer.prompt()`.

No harness, MCP gateway, or integration contract should need rollback.

## References

- `@clack/prompts` npm package: https://www.npmjs.com/package/@clack/prompts
- Clack prompts documentation: https://bomb.sh/docs/clack/packages/prompts/
- Clack repository package metadata: https://github.com/bombshell-dev/clack/tree/main/packages/prompts
