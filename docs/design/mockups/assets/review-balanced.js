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

  var toolIcons = {
    shell: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 5 6 8 3 11"/><line x1="6" y1="11" x2="13" y2="11"/></svg>',
    read: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><polyline points="9 2 9 5 12 5"/></svg>',
    edit: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13l2.5-.6 7-7-1.9-1.9-7 7L3 13z"/><path d="M9.8 4.3l1.9 1.9"/></svg>',
    search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.5"/><line x1="10" y1="10" x2="14" y2="14"/></svg>',
    mcp: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="3" width="4" height="4" rx="1"/><rect x="9.5" y="9" width="4" height="4" rx="1"/><path d="M6.5 5h2a2 2 0 0 1 2 2v2"/></svg>',
    web: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M2.8 8h10.4M8 2.5c1.5 1.5 2.2 3.3 2.2 5.5S9.5 12 8 13.5M8 2.5C6.5 4 5.8 5.8 5.8 8S6.5 12 8 13.5"/></svg>',
    tool: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.8 3.1a3 3 0 0 0-3.7 3.7L2.8 10a1.5 1.5 0 0 0 2.1 2.1l3.3-3.3a3 3 0 0 0 3.7-3.7L10 7 8.8 5.8l1-2.7z"/></svg>'
  }

  /* 工具图标保持“徽章 + SVG + 小面积语义色”；错误是执行状态，不替换工具类型图标。 */
  root.querySelectorAll('.kicon').forEach(function (icon) {
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
