/**
 * 未接入的实现参考：不是原规范 Runtime Profile，也不是可直接导入的 DSH 能力。
 *
 * 约定：
 * - input 已经通过 schemas/input.schema.json 校验。
 * - tools.call 由宿主提供，负责执行受控工具。
 * - 返回值必须符合 schemas/output.schema.json。
 */
export async function run(input, tools) {
  const status = await tools.call({
    name: 'exec_command',
    arguments: { cmd: 'git status --short' },
  });

  const statusBefore = String(status.output || '').trim();
  if (!statusBefore) {
    throw new Error('工作区没有可提交变更');
  }

  await tools.call({
    name: 'exec_command',
    arguments: { cmd: 'git add -A' },
  });

  // POSIX shell quoting; JSON quoting does not prevent $() or backtick expansion.
  const commitMessage = "'" + String(input.message).replaceAll("'", "'\"'\"'") + "'";
  const commit = await tools.call({
    name: 'exec_command',
    arguments: { cmd: `git commit -m ${commitMessage}` },
  });

  if (commit.exitCode !== 0) {
    throw new Error('git commit 执行失败');
  }

  const rev = await tools.call({
    name: 'exec_command',
    arguments: { cmd: 'git rev-parse HEAD' },
  });

  const output = {
    commit: String(rev.output || '').trim(),
    summary: String(commit.output || '').trim().slice(0, 1000),
  };

  if (input.includeStatus) {
    output.statusBefore = statusBefore;
  }

  return output;
}
