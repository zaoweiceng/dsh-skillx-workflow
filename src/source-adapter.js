import { parse } from 'acorn';

const syntax = source => parse(source, {ecmaVersion:'latest',sourceType:'module',allowHashBang:true});
export function sourceInvocations(source) {
  let tree; try { tree=syntax(source); } catch { return []; }
  const found = new Map();
  const bindings = new Map();
  const resolve = node => {const seen=new Set();while(node?.type==='Identifier' && bindings.has(node.name) && !seen.has(node.name)){seen.add(node.name);node=bindings.get(node.name);}return node;};
  const file = node => node?.type==='Literal' && typeof node.value==='string' && /\.(?:mjs|cjs|js|py)$/.test(node.value) ? node.value.split(/[\\/]/).pop() : node?.type==='CallExpression' ? node.arguments.map(file).find(Boolean) : undefined;
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type==='VariableDeclarator' && node.id.type==='Identifier') bindings.set(node.id.name,node.init);
    if (node.type==='CallExpression' && ['run','runSync','spawn','spawnSync'].includes(node.callee.name ?? node.callee.property?.name)) {
      const argv=node.arguments[1], name=argv?.type==='ArrayExpression' && file(argv.elements[0]);
      if (name) {
        const options=node.arguments[2];
        let env=resolve(options?.type==='ObjectExpression' && options.properties.find(p=>(p.key?.name ?? p.key?.value)==='env')?.value);
        if (env?.type==='CallExpression') env=resolve(env.arguments[0]);
        const keys=env?.type==='ObjectExpression' ? env.properties.filter(p=>p.type==='Property' && !p.computed).map(p=>p.key.name ?? p.key.value) : [];
        const prior=found.get(name); found.set(name,prior ? prior.filter(key=>keys.includes(key)) : keys);
      }
    }
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value==='object') visit(value);
  };
  visit(tree); return [...found].filter(([,env])=>env.length).map(([script,env])=>({script,env}));
}
export function sourceEntrypoint(source) {
  let tree; try { tree=syntax(source); } catch { return undefined; }
  const functions = new Map(tree.body.filter(node=>node.type==='FunctionDeclaration').map(node=>[node.id.name,node]));
  const called = node => node?.type==='AwaitExpression' ? called(node.argument) : node?.type==='CallExpression' ? node.callee.type==='Identifier' && functions.has(node.callee.name) ? node.callee.name : called(node.callee.object) : undefined;
  for (const node of tree.body.toReversed()) {
    const name = node.type==='ExpressionStatement' && called(node.expression);
    if (name) {const fn=functions.get(name);return {name,body:source.slice(fn.body.start,fn.body.end)};}
  }
}
export function sourceInterface(source) {
  try {
    const tree = syntax(source);
    const functions = tree.body.filter(node=>node.type==='FunctionDeclaration');
    const names = new Set(functions.map(node=>node.id.name));
    const calls = body => {
      const result = [];
      const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'CallExpression') {
          const name = source.slice(node.callee.start,node.callee.end);
          if (names.has(name) || /^(fs|path)\./.test(name)) result.push({name,arguments:node.arguments.map(arg=>source.slice(arg.start,arg.end)),line:source.slice(0,node.start).split('\n').length});
        }
        for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
      };
      visit(body); return result;
    };
    return {
      invocations:sourceInvocations(source),
      functions:functions.map(node=>({name:node.id.name,parameters:node.params.map(param=>source.slice(param.start,param.end)),line:source.slice(0,node.start).split('\n').length,calls:calls(node.body)})),
      constants:tree.body.filter(node=>node.type==='VariableDeclaration').flatMap(node=>node.declarations.filter(item=>item.id.type==='Identifier').map(item=>({name:item.id.name,initializer:item.init ? source.slice(item.init.start,item.init.end) : null}))),
    };
  } catch { return undefined; }
}

// Turn a standalone ESM script function into the existing JSON main protocol.
// Preserve business bodies; only remove imports/startup and bind selected constants.
export function adaptSource(source, spec) {
  if (!spec || typeof spec !== 'object' || Object.keys(spec).some(key=>!['path','call','arguments','bindings','entrypoint'].includes(key))) throw new Error('Invalid source function adapter');
  const tree = syntax(source), args = spec.arguments ?? [], bindings = spec.bindings ?? {};
  const fn = tree.body.find(node=>node.type==='FunctionDeclaration' && node.id.name===spec.call);
  if (!fn || !Array.isArray(args) || args.some(key=>typeof key!=='string' || !key)) throw new Error('Select a declared source function and input field names for its arguments');
  if (!bindings || typeof bindings!=='object' || Array.isArray(bindings) || Object.values(bindings).some(key=>typeof key!=='string'||!key)) throw new Error('Source bindings map constant names to input field names');
  if (tree.body.some(node=>node.type.startsWith('Export'))) throw new Error('Use existing exported module main directly; this adapter accepts standalone scripts');
  const required = fn.params.reduce((n,param,index)=>param.type!=='AssignmentPattern' && param.type!=='RestElement' ? index+1 : n,0);
  if (args.length < required) throw new Error('Map every required source argument: '+spec.call);
  const edits = [], imports = [], bound = new Set();
  const entryCall = node => node?.type==='AwaitExpression' ? entryCall(node.argument) : node?.type==='CallExpression' ? (node.callee.type==='Identifier' ? node.callee.name===(spec.entrypoint ?? 'main') : node.callee.type==='MemberExpression' && entryCall(node.callee.object)) : false;
  for (const node of tree.body) {
    if (node.type==='ImportDeclaration') { imports.push(source.slice(node.start,node.end)); edits.push({start:node.start,end:node.end,text:''}); }
    if (node.type==='ExpressionStatement' && entryCall(node.expression)) edits.push({start:node.start,end:node.end,text:''});
    if (node.type==='VariableDeclaration') for (const declaration of node.declarations) {
      if (declaration.id.type!=='Identifier' || !Object.hasOwn(bindings,declaration.id.name)) continue;
      if (!declaration.init) throw new Error('Source constant has no initializer: '+declaration.id.name);
      bound.add(declaration.id.name);
      const key = JSON.stringify(bindings[declaration.id.name]);
      // A binding is an optional configuration override. Preserve the original
      // initializer (including derivation from earlier bound constants).
      edits.push({start:declaration.init.start,end:declaration.init.end,text:'(Object.hasOwn(__skillxSourceInput,'+key+') ? __skillxSourceInput['+key+'] : ('+source.slice(declaration.init.start,declaration.init.end)+'))'});
    }
  }
  if (Object.keys(bindings).some(name=>!bound.has(name))) throw new Error('Source binding must name a top-level variable');
  if (source.startsWith('#!')) edits.push({start:0,end:source.indexOf('\n')+1,text:''});
  let body = source;
  for (const edit of edits.sort((a,b)=>b.start-a.start)) body=body.slice(0,edit.start)+edit.text+body.slice(edit.end);
  const fields = [...new Set(args.filter((_,index)=>fn.params[index] && !['AssignmentPattern','RestElement'].includes(fn.params[index].type)))];
  const guard = 'for (const key of '+JSON.stringify(fields)+') if (!Object.hasOwn(__skillxSourceInput,key)) throw new Error("Required source input: "+key);';
  // Source preparation/writing functions legitimately return void. Keep their
  // effects and provide a JSON value rather than forcing an author to rewrite them.
  const adapted = imports.join('\n')+'\nexport async function main(__skillxSourceInput) {\n'+guard+'\n'+body+'\nconst __skillxSourceResult = await '+spec.call+'('+args.map(key=>'__skillxSourceInput['+JSON.stringify(key)+']').join(',')+');\nreturn __skillxSourceResult === undefined ? null : __skillxSourceResult;\n}\n';
  syntax(adapted);
  return adapted;
}
