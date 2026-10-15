window.__ModuleLoader__.load({
  id: 'dsh-skillx-workflow',
  factory(require) {
    const React = require('react')
    const { MenuItemButton, Button, StateDot, IconCloseOutlineRegular, IconRightUpOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const NS = 'skillx-workflow'
    // Match the source text so a revised capability never receives a stale translation.
    const descriptionTranslations = new Map([
      ['Commit all pending modified/untracked files in a Git repo exactly once with a fixed message, without creating branches or touching remotes, and verify the resulting clean state.', '使用固定提交信息一次性提交 Git 仓库中所有待处理修改及未跟踪文件，并确认工作区干净；不创建分支或操作远端。'],
      ['End-to-end local-only flow: commit all pending changes once with a fixed message, then create, merge, and read back a simulated merge request against a local mock Git hosting service (loopback JSON API); no remotes or real push.', '一次性提交所有待处理修改，再通过本地模拟 Git 服务创建、合并并回查合并请求；全程在本地执行，不操作远端或实际推送。'],
      ["Absolute path of the isolated Git repo (the only repo touched)", "隔离 Git 仓库的绝对路径，仅操作此仓库。"],
      ["Loopback mock service base URL, e.g. http://127.0.0.1:8876", "本地模拟服务地址，例如 http://127.0.0.1:8876。"],
      ["Path to the mock service API doc; the program verifies it describes the /api/mrs contract with idempotencyKey", "模拟服务 API 文档路径，须包含支持 idempotencyKey 的 /api/mrs 接口约定。"],
      ["Fixed commit message to use exactly once", "本次提交使用的固定信息，仅提交一次。"],
      ["Expected baseline/main SHA (40 hex; also the service's initial targetHead)", "预期的 main 分支基线 SHA，40 位十六进制值，也是服务初始 targetHead。"],
      ["Expected fixture identity returned by /health and stored in the repo's .fixture-id", "预期的环境标识，须与 /health 返回值及仓库 .fixture-id 一致。"],
      ["MR title; defaults to commit_message", "合并请求标题，默认使用提交信息。"],
      ["Stable unique key for MR creation; generated once if omitted", "创建合并请求的固定唯一幂等键，留空时自动生成。"],
      ["Stable unique key for MR merge; generated once if omitted", "合并请求的固定唯一幂等键，留空时自动生成。"],
      ["Expected `git status --porcelain -uall` entries (status + path), e.g. [\" M docs/checklist.md\",\" M src/message.txt\",\"?? data/sample.json\",\"?? notes.txt\",\"?? src/new-feature.txt\"]", "预期的 Git 状态条目，格式为状态加文件路径，例如「 M src/message.txt」。"],
    ])
    const displayDescription = description => descriptionTranslations.get(description) ?? description ?? ''
    const fieldLabels = { repo_path: '仓库路径', api_base_url: '模拟服务地址', api_doc_path: '接口文档路径', commit_message: '提交信息', baseline_sha: '基线提交 SHA', fixture_id: '环境标识', mr_title: '合并请求标题', idempotency_key_create: '创建幂等键', idempotency_key_merge: '合并幂等键', expected_changes: '预期文件变更', a: '数值 A', b: '数值 B' }
    const stageLabels = new Map([
      ['read API doc (contract governs every call)', '读取接口文档并确认调用约定'],
      ['service state', '检查模拟服务状态'],
      ['repo state', '检查仓库状态'],
      ['commit exactly once', '提交待处理变更（仅一次）'],
      ['verify commit', '验证提交结果'],
      ['create simulated MR', '创建模拟合并请求'],
      ['merge simulated MR', '合并模拟请求'],
      ['mandatory readback', '回查合并结果'],
      ['audit + final service/local verification', '审计并核验服务及本地状态'],
      ['report', '输出执行报告'],
    ])
    const dictionaries = {
      zh: { skillx: 'SkillX', workflow: '工作流', extract: '总结工作流', refresh: '刷新', open: '打开完整管理页面', empty: '暂无内容', loading: '加载中…', running: '正在总结工作流…', completed: '工作流总结完成', skipped: '未发现值得提取的可复用能力', failed: '工作流总结失败', dismiss: '关闭', manual: '工作流仅在你选择“总结工作流”时生成。', priority: '同名能力优先使用 SkillX 或工作流。' },
      en: { skillx: 'SkillX', workflow: 'Workflows', extract: 'Summarize workflow', refresh: 'Refresh', open: 'Open management page', empty: 'No entries yet', loading: 'Loading…', running: 'Summarizing workflow…', completed: 'Workflow summary completed', skipped: 'No worthwhile reusable capability found', failed: 'Workflow summary failed', dismiss: 'Dismiss', manual: 'Workflows are generated only when you choose “Summarize workflow”.', priority: 'SkillX and workflows take precedence over skills with the same name.' },
    }
    Object.assign(dictionaries.zh, { search: '按名称或描述筛选', noMatches: '没有匹配的内容', enabled: '启用', disabled: '停用', back: '返回', optimize: '优化', execution: '执行会话 ID（多个用逗号或空格分隔）', cancel: '取消任务', details: '详情', result: '查看提取结果', conversation: '查看提取对话' })
    Object.assign(dictionaries.en, { search: 'Filter by name or description', noMatches: 'No matching entries', enabled: 'Enabled', disabled: 'Disabled', back: 'Back', optimize: 'Optimize', execution: 'Execution session IDs (comma or space separated)', cancel: 'Cancel task', details: 'Details', result: 'View extraction result', conversation: 'View author conversation' })
    Object.assign(dictionaries.zh, {"monitoring":"监控面板","tokens":"Token 消耗","success":"任务成功率","failure":"任务失败率","skillxCalls":"SkillX 调用量","workflowCalls":"Workflow 调用量","duration":"任务耗时排行","reasons":"失败原因排行","timeRange":"时间范围","custom":"自定义","hours":"小时","days":"天","start":"开始日期","end":"结束日期","invalidRange":"请选择有效日期，范围最多 366 天","trend":"趋势","noSamples":"无样本","rank":"排名","task":"任务","status":"状态","createdAt":"创建时间","reason":"失败原因","count":"次数","previous":"上一页","next":"下一页","unfinished":"未结束","blocked":"阻塞","cancelled":"已取消","queued":"排队中","sessions":"Session / 执行记录","records":"查看原始记录","runId":"执行 ID","monitoringIntro":"用量与执行质量。每个面板可独立选择时间。","callsBasis":"按原生顶层能力执行计数；不重复计算内部依赖与恢复。","tokensBasis":"原生能力执行及学习任务已上报的 Token；不包含普通对话及独立后台维护。","tasksBasis":"按创建时间统计能力执行和学习任务；取消与未结束任务不计入成功/失败率。","incompleteUsage":"个任务的用量未上报或不完整，仅汇总已知用量","skippedRecords":"条记录无法读取，未计入统计","sessionsBasis":"原生执行记录可分页查看工具参数、结果与结束状态；学习任务可打开 DSH 会话。敏感字段脱敏。"})
    Object.assign(dictionaries.en, {"monitoring":"Monitoring","tokens":"Token usage","success":"Task success rate","failure":"Task failure rate","skillxCalls":"SkillX calls","workflowCalls":"Workflow calls","duration":"Task duration ranking","reasons":"Failure reasons","timeRange":"Time range","custom":"Custom","hours":" hours","days":" days","start":"Start date","end":"End date","invalidRange":"Choose valid dates spanning at most 366 days","trend":"Trend","noSamples":"No samples","rank":"Rank","task":"Task","status":"Status","createdAt":"Created at","reason":"Failure reason","count":"Count","previous":"Previous","next":"Next","unfinished":"Unfinished","blocked":"Blocked","cancelled":"Cancelled","queued":"Queued","sessions":"Session / execution records","records":"View raw records","runId":"Execution ID","monitoringIntro":"Usage and execution quality. Each panel has its own time range.","callsBasis":"Top-level native capability executions; excludes duplicate dependency and recovery calls.","tokensBasis":"Reported native execution and learning tokens; excludes ordinary chat and independent background maintenance.","tasksBasis":"Native executions and learning tasks by creation time; cancelled and unfinished tasks are excluded from rates.","incompleteUsage":"tasks have missing or incomplete usage; only known usage is summed","skippedRecords":"unreadable records excluded from statistics","sessionsBasis":"Page through native tool arguments, results and end states, or open the DSH learning session. Sensitive fields are redacted."})
    Object.assign(dictionaries.zh, { elapsed: '耗时', executionSettled: '执行已完成', statusCompleted: '成功', statusFailed: '失败', statusRunning: '运行中' })
    Object.assign(dictionaries.en, { elapsed: 'Duration', executionSettled: 'Execution settled', statusCompleted: 'Succeeded', statusFailed: 'Failed', statusRunning: 'Running' })
    Object.assign(dictionaries.zh, { savings: '预计 Token 节省', savingsBasis: '原始提取会话平均用量 × 成功复用次数 − 执行用量。按任务规模相当估算；不含调用方对话、提取及后台维护成本。负值表示额外消耗。', baselineTotal: '原始流程估算', executionTotal: '执行用量', estimatedRate: '估算节省率', estimatedRuns: '已估算执行', excludedRuns: '缺少基线或完整用量' })
    Object.assign(dictionaries.en, { savings: 'Expected token savings', savingsBasis: 'Average original extraction-session usage × successful reuses − execution usage. Assumes comparable workloads; excludes caller chat, extraction and background maintenance. Negative values mean extra usage.', baselineTotal: 'Estimated original usage', executionTotal: 'Execution usage', estimatedRate: 'Estimated savings rate', estimatedRuns: 'Estimated executions', excludedRuns: 'Missing baseline or complete usage' })
    Object.assign(dictionaries.zh, { recordingFailed: '执行已结束，会话记录保存失败', fillObject: '填写对象', optionalParameters: '可选参数', execute: '执行', runConfig: '运行配置', formInput: '表单输入', jsonInput: 'JSON 输入', invalidJson: '请输入有效 JSON', chooseValue: '请选择', yes: '是', no: '否', addItem: '添加一项', removeItem: '删除此项', dag: '工作流 DAG', graphInput: '输入参数', graphOutput: '执行结果', graphNodes: '个节点', graphBoundary: '输入 / 输出', graphStage: '阶段', graphStagesNote: '执行阶段概览；分支和循环在阶段内执行。', graphProgramNote: '当前程序未定义独立阶段，按整体执行单元展示。', graphDependencies: '已声明依赖', needsContract: '此旧版能力尚无执行接口。可基于已有证据生成，无需填写会话 ID。', prepareContract: '生成执行接口', preparingContract: '正在生成执行接口…', noParameters: '此能力无需填写参数', runtimeOptions: '运行选项', workingDirectory: '工作目录', defaultDirectory: '使用 DSH 默认工作目录', disabledExecution: '能力已停用，请先在列表中启用。', runHistory: '执行记录', noRuns: '提交参数后将在这里展示执行结果。', executionSession: '查看执行会话', capabilityNotes: '能力说明与来源', interrupted: '执行中断', cancelling: '正在取消', contractPrepared: '执行接口已生成', contractFailed: '执行接口生成失败', statisticsInfo: '统计说明', shortSavings: '估算节省率', shortCoverage: '次执行', missingComparison: '次无法估算' })
    Object.assign(dictionaries.en, { recordingFailed: 'Execution settled; session recording failed', fillObject: 'Fill object', optionalParameters: 'Optional parameters', execute: 'Execute', runConfig: 'Run configuration', formInput: 'Form input', jsonInput: 'JSON input', invalidJson: 'Enter valid JSON', chooseValue: 'Select a value', yes: 'Yes', no: 'No', addItem: 'Add item', removeItem: 'Remove item', dag: 'Workflow DAG', graphInput: 'Input', graphOutput: 'Output', graphNodes: 'nodes', graphBoundary: 'Input / output', graphStage: 'Stage', graphStagesNote: 'Stage overview; branches and loops execute inside stages.', graphProgramNote: 'This program has no separate stages; shown as one execution unit.', graphDependencies: 'Declared dependencies', needsContract: 'This legacy capability needs an executable contract. Generate it from existing evidence without entering a session ID.', prepareContract: 'Generate execution interface', preparingContract: 'Generating execution interface…', noParameters: 'No input parameters required', runtimeOptions: 'Runtime options', workingDirectory: 'Working directory', defaultDirectory: 'Use the DSH default working directory', disabledExecution: 'Enable this capability in the list before executing.', runHistory: 'Execution history', noRuns: 'Submit parameters to see execution results here.', executionSession: 'Open execution session', capabilityNotes: 'Capability notes and source', interrupted: 'Interrupted', cancelling: 'Cancelling', contractPrepared: 'Execution interface ready', contractFailed: 'Execution interface generation failed', statisticsInfo: 'Statistics details', shortSavings: 'Estimated savings rate', shortCoverage: 'executions', missingComparison: 'executions not estimated' })
    Object.assign(dictionaries.zh, {sessionNotReady:'会话尚未创建，请稍后重试'})
    Object.assign(dictionaries.en, {sessionNotReady:'Session is not ready yet. Try again shortly.'})
    Object.assign(dictionaries.zh, { deleteEntry: '删除', confirmDelete: '确认删除', deleteWarning: '删除后将从能力目录移除，历史执行记录保留。', deleteInUse: '无法删除，以下能力依赖此项：', deleteChanged: '能力已更新，请刷新后再删除。' })
    Object.assign(dictionaries.en, { deleteEntry: 'Delete', confirmDelete: 'Confirm deletion', deleteWarning: 'Remove from the catalog; retain execution history.', deleteInUse: 'Cannot delete; referenced by: ', deleteChanged: 'Capability changed. Refresh before deleting.' })
    const box = { padding: 16, height: '100%', minWidth: 0, boxSizing: 'border-box', overflow: 'hidden', color: 'var(--dsw-alias-label-primary)' }
    async function api(path, options) {
      const response = await fetch('/skillx-workflow/api/' + path, options)
      const raw = await response.text()
      let data
      try { data = JSON.parse(raw) } catch { throw new Error('Workflow service unavailable (HTTP ' + response.status + '). Check plugin startup and engine logs.') }
      if (!response.ok || data.error) throw Object.assign(new Error(data.error?.message || data.error || response.statusText), { code: data.code, dependents: data.dependents })
      return data
    }
    function Icon({ size = 16 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
        h('rect', { x: 3, y: 3, width: 6, height: 6, rx: 1 }), h('rect', { x: 15, y: 15, width: 6, height: 6, rx: 1 }), h('path', { d: 'M9 6h9v9M6 9v9h9' }))
    }
    return {
      name: 'dsh-skillx-workflow/client',
      inject: ['slots', 'locale', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries))
        const t = ctx.locale.bind(NS)
        const listeners = new Set()
        const pending = new Map()
        let notice = null
        let disposed = false
        const timers = new Set()
        const update = value => { notice = value; for (const listener of listeners) listener() }
        const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
        const sleep = () => new Promise(resolve => { const timer = setTimeout(() => { timers.delete(timer); resolve() }, 1500); timers.add(timer) })
        ctx.effect(() => () => { disposed = true; for (const timer of timers) clearTimeout(timer); listeners.clear() })
        async function runTask(route, input) {
          const key = route + ':' + (input.sessionIds?.join(',') || input.sessionId || '') + ':' + (input.name || '')
          if (pending.has(key)) return
          pending.set(key, true)
          update({ kind: 'running', operation: route })
          try {
            const task = await api(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
            update({ kind: 'running', operation: route, taskId: task.taskId, generatorSessionId: task.activeGeneratorSessionId || task.generatorSessionId })
            while (!disposed) {
              const status = await api('status?taskId=' + encodeURIComponent(task.taskId))
              const info = { operation: route, taskId: task.taskId, generatorSessionId: status.activeGeneratorSessionId || status.generatorSessionId || task.generatorSessionId, entries: status.entries, outcome: status.outcome, detail: status.skipReason }
              if (['completed', 'done', 'succeeded'].includes(status.status)) { update({ kind: 'completed', ...info }); break }
              if (['failed', 'error', 'cancelled'].includes(status.status)) { update({ kind: 'failed', detail: typeof status.error === 'string' ? status.error : JSON.stringify(status.error || status.status), ...info }); break }
              update({ kind: 'running', ...info })
              await sleep()
            }
          } catch (error) { if (!disposed) update({ kind: 'failed', operation: route, detail: error.message }) }
          finally { pending.delete(key) }
        }
        const extract = sessionId => runTask('extract', { sessionId })
        function DeleteEntry({ entry, onDeleted }) {
          const [confirming, setConfirming] = React.useState(false)
          const [busy, setBusy] = React.useState(false)
          const [error, setError] = React.useState('')
          async function remove() {
            if (busy) return
            setBusy(true); setError('')
            try {
              await api('entries/' + encodeURIComponent(entry.name), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: entry.version, revisionId: entry.revisionId }) })
              await onDeleted()
            } catch (error) { setError(error.code === 'CAPABILITY_IN_USE' ? t('deleteInUse') + error.dependents.map(item => item.name).join('、') : error.code === 'CAPABILITY_CHANGED' ? t('deleteChanged') : error.message) }
            finally { setBusy(false) }
          }
          return h('div', { style: { maxWidth: '100%' } },
            !confirming ? h(Button, { variant: 'ghost', size: 'sm', 'aria-label': t('deleteEntry') + ' ' + entry.name, onClick: () => setConfirming(true) }, t('deleteEntry')) : h('div', null,
              h('p', { style: { fontSize: 12, margin: '4px 0', overflowWrap: 'anywhere' } }, entry.name + ' — ' + t('deleteWarning')),
              h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: remove }, t('confirmDelete')),
              h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => { setConfirming(false); setError('') } }, t('dismiss'))),
            error && h('p', { role: 'alert', style: { fontSize: 12, overflowWrap: 'anywhere' } }, error))
        }
        function Page({ kind }) {
          const [data, setData] = React.useState(null)
          const [error, setError] = React.useState('')
          const [query, setQuery] = React.useState('')
          const [entry, setEntry] = React.useState(null)
          const [busy, setBusy] = React.useState(null)
          const state = React.useSyncExternalStore(subscribe, () => notice)
          const reload = () => { setError(''); return api('catalog').then(setData, error => setError(error.message)) }
          React.useEffect(() => { let active = true; api('catalog').then(value => { if (active) setData(value) }, error => { if (active) setError(error.message) }); return () => { active = false } }, [state?.kind])
          React.useEffect(() => { setEntry(null); setQuery('') }, [kind])
          React.useEffect(() => {
            if (state?.kind !== 'completed' || !entry) return
            let active = true
            api('entries/' + encodeURIComponent(entry.name)).then(value => { if (active) setEntry(value) }, error => { if (active) setError(error.message) })
            return () => { active = false }
          }, [state?.kind, state?.taskId])
          const rows = (kind === 'skillx' ? data?.capabilities : data?.workflows) || []
          const filtered = rows.filter(row => (row.name + ' ' + displayDescription(row.description)).toLowerCase().includes(query.toLowerCase()))
          const control = { font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-specific-sidebar-fill)', border: '1px solid var(--sxw-control-border)', borderRadius: 'var(--dsw-radius-md, 8px)', padding: '8px 10px' }
          async function open(row) {
            setBusy(row.name); setError('')
            try { setEntry(await api('entries/' + encodeURIComponent(row.name))) } catch (error) { setError(error.message) } finally { setBusy(null) }
          }
          async function toggle(row) {
            setBusy(row.name); setError('')
            try { await api('entries/' + encodeURIComponent(row.name) + '/availability', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: row.enabled === false }) }); await reload() } catch (error) { setError(error.message) } finally { setBusy(null) }
          }
          return h('section', { className: 'sxw-page', style: { ...box, padding: 0, display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 1248, margin: '0 auto' }, 'aria-label': t(kind) },
            h('style', null, '.sxw-page .sxw-row:last-child{border-bottom:0!important}.sxw-page .sxw-row:hover{background:var(--dsw-specific-sidebar-fill)}.sxw-page .sxw-name{white-space:normal!important;height:auto!important;text-align:left;overflow-wrap:anywhere;max-width:100%;justify-content:flex-start}.sxw-page .sxw-name:focus-visible{outline:2px solid currentColor;outline-offset:3px}'),
            !entry && h('header', { style: { padding: '24px 24px 0', flexShrink: 0 } },
              h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: 12, border: '1px solid var(--sxw-border)', background: 'var(--dsw-specific-sidebar-fill)', borderRadius: 12 } },
                h('input', { type: 'search', value: query, placeholder: t('search'), 'aria-label': t('search'), onChange: event => setQuery(event.target.value), style: { ...control, background: 'transparent', width: 360, flex: '1 1 240px', maxWidth: '100%', minWidth: 0, boxSizing: 'border-box' } }),
                h(Button, { variant: 'ghost', size: 'sm', onClick: reload }, t('refresh')))),
            h('div', { style: { padding: '20px 24px 24px', overflow: 'auto', flex: 1, minHeight: 0, minWidth: 0 } },
              error && h('p', { role: 'alert' }, error),
              !data && !error && h('p', null, t('loading')),
              entry ? h(EntryDetail, { key: entry.revisionId, entry, onBack: () => setEntry(null), onDeleted: async () => { setEntry(null); await reload() }, preparing: state?.kind === 'running' }) :
                h('div', { style: { margin: 0, padding: '0 20px', minWidth: 0, border: '1px solid var(--sxw-border)', borderRadius: 14 } }, h('div', { style: { padding: '16px 0', fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)', borderBottom: '1px solid var(--sxw-divider)' } }, t(kind) + ' · ' + filtered.length), data && !filtered.length && h('p', { role: 'status', style: { padding: '16px 0', color: 'var(--dsw-alias-label-secondary)' } }, t(query ? 'noMatches' : 'empty')), filtered.map(row => h('div', { key: row.name, className: 'sxw-row', style: { display: 'flex', flexWrap: 'wrap', gap: '8px 16px', alignItems: 'flex-start', padding: '18px 0', borderBottom: '1px solid var(--sxw-divider)' } },
                  h('div', { style: { flex: '1 1 220px', minWidth: 0 } }, h(Button, { variant: 'ghost', size: 'sm', disabled: busy === row.name, onClick: () => open(row), className: 'sxw-name', style: { padding: 0, fontWeight: 600, fontSize: 14, lineHeight: '22px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } }, row.name),
                    h('p', { style: { margin: '6px 0 0', fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)', overflowWrap: 'anywhere' } }, displayDescription(row.description))),
                  h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, paddingTop: 2, fontSize: 12, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer' } }, h('input', { type: 'checkbox', role: 'switch', checked: row.enabled !== false, disabled: busy === row.name, 'aria-label': row.name + ' ' + t('enabled'), onChange: () => toggle(row), style: { accentColor: 'var(--dsw-alias-label-primary)' } }), t(row.enabled === false ? 'disabled' : 'enabled')),
                  h(DeleteEntry, { entry: row, onDeleted: reload }))))))
        }
        const control = { font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'transparent', border: '1px solid var(--sxw-control-border)', borderRadius: 8, padding: '6px 8px', maxWidth: '100%' }
        const note = { fontSize: 12, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)' }
        const card = { padding: 20, minWidth: 0, background: 'var(--dsw-specific-background, transparent)', border: '1px solid var(--sxw-border)', borderRadius: 14 }
        const initialValue = schema => {
          if (Object.hasOwn(schema, 'default')) return schema.default
          if (Object.hasOwn(schema, 'const')) return schema.const
          if (schema.type === 'object' || schema.properties) return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, child]) => [key, schema.required?.includes(key) || Object.hasOwn(child, 'default') || Object.hasOwn(child, 'const') ? initialValue(child) : undefined]).filter(([, value]) => value !== undefined))
          return undefined
        }
        function JsonField({ value, onChange, label, required, disabled }) {
          const [text, setText] = React.useState(value === undefined ? '' : JSON.stringify(value, null, 2))
          return h('textarea', { value: text, required, disabled, rows: 5, 'aria-label': label, style: { ...control, width: '100%', resize: 'vertical', fontFamily: 'ui-monospace, monospace' }, onInput: event => {
            const input = event.currentTarget; setText(input.value)
            try { const parsed = input.value.trim() ? JSON.parse(input.value) : undefined; input.setCustomValidity(''); onChange(parsed) } catch { input.setCustomValidity(t('invalidJson')) }
          } })
        }
        function SchemaField({ schema, value, onChange, name, required = false, disabled = false, depth = 0 }) {
          const label = displayDescription(schema.title || fieldLabels[name.split('.').pop().replace(/\[\d+\]/g, '')] || name)
          const type = Array.isArray(schema.type) ? schema.type.find(type => type !== 'null') : schema.type || (schema.properties ? 'object' : 'string')
          const id = 'sxw-field-' + name
          const changeObject = (key, next) => onChange({ ...(value || {}), [key]: next })
          let field
          if (schema.oneOf || schema.anyOf || depth > 8 || !['string', 'number', 'integer', 'boolean', 'object', 'array'].includes(type)) field = h(JsonField, { value, onChange, label, required, disabled })
          else if (Object.hasOwn(schema, 'const')) field = h('input', { id, value: typeof schema.const === 'string' ? schema.const : JSON.stringify(schema.const), readOnly: true, style: { ...control, width: '100%', opacity: 0.7 } })
          else if (schema.enum) field = h('select', { id, value: value === undefined ? '' : String(schema.enum.findIndex(item => JSON.stringify(item) === JSON.stringify(value))), required, disabled, style: { ...control, width: '100%' }, onChange: event => onChange(event.target.value === '' ? undefined : schema.enum[Number(event.target.value)]) },
            h('option', { value: '' }, t('chooseValue')), schema.enum.map((item, index) => h('option', { key: index, value: String(index) }, typeof item === 'string' ? item : JSON.stringify(item))))
          else if (type === 'object' && !required && value === undefined) field = h(Button, { variant: 'ghost', type: 'button', size: 'sm', disabled, onClick: () => onChange(initialValue(schema) || {}) }, t('fillObject'))
          else if (type === 'object') field = h('div', { style: { display: 'grid', gap: 16, padding: depth ? 14 : 0, border: depth ? '1px solid var(--sxw-border)' : undefined, borderRadius: 10 } },
            Object.entries(schema.properties || {}).map(([key, child]) => h(SchemaField, { key, schema: child, name: name + '.' + key, required: schema.required?.includes(key), value: value?.[key], onChange: next => changeObject(key, next), disabled, depth: depth + 1 })),
            !Object.keys(schema.properties || {}).length && h(JsonField, { value, onChange, label, required, disabled }))
          else if (type === 'array') field = schema.items && !Array.isArray(schema.items) ? h('div', { style: { display: 'grid', gap: 10 } },
            (value || []).map((item, index) => h('div', { key: index, style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
              h('div', { style: { flex: 1, minWidth: 0 } }, h(SchemaField, { schema: schema.items, value: item, name: name + '[' + index + ']', required: true, disabled, depth: depth + 1, onChange: next => onChange(value.map((old, i) => i === index ? next : old)) })),
              h(Button, { variant: 'ghost', size: 'sm', type: 'button', disabled, 'aria-label': t('removeItem') + ' ' + (index + 1), onClick: () => onChange(value.filter((_, i) => i !== index)) }, '×'))),
            h(Button, { variant: 'ghost', size: 'sm', type: 'button', disabled: disabled || (schema.maxItems != null && (value || []).length >= schema.maxItems), onClick: () => onChange([...(value || []), initialValue(schema.items) ?? (schema.items.type === 'object' ? {} : '')]), style: { justifySelf: 'start' } }, '+ ' + t('addItem'))) : h(JsonField, { value, onChange, label, required, disabled })
          else if (type === 'boolean') field = h('select', { id, required, disabled, value: value === undefined ? '' : String(value), onChange: event => onChange(event.target.value === '' ? undefined : event.target.value === 'true'), style: { ...control, width: '100%' } }, h('option', { value: '' }, t('chooseValue')), h('option', { value: 'true' }, t('yes')), h('option', { value: 'false' }, t('no')))
          else field = h('input', { id, value: value ?? '', disabled, required, type: type === 'number' || type === 'integer' ? 'number' : schema.format === 'date' ? 'date' : 'text', step: type === 'integer' ? 1 : type === 'number' ? 'any' : undefined, min: schema.minimum, max: schema.maximum, minLength: schema.minLength, maxLength: schema.maxLength, pattern: schema.pattern, placeholder: schema.examples?.[0] == null ? undefined : String(schema.examples[0]), style: { ...control, width: '100%' }, onInput: event => onChange(event.currentTarget.value === '' && !required ? undefined : type === 'number' || type === 'integer' ? event.currentTarget.value === '' ? undefined : Number(event.currentTarget.value) : event.currentTarget.value) })
          return h('div', { style: { minWidth: 0 } },
            h('label', { htmlFor: id, style: { display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 8, overflowWrap: 'anywhere' } }, label, required && h('span', { style: { marginLeft: 4, color: 'var(--dsw-alias-label-secondary)' } }, '*')),
            field, schema.description && h('p', { title: displayDescription(schema.description), style: { ...note, margin: '6px 0 0', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, displayDescription(schema.description)))
        }
        function WorkflowDag({ entry }) {
          // Native workflows store programs, not the original engine's node
          // schema. Numbered code sections form a coarse stage graph; never
          // pretend they describe every conditional branch or loop.
          const stages = [...(entry.execution?.program || '').matchAll(/^\s*\/\/\s*-+\s*\d+[.)]\s*(.*?)\s*-*\s*$/gm)].map(match => stageLabels.get(match[1]) ?? match[1]).filter(Boolean).slice(0, 40)
          const nodes = [t('graphInput'), ...(stages.length ? stages : [entry.name]), t('graphOutput')]
          const graphRef = React.useRef(null)
          const [availableColumns, setAvailableColumns] = React.useState(2)
          React.useEffect(() => { const observer = new ResizeObserver(([size]) => setAvailableColumns(size.contentRect.width >= 700 ? 3 : size.contentRect.width >= 360 ? 2 : 1)); observer.observe(graphRef.current); return () => observer.disconnect() }, [])
          const columns = Math.min(availableColumns, nodes.length), width = columns * 256, height = Math.ceil(nodes.length / columns) * 126 + 12
          const point = index => { const row = Math.floor(index / columns), column = index % columns; return { x: 24 + (row % 2 ? columns - 1 - column : column) * 256, y: 16 + row * 126, row } }
          return h('article', { style: { ...card, marginBottom: 20 } },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' } }, h('h3', { style: { fontSize: 15, margin: '0 0 16px' } }, t('dag')), h('span', { style: note }, nodes.length + ' ' + t('graphNodes'))),
            h('div', { ref: graphRef, style: { overflow: 'auto', maxHeight: 520, background: 'var(--dsw-specific-sidebar-fill)', borderRadius: 10, padding: 8 } },
              h('svg', { viewBox: '0 0 ' + width + ' ' + height, role: 'img', 'aria-label': t('dag'), style: { width: '100%', minWidth: Math.min(256, width), height: 'auto', aspectRatio: width + '/' + height, display: 'block' } },
                h('defs', null, h('marker', { id: 'sxw-dag-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' }, h('path', { d: 'M0 0L10 5L0 10Z', fill: 'var(--sxw-line)' }))),
                nodes.slice(1).map((_, index) => {
                  const a = point(index), b = point(index + 1), forward = a.row % 2 === 0
                  const path = a.row === b.row ? 'M' + (a.x + (forward ? 204 : 0)) + ' ' + (a.y + 36) + 'H' + (b.x + (forward ? 0 : 204)) : 'M' + (a.x + 102) + ' ' + (a.y + 72) + 'V' + b.y
                  return h('path', { key: index, d: path, fill: 'none', stroke: 'var(--sxw-line)', strokeWidth: 1.8, markerEnd: 'url(#sxw-dag-arrow)' })
                }),
                nodes.map((label, index) => { const p = point(index); return h('g', { key: index, transform: 'translate(' + p.x + ',' + p.y + ')' },
                  h('rect', { width: 204, height: 72, rx: 10, fill: 'var(--dsw-alias-container-base, var(--dsw-specific-sidebar-fill))', stroke: 'var(--sxw-control-border)', strokeWidth: 1.25 }),
                  h('text', { x: 14, y: 23, fontSize: 11, fill: 'var(--dsw-alias-label-secondary)' }, index === 0 || index === nodes.length - 1 ? t('graphBoundary') : t('graphStage') + ' ' + index),
                  h('text', { x: 14, y: 47, fontSize: 12, fontWeight: 500, fill: 'currentColor' }, label.length > 26 ? label.slice(0, 25) + '…' : label), h('title', null, label)) }))),
            h('p', { style: { ...note, marginBottom: 0 } }, t(stages.length ? 'graphStagesNote' : 'graphProgramNote')),
            !!entry.dependencies?.length && h('p', { style: { ...note, marginBottom: 0 } }, t('graphDependencies') + ': ' + entry.dependencies.map(item => item.name + ' v' + item.version).join(' · ')))
        }
        function EntryDetail({ entry, onBack, onDeleted, preparing }) {
          const [input, setInput] = React.useState(() => initialValue(entry.execution?.inputSchema || { type: 'object' }) || {})
          const [jsonMode, setJsonMode] = React.useState(false)
          const [raw, setRaw] = React.useState('{}')
          const [cwd, setCwd] = React.useState('')
          const [busy, setBusy] = React.useState(false)
          const [error, setError] = React.useState('')
          const [runs, setRuns] = React.useState([])
          const [revision, setRevision] = React.useState(0)
          const request = React.useRef(null)
          const submitting = React.useRef(false)
          React.useEffect(() => {
            const controller = new AbortController(); let timer
            async function load() {
              try { const jobs = await api('runs?name=' + encodeURIComponent(entry.name), { signal: controller.signal }); if (controller.signal.aborted) return; setRuns(jobs); if (jobs.some(job => ['queued', 'running', 'cancelling'].includes(job.status))) timer = setTimeout(load, 1500) }
              catch (error) { if (!controller.signal.aborted) setError(error.message) }
            }
            void load(); return () => { controller.abort(); clearTimeout(timer) }
          }, [entry.name, revision])
          const properties = Object.entries(entry.execution?.inputSchema?.properties || {})
          const requiredFields = entry.execution?.inputSchema?.required || []
          const optionalFields = requiredFields.length ? properties.filter(([name]) => !requiredFields.includes(name)) : []
          const renderField = ([name, schema]) => h(SchemaField, { key: name, schema, name, value: input?.[name], required: requiredFields.includes(name), onChange: value => setInput(previous => ({ ...previous, [name]: value })) })
          const active = busy || runs.some(job => ['queued', 'running', 'cancelling'].includes(job.status))
          async function execute(event) {
            event.preventDefault(); if (submitting.current || active) return
            let values
            try { values = jsonMode ? JSON.parse(raw) : input } catch { setError(t('invalidJson')); return }
            const payload = { name: entry.name, revisionId: entry.revisionId, input: values, ...(cwd.trim() ? { cwd: cwd.trim() } : {}) }
            const fingerprint = JSON.stringify(payload)
            if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, key: crypto.randomUUID() }
            submitting.current = true; setBusy(true); setError('')
            try {
              const job = await api('runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, idempotencyKey: request.current.key }) })
              setRuns(previous => [job, ...previous.filter(item => item.id !== job.id)]); request.current = null; setRevision(value => value + 1)
            } catch (error) { setError(error.message) } finally { submitting.current = false; setBusy(false) }
          }
          function switchMode() {
            if (jsonMode) { try { setInput(JSON.parse(raw)); setJsonMode(false); setError('') } catch { setError(t('invalidJson')) } }
            else { setRaw(JSON.stringify(input, null, 2)); setJsonMode(true) }
          }
          return h('article', { className: 'sxw-detail' },
            h(Button, { variant: 'ghost', size: 'sm', onClick: onBack, style: { paddingLeft: 0, marginBottom: 16 } }, '← ' + t('back')),
            h('header', { style: { marginBottom: 24 } },
              h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' } }, h('h2', { style: { fontSize: 22, margin: 0, overflowWrap: 'anywhere' } }, entry.name), h('span', { style: { ...note, background: 'var(--dsw-specific-sidebar-fill)', borderRadius: 6, padding: '2px 8px' } }, 'v' + entry.version), h(DeleteEntry, { entry, onDeleted })),
              h('p', { style: { ...note, fontSize: 14, marginBottom: 0 } }, displayDescription(entry.description))),
            error && h('p', { role: 'alert' }, error),
            h('div', { className: entry.kind === 'workflow' && entry.execution ? 'sxw-execute-layout' : undefined },
            h('section', { style: { ...card, marginBottom: 20 } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 18 } }, h('h3', { style: { fontSize: 15, margin: 0 } }, t('runConfig')), entry.execution && h(Button, { variant: 'ghost', size: 'sm', disabled: active, onClick: switchMode }, t(jsonMode ? 'formInput' : 'jsonInput'))),
              !entry.execution ? h('div', null, h('p', { style: note }, t('needsContract')), h(Button, { variant: 'ghost', size: 'sm', disabled: preparing || entry.enabled === false, onClick: () => runTask('prepare', { name: entry.name }) }, t(preparing ? 'preparingContract' : 'prepareContract'))) :
                h('form', { onSubmit: execute },
                  h('fieldset', { disabled: active || entry.enabled === false, style: { border: 0, padding: 0, margin: 0, minWidth: 0 } },
                    jsonMode ? h('textarea', { 'aria-label': t('jsonInput'), value: raw, onInput: event => setRaw(event.currentTarget.value), rows: 10, style: { ...control, width: '100%', fontFamily: 'ui-monospace, monospace', resize: 'vertical' } }) : h('div', { className: 'sxw-input-grid' },
                      properties.filter(([name]) => !requiredFields.length || requiredFields.includes(name)).map(renderField),
                      !Object.keys(entry.execution.inputSchema.properties || {}).length && h('p', { style: note }, t('noParameters'))),
                    !jsonMode && optionalFields.length > 0 && h('details', { style: { marginTop: 20 } }, h('summary', { style: { ...note, cursor: 'pointer' } }, t('optionalParameters') + ' (' + optionalFields.length + ')'), h('div', { className: 'sxw-input-grid', style: { marginTop: 16 } }, optionalFields.map(renderField))),
                    h('details', { style: { marginTop: 20 } }, h('summary', { style: { ...note, cursor: 'pointer' } }, t('runtimeOptions')), h('label', { style: { display: 'block', marginTop: 12, fontSize: 13 } }, t('workingDirectory'), h('input', { value: cwd, onInput: event => setCwd(event.currentTarget.value), placeholder: t('defaultDirectory'), style: { ...control, display: 'block', width: '100%', marginTop: 8 } }))),
                    h(Button, { type: 'submit', variant: 'primary', size: 'md', disabled: active || entry.enabled === false, style: { marginTop: 22 } }, t(active ? 'statusRunning' : 'execute'))),
                  entry.enabled === false && h('p', { style: note }, t('disabledExecution')))),
            entry.kind === 'workflow' && entry.execution && h(WorkflowDag, { entry })),
            h('section', { style: { ...card, marginBottom: 20 } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16 } }, h('h3', { style: { fontSize: 15, margin: 0 } }, t('runHistory')), h(Button, { variant: 'ghost', size: 'sm', onClick: () => setRevision(value => value + 1) }, t('refresh'))),
              !runs.length && h('p', { style: note }, t('noRuns')),
              runs.map(job => h('div', { key: job.id, style: { padding: '14px 0', borderTop: '1px solid var(--sxw-divider)' } },
                h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 } }, h('strong', { style: { fontSize: 13 } }, statusLabel(job.status)), h('span', { style: note }, new Date(job.createdAt).toLocaleString()),
                  job.sessionId && h(Button, { variant: 'ghost', size: 'sm', onClick: () => ctx.uiWorkspace.openSession(job.sessionId) }, t('executionSession')),
                  ['queued', 'running', 'cancelling'].includes(job.status) && h(Button, { variant: 'ghost', size: 'sm', disabled: job.status === 'cancelling', onClick: async () => { try { await api('runs/' + encodeURIComponent(job.id) + '/cancel', { method: 'POST' }); setRevision(value => value + 1) } catch (error) { setError(error.message) } } }, t('cancel'))),
                job.recordingError && h('p', { role: 'alert', style: note }, t('recordingFailed') + ': ' + job.recordingError),
                job.error && h('p', { role: 'alert', style: { fontSize: 13, overflowWrap: 'anywhere' } }, job.error.message || JSON.stringify(job.error)),
                job.output !== undefined && h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, background: 'var(--dsw-specific-sidebar-fill)', borderRadius: 8, padding: 12 } }, JSON.stringify(job.output, null, 2))))),
            h('details', { style: { ...card, marginBottom: 20 } }, h('summary', { style: { cursor: 'pointer', fontSize: 13, fontWeight: 500 } }, t('capabilityNotes')),
              entry.generatorSessionId && h(Button, { variant: 'ghost', size: 'sm', style: { marginTop: 12 }, onClick: () => ctx.uiWorkspace.openSession(entry.generatorSessionId) }, t('conversation')),
              h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.7 } }, entry.content)))
        }
        const metricKeys = ['savings', 'success', 'failure', 'skillxCalls', 'workflowCalls', 'duration', 'reasons']
        const metricRoute = key => ({ skillxCalls: 'skillx', workflowCalls: 'workflow' })[key] || key
        function recent(hours) { const end = new Date(); return { start: new Date(+end - hours * 3600000).toISOString(), end: end.toISOString() } }
        function RangeControl({ value, onChange, hourly }) {
          const choices = [...(hourly ? [1, 3, 12] : []), 24, 72, 168, 'custom']
          return h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 } },
            h('select', { value: value.choice, 'aria-label': t('timeRange'), style: control, onChange: event => { const choice = event.target.value === 'custom' ? 'custom' : Number(event.target.value); onChange(previous => ({ ...previous, choice })) } }, choices.map(choice => h('option', { key: choice, value: choice }, choice === 'custom' ? t('custom') : choice < 24 ? choice + t('hours') : choice / 24 + t('days')))),
            value.choice === 'custom' && ['start', 'end'].map(key => h('input', { key, type: 'date', value: value[key], 'aria-label': t(key), style: control, onInput: event => { const date = event.currentTarget.value; onChange(previous => ({ ...previous, [key]: date })) } })))
        }
        function useMonitoring(path, range, revision, offset = 0) {
          const [result, setResult] = React.useState({ loading: true })
          React.useEffect(() => {
            const controller = new AbortController()
            setResult({ loading: true })
            let selected
            if (range.choice === 'custom') {
              const start = new Date(range.start + 'T00:00:00'), end = new Date(range.end + 'T00:00:00')
              end.setDate(end.getDate() + 1)
              if (!range.start || !range.end || !Number.isFinite(+start) || !Number.isFinite(+end) || +end <= +start || +end - +start > 366 * 86400000) { setResult({ error: t('invalidRange') }); return () => controller.abort() }
              selected = { start: start.toISOString(), end: end.toISOString() }
            } else selected = recent(range.choice)
            const query = new URLSearchParams({ ...selected, offset: String(offset) })
            api(path + '?' + query, { signal: controller.signal }).then(data => { if (!controller.signal.aborted) setResult({ data }) }, error => { if (!controller.signal.aborted) setResult({ error: error.message }) })
            return () => controller.abort()
          }, [path, range.choice, range.start, range.end, revision, offset])
          return result
        }
        function formatted(key, value) {
          if (value == null) return '—'
          if (key === 'success' || key === 'failure') return value.toFixed(1) + '%'
          if (key === 'duration') return value < 1000 ? value + ' ms' : value < 60000 ? (value / 1000).toFixed(1) + ' s' : (value / 60000).toFixed(1) + ' min'
          return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
        }
        function Chart({ points, metric }) {
          const values = points.filter(point => point.value !== null)
          if (!values.length) return h('p', { style: note }, t('noSamples'))
          const max = Math.max(1, ...values.map(point => point.value)), min = Math.min(0, ...values.map(point => point.value))
          const xy = (point, index) => [32 + index / Math.max(1, points.length - 1) * 432, 112 - (point.value - min) / (max - min) * 88]
          return h('div', null,
            h('svg', { viewBox: '0 0 480 140', role: 'img', 'aria-label': t(metric) + ' ' + t('trend'), style: { width: '100%', height: 150, overflow: 'visible' } },
              h('path', { d: 'M32 16V112H464', fill: 'none', stroke: 'var(--sxw-control-border)' }),
              h('text', { x: 32, y: 12, fontSize: 10, fill: 'currentColor' }, formatted(metric, max)),
              min < 0 && h('line', { x1: 32, x2: 464, y1: 112 + min / (max - min) * 88, y2: 112 + min / (max - min) * 88, stroke: 'var(--sxw-control-border)', strokeDasharray: '3 3' }),
              min < 0 && h('text', { x: 32, y: 122, fontSize: 10, fill: 'currentColor' }, formatted(metric, min)),
              h('polyline', { points: points.map((point, index) => point.value === null ? null : xy(point, index).join(',')).filter(Boolean).join(' '), fill: 'none', stroke: 'currentColor', strokeWidth: 2 }),
              points.map((point, index) => point.value === null ? null : h('circle', { key: point.start, cx: xy(point, index)[0], cy: xy(point, index)[1], r: 3, fill: 'currentColor' }, h('title', null, new Date(point.start).toLocaleString() + ' · ' + (point.value ?? t('noSamples')) + (['success', 'failure'].includes(metric) ? '%' : '')))),
              h('text', { x: 32, y: 134, fontSize: 10, fill: 'currentColor' }, new Date(points[0].start).toLocaleString()),
              h('text', { x: 464, y: 134, textAnchor: 'end', fontSize: 10, fill: 'currentColor' }, new Date(points.at(-1).start).toLocaleString())))
        }
        function Table({ columns, rows }) {
          return rows.length ? h('div', { style: { overflowX: 'auto' } }, h('table', { style: { width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 } },
            h('thead', null, h('tr', null, columns.map(([key, label]) => h('th', { key, style: { padding: '10px 8px', ...note } }, t(label))))),
            h('tbody', null, rows.map((row, index) => h('tr', { key: row.id || row.reason || index }, columns.map(([key, , render]) => h('td', { key, style: { padding: '10px 8px', borderTop: '1px solid var(--sxw-divider)', overflowWrap: 'anywhere', minWidth: key === 'name' ? 160 : undefined } }, render ? render(row, index) : row[key]))))))) : h('p', { style: note }, t('empty'))
        }
        function Pager({ page, total, size, onChange }) {
          return total > size && h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 } },
            h(Button, { variant: 'ghost', size: 'sm', disabled: page === 0, onClick: () => onChange(page - 1) }, t('previous')),
            h('span', { style: note }, (page + 1) + ' / ' + Math.ceil(total / size)),
            h(Button, { variant: 'ghost', size: 'sm', disabled: (page + 1) * size >= total, onClick: () => onChange(page + 1) }, t('next')))
        }
        function statusLabel(status) { return ({ completed: t('executionSettled'), failed: t('statusFailed'), running: t('statusRunning') })[status] || t(status) }
        async function openRecordedSession(row, onError) {
          try {
            let sessionId = row.sessionId
            if (row.type === 'learning') {
              const task = await api('status?taskId=' + encodeURIComponent(row.id))
              sessionId = task.activeGeneratorSessionId || task.phaseSessions?.filter(phase => phase.status === 'completed').at(-1)?.sessionId
              if (!sessionId && !['queued', 'running'].includes(task.status)) sessionId = task.generatorSessionId
            }
            if (!sessionId) throw new Error(t('sessionNotReady'))
            await ctx.uiWorkspace.openSession(sessionId)
          } catch (error) {
            if (onError) onError(error.message)
            else update({ kind: 'failed', detail: error.message })
          }
        }
        function sessionButton(row) { return row.sessionId ? h(Button, { variant: 'ghost', size: 'sm', onClick: () => openRecordedSession(row) }, row.name) : row.name }
        function MetricPanel({ metric, revision }) {
          const [range, setRange] = React.useState({ choice: 24, start: '', end: '' })
          const [page, setPage] = React.useState(0)
          const { data, loading, error } = useMonitoring('monitoring/metrics/' + metricRoute(metric), range, revision)
          React.useEffect(() => setPage(0), [range, revision])
          return h('article', { style: { ...card, gridColumn: ['duration', 'reasons'].includes(metric) ? '1 / -1' : undefined } },
            h('h2', { style: { margin: '0 0 12px', fontSize: 15 } }, t(metric)),
            h(RangeControl, { value: range, onChange: setRange, hourly: metric === 'savings' }),
            loading ? h('p', { role: 'status', style: note }, t('loading')) : error ? h('p', { role: 'alert' }, error) : data && h(React.Fragment, null,
              metric === 'duration' ? h(React.Fragment, null,
                h(Table, { columns: [['rank', 'rank', (_row, index) => page * 5 + index + 1], ['name', 'task', sessionButton], ['status', 'status', row => row.outcome === 'skipped' ? t('skipped') : statusLabel(row.status)], ['durationMs', 'elapsed', row => formatted('duration', row.durationMs)], ['createdAt', 'createdAt', row => new Date(row.createdAt).toLocaleString()]], rows: (data.ranking || []).slice(page * 5, page * 5 + 5) }),
                h(Pager, { page, total: data.ranking?.length || 0, size: 5, onChange: setPage })) : metric === 'reasons' ? h(React.Fragment, null,
                h(Table, { columns: [['reason', 'reason'], ['count', 'count']], rows: (data.items || []).slice(page * 5, page * 5 + 5) }), h(Pager, { page, total: data.items?.length || 0, size: 5, onChange: setPage })) : h(React.Fragment, null,
                h('div', { style: { fontSize: 30, fontWeight: 600, margin: '12px 0' }, title: data.value == null ? undefined : String(data.value) }, (metric === 'savings' && data.value != null ? '≈ ' : '') + formatted(metric, data.value)),
                metric === 'savings' && data.value == null ? h('p', { style: { ...note, minHeight: 150, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--dsw-specific-sidebar-fill)', borderRadius: 8 } }, t('noSamples')) : h(Chart, { points: data.series || [], metric })),
              metric === 'savings' && data.estimatedExecutions > 0 && h('p', { style: { ...note, marginBottom: 0 } }, t('shortSavings') + ' ' + formatted('success', data.savingsRate) + ' · ' + data.estimatedExecutions + ' ' + t('shortCoverage')),
              metric === 'savings' && data.excludedExecutions > 0 && h('p', { style: { ...note, marginBottom: 0 } }, data.excludedExecutions + ' ' + t('missingComparison')),
              h('details', { style: { ...note, marginTop: 8 } }, h('summary', { style: { cursor: 'pointer' } }, t('statisticsInfo')),
                h('p', { style: { marginBottom: 0 } }, t(['skillxCalls', 'workflowCalls'].includes(metric) ? 'callsBasis' : metric === 'savings' ? 'savingsBasis' : 'tasksBasis')),
                metric === 'savings' && data.estimatedExecutions > 0 && h('p', { style: { marginBottom: 0 } }, t('baselineTotal') + ': ' + formatted('savings', data.baselineTokens) + ' · ' + t('executionTotal') + ': ' + formatted('savings', data.executionTokens)),
                !!data.incompleteTasks && h('p', null, data.incompleteTasks + ' ' + t('incompleteUsage'))),
              !!data.skippedRecords && h('p', { role: 'status', style: note }, data.skippedRecords + ' · ' + t('skippedRecords'))))
        }
        function Records({ id }) {
          const [offset, setOffset] = React.useState(0)
          const [revision, setRevision] = React.useState(0)
          const { data, error, loading } = useMonitoring('monitoring/records/' + id, { choice: 24 }, revision, offset)
          return h('div', { style: { ...card, marginTop: 16 } },
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
              h(Button, { variant: 'ghost', size: 'sm', onClick: () => setRevision(value => value + 1) }, t('refresh')),
              h(Button, { variant: 'ghost', size: 'sm', disabled: offset === 0 || loading, onClick: () => setOffset(Math.max(0, offset - 50)) }, t('previous')),
              h(Button, { variant: 'ghost', size: 'sm', disabled: data?.nextOffset == null || loading, onClick: () => setOffset(data.nextOffset) }, t('next'))),
            loading ? h('p', { role: 'status' }, t('loading')) : error ? h('p', { role: 'alert' }, error) : data?.items.map((item, index) => h('details', { key: offset + index, style: { marginTop: 12 } },
              h('summary', null, (offset + index + 1) + ' · ' + item.type), h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 } }, JSON.stringify(item, null, 2)))))
        }
        function Sessions({ revision }) {
          const [range, setRange] = React.useState({ choice: 24, start: '', end: '' })
          const [page, setPage] = React.useState(0)
          const [selected, setSelected] = React.useState(null)
          const [openError, setOpenError] = React.useState('')
          const { data, error, loading } = useMonitoring('monitoring/sessions', range, revision, page * 30)
          return h('article', { style: { ...card, gridColumn: '1 / -1' } },
            h('h2', { style: { margin: '0 0 12px', fontSize: 15 } }, t('sessions')),
            h(RangeControl, { value: range, onChange: value => { setRange(value); setPage(0); setSelected(null) } }),
            h('p', { style: note }, t('sessionsBasis')),
            openError && h('p', { role:'alert' }, openError),
            loading ? h('p', { role: 'status' }, t('loading')) : error ? h('p', { role: 'alert' }, error) : data && h(React.Fragment, null,
              h(Table, { columns: [['createdAt', 'createdAt', row => new Date(row.createdAt).toLocaleString()], ['name', 'task', sessionButton], ['status', 'status', row => row.outcome === 'skipped' ? t('skipped') : statusLabel(row.status)], ['id', 'runId'], ['action', 'details', row => row.type === 'execution' ? h(Button, { variant: 'ghost', size: 'sm', onClick: () => setSelected(selected === row.id ? null : row.id) }, t('records')) : h(Button, { variant: 'ghost', size: 'sm', onClick: () => { setOpenError(''); return openRecordedSession(row, setOpenError) } }, t('conversation'))]], rows: data.items }),
              h(Pager, { page, total: data.total, size: 30, onChange: value => { setPage(value); setSelected(null) } })),
            selected && h('div', null, h(Button, { variant: 'ghost', size: 'sm', onClick: () => setSelected(null) }, t('dismiss')), h(Records, { key: selected, id: selected })))
        }
        function Monitoring() {
          const [revision, setRevision] = React.useState(0)
          return h('section', { className: 'sxw-monitor', style: { padding: 24, overflow: 'auto', height: '100%', boxSizing: 'border-box' }, 'aria-label': t('monitoring') },
            h('style', null, '.sxw-monitor>header,.sxw-monitor-grid{width:100%;max-width:1200px;margin-left:auto;margin-right:auto}.sxw-monitor-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr));gap:20px}@media(max-width:760px){.sxw-monitor{padding:16px!important}.sxw-monitor-grid{grid-template-columns:minmax(0,1fr)}}'),
            h('header', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 } }, h('p', { style: { ...note, flex: 1, margin: 0 } }, t('monitoringIntro')), h(Button, { variant: 'ghost', size: 'sm', onClick: () => setRevision(value => value + 1) }, t('refresh'))),
            h('div', { className: 'sxw-monitor-grid' }, metricKeys.map(metric => h(MetricPanel, { key: metric, metric, revision }))))
        }
        function ExecutionHistory() {
          const [revision, setRevision] = React.useState(0)
          return h('section', { className: 'sxw-history', style: { padding: 24, overflow: 'auto', height: '100%', boxSizing: 'border-box' }, 'aria-label': t('runHistory') },
            h('style', null, '.sxw-history>header,.sxw-history>article{width:100%;max-width:1200px;margin-left:auto;margin-right:auto;box-sizing:border-box}@media(max-width:760px){.sxw-history{padding:16px!important}}'),
            h('header', { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 16 } }, h(Button, { variant: 'ghost', size: 'sm', onClick: () => setRevision(value => value + 1) }, t('refresh'))),
            h(Sessions, { revision }))
        }
        function Workspace({ initialTab = 'skillx' }) {
          const [tab, setTab] = React.useState(initialTab)
          const tabs = ['skillx', 'workflow', 'monitoring', 'runHistory']
          function onKeyDown(event) {
            const index = tabs.indexOf(tab)
            const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
            if (next === null) return
            event.preventDefault(); setTab(tabs[next]); event.currentTarget.querySelectorAll('[role="tab"]')[next].focus()
          }
          return h('section', { className: 'sxw-workspace', style: { ...box, padding: 0, display: 'flex', flexDirection: 'column' }, 'aria-label': t('skillx') },
            h('style', null, '.sxw-workspace{--sxw-border:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);--sxw-control-border:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);--sxw-divider:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);--sxw-line:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}.sxw-detail{container-type:inline-size}.sxw-execute-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:20px;align-items:start}@container(min-width:900px){.sxw-execute-layout{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}.sxw-input-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:20px 24px}.sxw-workspace-header{width:100%;max-width:1248px;margin:0 auto;padding:28px 24px 0;box-sizing:border-box;flex-shrink:0}.sxw-tab:hover{background:var(--dsw-specific-sidebar-fill)!important}.sxw-tab:focus-visible{outline:2px solid currentColor;outline-offset:3px}@media(max-width:760px){.sxw-workspace-header{padding:20px 16px 0}.sxw-page>header{padding:16px 16px 0!important}.sxw-page>div{padding:16px!important}}'),
            h('header', { className: 'sxw-workspace-header' }, h('h1', { style: { fontSize: 22, lineHeight: '30px', fontWeight: 600, margin: '0 0 20px', letterSpacing: '-0.4px' } }, t('skillx')),
              h('div', { role: 'tablist', 'aria-label': t('skillx'), onKeyDown, style: { display: 'flex', gap: 6, paddingBottom: 16, overflowX: 'auto', whiteSpace: 'nowrap', borderBottom: '1px solid var(--sxw-divider)' } }, tabs.map(kind => h('button', { key: kind, className: 'sxw-tab', id: 'sxw-tab-' + kind, type: 'button', role: 'tab', 'aria-selected': tab === kind, 'aria-controls': 'sxw-panel-' + kind, tabIndex: tab === kind ? 0 : -1, onClick: () => setTab(kind), style: { font: 'inherit', fontSize: 14, fontWeight: tab === kind ? 600 : 400, borderRadius: 8, color: tab === kind ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)', cursor: 'pointer', background: tab === kind ? 'var(--dsw-specific-sidebar-fill)' : 'transparent', border: '1px solid ' + (tab === kind ? 'var(--sxw-border)' : 'transparent'), padding: '9px 16px' } }, t(kind))))),
            tabs.map(kind => h('div', { key: kind, id: 'sxw-panel-' + kind, role: 'tabpanel', 'aria-labelledby': 'sxw-tab-' + kind, hidden: tab !== kind, style: { flex: 1, minHeight: 0, minWidth: 0 } }, tab === kind && (kind === 'monitoring' ? h(Monitoring) : kind === 'runHistory' ? h(ExecutionHistory) : h(Page, { key: kind, kind })))))
        }
        function Notice() {
          const state = React.useSyncExternalStore(subscribe, () => notice)
          if (!state) return null
          return h('aside', { role: state.kind === 'failed' ? 'alert' : 'status', 'aria-live': state.kind === 'failed' ? 'assertive' : 'polite', style: { position: 'fixed', right: 24, bottom: 24, width: 336, maxWidth: 'calc(100vw - 48px)', padding: 16, borderRadius: 'var(--dsw-radius-lg, 12px)', background: 'var(--dsw-specific-sidebar-fill)', color: 'var(--dsw-alias-label-primary)', border: '0.5px solid var(--dsw-alias-border-l2)', boxShadow: 'var(--dsw-shadow-lv2)', fontSize: 13, lineHeight: '20px', zIndex: 1100 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
              h(StateDot, { state: state.kind === 'running' ? 'ongoing' : state.kind === 'failed' ? 'error' : 'done', size: 16 }),
              h('span', { style: { flex: 1, fontWeight: 500 } }, t(state.operation === 'prepare' ? state.kind === 'running' ? 'preparingContract' : state.kind === 'completed' ? 'contractPrepared' : 'contractFailed' : state.outcome === 'skipped' ? 'skipped' : state.kind)),
              h(Button, { variant: 'ghost', size: 'sm', title: t('dismiss'), 'aria-label': t('dismiss'), onClick: () => update(null), style: { width: 28, padding: 0, color: 'var(--dsw-alias-label-tertiary)' }, icon: h(IconCloseOutlineRegular, { size: 16 }) })),
            state.detail && h('p', { style: { margin: '10px 0 0', color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' } }, state.detail),
            state.generatorSessionId && h(Button, { variant: 'ghost', size: 'sm', icon: h(IconRightUpOutlineRegular, { size: 14 }), onClick: () => ctx.uiWorkspace.openSession(state.generatorSessionId) }, t('conversation')),
            state.kind === 'running' && state.taskId && h(Button, { variant: 'ghost', size: 'sm', onClick: () => { void api('cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: state.taskId }) }).catch(error => update({ ...state, detail: error.message })) } }, t('cancel')),
            state.resultUrl && h('div', { style: { marginTop: 12, paddingTop: 10, borderTop: '0.5px solid var(--dsw-alias-border-l1)', display: 'flex', justifyContent: 'flex-end' } },
              h(Button, { variant: 'ghost', size: 'sm', icon: h(IconRightUpOutlineRegular, { size: 14 }), onClick: () => window.open(state.resultUrl, '_blank', 'noopener,noreferrer') }, t('result'))))
        }
        const id = 'skillx-workflow.skillx'
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: id, locale: NS }, () => h(Workspace)))
        // Keep the old panel key available for saved host navigation state.
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'skillx-workflow.workflow', locale: NS }, () => h(Workspace, { initialTab: 'workflow' })))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id, order: 30, locale: NS, label: () => t('skillx') }, Icon))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'skillx-workflow.notice', locale: NS }, Notice))
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'skillx-workflow.extract', order: 350, locale: NS }, ({ sessionId, useMenuOpenState }) => {
          const [, setOpen] = useMenuOpenState()
          return h(MenuItemButton, { icon: h(Icon, { size: 14 }), onSelect: () => { setOpen(false); void extract(sessionId) } }, t('extract'))
        }))
      },
    }
  },
})
