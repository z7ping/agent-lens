import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = path => readFileSync(resolve(root, path), 'utf8')
const requireText = (condition, message) => {
  if (!condition) throw new Error(`[desktop-contract] ${message}`)
}

const desktopPackage = JSON.parse(read('apps/desktop/package.json'))
requireText(desktopPackage.build?.productName === 'AgentLens', '桌面产品名必须为 AgentLens')
requireText(desktopPackage.description.includes('智能体透镜'), '桌面描述缺少正式中文名“智能体透镜”')
requireText(desktopPackage.build?.nsis?.runAfterFinish === true, 'Windows 交互安装完成后必须默认运行 AgentLens')
for (const platform of ['win', 'mac', 'linux']) {
  const targets = desktopPackage.build?.[platform]?.target ?? []
  requireText(targets.length > 0, `${platform} 缺少桌面打包目标`)
  requireText(targets.every(target => Array.isArray(target.arch) && target.arch.length === 1 && target.arch[0] === 'x64'), `${platform} 桌面发行必须仅允许 x64`)
}
for (const script of ['dist:win', 'dist:win:dir', 'dist:mac', 'dist:mac:release', 'dist:mac:dir', 'dist:linux', 'dist:linux:dir']) {
  requireText(desktopPackage.scripts?.[script]?.includes('--x64'), `${script} 必须显式限制为 x64`)
}

const desktopWorkflow = read('.github/workflows/desktop-macos-linux.yml')
requireText(desktopWorkflow.includes('runs-on: macos-15-intel'), 'macOS 桌面发行必须使用 Intel runner')
requireText(desktopWorkflow.includes('runs-on: ubuntu-latest'), 'Linux 桌面发行必须使用 x64 runner')
requireText(!/arm64|ubuntu-24\.04-arm|macos-latest/.test(desktopWorkflow), '桌面发行 Workflow 不得再包含 ARM64 runner 或产物')
requireText(desktopWorkflow.includes('SHA256SUMS-macos-x64.txt'), 'macOS 校验文件必须明确为 x64')
requireText(desktopWorkflow.includes('SHA256SUMS-linux-x64.txt'), 'Linux 校验文件必须明确为 x64')

const bootstrap = read('apps/desktop/src/bootstrap.mjs')
requireText(bootstrap.includes("app.setName('AgentLens')"), 'Electron bootstrap 未固定产品名 AgentLens')
requireText(bootstrap.includes("app.setPath('logs', dirname(bootLogPath))"), 'Desktop 与 Daemon 日志未统一到正式日志目录')
requireText(bootstrap.includes("join(dirname(process.execPath), 'logs', 'desktop.log')"), '打包版没有优先把日志写到安装目录')
requireText(bootstrap.includes('AGENT_LENS_LOG_DIR'), '桌面日志缺少显式目录覆盖入口')
requireText(bootstrap.includes('fallbackBootLogPath()'), '安装目录不可写时没有保留日志兜底')

const main = read('apps/desktop/src/main.mjs')
requireText(main.includes('AgentLens · 智能体透镜'), '桌面窗口或托盘缺少正式中文名“智能体透镜”')
requireText(main.includes('show: !startHidden'), '普通双击启动没有立即显示窗口反馈')
requireText(main.includes('DAEMON_STARTUP_TIMEOUT_MS = 10 * 60_000'), '首次同步等待窗口没有覆盖大数据量冷启动')

const integration = read('apps/desktop/src/integration.mjs')
requireText(integration.includes('refreshDesktopCliPath'), 'Desktop 启动没有重新协调 npm/Desktop CLI PATH 优先级')
requireText(integration.includes("'-Action', 'install'"), 'Desktop 启动没有复用安装器 CLI PATH helper')

const installer = read('apps/desktop/build/installer.nsh')
requireText(installer.includes('agent-lens.cmd'), 'Windows 安装器没有安装 Desktop CLI shim')
requireText(installer.includes('agent-lens-cli-path.ps1'), 'Windows 安装器没有安装 CLI PATH helper')

const cliPathHelper = read('apps/desktop/build/agent-lens-cli-path.ps1')
requireText(cliPathHelper.includes("@z7ping\\agent-lens\\package.json"), 'CLI PATH helper 没有验证 npm AgentLens 安装')
requireText(cliPathHelper.includes("$mode = 'npm-primary'"), 'CLI PATH helper 没有固定有效 1.x npm 优先规则')
requireText(cliPathHelper.includes("$mode = 'desktop-primary'"), 'CLI PATH helper 没有固定 Desktop 兜底规则')
requireText(cliPathHelper.includes("[int]$Matches[1] -lt 1"), 'CLI PATH helper 没有排除 0.x npm CLI')

const surface = read('packages/surface-http/src/server.ts')
requireText(surface.includes('storageHealthProbe'), 'Health 请求没有合并并发 Storage 探测')

const windowsSmoke = read('scripts/smoke-windows-desktop.ps1')
requireText(windowsSmoke.includes('$process.MainWindowHandle -eq 0'), 'Windows 冒烟没有验证普通双击后的可见窗口')
requireText(windowsSmoke.includes('内嵌图标仍有深色外边缘'), 'Windows 冒烟没有阻止深色图标外边缘回归')

const installerCliSmoke = read('scripts/smoke-windows-installer-cli.ps1')
requireText(installerCliSmoke.includes('npm-agent-lens-ci'), 'Windows Installer 冒烟没有覆盖 npm CLI 优先场景')
requireText(installerCliSmoke.includes('npm 卸载后 Desktop CLI 没有自动兜底'), 'Windows Installer 冒烟没有覆盖 npm 卸载后的 Desktop CLI 回退')
requireText(installerCliSmoke.includes('卸载 Desktop 错误删除了 npm CLI'), 'Windows Installer 冒烟没有覆盖 Desktop 卸载保护 npm')

console.log('AgentLens 桌面契约检查通过：产品名、x64-only 发行、安装后启动、CLI 双发行优先级、即时窗口、Health 合并、日志目录与图标边缘均已锁定。')
