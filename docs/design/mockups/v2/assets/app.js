/* AgentLens v2.1 共享交互：最终样式 / 品牌 / 主题 / 智能体筛选 / 原始记录 / 抽屉 / 页签 / 排序 / 复制 / 轮次轨 */
(function () {
  var currentStyles = document.createElement('link')
  currentStyles.rel = 'stylesheet'
  currentStyles.href = 'assets/current.css'
  document.head.appendChild(currentStyles)

  var parityStyles = document.createElement('style')
  parityStyles.textContent = '.tip::after{white-space:pre-line!important;max-width:min(320px,calc(100vw - 24px))!important}.tip{position:relative;cursor:help}'
  document.head.appendChild(parityStyles)

  var THEME_KEY = 'al-mock-theme'
  var AUDIT_KEY = 'al-mock-audit'
  var sunIcon = '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="3.4"/><path d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M15.8 4.2l-1.4 1.4M5.6 14.4l-1.4 1.4"/></svg>'
  var moonIcon = '<svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.8 12.8A6.7 6.7 0 0 1 7.2 4.2 6.8 6.8 0 1 0 15.8 12.8Z"/></svg>'

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
      img.src = '../../../../packages/web/public/agentlens-icon.svg'
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

  function normalizeStatusPills() {
    document.querySelectorAll('.status-pill').forEach(function (pill) {
      var label = pill.querySelector('.status-label')
      if (!label) {
        Array.prototype.slice.call(pill.childNodes).forEach(function (node) {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) return
          if (!label) {
            label = document.createElement('span')
            label.className = 'status-label'
            node.replaceWith(label)
          } else {
            node.remove()
          }
        })
      }
      if (label) label.textContent = '运行正常'
    })
  }

  function sourceRowsHtml() {
    return [
      ['Codex', 'dot-codex', true],
      ['Claude Code', 'dot-claude', true],
      ['Pi', 'dot-pi', false],
      ['Hermes', 'dot-hermes', false],
      ['OpenCode', 'dot-opencode', false]
    ].map(function (source) {
      return '<label><input type="checkbox" ' + (source[2] ? 'checked' : '') + '><span class="src-dot ' + source[1] + '"></span><span>' + source[0] + '</span><span class="st ' + (source[2] ? 'on' : '') + '">' + (source[2] ? '已检测' : '未检测') + '</span></label>'
    }).join('')
  }

  function normalizeScopeLabels() {
    document.querySelectorAll('.agent-scope .scope-chip').forEach(function (chip) {
      if (chip.textContent.trim() === '全部') chip.textContent = '全部智能体'
    })
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
    document.querySelectorAll('.system-section .badge').forEach(function (badge) {
      var text = badge.textContent || ''
      if ((text.indexOf('Hermes') < 0 && text.indexOf('OpenCode') < 0) || badge.querySelector('.src-dot')) return
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

  function syncAgentDetails() {
    if (!/agents\.html$/i.test(location.pathname)) return
    var selectedCard = document.querySelector('.agents-browser .acard')
    if (selectedCard) selectedCard.classList.add('src-claude')

    document.querySelectorAll('.caps .cap').forEach(function (cap) {
      if (cap.dataset.currentCapability === 'true') return
      var title = cap.querySelector('b')
      var detail = cap.querySelector('span')
      if (!title || !detail) return
      var parts = title.textContent.split(' · ')
      var name = parts.shift() || title.textContent
      var status = parts.join(' · ') || '可用'
      cap.innerHTML = '<span>' + name + ' · ' + detail.textContent + '</span><b>' + status + '</b>'
      cap.dataset.currentCapability = 'true'
    })

    var matrix = document.querySelector('.matrix')
    if (!matrix || matrix.dataset.currentMatrix === 'true') return
    var rows = Array.prototype.slice.call(matrix.querySelectorAll('.mrow'))
    rows.forEach(function (row, index) {
      if (index === 0) {
        if (row.textContent.indexOf('Hermes') < 0) row.insertAdjacentHTML('beforeend', '<span><span class="src-dot dot-hermes"></span>Hermes</span><span><span class="src-dot dot-opencode"></span>OpenCode</span>')
        return
      }
      var first = row.children[0]
      if (first) first.classList.add('m-asset')
      if (row.children.length < 6) row.insertAdjacentHTML('beforeend', '<span>未观察到</span><span>未观察到</span>')
      Array.prototype.slice.call(row.children, 1).forEach(function (cell) {
        var text = cell.textContent.trim()
        cell.classList.add('heat')
        if (text === '已使用') cell.classList.add('used')
        else if (text === '可发现') cell.classList.add('discoverable')
        else if (text === '已配置') cell.classList.add('configured')
        else if (text === '已发现') cell.classList.add('discovered')
        else cell.classList.add('unobserved')
      })
    })
    var wrap = document.createElement('div')
    wrap.className = 'matrix-wrap'
    rows.forEach(function (row) { wrap.appendChild(row) })
    matrix.appendChild(wrap)
    matrix.dataset.currentMatrix = 'true'
  }

  function backupSourceChip(id, label, dot) {
    return '<button class="scope-chip" disabled data-source="' + id + '"><span class="src-dot ' + dot + '"></span>' + label + '</button>'
  }

  function builderKindHtml() {
    return [
      ['skill', '技能', 63], ['mcp', '模型上下文协议（MCP）', 18], ['plugin', '插件', 5], ['extension', '扩展', 2], ['hook', '钩子', 4],
      ['memory', '记忆', 3], ['rule', '规则', 7], ['session', '会话 / 历史', 76], ['config', '关键配置', 11], ['other', '其他', 1]
    ].map(function (kind) {
      return '<label class="builder-check" data-kind="' + kind[0] + '"><input type="checkbox" checked>' + kind[1] + '<small>' + kind[2] + '</small></label>'
    }).join('')
  }

  function syncBackupPrototype() {
    if (!/backup\.html$/i.test(location.pathname)) return

    var toolbarScope = document.querySelector('.workspace-toolbar .agent-scope')
    if (toolbarScope && !toolbarScope.querySelector('[data-source="hermes"]')) {
      toolbarScope.insertAdjacentHTML('beforeend', backupSourceChip('hermes', 'Hermes', 'dot-hermes') + backupSourceChip('opencode', 'OpenCode', 'dot-opencode'))
    }

    var grid = document.querySelector('.protection-grid')
    if (grid && !grid.querySelector('[data-source="hermes"]')) {
      ;[
        { id: 'hermes', label: 'Hermes', dot: 'dot-hermes' },
        { id: 'opencode', label: 'OpenCode', dot: 'dot-opencode' }
      ].forEach(function (source) {
        var card = document.createElement('article')
        card.className = 'protection-card is-muted'
        card.dataset.source = source.id
        card.innerHTML = '<div class="protection-card-head"><span class="src-dot lg ' + source.dot + '"></span><b>' + source.label + '</b><span class="badge">未检测</span></div><div class="protection-counts"><div class="protection-count"><strong>0</strong><span>技能文件</span></div><div class="protection-count"><strong>0</strong><span>会话文件</span></div><div class="protection-count"><strong>0</strong><span>全部文件</span></div></div><div class="protection-meta"><span>模型上下文协议 0 · 插件/扩展 0</span><span>暂无路径</span></div>'
        grid.appendChild(card)
      })
    }

    var createButton = document.querySelector('.snapshot-create-button')
    var builder = createButton && createButton.closest('.future-card-body')
    if (builder && builder.dataset.currentBuilder !== 'true') {
      builder.classList.add('snapshot-builder')
      builder.innerHTML = '<div class="builder-block"><div class="builder-label"><span>智能体</span><span data-builder-count>3 / 3</span></div><div class="builder-checks">' +
        '<label class="builder-check"><input type="checkbox" checked><span class="src-dot dot-codex"></span>Codex<small>80 文件</small></label>' +
        '<label class="builder-check"><input type="checkbox" checked><span class="src-dot dot-claude"></span>Claude Code<small>85 文件</small></label>' +
        '<label class="builder-check"><input type="checkbox" checked><span class="src-dot dot-pi"></span>Pi<small>19 文件</small></label>' +
        '</div></div><div class="builder-block"><div class="builder-label"><span>资产类型</span><button class="link-btn" data-builder-toggle>清空</button></div><div class="builder-checks" data-kind-checks>' + builderKindHtml() +
        '</div></div><div class="safety-note"><span>✓</span><div><b>敏感信息保护强制开启</b><span>凭据、令牌、私钥和秘密赋值会整文件排除并记录原因。</span></div></div>' +
        '<div class="builder-summary"><span>按分类统计约 <b>190</b> 条文件引用</span><span>重叠路径会自动去重</span></div>' +
        '<button class="btn primary snapshot-create-button">创建并校验快照</button>'
      builder.dataset.currentBuilder = 'true'
    }

    var preview = document.getElementById('restore-preview')
    if (preview && preview.dataset.currentPreview !== 'true') {
      preview.innerHTML = '<div class="dw-head"><div><div class="dw-eyebrow">恢复预演</div><div class="dw-title">快照差异 <span class="badge warn">1 项需关注</span></div><div class="dw-sub">backup-20260824-2142</div></div><button class="icon-button" data-close-drawer aria-label="关闭">×</button></div>' +
        '<div class="future-drawer-body"><section class="drawer-section"><h3>差异摘要</h3><div class="preview-summary"><span><b>182</b> 一致</span><span><b>1</b> 缺失</span><span><b>1</b> 已修改</span><span><b>0</b> 阻止</span></div></section>' +
        '<section class="drawer-section"><h3>文件</h3><div class="drawer-file-list"><div class="drawer-file preview-file"><span class="badge ok">一致</span><code>skills/code-review/SKILL.md</code></div><div class="drawer-file preview-file"><span class="badge warn">当前已修改</span><code>sessions/2026-08-21.jsonl</code><small>当前文件内容与快照哈希不同</small></div></div></section>' +
        '<section class="drawer-section"><div class="future-note"><b>这里只做预演。</b> 当前版本没有直接写回接口，因此查看差异不会修改任何已检测智能体的文件。</div></section></div>' +
        '<div class="future-drawer-footer"><span>仅预览 · 不会自动写回</span><button class="btn" data-close-drawer>关闭</button></div>'
      preview.dataset.currentPreview = 'true'
    }
  }

  function syncSessionAutoLoadHint() {
    document.querySelectorAll('.session-load-more').forEach(function (control) {
      var hint = document.createElement('div')
      hint.className = control.className
      hint.dataset.sessionAutoLoad = 'true'
      hint.setAttribute('role', 'status')
      hint.setAttribute('aria-live', 'polite')
      hint.textContent = '滚轮 / 滚动条向下到底部，自动加载更多会话 · 每次最多 40 条'
      hint.title = '滚动左侧会话列表到底部时自动加载下一批会话'
      hint.style.cursor = 'default'
      hint.style.pointerEvents = 'none'
      control.replaceWith(hint)
    })
  }

  function syncReviewPrototype() {
    if (!/review\.html$/i.test(location.pathname)) return
    document.title = '任务复盘 · AgentLens v2.1'
    document.querySelectorAll('.trajectory-source').forEach(function (source) {
      if (source.textContent.trim() === 'Daemon') source.textContent = '后台服务'
    })
    document.querySelectorAll('.sentinel').forEach(function (sentinel) {
      if (sentinel.textContent.indexOf('执行轨迹审阅版') >= 0) sentinel.textContent = '已完整加载当前会话'
    })
    document.querySelectorAll('.trajectory-thought').forEach(function (thought) {
      var content = thought.querySelector('.trajectory-thought-content')
      var actions = thought.querySelector('.trajectory-thought-actions')
      if (!content || !actions || actions.querySelector('[data-thought-source]')) return
      var source = document.createElement('pre')
      source.className = 'trajectory-message-source'
      source.hidden = true
      source.textContent = content.textContent
      actions.before(source)
      var button = document.createElement('button')
      button.className = 'trajectory-evidence-link'
      button.dataset.thoughtSource = 'true'
      button.textContent = '查看源码'
      actions.insertBefore(button, actions.firstChild)
    })
  }

  function syncInspectorEvidenceCount() {
    var inspector = document.getElementById('trajectory-inspector')
    if (!inspector) return
    var tab = inspector.querySelector('[data-tab="evidence"]')
    var list = inspector.querySelector('#inspector-evidence')
    if (!tab || !list) return
    var count = list.querySelectorAll('.inspector-evidence-card').length
    tab.textContent = count > 0 ? '证据 · ' + count : '证据'
  }

  function syncSystemPrototype() {
    if (!/system\.html$/i.test(location.pathname)) return
    var sections = document.querySelectorAll('.system-section')
    if (sections[0]) {
      var p = sections[0].querySelector('p')
      if (p) p.textContent = '正文 14px，列表与表格主体 13px，辅助信息统一 12px；22px 用于会话标题和非一级导航的规范页标题。一级页面名称已经由顶部导航表达时，不再重复占用首屏。'
      var firstLabel = sections[0].querySelector('.type-spec small')
      if (firstLabel) firstLabel.textContent = '会话 / 规范页标题 22/700'
    }
    var colorSection = sections[sections.length - 1]
    if (colorSection) {
      var colorNote = colorSection.querySelector('p')
      if (colorNote) colorNote.textContent = '明暗主题共用语义设计令牌；浅色工作区使用冷中性灰画布承托白色数据层，任务复盘右侧阅读区保持白色、左侧会话区使用浅灰层级。顶部、表格、抽屉与检查器不使用背景模糊。'
    }
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme
    renderThemeControls(theme)
    try { localStorage.setItem(THEME_KEY, theme) } catch (e) {}
  }

  var auditOn = false
  try { auditOn = localStorage.getItem(AUDIT_KEY) === '1' } catch (e) {}
  function applyAudit(on) {
    document.body.classList.toggle('audit-mode', on)
    document.querySelectorAll('[data-audit-toggle]').forEach(function (button) { button.setAttribute('aria-pressed', String(on)) })
    try { localStorage.setItem(AUDIT_KEY, on ? '1' : '0') } catch (e) {}
  }

  try { applyTheme(localStorage.getItem(THEME_KEY) || 'light') } catch (e) { applyTheme('light') }

  renderBrand()
  normalizeStatusPills()
  normalizeScopeLabels()
  syncScopeManagers()
  renderSourceDots()
  syncAgentSources()
  syncAgentDetails()
  syncBackupPrototype()
  syncSessionAutoLoadHint()
  syncReviewPrototype()
  syncSystemPrototype()
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

  function refreshBuilderToggle(button) {
    var block = button.closest('.builder-block')
    var boxes = block ? Array.prototype.slice.call(block.querySelectorAll('input[type="checkbox"]')) : []
    var allChecked = boxes.length > 0 && boxes.every(function (box) { return box.checked })
    button.textContent = allChecked ? '清空' : '全选'
  }

  document.addEventListener('change', function (event) {
    var box = event.target.closest('.snapshot-builder input[type="checkbox"]')
    if (!box) return
    var builder = box.closest('.snapshot-builder')
    if (!builder) return
    var sourceBoxes = Array.prototype.slice.call(builder.querySelectorAll('.builder-block:first-child input[type="checkbox"]'))
    var count = builder.querySelector('[data-builder-count]')
    if (count) count.textContent = sourceBoxes.filter(function (item) { return item.checked }).length + ' / ' + sourceBoxes.length
    var toggle = builder.querySelector('[data-builder-toggle]')
    if (toggle) refreshBuilderToggle(toggle)
  })

  document.addEventListener('click', function (event) {
    var inspectTrigger = event.target.closest('[data-inspect]')
    if (inspectTrigger) setTimeout(syncInspectorEvidenceCount, 0)

    var thoughtSource = event.target.closest('[data-thought-source]')
    if (thoughtSource) {
      var thought = thoughtSource.closest('.trajectory-thought')
      var content = thought && thought.querySelector('.trajectory-thought-content')
      var source = thought && thought.querySelector('.trajectory-message-source')
      if (!content || !source) return
      var showingSource = !source.hidden
      source.hidden = showingSource
      content.hidden = !showingSource
      thoughtSource.textContent = showingSource ? '查看源码' : '返回渲染'
      return
    }

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
    var builderToggle = event.target.closest('[data-builder-toggle]')
    if (builderToggle) {
      var block = builderToggle.closest('.builder-block')
      var boxes = block ? Array.prototype.slice.call(block.querySelectorAll('input[type="checkbox"]')) : []
      var shouldCheck = !boxes.every(function (box) { return box.checked })
      boxes.forEach(function (box) { box.checked = shouldCheck })
      refreshBuilderToggle(builderToggle)
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
      document.querySelectorAll('details.interaction:not(.audit-only), details.trajectory-round:not([hidden])').forEach(function (round) { round.open = expand })
      expandButton.setAttribute('aria-pressed', String(expand))
      expandButton.textContent = expand ? '收起当前页' : '展开当前页'
    }
  })

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      closeAllDrawers()
      return
    }
    if (event.key !== 'Enter' && event.key !== ' ') return
    var opener = event.target.closest('[data-open-drawer]')
    if (!opener) return
    event.preventDefault()
    openDrawer(opener.dataset.openDrawer)
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
      var nextDirection = th.getAttribute('aria-sort') === 'descending' ? 'ascending' : 'descending'
      var rows = Array.prototype.slice.call(tbody.rows).sort(function (a, b) {
        var left = a.children[index].dataset.v || a.children[index].textContent.trim()
        var right = b.children[index].dataset.v || b.children[index].textContent.trim()
        var delta = numeric ? (+left) - (+right) : String(left).localeCompare(String(right))
        return nextDirection === 'descending' ? -delta : delta
      })
      rows.forEach(function (row) { tbody.appendChild(row) })
      table.querySelectorAll('th').forEach(function (item) { item.removeAttribute('aria-sort') })
      th.setAttribute('aria-sort', nextDirection)
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
