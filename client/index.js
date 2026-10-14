window.__ModuleLoader__.load({
  id: 'dsh-skillx-workflow',
  factory(require) {
    const React = require('react')
    const { MenuItemButton, Button, StateDot, IconCloseOutlineRegular, IconRightUpOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const NS = 'skillx-workflow'
    const dictionaries = {
      zh: { skillx: 'SkillX', workflow: '工作流', extract: '总结工作流', refresh: '刷新', open: '打开完整管理页面', empty: '暂无内容', loading: '加载中…', running: '正在总结工作流…', completed: '工作流总结完成', failed: '工作流总结失败', dismiss: '关闭', manual: '工作流仅在你选择“总结工作流”时生成。', priority: '同名能力优先使用 SkillX 或工作流。' },
      en: { skillx: 'SkillX', workflow: 'Workflows', extract: 'Summarize workflow', refresh: 'Refresh', open: 'Open management page', empty: 'No entries yet', loading: 'Loading…', running: 'Summarizing workflow…', completed: 'Workflow summary completed', failed: 'Workflow summary failed', dismiss: 'Dismiss', manual: 'Workflows are generated only when you choose “Summarize workflow”.', priority: 'SkillX and workflows take precedence over skills with the same name.' },
    }
    Object.assign(dictionaries.zh, { search: '搜索', enabled: '启用', disabled: '停用', back: '返回', optimize: '优化', execution: '执行会话 ID（多个用逗号或空格分隔）', cancel: '取消任务', details: '详情', result: '查看提取结果', conversation: '查看提取对话' })
    Object.assign(dictionaries.en, { search: 'Search', enabled: 'Enabled', disabled: 'Disabled', back: 'Back', optimize: 'Optimize', execution: 'Execution session IDs (comma or space separated)', cancel: 'Cancel task', details: 'Details', result: 'View extraction result', conversation: 'View author conversation' })
    const box = { padding: 24, height: '100%', overflow: 'auto', color: 'var(--dsw-alias-label-primary)' }
    async function api(path, options) {
      const response = await fetch('/skillx-workflow/api/' + path, options)
      const raw = await response.text()
      let data
      try { data = JSON.parse(raw) } catch { throw new Error('Workflow service unavailable (HTTP ' + response.status + '). Check plugin startup and engine logs.') }
      if (!response.ok || data.error) throw new Error(data.error?.message || data.error || response.statusText)
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
          update({ kind: 'running' })
          try {
            const task = await api(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
            update({ kind: 'running', taskId: task.taskId, generatorSessionId: task.generatorSessionId })
            while (!disposed) {
              const status = await api('status?taskId=' + encodeURIComponent(task.taskId))
              const info = { taskId: task.taskId, generatorSessionId: status.generatorSessionId || task.generatorSessionId, entries: status.entries }
              if (['completed', 'done', 'succeeded'].includes(status.status)) { update({ kind: 'completed', ...info }); break }
              if (['failed', 'error', 'cancelled'].includes(status.status)) { update({ kind: 'failed', detail: typeof status.error === 'string' ? status.error : JSON.stringify(status.error || status.status), ...info }); break }
              update({ kind: 'running', ...info })
              await sleep()
            }
          } catch (error) { if (!disposed) update({ kind: 'failed', detail: error.message }) }
          finally { pending.delete(key) }
        }
        const extract = sessionId => runTask('extract', { sessionId })
        function Page({ kind }) {
          const [data, setData] = React.useState(null)
          const [error, setError] = React.useState('')
          const [query, setQuery] = React.useState('')
          const [entry, setEntry] = React.useState(null)
          const [busy, setBusy] = React.useState(null)
          const [execution, setExecution] = React.useState('')
          const state = React.useSyncExternalStore(subscribe, () => notice)
          const reload = () => { setError(''); return api('catalog').then(setData, error => setError(error.message)) }
          React.useEffect(() => { let active = true; api('catalog').then(value => { if (active) setData(value) }, error => { if (active) setError(error.message) }); return () => { active = false } }, [state?.kind])
          React.useEffect(() => { setEntry(null); setQuery(''); setExecution('') }, [kind])
          const rows = (kind === 'skillx' ? data?.capabilities : data?.workflows) || []
          const filtered = rows.filter(row => (row.name + ' ' + (row.description || '')).toLowerCase().includes(query.toLowerCase()))
          const control = { font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-specific-sidebar-fill)', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md, 8px)', padding: '8px 10px' }
          async function open(row) {
            setBusy(row.name); setError('')
            try { setEntry(await api('entries/' + encodeURIComponent(row.name))) } catch (error) { setError(error.message) } finally { setBusy(null) }
          }
          async function toggle(row) {
            setBusy(row.name); setError('')
            try { await api('entries/' + encodeURIComponent(row.name) + '/availability', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: row.enabled === false }) }); await reload() } catch (error) { setError(error.message) } finally { setBusy(null) }
          }
          return h('section', { style: { ...box, padding: 0, display: 'flex', flexDirection: 'column' }, 'aria-label': t(kind) },
            h('header', { style: { padding: '20px 24px', borderBottom: '0.5px solid var(--dsw-alias-border-l2)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 } },
              h('h1', { style: { fontSize: 18, margin: 0, marginRight: 'auto' } }, t(kind)),
              h('input', { type: 'search', value: query, placeholder: t('search'), 'aria-label': t('search'), onChange: event => setQuery(event.target.value), style: { ...control, width: 240, maxWidth: '100%' } }),
              h(Button, { variant: 'ghost', size: 'sm', onClick: reload }, t('refresh'))),
            h('div', { style: { padding: 24, overflow: 'auto', flex: 1, minHeight: 0 } },
              error && h('p', { role: 'alert' }, error),
              !data && !error && h('p', null, t('loading')),
              entry ? h('article', null,
                h(Button, { variant: 'ghost', size: 'sm', onClick: () => setEntry(null) }, t('back')),
                h('h2', { style: { fontSize: 17, overflowWrap: 'anywhere' } }, entry.name),
                entry.generatorSessionId && h(Button, { variant: 'ghost', size: 'sm', icon: h(IconRightUpOutlineRegular, { size: 14 }), onClick: () => ctx.uiWorkspace.openSession(entry.generatorSessionId) }, t('conversation')),
                h('p', { style: { color: 'var(--dsw-alias-label-secondary)' } }, entry.description),
                h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.7 } }, typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content, null, 2)),
                h('form', { onSubmit: event => { event.preventDefault(); if (execution.trim()) void runTask('optimize', { name: entry.name, sessionIds: execution.trim().split(/[\s,，]+/).filter(Boolean) }) }, style: { display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 24 } },
                  h('input', { value: execution, required: true, placeholder: t('execution'), 'aria-label': t('execution'), onChange: event => setExecution(event.target.value), style: { ...control, flex: 1 } }),
                  h(Button, { type: 'submit', disabled: !execution.trim(), variant: 'ghost', size: 'sm' }, t('optimize')))) :
                h('div', null, data && !filtered.length && h('p', null, t('empty')), filtered.map(row => h('div', { key: row.name, style: { display: 'flex', gap: 16, alignItems: 'center', padding: '16px 0', borderBottom: '0.5px solid var(--dsw-alias-border-l1)' } },
                  h('div', { style: { flex: 1, minWidth: 0 } }, h(Button, { variant: 'ghost', size: 'sm', disabled: busy === row.name, onClick: () => open(row), style: { padding: 0, fontWeight: 500 } }, row.name),
                    h('p', { style: { margin: '6px 0 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' } }, row.description)),
                  h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' } }, h('input', { type: 'checkbox', role: 'switch', checked: row.enabled !== false, disabled: busy === row.name, 'aria-label': row.name + ' ' + t('enabled'), onChange: () => toggle(row), style: { accentColor: 'var(--dsw-alias-label-primary)' } }), t(row.enabled === false ? 'disabled' : 'enabled')))))))
        }
        function Notice() {
          const state = React.useSyncExternalStore(subscribe, () => notice)
          if (!state) return null
          return h('aside', { role: state.kind === 'failed' ? 'alert' : 'status', 'aria-live': state.kind === 'failed' ? 'assertive' : 'polite', style: { position: 'fixed', right: 24, bottom: 24, width: 336, maxWidth: 'calc(100vw - 48px)', padding: 16, borderRadius: 'var(--dsw-radius-lg, 12px)', background: 'var(--dsw-specific-sidebar-fill)', color: 'var(--dsw-alias-label-primary)', border: '0.5px solid var(--dsw-alias-border-l2)', boxShadow: 'var(--dsw-shadow-lv2)', fontSize: 13, lineHeight: '20px', zIndex: 1100 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
              h(StateDot, { state: state.kind === 'running' ? 'ongoing' : state.kind === 'failed' ? 'error' : 'done', size: 16 }),
              h('span', { style: { flex: 1, fontWeight: 500 } }, t(state.kind)),
              h(Button, { variant: 'ghost', size: 'sm', title: t('dismiss'), 'aria-label': t('dismiss'), onClick: () => update(null), style: { width: 28, padding: 0, color: 'var(--dsw-alias-label-tertiary)' }, icon: h(IconCloseOutlineRegular, { size: 16 }) })),
            state.detail && h('p', { style: { margin: '10px 0 0', color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' } }, state.detail),
            state.generatorSessionId && h(Button, { variant: 'ghost', size: 'sm', icon: h(IconRightUpOutlineRegular, { size: 14 }), onClick: () => ctx.uiWorkspace.openSession(state.generatorSessionId) }, t('conversation')),
            state.kind === 'running' && state.taskId && h(Button, { variant: 'ghost', size: 'sm', onClick: () => { void api('cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: state.taskId }) }).catch(error => update({ ...state, detail: error.message })) } }, t('cancel')),
            state.resultUrl && h('div', { style: { marginTop: 12, paddingTop: 10, borderTop: '0.5px solid var(--dsw-alias-border-l1)', display: 'flex', justifyContent: 'flex-end' } },
              h(Button, { variant: 'ghost', size: 'sm', icon: h(IconRightUpOutlineRegular, { size: 14 }), onClick: () => window.open(state.resultUrl, '_blank', 'noopener,noreferrer') }, t('result'))))
        }
        for (const kind of ['skillx', 'workflow']) {
          const id = 'skillx-workflow.' + kind
          ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: id, locale: NS }, () => h(Page, { kind })))
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id, order: kind === 'skillx' ? 30 : 31, locale: NS, label: () => t(kind) }, Icon))
        }
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'skillx-workflow.notice', locale: NS }, Notice))
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({ name: 'sidebar.workspaces.session.menu.item', id: 'skillx-workflow.extract', order: 350, locale: NS }, ({ sessionId, useMenuOpenState }) => {
          const [, setOpen] = useMenuOpenState()
          return h(MenuItemButton, { icon: h(Icon, { size: 14 }), onSelect: () => { setOpen(false); void extract(sessionId) } }, t('extract'))
        }))
      },
    }
  },
})
