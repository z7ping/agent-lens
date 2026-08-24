/* AgentLens v2.1 共享交互：最终样式 / 品牌 / 主题 / 智能体筛选 / 原始记录 / 抽屉 / Tab / 排序 / 复制 / turn-rail */
(function () {
  var currentStyles = document.createElement('link')
  currentStyles.rel = 'stylesheet'
  currentStyles.href = 'assets/current.css'
  document.head.appendChild(currentStyles)

  var KEY = 'al-mock-theme'
  var AKEY = 'al-mock-audit'
  var sunIcon = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="3.4"/><path d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M15.8 4.2l-1.4 1.4M5.6 14.4l-1.4 1.4"/></svg>'
  var moonIcon = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.8 12.8A6.7 6.7 0 0 1 7.2 4.2 6.8 6.8 0 1 0 15.8 12.8Z"/></svg>'

  function renderThemeControls(theme) {
    document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
      button.innerHTML = theme === 'dark' ? sunIcon : moonIcon
      button.setAttribute('aria-label', theme === 'dark' ? '切换为浅色主题' : '切换为深色主题')
      button.setAttribute('title', theme === 'dark' ? '切换为浅色主题' : '切换为深色主题')
    })
  }

  function renderBrand() {
    document.querySelectorAll('.brand-mark').forEach(function (mark) {
      if (mark.querySelector('img')) return
      mark.textContent = ''
      var img = document.createElement('img')
      img.src = '../../../../packages/web/public/favicon.png'
      img.alt = ''
      img.setAttribute('aria-hidden', 'true')
      img.style.width = '100%'
      img.style.height = '100%'
      img.style.display = 'block'
      img.style.objectFit = 'contain'
      img.style.borderRadius = '7px'
      mark.appendChild(img)
      mark.style.background = 'transparent'
      mark.style.boxShadow = 'none'
    })
  }

  function sourceRowsHtml() {
    return [
      ['codex', 'Codex', 'dot-codex', true],
      ['claude-code', 'Claude Code', 'dot-claude', true],
      ['pi', 'Pi', 'dot-pi', false],
      ['hermes', 'Hermes', 'dot-hermes', false],
      ['opencode', 'OpenCode', 'dot-opencode', false]
    ].map(function (source) {
      return '<label><input type="checkbox" ' + (source[3] ? 'checked' : '') + '><span class="src-dot ' + source[2] + '"></span><span>' + source[1] + '</span><span class="st ' + (source[3] ? 'on' : '') + '">' + (source[3] ? '已检测' : '未检测') + '</span></label>'
    }).join('')
  }

  function syncScopeManagers() {
    if (/backup\.html$/i.test(location.pathname)) return
    document.querySelectorAll('.agent-scope').forEach(function (scope) {
      if (scope.querySelector('.scope-manage')) return
      var details = document.createElement('details')
      details.className = 'scope-manage'
      details.innerHTML = '<summary title="管理智能体快捷入口" aria-label="管理智能体快捷入口">＋</summary><div class="scope-pop"><div class="scope-pop-title">快捷智能体</div>' + sourceRowsHtml() + '</div>'
      scope.appendChild(details)
    })
  }

  function renderSourceDots() {
    document.querySelectorAll('.scope-pop label').forEach(function (label) {
      var text = label.textContent || ''
      var dot = label.querySelector('.src-dot') || label.querySelector('span')
      if (!dot) return
      if (text.indexOf('Hermes') >= 0) dot.classList.add('src-dot', 'dot-hermes')
      if (text.indexOf('OpenCode') >= 0) dot.classList.add('src-dot', 'dot-opencode')
    })
    document.querySelectorAll('.system-section .badge').forEach(function (badge) {
      var text = badge.textContent || ''
      if (text.indexOf('Hermes') < 0 && text.indexOf('OpenCode') < 0) return
      if (badge.querySelector('.src-dot')) return
      var dot = document.createElement('span')
      dot.className = 'src-dot ' + (text.indexOf('Hermes') >= 0 ? 'dot-hermes' : 'dot-opencode')
      badge.prepend(dot)
    })
  }

  function syncAgentSources() {
    var nav = document.querySelector('.source-nav')
    if (!nav || nav.querySelector('[data-source="hermes"]')) return
    ;[
      { id: 'hermes', label: 'Hermes', dot: 'dot-hermes' },
      { id: 'opencode', label: 'OpenCode', dot: 'dot-opencode' }
    ].forEach(function (source) {
      var button = document.createElement('button')
      button.className = 'src-option'
      button.dataset.source = source.id
      button.innerHTML = '<span class="src-dot lg ' + source.dot + '"></span><span class="src-copy"><b>' + source.label + '</b><small>0 项用户资产</small><em>未检测 · 未启用采集</em></span>'
      nav.appendChild(button)
    })
  }

  function syncBackupPrototype() {
    if (!/backup\.html$/i.test(location.pathname)) return
    var grid = document.querySelector('.protection-grid')
    if (grid && !grid.querySelector('[data-source="hermes"]')) {
      ;[
        { id: 'hermes', label: 'Hermes', dot: 'dot-hermes' },
        { id: 'opencode', label: 'OpenCode', dot: 'dot-opencode' }
      ].forEach(function (source) {
        var card = document.createElement('article')
        card.className = 'protection-card is-muted'
        card.dataset.source = source.id
        card.innerHTML = '<div class="protection-card-head"><span class="src-dot lg ' + source.dot + '"></span><b>' + source.label + '</b><span class="badge">未检测</span></div><div class="protection-counts"><div class="protection-count"><strong>0</strong><span>技能文件</span></div><div class="protection-count"><strong>0</strong><span>会话文件</span></div><div class="protection-count"><strong>0</strong><span>全部文件</span></div></div><div class="protection-meta"><span>MCP 0 · 插件/扩展 0</span><span>暂无路径</span></div>'
        grid.appendChild(card)
      })
    }

    var createButton = document.querySelector('.snapshot-create-button')
    var builder = createButton && createButton.closest('.future-card-body')
    if (!builder || builder.querySelector('[data-kind="plugin"]')) return
    var safety = builder.querySelector('.safety-note')
    if (!safety) return
    var counts = { skill: 63, mcp: 18, session: 76, config: 11, plugin: 5, extension: 2, hook: 4, memory: 3, rule: 7, other: 1 }
    var labels = {
      skill: '技能', mcp: 'MCP（模型上下文协议）', session: '会话 / 历史', config: '关键配置',
      plugin: '插件', extension: '扩展', hook: '钩子', memory: '记忆', rule: '规则', other: '其他'
    }
    var existing = Array.prototype.slice.call(builder.querySelectorAll('.builder-check'))
    var existingKinds = ['skill', 'mcp', 'session', 'config']
    existing.slice(-4).forEach(function (label, index) {
      var kind = existingKinds[index]
      if (!kind) return
      label.dataset.kind = kind
      if (!label.querySelector('small')) label.insertAdjacentHTML('beforeend', '<small>' + counts[kind] + '</small>')
    })
    ;['plugin', 'extension', 'hook', 'memory', 'rule', 'other'].forEach(function (kind) {
      var label = document.createElement('label')
      label.className = 'builder-check'
      label.dataset.kind = kind
      label.innerHTML = '<input type="checkbox" checked> ' + labels[kind] + '<small>' + counts[kind] + '</small>'
      builder.insertBefore(label, safety)
    })
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme
    renderThemeControls(theme)
    try { localStorage.setItem(KEY, theme) } catch (e) {}
  }

  var auditOn = false
  try { auditOn = localStorage.getItem(AKEY) === '1' } catch (e) {}
  function applyAudit(on) {
    document.body.classList.toggle('audit-mode', on)
    document.querySelectorAll('[data-audit-toggle]').forEach(function (button) { button.setAttribute('aria-pressed', String(on)) })
    try { localStorage.setItem(AKEY, on ? '1' : '0') } catch (e) {}
  }

  try { applyTheme(localStorage.getItem(KEY) || 'light') } catch (e) { applyTheme('light') }

  /* 页面脚本位于 body 末尾，可在事件绑定前补齐当前稿需要的共享组件。 */
  renderBrand()
  syncScopeManagers()
  renderSourceDots()
  syncAgentSources()
  syncBackupPrototype()
  renderThemeControls(document.documentElement.dataset.theme || 'light')
  applyAudit(auditOn)

  function closeAllDrawers() {
    document.querySelectorAll('.drawer.show').forEach(function (drawer) { drawer.classList.remove('show') })
    var scrim = document.getElementById('scrim')
    if (scrim) scrim.classList.remove('show')
  }

  function openDrawer(selector) {
    var drawer = document.querySelector(selector)
    if (!drawer) return
    drawer.classList.add('show')
    var scrim = document.getElementById('scrim')
    if (scrim) scrim.classList.add('show')
  }

  document.addEventListener('click', function (event) {
    var themeButton = event.target.closest('[data-theme-toggle]')
    if (themeButton) {
      applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark')
      return
    }
    var auditButton = event.target.closest('[data-audit-toggle]')
    if (auditButton) {
      auditOn = !auditOn
      applyAudit(auditOn)
      return
    }
    var opener = event.target.closest('[data-open-drawer]')
    if (opener) {
      openDrawer(opener.dataset.openDrawer)
      return
    }
    if (event.target.closest('[data-close-drawer]') || event.target.id === 'scrim') {
      closeAllDrawers()
      return
    }
    var copyButton = event.target.closest('[data-copy]')
    if (copyButton && navigator.clipboard) {
      navigator.clipboard.writeText(copyButton.dataset.copy).then(function () {
        var old = copyButton.textContent
        copyButton.textContent = '已复制'
        setTimeout(function () { copyButton.textContent = old }, 1200)
      }).catch(function () {})
    }
    var expandButton = event.target.closest('[data-expand-rounds]')
    if (expandButton) {
      var expand = expandButton.getAttribute('aria-pressed') !== 'true'
      document.querySelectorAll('details.interaction:not(.audit-only)').forEach(function (round) { round.open = expand })
      expandButton.setAttribute('aria-pressed', String(expand))
      expandButton.textContent = expand ? '收起当前页' : '展开当前页'
    }
  })

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeAllDrawers()
  })

  document.querySelectorAll('.tabs').forEach(function (tabs) {
    tabs.addEventListener('click', function (event) {
      var button = event.target.closest('[data-tab]')
      if (!button) return
      tabs.querySelectorAll('[data-tab]').forEach(function (item) { item.classList.toggle('active', item === button) })
      var host = tabs.closest('.drawer') || document
      host.querySelectorAll('[data-panel]').forEach(function (panel) { panel.hidden = panel.dataset.panel !== button.dataset.tab })
    })
  })

  document.querySelectorAll('th[data-sort]').forEach(function (th) {
    th.setAttribute('title', '点击排序')
    th.setAttribute('tabindex', '0')
    th.setAttribute('role', 'button')
    function activate() {
      var table = th.closest('table')
      var tbody = table && table.querySelector('tbody')
      if (!table || !tbody) return
      var index = Array.prototype.indexOf.call(th.parentElement.children, th)
      var numeric = th.dataset.sort === 'num'
      var rows = Array.prototype.slice.call(tbody.rows).sort(function (a, b) {
        var left = a.children[index].dataset.v
        var right = b.children[index].dataset.v
        return numeric ? (+right) - (+left) : String(right).localeCompare(String(left))
      })
      rows.forEach(function (row) { tbody.appendChild(row) })
      table.querySelectorAll('th').forEach(function (item) { item.removeAttribute('aria-sort') })
      th.setAttribute('aria-sort', 'descending')
    }
    th.addEventListener('click', activate)
    th.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        activate()
      }
    })
  })

  document.querySelectorAll('[data-scroll-bottom]').forEach(function (button) {
    button.addEventListener('click', function () {
      var pane = document.querySelector(button.getAttribute('data-scroll-bottom'))
      if (pane) pane.scrollTo({ top: pane.scrollHeight, behavior: 'smooth' })
    })
  })

  document.querySelectorAll('details.scope-manage > summary').forEach(function (summary) {
    summary.addEventListener('click', function (event) {
      event.stopPropagation()
      var details = summary.parentElement
      if (!details.hasAttribute('open')) {
        document.querySelectorAll('details.scope-manage[open]').forEach(function (open) {
          if (open !== details) open.removeAttribute('open')
        })
      }
    })
  })
  document.addEventListener('click', function (event) {
    if (!event.target.closest('.scope-manage')) {
      document.querySelectorAll('details.scope-manage[open]').forEach(function (open) { open.removeAttribute('open') })
    }
  })

  /* 会话切换：保存 / 恢复阅读位置。 */
  var reader = document.querySelector('[data-reader]')
  if (reader) {
    var positions = Object.create(null)
    var sessions = Array.prototype.slice.call(document.querySelectorAll('.session-item'))
    var current = document.querySelector('.session-item.active') || null
    function sessionKey(item) {
      if (!item) return ''
      var title = item.querySelector('.si-title')
      return item.dataset.sessionId || (title ? title.textContent.trim() : String(sessions.indexOf(item)))
    }
    sessions.forEach(function (item) {
      item.addEventListener('click', function () {
        if (item === current) return
        if (current) positions[sessionKey(current)] = reader.scrollTop
        sessions.forEach(function (other) { other.classList.toggle('active', other === item) })
        current = item
        reader.scrollTop = positions[sessionKey(item)] !== undefined ? positions[sessionKey(item)] : 0
      })
    })
  }

  /* turn-rail：滚动联动 + 点击定位。 */
  var rail = document.querySelector('.turn-rail')
  if (rail && reader) {
    var ticks = Array.prototype.slice.call(rail.querySelectorAll('.turn-tick'))
    var rounds = ticks.map(function (tick) {
      var element = document.querySelector(tick.dataset.target)
      if (tick.dataset.tip) tick.setAttribute('aria-label', tick.dataset.tip)
      return element
    })
    function visible(element) { return !!element && element.getClientRects().length > 0 }
    ticks.forEach(function (tick, index) {
      tick.addEventListener('click', function () {
        var element = rounds[index]
        if (!visible(element)) return
        var delta = element.getBoundingClientRect().top - reader.getBoundingClientRect().top - 88
        reader.scrollTo({ top: reader.scrollTop + delta, behavior: 'smooth' })
      })
    })
    function updateActive() {
      var top = reader.getBoundingClientRect().top
      var best = -1
      var bestDistance = Infinity
      rounds.forEach(function (element, index) {
        if (!visible(element)) return
        var distance = Math.abs(element.getBoundingClientRect().top - top - 90)
        if (distance < bestDistance) {
          bestDistance = distance
          best = index
        }
      })
      ticks.forEach(function (tick, index) { tick.classList.toggle('active', index === best) })
    }
    reader.addEventListener('scroll', updateActive, { passive: true })
    requestAnimationFrame(updateActive)
  }

  /* 工具类型 SVG 图标注入。 */
  var toolIcons = {
    shell: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 5 6 8 3 11"/><line x1="6" y1="11" x2="13" y2="11"/></svg>',
    read: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><polyline points="9 2 9 5 12 5"/></svg>',
    edit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13l2.5-.6 7-7-1.9-1.9-7 7L3 13z"/><path d="M9.8 4.3l1.9 1.9"/></svg>',
    search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5"/><line x1="10" y1="10" x2="14" y2="14"/></svg>',
    mcp: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="3" width="4" height="4" rx="1"/><rect x="9.5" y="9" width="4" height="4" rx="1"/><path d="M6.5 5h2a2 2 0 0 1 2 2v2"/></svg>',
    web: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M2.8 8h10.4M8 2.5c1.5 1.5 2.2 3.3 2.2 5.5S9.5 12 8 13.5M8 2.5C6.5 4 5.8 5.8 5.8 8S6.5 12 8 13.5"/></svg>',
    tool: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.8 3.1a3 3 0 0 0-3.7 3.7L2.8 10a1.5 1.5 0 0 0 2.1 2.1l3.3-3.3a3 3 0 0 0 3.7-3.7L10 7 8.8 5.8l1-2.7z"/></svg>'
  }
  document.querySelectorAll('.kicon[data-kind], .kicon[class*="kind-"]').forEach(function (icon) {
    var kind = 'tool'
    Object.keys(toolIcons).some(function (name) {
      if (icon.classList.contains('kind-' + name)) {
        kind = name
        return true
      }
      return false
    })
    icon.innerHTML = toolIcons[kind]
    icon.setAttribute('aria-hidden', 'true')
  })
})()
