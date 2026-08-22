/* AgentLens Mock 共享交互：主题持久化 / 抽屉 / Tab / 排序 / 复制 / 长期能力导航 */
(function () {
  var KEY = 'al-mock-theme'
  function applyTheme(t) {
    document.documentElement.dataset.theme = t
    try { localStorage.setItem(KEY, t) } catch (e) {}
  }
  var saved = 'light'
  try { saved = localStorage.getItem(KEY) || 'light' } catch (e) {}
  applyTheme(saved)

  // 长期能力原型加入既有主导航；老画板无需逐页复制导航标记。
  var futureNav = [
    { href: 'backup.html', label: '资产备份' },
    { href: 'insights.html', label: '使用洞察' },
  ]
  document.querySelectorAll('.app-nav').forEach(function (nav) {
    futureNav.forEach(function (item) {
      if (nav.querySelector('a[href="' + item.href + '"]')) return
      var a = document.createElement('a')
      a.className = 'nav-item'
      a.href = item.href
      a.textContent = item.label
      nav.appendChild(a)
    })
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
    th.setAttribute('title', '点击切换升序/降序')
    th.setAttribute('tabindex', '0')
    th.setAttribute('role', 'button')
    function activate() {
      var table = th.closest('table')
      var tb = table.querySelector('tbody')
      var idx = Array.prototype.indexOf.call(th.parentElement.children, th)
      var numeric = th.dataset.sort === 'num'
      var dir = th.getAttribute('aria-sort') === 'descending' ? 'ascending' : 'descending'
      var rows = Array.prototype.slice.call(tb.rows).sort(function (a, b) {
        var x = a.children[idx].dataset.v, y = b.children[idx].dataset.v
        var cmp = numeric ? (+x) - (+y) : String(x).localeCompare(String(y))
        return dir === 'descending' ? -cmp : cmp
      })
      rows.forEach(function (r) { tb.appendChild(r) })
      table.querySelectorAll('th').forEach(function (h) { h.removeAttribute('aria-sort') })
      th.setAttribute('aria-sort', dir)
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

  // 轮次导航轨：点击刻度跳转滚动到对应轮次
  document.querySelectorAll('[data-scroll-to]').forEach(function (b) {
    b.addEventListener('click', function () {
      var el = document.querySelector(b.getAttribute('data-scroll-to'))
      if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  })

  document.querySelectorAll('.scope-manage > summary').forEach(function (s) {
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

  document.querySelectorAll('details.interaction > summary').forEach(function (s) {
    s.addEventListener('click', function () {
      var d = s.parentElement
      setTimeout(function () {
        var rect = d.getBoundingClientRect()
        if (rect.top < 60) d.scrollIntoView({ block: 'start' })
      }, 0)
    })
  })
})()
