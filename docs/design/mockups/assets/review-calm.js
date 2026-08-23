/* 任务复盘降噪提案：只负责原型交互，不进入正式 Web。 */
(function () {
  var root = document.querySelector('.calm-review')
  if (!root) return

  var reader = root.querySelector('#calmReader')
  var rounds = Array.prototype.slice.call(root.querySelectorAll('.calm-round'))
  var sessions = Array.prototype.slice.call(root.querySelectorAll('.calm-session'))
  var positions = Object.create(null)
  var currentSession = root.querySelector('.calm-session.active') || sessions[0] || null

  function sessionKey(item) {
    if (!item) return ''
    if (item.dataset.sessionId) return item.dataset.sessionId
    var title = item.querySelector('.calm-session-title')
    return title ? title.textContent.trim() : String(sessions.indexOf(item))
  }

  function isRunning(item) {
    return !!item && (item.dataset.sessionState === 'running' || item.classList.contains('is-running'))
  }

  function savePosition(item) {
    if (!reader || !item) return
    positions[sessionKey(item)] = reader.scrollTop
  }

  function restorePosition(item) {
    if (!reader || !item) return
    var key = sessionKey(item)
    if (Object.prototype.hasOwnProperty.call(positions, key)) {
      reader.scrollTop = positions[key]
      return
    }
    reader.scrollTop = isRunning(item) ? reader.scrollHeight : 0
  }

  /* 轮次是连续阅读锚点，不承担折叠职责：默认全部展开，并保持展开。 */
  rounds.forEach(function (round) {
    round.open = true
    var summary = round.querySelector(':scope > summary')
    if (summary) {
      summary.setAttribute('aria-expanded', 'true')
      summary.setAttribute('title', '轮次默认展开；思考过程、工具详情和审计信息按需展开')
      summary.addEventListener('click', function (event) { event.preventDefault() })
      summary.style.cursor = 'default'
    }
    round.addEventListener('toggle', function () {
      if (!round.open) round.open = true
    })
  })

  var latest = root.querySelector('[data-scroll-bottom="#calmReader"]')
  if (latest) {
    latest.textContent = '↓ 最新'
    latest.setAttribute('title', '跳到会话最新位置')
  }

  var audit = root.querySelector('[data-audit-toggle]')
  if (audit) {
    audit.addEventListener('click', function () {
      var enabled = root.classList.toggle('audit-mode')
      audit.setAttribute('aria-pressed', String(enabled))
      audit.textContent = enabled ? '隐藏审计细节' : '显示审计细节'
    })
  }

  var roundButtons = root.querySelectorAll('[data-round-filter]')
  roundButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      roundButtons.forEach(function (item) { item.classList.toggle('active', item === button) })
      var mode = button.dataset.roundFilter
      rounds.forEach(function (round) {
        round.hidden = mode === 'error' && !round.classList.contains('has-error')
      })
    })
  })

  sessions.forEach(function (item) {
    item.addEventListener('click', function () {
      if (item === currentSession) return
      savePosition(currentSession)
      sessions.forEach(function (other) { other.classList.toggle('active', other === item) })
      currentSession = item
      restorePosition(item)
    })
  })

  /* 历史会话首次从顶部进入；进行中会话首次到底部；重新进入恢复上次阅读位置。 */
  requestAnimationFrame(function () { restorePosition(currentSession) })

  document.addEventListener('click', function (event) {
    if (!event.target.closest('.calm-filter')) {
      root.querySelectorAll('.calm-filter[open]').forEach(function (item) { item.removeAttribute('open') })
    }
  })
})()
