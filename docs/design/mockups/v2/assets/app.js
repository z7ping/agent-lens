/* AgentLens v2.1 共享交互：品牌 / 主题 / 原始记录 / 抽屉 / Tab / 排序 / 复制 / turn-rail */
(function () {
  var KEY = 'al-mock-theme'
  var sunIcon = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="3.4"/><path d="M10 1.8v2M10 16.2v2M1.8 10h2M16.2 10h2M4.2 4.2l1.4 1.4M14.4 14.4l1.4 1.4M15.8 4.2l-1.4 1.4M5.6 14.4l-1.4 1.4"/></svg>'
  var moonIcon = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.8 12.8A6.7 6.7 0 0 1 7.2 4.2 6.8 6.8 0 1 0 15.8 12.8Z"/></svg>'

  function renderThemeControls(t) {
    document.querySelectorAll('[data-theme-toggle]').forEach(function (button) {
      button.innerHTML = t === 'dark' ? sunIcon : moonIcon
      button.setAttribute('aria-label', t === 'dark' ? '切换为浅色主题' : '切换为深色主题')
      button.setAttribute('title', t === 'dark' ? '切换为浅色主题' : '切换为深色主题')
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

  function applyTheme(t) {
    document.documentElement.dataset.theme = t
    renderThemeControls(t)
    try { localStorage.setItem(KEY, t) } catch (e) {}
  }
  try { applyTheme(localStorage.getItem(KEY) || 'light') } catch (e) { applyTheme('light') }

  /* 原始记录开关（证据徽章始终可见） */
  var AKEY = 'al-mock-audit'
  function applyAudit(on) {
    document.body.classList.toggle('audit-mode', on)
    document.querySelectorAll('[data-audit-toggle]').forEach(function (b) { b.setAttribute('aria-pressed', String(on)) })
    try { localStorage.setItem(AKEY, on ? '1' : '0') } catch (e) {}
  }
  var auditOn = false
  try { auditOn = localStorage.getItem(AKEY) === '1' } catch (e) {}
  if (document.body) applyAudit(auditOn)
  document.addEventListener('DOMContentLoaded', function () {
    renderBrand()
    renderThemeControls(document.documentElement.dataset.theme || 'light')
    applyAudit(auditOn)
  })

  function closeAllDrawers() {
    document.querySelectorAll('.drawer.show').forEach(function (d) { d.classList.remove('show') })
    var s = document.getElementById('scrim')
    if (s) s.classList.remove('show')
  }
  function openDrawer(sel) {
    var d = document.querySelector(sel)
    if (!d) return
    d.classList.add('show')
    var s = document.getElementById('scrim')
    if (s) s.classList.add('show')
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-theme-toggle]')
    if (t) { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); return }
    var a = e.target.closest('[data-audit-toggle]')
    if (a) { auditOn = !auditOn; applyAudit(auditOn); return }
    var opener = e.target.closest('[data-open-drawer]')
    if (opener) { openDrawer(opener.dataset.openDrawer); return }
    if (e.target.closest('[data-close-drawer]') || e.target.id === 'scrim') { closeAllDrawers(); return }
    var copyBtn = e.target.closest('[data-copy]')
    if (copyBtn && navigator.clipboard) {
      navigator.clipboard.writeText(copyBtn.dataset.copy).then(function () {
        var old = copyBtn.textContent
        copyBtn.textContent = '已复制'
        setTimeout(function () { copyBtn.textContent = old }, 1200)
      }).catch(function () {})
    }
    var expandBtn = e.target.closest('[data-expand-rounds]')
    if (expandBtn) {
      var expand = expandBtn.getAttribute('aria-pressed') !== 'true'
      document.querySelectorAll('details.interaction:not(.audit-only)').forEach(function (round) { round.open = expand })
      expandBtn.setAttribute('aria-pressed', String(expand))
      expandBtn.textContent = expand ? '收起当前页' : '展开当前页'
    }
  })

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeAllDrawers()
  })

  document.querySelectorAll('.tabs').forEach(function (tabs) {
    tabs.addEventListener('click', function (e) {
      var b = e.target.closest('[data-tab]')
      if (!b) return
      tabs.querySelectorAll('[data-tab]').forEach(function (x) { x.classList.toggle('active', x === b) })
      var host = tabs.closest('.drawer') || document
      host.querySelectorAll('[data-panel]').forEach(function (p) { p.hidden = p.dataset.panel !== b.dataset.tab })
    })
  })

  document.querySelectorAll('th[data-sort]').forEach(function (th) {
    th.setAttribute('title', '点击排序')
    th.setAttribute('tabindex', '0')
    th.setAttribute('role', 'button')
    function activate() {
      var table = th.closest('table')
      var tb = table.querySelector('tbody')
      var idx = Array.prototype.indexOf.call(th.parentElement.children, th)
      var numeric = th.dataset.sort === 'num'
      var rows = Array.prototype.slice.call(tb.rows).sort(function (a, b) {
        var x = a.children[idx].dataset.v, y = b.children[idx].dataset.v
        return numeric ? (+y) - (+x) : String(y).localeCompare(String(x))
      })
      rows.forEach(function (r) { tb.appendChild(r) })
      table.querySelectorAll('th').forEach(function (h) { h.removeAttribute('aria-sort') })
      th.setAttribute('aria-sort', 'descending')
    }
    th.addEventListener('click', activate)
    th.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate() }
    })
  })

  document.querySelectorAll('[data-scroll-bottom]').forEach(function (b) {
    b.addEventListener('click', function () {
      var pane = document.querySelector(b.getAttribute('data-scroll-bottom'))
      if (pane) pane.scrollTo({ top: pane.scrollHeight, behavior: 'smooth' })
    })
  })

  document.querySelectorAll('details.scope-manage > summary').forEach(function (s) {
    s.addEventListener('click', function (e) {
      e.stopPropagation()
      var d = s.parentElement
      if (!d.hasAttribute('open')) {
        document.querySelectorAll('details.scope-manage[open]').forEach(function (o) { if (o !== d) o.removeAttribute('open') })
      }
    })
  })
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.scope-manage')) {
      document.querySelectorAll('details.scope-manage[open]').forEach(function (o) { o.removeAttribute('open') })
    }
  })

  /* 会话切换：保存/恢复阅读位置 */
  var reader = document.querySelector('[data-reader]')
  if (reader) {
    var positions = Object.create(null)
    var sessions = Array.prototype.slice.call(document.querySelectorAll('.session-item'))
    var current = document.querySelector('.session-item.active') || null
    function keyOf(item) {
      if (!item) return ''
      var title = item.querySelector('.si-title')
      return item.dataset.sessionId || (title ? title.textContent.trim() : String(sessions.indexOf(item)))
    }
    sessions.forEach(function (item) {
      item.addEventListener('click', function () {
        if (item === current) return
        if (current) positions[keyOf(current)] = reader.scrollTop
        sessions.forEach(function (other) { other.classList.toggle('active', other === item) })
        current = item
        reader.scrollTop = positions[keyOf(item)] !== undefined ? positions[keyOf(item)] : 0
      })
    })
  }

  /* turn-rail：滚动联动 + 点击定位 */
  var rail = document.querySelector('.turn-rail')
  if (rail && reader) {
    var ticks = Array.prototype.slice.call(rail.querySelectorAll('.turn-tick'))
    var rounds = ticks.map(function (tick) {
      var el = document.querySelector(tick.dataset.target)
      if (tick.dataset.tip) tick.setAttribute('aria-label', tick.dataset.tip)
      return el
    })
    function isVisible(el) { return !!el && el.getClientRects().length > 0 }
    ticks.forEach(function (tick, i) {
      tick.addEventListener('click', function () {
        var el = rounds[i]
        if (!isVisible(el)) return
        var delta = el.getBoundingClientRect().top - reader.getBoundingClientRect().top - 88
        reader.scrollTo({ top: reader.scrollTop + delta, behavior: 'smooth' })
      })
    })
    function updateActive() {
      var top = reader.getBoundingClientRect().top
      var best = -1, bestDist = Infinity
      rounds.forEach(function (el, i) {
        if (!isVisible(el)) return
        var d = Math.abs(el.getBoundingClientRect().top - top - 90)
        if (d < bestDist) { bestDist = d; best = i }
      })
      ticks.forEach(function (tick, i) { tick.classList.toggle('active', i === best) })
    }
    reader.addEventListener('scroll', updateActive, { passive: true })
    requestAnimationFrame(updateActive)
  }

  /* 工具类型 SVG 图标注入 */
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
      if (icon.classList.contains('kind-' + name)) { kind = name; return true }
      return false
    })
    icon.innerHTML = toolIcons[kind]
    icon.setAttribute('aria-hidden', 'true')
  })
})()
