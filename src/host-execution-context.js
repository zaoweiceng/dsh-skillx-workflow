import { AsyncLocalStorage } from 'node:async_hooks';

// Native tool definitions close over the host policy and filesystem services.
// Route their agentless lookups by async execution, without changing defaults
// or creating a session. A real Agent always resolves its own session policy.
export function createHostExecutionContext(ctx) {
  const scope = new AsyncLocalStorage();
  const restore = [];
  const wrap = (service, name, decorate) => {
    if (typeof service?.[name] !== 'function') throw new Error('Host execution requires ' + name);
    const original = service[name];
    const descriptor = Object.getOwnPropertyDescriptor(service, name);
    const wrapped = decorate(original.bind(service));
    Object.defineProperty(service, name, { configurable: true, writable: true, value: wrapped });
    restore.push(() => {
      if (Object.getOwnPropertyDescriptor(service, name)?.value !== wrapped) return;
      if (descriptor) Object.defineProperty(service, name, descriptor);
      else delete service[name];
    });
  };
  const install = () => {
    const policy = ctx.get('sandboxPolicy');
    const fs = ctx.get('fs');
    // Preset tools live on a standing scope, independently of any Agent.
    // Borrow that view for agentless workbench calls only; session callers keep
    // their own tool composition and restrictions.
    for (const name of ['get', 'schemas', 'modeFor']) wrap(ctx.tools, name, original => (argument, ...rest) => {
      const current = scope.getStore();
      if (name === 'get') return original(argument, rest[0] ?? current?.toolScope);
      return original(argument ?? current?.toolScope, ...rest);
    });
    wrap(policy, 'resolve', original => (request = {}) => {
      const current = scope.getStore();
      return current && !request.session
        ? { mode: 'danger-full-access', workspaceRoot: current.cwd }
        : original(request);
    });
    if (fs) wrap(fs, 'resolve', original => (path, options = {}) => {
      const current = scope.getStore();
      return original(path, current && options.cwd === undefined ? { ...options, cwd: current.cwd } : options);
    });
    // Keep observation/CAS integrity for agentless tools, keyed by execution
    // rather than a fabricated session. Existing conversation guards are untouched.
    ctx.on('fs/observed', (target, observation, actor) => {
      const current = scope.getStore();
      if (current && !actor?.agent) current.observations.set(target.targetKey, observation);
    });
    ctx.on('fs/write-intent', (target, actor, next) => {
      const current = scope.getStore();
      if (!current || actor?.agent) return next();
      const prior = current.observations.get(target.targetKey);
      return Promise.resolve(prior?.kind === 'present'
        ? { kind: 'replaceIfVersion', version: prior.version } : { kind: 'createIfAbsent' });
    }, { prepend: true });
    ctx.on('fs/edit-intent', (target, actor, next) => {
      const current = scope.getStore();
      if (!current || actor?.agent) return next();
      const prior = current.observations.get(target.targetKey);
      if (prior?.kind === 'present') return Promise.resolve({ version: prior.version });
      const error = new Error(prior ? 'Cannot edit an absent file' : 'Edit requires reading the file first');
      error.code = prior ? 'FS_NOT_FOUND' : 'FS_NOT_OBSERVED';
      throw error;
    }, { prepend: true });
  };
  let installed = false;
  return {
    run(context, callback) {
      if (!installed) {
        try { install(); installed = true; }
        catch (error) { for (const undo of restore.splice(0).reverse()) undo(); throw error; }
      }
      return scope.run(context, callback);
    },
    dispose() { for (const undo of restore.splice(0).reverse()) undo(); scope.disable(); },
  };
}
