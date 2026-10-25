import { parse } from 'acorn';

/** Read-only projection of executable syntax. Unknown JS remains an explicit
 * opaque block; never turn comments or dependency declarations into flow edges.
 * A Promise.all boundary is syntax, not a promise of parallel native effects.
 */
export function workflowGraph(entries, rootName) {
  const definitions=new Map(entries.map(entry=>[entry.name,entry]));
  const nodes=[],edges=[],limitations=new Set();
  let serial=0;
  const add=(label,type,entry,ast,extra={})=>{
    const node={id:'n'+(++serial),label,type,capability:entry.name,version:entry.version,...(ast?.loc?{line:Math.max(1,ast.loc.start.line-1)}:{}),...extra};nodes.push(node);return node.id;
  };
  const connect=(from,to,label)=>{for(const id of from) edges.push({from:id,to,...(label?{label}:{})});};
  const opaque=(ast,frontier,entry,reason)=>{limitations.add(reason);const id=add(reason,'opaque',entry,ast);connect(frontier,id);return [id];};
  const member=node=>node?.type==='MemberExpression' && !node.computed ? [node.object?.name,node.property?.name].join('.') : '';
  // JSON-schema primitive inputs and non-shadowed synchronous predicates cannot
  // launch background work. Keep arbitrary helpers opaque. If the program writes
  // or shadows these bindings, decline this inference for the whole definition.
  const synchronous = (node, scope) => {
    if (!scope?.primitiveInference || node?.type !== 'CallExpression') return false;
    const method = member(node.callee);
    if (['Number.isInteger', 'Number.isFinite', 'Array.isArray'].includes(method))
      return !node.arguments.some(value => containsCall(value, scope));
    const receiver = node.callee?.object;
    return node.callee?.type === 'MemberExpression' && !node.callee.computed &&
      ['endsWith', 'startsWith', 'includes', 'trim', 'toLowerCase', 'toUpperCase'].includes(node.callee.property.name) &&
      receiver?.type === 'MemberExpression' && !receiver.computed && receiver.object?.name === 'input' &&
      scope.entry.execution?.inputSchema?.properties?.[receiver.property.name]?.type === 'string' &&
      node.arguments.every(value => value.type === 'Literal');
  };
  const containsCall=(node, scope)=>{
    if(!node||typeof node!=='object')return false;
    if(synchronous(node, scope))return false;
    if(node.type==='CallExpression'||node.type==='NewExpression'||node.type==='ImportExpression'||node.type==='AwaitExpression')return true;
    return Object.values(node).some(value=>Array.isArray(value)?value.some(item=>containsCall(item,scope)):value&&typeof value==='object'&&containsCall(value,scope));
  };
  function expand(entry,frontier,path,ast) {
    if(path.includes(entry.name))return opaque(ast,frontier,entry,'递归调用：静态展开停止');
    const start=add(entry.name,'workflow-start',entry,ast),end=add(entry.name,'workflow-end',entry,ast);connect(frontier,start);
    if(entry.execution?.language!=='typescript'){connect(opaque(ast,[start],entry,'外部脚本：内部控制流未展开'),end);return [end];}
    let body;
    try{body=parse('(async function(){\n'+entry.execution.program+'\n})',{ecmaVersion:'latest',locations:true}).body[0].expression.body.body;}
    catch {connect(opaque(ast,[start],entry,'程序无法解析'),end);return [end];}
    let primitiveInference = true;
    const reservedBinding = pattern => {
      if (!pattern || typeof pattern !== 'object') return false;
      if (pattern.type === 'Identifier') return ['Number', 'Array', 'input'].includes(pattern.name);
      return Object.values(pattern).some(value => Array.isArray(value) ? value.some(reservedBinding) : value && typeof value === 'object' && reservedBinding(value));
    };
    const inspect = node => {
      if (!node || typeof node !== 'object') return;
      if (['AssignmentExpression', 'UpdateExpression', 'NewExpression', 'ImportExpression'].includes(node.type) ||
          (node.type === 'UnaryExpression' && node.operator === 'delete') ||
          (node.type === 'Identifier' && ['eval', 'Function', 'globalThis', 'Object', 'Reflect'].includes(node.name)) ||
          (['VariableDeclarator', 'FunctionDeclaration', 'ClassDeclaration'].includes(node.type) &&
           reservedBinding(node.id))) primitiveInference = false;
      // Helpers may mutate intrinsics, including via parameters or closures.
      if (['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration'].includes(node.type)) primitiveInference = false;
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(inspect); else if (value && typeof value === 'object') inspect(value);
    };
    body.forEach(inspect);
    const scope={entry,path:[...path,entry.name],end,primitiveInference};
    const tails=statements(body,[start],scope);connect(tails,end);
    if(!edges.some(edge=>edge.to===end)) {nodes.splice(nodes.findIndex(node=>node.id===end),1);return [];}
    return [end];
  }
  function expression(ast,frontier,scope) {
    if(!ast)return frontier;
    const {entry,path}=scope;
    if(ast.type==='AwaitExpression')return expression(ast.argument,frontier,scope);
    if(synchronous(ast,scope))return frontier;
    if(ast.type==='CallExpression') {
      const method=member(ast.callee);
      if(ast.callee?.name==='require' && ast.arguments.length===1 && ast.arguments[0].type==='Literal' && /^node:/.test(ast.arguments[0].value)) return frontier;
      if(method==='capabilities.run') {
        const object=ast.arguments[0];
        const name=object?.type==='ObjectExpression' && !object.properties.some(p=>p.type==='SpreadElement') && object.properties.find(p=>!p.computed&&(p.key?.name??p.key?.value)==='name')?.value;
        if(containsCall(object,scope))return opaque(ast,frontier,entry,'能力参数包含动态操作');
        const target=name?.type==='Literal'&&typeof name.value==='string'?definitions.get(name.value):null;
        const lock=entry.dependencies?.find(lock=>lock.name===name?.value);
        if(!target||!lock||target.version!==lock.version)return opaque(ast,frontier,entry,'动态或未解析的能力调用');
        if(target.kind==='workflow')return expand(target,frontier,path,ast);
        const id=add(target.name,'skill',target,ast);connect(frontier,id);return [id];
      }
      if(['Promise.all','Promise.allSettled'].includes(method)) {
        const values=ast.arguments[0];
        if(values?.type!=='ArrayExpression'||values.elements.some(value=>!value||value.type==='SpreadElement'||value.type==='Identifier'||value.type==='AwaitExpression'))return opaque(ast,frontier,entry,'动态并行集合：成员与依赖未知');
        const fork=add(method,'parallel-start',entry,ast),join=add(method==='Promise.all'?'全部成功后继续；拒绝进入异常路径':'全部结束后继续','parallel-join',entry,ast);connect(frontier,fork);
        let rejects=false;
        for(const value of values.elements) {
          const before=nodes.length,tails=expression(value,[fork],scope);
          connect(tails,join);
          if(!tails.length) {
            rejects=true;
            connect(nodes.slice(before).filter(node=>node.type==='throw').map(node=>node.id),join,'rejected');
          }
        }
        if(!values.elements.length)connect([fork],join);
        if(rejects&&method==='Promise.all') {
          Object.assign(nodes.find(node=>node.id===join),{type:'parallel-reject',label:'分支抛错：不会进入成功后续'});
          return [];
        }
        return [join];
      }
      if(['processes.run','processes.checkedRun','resources.run','tools.call'].includes(method)) {
        if(containsCall(ast.arguments,scope))return opaque(ast,frontier,entry,'调用参数包含动态操作');
        const id=add(method,'operation',entry,ast);connect(frontier,id);return [id];
      }
      return opaque(ast,frontier,entry,'动态函数调用：'+(method||ast.callee.name||'expression'));
    }
    if(containsCall(ast,scope))return opaque(ast,frontier,entry,'表达式内部控制流未静态展开');
    return frontier;
  }
  function statement(ast,frontier,scope) {
    if(!frontier.length)return [];
    const {entry}=scope;
    if(ast.type==='BlockStatement')return statements(ast.body,frontier,scope);
    if(ast.type==='VariableDeclaration') {
      let tails=frontier;
      for(const item of ast.declarations) {
        // An unawaited promise can overlap subsequent statements. Do not render
        // the remaining block as serial when lifetime/data flow is unknown.
        if(item.init && containsCall(item.init,scope) && item.init.type!=='AwaitExpression' && !(item.init.type==='CallExpression' && item.init.callee.name==='require' && item.init.arguments[0]?.type==='Literal' && /^node:/.test(item.init.arguments[0].value)))return null;
        tails=expression(item.init,tails,scope);
      }
      return tails;
    }
    if(ast.type==='ExpressionStatement') {
      if(containsCall(ast.expression,scope)&&ast.expression.type!=='AwaitExpression')return null;
      return expression(ast.expression,frontier,scope);
    }
    if(ast.type==='ReturnStatement') {connect(expression(ast.argument,frontier,scope),scope.end,'return');return [];}
    if(ast.type==='ThrowStatement') {const failure=add('抛出错误','throw',entry,ast);connect(expression(ast.argument,frontier,scope),failure);return [];}
    if(ast.type==='IfStatement') {
      if(containsCall(ast.test,scope))return null;
      const branch=add('条件分支','condition',entry,ast);connect(frontier,branch);
      const yes=add('条件成立','branch',entry,ast),no=add('条件不成立','branch',entry,ast);connect([branch],yes,'true');connect([branch],no,'false');
      const left=statement(ast.consequent,[yes],scope),right=ast.alternate?statement(ast.alternate,[no],scope):[no];
      if(left===null||right===null)return null;
      const tails=[...left,...right];if(!tails.length)return [];
      const joined=add('分支汇合','join',entry,ast);connect(tails,joined);return [joined];
    }
    if(['FunctionDeclaration','EmptyStatement'].includes(ast.type))return frontier;
    if(['ForStatement','ForOfStatement','ForInStatement','WhileStatement','DoWhileStatement','TryStatement','SwitchStatement'].includes(ast.type))return null;
    return containsCall(ast,scope)?null:frontier;
  }
  function statements(body,frontier,scope) {
    let tails=frontier;
    for(let i=0;i<body.length&&tails.length;i++) {
      const savedNodes=nodes.length,savedEdges=edges.length;
      const next=statement(body[i],tails,scope);
      if(next===null) {
        nodes.length=savedNodes;edges.length=savedEdges;
        // Includes the remainder so later awaits cannot acquire false ordering.
        const unknown=opaque(body[i],tails,scope.entry,'动态控制区间（含后续语句）：无法静态证明调用顺序');
        // Preserve evidenced call sites inside an opaque interval as containment,
        // never as serial/parallel execution edges. This also exposes locked
        // nested workflows in ordinary try/loop/helper-heavy programs.
        const visit=ast=>{
          if(!ast||typeof ast!=='object')return;
          if(ast.type==='CallExpression' && ['Promise.all','Promise.allSettled'].includes(member(ast.callee)) && ast.arguments[0]?.type==='ArrayExpression'
            && ast.arguments[0].elements.every(value=>value && !['SpreadElement','Identifier','AwaitExpression'].includes(value.type))) {
            // A local fork/join is visible even when surrounding control flow
            // is opaque. Containment does not assert when it is reached.
            const before=nodes.length;
            expression(ast,[],scope);
            edges.push({from:unknown[0],to:nodes[before].id,relation:'contains',label:'区间内并行表达式；到达条件未知'});
            return;
          }
          if(ast.type==='CallExpression'&&member(ast.callee)==='capabilities.run') {
            const object=ast.arguments[0];
            const name=object?.type==='ObjectExpression'&&!object.properties.some(p=>p.type==='SpreadElement')&&object.properties.find(p=>!p.computed&&(p.key?.name??p.key?.value)==='name')?.value;
            const target=name?.type==='Literal'?definitions.get(name.value):null;
            const lock=scope.entry.dependencies?.find(lock=>lock.name===name?.value);
            if(target&&lock&&target.version===lock.version) {
              const before=nodes.length;
              if(target.kind==='workflow')expand(target,[],scope.path,ast);
              else add(target.name,'skill',target,ast);
              edges.push({from:unknown[0],to:nodes[before].id,relation:'contains',label:'区间内可能调用；顺序与次数未知'});
            }
          }
          for(const value of Object.values(ast)) if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);
        };
        body.slice(i).forEach(visit);
        return unknown;
      }
      tails=next;
    }
    return tails;
  }
  const root=definitions.get(rootName);
  if(!root)throw new Error('Workflow definition unavailable');
  expand(root,[],[]);
  return {basis:'executable-syntax-v1',rootRevisionId:root.revisionId,nodes,edges,limitations:[...limitations]};
}
