/* 任务复盘降噪提案：只负责原型交互，不进入正式 Web。 */
(function () {
  var root = document.querySelector('.calm-review')
  if (!root) return

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
      root.querySelectorAll('.calm-round').forEach(function (round) {
        round.hidden = mode === 'error' && !round.classList.contains('has-error')
      })
    })
  })

  root.querySelectorAll('.calm-session').forEach(function (item) {
    item.addEventListener('click', function () {
      root.querySelectorAll('.calm-session').forEach(function (other) { other.classList.toggle('active', other === item) })
    })
  })

  document.addEventListener('click', function (event) {
    if (!event.target.closest('.calm-filter')) {
      root.querySelectorAll('.calm-filter[open]').forEach(function (item) { item.removeAttribute('open') })
    }
  })
})()
