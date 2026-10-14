// DSH itself advertises summaries and loads bodies through its native skill tool.

function bundledContent(bundle) {
  const { root } = bundle;
  return JSON.stringify({ name: root.name, description: root.description, version: root.version,
    inputSchema: root.execution?.inputSchema, outputSchema: root.execution?.outputSchema,
    available: Boolean(root.execution),
    invocation: root.execution ? { tool: 'capability_run', arguments: { name: root.name, input: 'Object matching inputSchema' } } : null,
    instruction: root.execution
      ? 'Invoke capability_run with the requested inputs. Implementation and dependencies are private to the executor. Use its verified output/receipt; do not reconstruct or repeat internal steps. External blockers require caller action; internal repair is handled inside the plugin.'
      : 'This legacy definition has no executable contract yet. Ask the native optimization Agent to compile it before black-box invocation.',
  });
}
export function registerNativeSkills(ctx, store) {
  let unsubscribe;
  const dispose = ctx.skills.registerProvider(control => {
    unsubscribe = store.subscribe(() => control.invalidate());
    control.signal.addEventListener('abort', () => unsubscribe?.(), { once: true });
    return {
      name: 'native-workflows',
      async list(options = {}) {
        options.signal?.throwIfAborted();
        return (await store.list()).map(summary => ({ ...summary,
          provider: 'native-workflows', source: 'custom', rank: -1000,
          invocation: { modelInvocable: true, userInvocable: true }, locator: summary.name,
        }));
      },
      async get(candidate, options = {}) {
        options.signal?.throwIfAborted();
        const bundle = await store.loadBundle(candidate.locator, { signal: options.signal });
        if (!bundle) return undefined;
        const entry = bundle.root;
        const { rank, locator, ...summary } = candidate;
        return { ...summary, description: entry.description, content: bundledContent(bundle),
          metadata: { kind: entry.kind, version: entry.version, revisionId: entry.revisionId,
            dependencies: entry.dependencies ?? [], loadReceipt: bundle.loadReceipt } };
      },
    };
  });
  return () => { unsubscribe?.(); dispose(); };
}
