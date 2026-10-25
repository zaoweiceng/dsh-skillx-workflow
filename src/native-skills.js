// Keep presentation-only labels/examples out of the model contract. Constraints,
// defaults and descriptions remain identical to the executable schema.
function invocationSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const { title, examples, ...result } = schema;
  if (title && !result.description) result.description = title;
  if (result.properties) result.properties = Object.fromEntries(Object.entries(result.properties).map(([name, value]) => [name, invocationSchema(value)]));
  if (result.items) result.items = invocationSchema(result.items);
  if (result.oneOf) result.oneOf = result.oneOf.map(invocationSchema);
  return result;
}

const INLINE_CONTRACT_BYTES = 16384; // Prompt presentation only; never a publication/execution limit.

function publicContract(root) {
  return JSON.stringify({ name: root.name, description: root.description, version: root.version,
    compatibility: root.compatibility ? {platforms:root.compatibility.platforms,requirements:root.compatibility.requirements,limitations:root.compatibility.limitations} : { limitations: 'Platform compatibility has not been declared for this legacy revision.' },
    inputSchema: invocationSchema(root.execution?.inputSchema), outputSchema: invocationSchema(root.execution?.outputSchema), outcome:root.execution?.outcome,
    available: Boolean(root.execution),
    executionTarget:root.execution?.target ?? 'local',
    verification:{scope:root.evidence?.validation?.scope ?? 'unverified',behaviorTested:root.evidence?.validation?.behaviorTested === true},
    invocation: root.execution ? { tool: 'capability_run', arguments: { name: root.name, expectedRevisionId: root.revisionId, input: 'Object matching inputSchema' } } : null,
    instruction: root.execution
      ? 'Invoke capability_run once with the requested inputs. Load this root contract only: the executor resolves its dependencies and CLI operations internally. Use the verified output/receipt. Default to bounded business summaries; request raw detail only when necessary. delivery.complete=false means a preview: use capability_result_read with the retained runId and needed JSON pointers, never repeat the query or read implementation to retrieve detail. Follow published hard parameter bounds exactly; default annotations do not insert values. External blockers require caller action; observed implementation defects can be submitted through capability_revise.'
      : 'This legacy definition has no executable contract yet. Ask the native optimization Agent to compile it before black-box invocation.',
  });
}
export function registerNativeSkills(ctx, store) {
  // Advertise callable roots as typed alternatives in the existing invocation
  // tool. The model selects by purpose for ordinary tasks, without a name hint
  // or a second inference just to load a contract. Other entries remain lazy.
  const stopPresentation = ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next();
    const tool = assembly.tools.find(tool => tool.name === 'capability_run');
    if (!tool) return assembly; // Author/recovery scopes keep their own tool set.
    const entries = (await Promise.all((await store.list()).map(entry => store.get(entry.name)))).filter(entry => entry?.execution);
    const referenced = new Set(entries.flatMap(entry => (entry.dependencies ?? []).map(dependency => dependency.name)));
    const roots = entries.filter(entry => !referenced.has(entry.name));
    if (!roots.length) return assembly;
    const { snapshotRevisionId, ...currentProperties } = tool.parameters.properties;
    const variants = roots.map(entry => ({ type: 'object', description: JSON.stringify({purpose:entry.description,compatibility:entry.compatibility ? {platforms:entry.compatibility.platforms,requirements:entry.compatibility.requirements,limitations:entry.compatibility.limitations} : {limitations:'Compatibility unverified'},outputSchema:invocationSchema(entry.execution.outputSchema),defaults:'Schema defaults are annotations; required inputs must still be supplied.'}),
      properties: { ...currentProperties,
        name: { type: 'string', const: entry.name, description: entry.description },
        input: invocationSchema(entry.execution.inputSchema),
        expectedRevisionId: { type: 'string', const: entry.revisionId },
      }, required: [...new Set([...tool.parameters.required, 'expectedRevisionId'])],
      additionalProperties: tool.parameters.additionalProperties ?? false,
    }));
    const lazyNames = entries.filter(entry => referenced.has(entry.name)).map(entry => entry.name);
    if (lazyNames.length) variants.push({ ...tool.parameters, properties: { ...currentProperties,
      name: { type: 'string', enum: lazyNames, description: 'Load this dependency’s public contract with skill before invoking it independently.' },
    } });
    // Historical contracts may have different input schemas. Keep that route
    // distinct from current typed alternatives; execution still validates it.
    if (snapshotRevisionId) variants.push({ ...tool.parameters,
      required: [...new Set([...tool.parameters.required, 'snapshotRevisionId'])],
    });
    const parameters = variants.length === 1 ? variants[0] : { oneOf: variants };
    // A large catalog stays progressive instead of inflating every model request.
    if (Buffer.byteLength(JSON.stringify(parameters)) > INLINE_CONTRACT_BYTES) return assembly;
    return { ...assembly, tools: assembly.tools.map(item => item === tool ? { ...item, parameters } : item) };
  });
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
        return { ...summary, description: entry.description, content: publicContract(entry),
          metadata: { kind: entry.kind, version: entry.version, revisionId: entry.revisionId,
            dependencies: entry.dependencies ?? [], loadReceipt: bundle.loadReceipt } };
      },
    };
  });
  return () => { stopPresentation(); unsubscribe?.(); dispose(); };
}
