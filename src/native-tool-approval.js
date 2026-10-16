import { basename, isAbsolute, relative } from 'node:path';
import { tmpdir } from 'node:os';

export function sandboxDenied(result) {
  return result?.value?.sandbox?.denied === true || result?.error?.info?.code === 'FS_SANDBOX_DENIED';
}

// Accept a literal single executable invocation, not a shell script. An exec
// refusal must name that executable: nested/compound commands may already have
// completed effects before encountering a sandbox refusal.
function literalExecutable(command) {
  if (typeof command !== 'string') return;
  const words = []; let word = '', quote = '', started = false;
  for (let i = 0; i < command.length; i++) {
    const character = command[i];
    if (quote === "'") {
      if (character === "'") quote = ''; else word += character;
    } else if (character === '\\') {
      const next = command[++i];
      if (next === undefined || next === '\n' || next === '\r') return;
      word += next; started = true;
    } else if (quote === '"') {
      if (character === '"') quote = '';
      else if ('$`\n\r'.includes(character)) return;
      else word += character;
    } else if (character === "'" || character === '"') {
      quote = character; started = true;
    } else if ('|&;<>($`{}*?[]~#\n\r'.includes(character)) return;
    else if (/\s/.test(character)) {
      if (started) { words.push(word); word = ''; started = false; }
    } else { word += character; started = true; }
  }
  if (quote) return;
  if (started) words.push(word);
  if (!words[0] || words[0].includes('=')) return;
  return words[0];
}

function refusedBeforeExec(args, value) {
  const executable = literalExecutable(args.command);
  if (!executable || args.run_in_background || value?.kind !== 'foreground' || value.exitCode !== 126
    || value.signal || value.timedOut || value.aborted || value.stdout?.truncated || value.stderr?.truncated
    || value.stdout?.text !== '') return false;
  const match = /^bash: (?:line 1: )?(.+): (?:Operation not permitted|Permission denied)\n?$/.exec(value.stderr?.text ?? '');
  return !!match && basename(match[1]) === basename(executable);
}

// Native filesystem sandbox failures precede the provider mutation. For a
// read-only session, resolve canonical identities before choosing the narrower
// workspace-write grant (including the host's writable temporary roots).
export async function nativeRetryMode(ctx, name, args, result, agent, signal) {
  if (!sandboxDenied(result) || Object.hasOwn(args, 'sandbox_permissions') || Object.hasOwn(args, 'justification')) return;
  const schema = ctx.tools.get(name, agent)?.parameters?.properties;
  const modes = schema?.sandbox_permissions?.enum;
  if (!Array.isArray(modes) || !schema.justification) return;
  const policy = ctx.get('sandboxPolicy')?.resolve({ session: agent.session });
  if (!policy || policy.mode === 'danger-full-access') return;
  let mode;
  if (name === 'bash' && refusedBeforeExec(args, result.value)) mode = 'danger-full-access';
  else if (['write', 'edit'].includes(name) && result.error?.info?.code === 'FS_SANDBOX_DENIED') {
    mode = 'danger-full-access';
    if (policy.mode === 'read-only' && typeof args.file_path === 'string') {
      const fs = agent.ctx.get('fs') ?? ctx.get('fs');
      if (!fs?.resolve) return;
      const target = await fs.resolve(args.file_path, { cwd: policy.workspaceRoot, signal });
      for (const root of new Set([policy.workspaceRoot, tmpdir(), '/tmp', '/private/tmp'])) {
        const directory = await fs.resolve(root, { signal });
        const path = relative(directory.targetKey, target.targetKey);
        if (path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\'))) {
          mode = 'workspace-write'; break;
        }
      }
    }
  }
  return modes.includes(mode) ? mode : undefined;
}

export function nativeApprovalOutcome(session, callId, since) {
  const events = session.snapshotEvents().filter(event => event.seq >= since);
  const asked = events.findLast(event => event.type === 'approval/asked' && event.data.callId === callId);
  if (!asked) return;
  return events.findLast(event => event.type === 'approval/decided' && event.data.id === asked.data.id)?.data.outcome;
}
