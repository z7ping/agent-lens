/* 任务复盘轻度降噪提案：轮次连续阅读 + 阅读位置恢复 + turn-rail 当前轮次。 */
(function () {
  var root = document.querySelector('.balanced-review')
  if (!root) return

  var reader = root.querySelector('#balancedReader')
  var rounds = Array.prototype.slice.call(root.querySelectorAll('.interaction'))
  var sessions = Array.prototype.slice.call(root.querySelectorAll('.session-item'))
  var ticks = Array.prototype.slice.call(root.querySelectorAll('.turn-tick'))
  var positions = Object.create(null)
  var currentSession = root.querySelector('.session-item.active') || sessions[0] || null

  function sessionKey(item) {
    if (!item) return ''
    if (item.dataset.sessionId) return item.dataset.sessionId
    var title = item.querySelector('.si-title')
    return title ? title.textContent.trim() : String(sessions.indexOf(item))
  }

  function isRunning(item) {
    return !!item && item.dataset.sessionState === 'running'
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

  /* 轮次默认全部展开，轮次标题只作为阅读锚点。 */
  rounds.forEach(function (round) {
    round.open = true
    var summary = round.querySelector(':scope > summary')
    if (summary) {
      summary.setAttribute('aria-expanded', 'true')
      summary.setAttribute('title', '轮次保持展开；思考过程、工具组和原始事件仍可按需展开')
      summary.addEventListener('click', function (event) { event.preventDefault() })
    }
    round.addEventListener('toggle', function () {
      if (!round.open) round.open = true
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

  function updateActiveTick() {
    if (!reader || !rounds.length || !ticks.length) return
    var readerTop = reader.getBoundingClientRect().top
    var bestIndex = 0
    var bestDistance = Infinity
    rounds.forEach(function (round, index) {
      if (round.hidden) return
      var distance = Math.abs(round.getBoundingClientRect().top - readerTop - 90)
      if (distance < bestDistance) {
        bestDistance = distance
        bestIndex = index
      }
    })
    ticks.forEach(function (tick, index) { tick.classList.toggle('active', index === bestIndex) })
  }

  if (reader) reader.addEventListener('scroll', updateActiveTick, { passive: true })
  requestAnimationFrame(function () {
    restorePosition(currentSession)
    updateActiveTick()
  })
})()
