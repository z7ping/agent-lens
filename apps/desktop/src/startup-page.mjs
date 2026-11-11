// The startup page is shown before the Web app (and its saved theme preference) can load.
// Keep this fallback aligned with packages/web/index.html; user preference still belongs to the Web app.
export const startupBackgroundColors = Object.freeze({ light: '#f6f7f9', dark: '#101216' })
export const startupBackgroundColor = dark => dark ? startupBackgroundColors.dark : startupBackgroundColors.light

const startupHtml = String.raw`
<!doctype html>
<html lang="en-US">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>AgentLens</title>
<style>
  :root {
    color-scheme: light;
    --startup-bg: #f6f7f9;
    --startup-fg: #1b2430;
    --startup-card: #ffffff;
    --startup-border: #dfe4ea;
    --startup-muted: #59677b;
    --startup-accent: #3675d9;
    --startup-ring: rgba(54,117,217,.12);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --startup-bg: #101216;
      --startup-fg: #f1f4f8;
      --startup-card: #171b21;
      --startup-border: #303744;
      --startup-muted: #a2adbc;
      --startup-accent: #8eb8ff;
      --startup-ring: rgba(142,184,255,.12);
    }
  }
  html,body{height:100%;margin:0;background:var(--startup-bg);color:var(--startup-fg);font-family:"Segoe UI","Microsoft YaHei",sans-serif}
  body{display:grid;place-items:center}
  main{display:flex;align-items:center;gap:14px;padding:24px 28px;border:1px solid var(--startup-border);border-radius:14px;background:var(--startup-card)}
  strong{display:block;font-size:18px;letter-spacing:.01em}
  span{display:block;margin-top:4px;color:var(--startup-muted);font-size:13px}
  i{width:10px;height:10px;border-radius:50%;background:var(--startup-accent);box-shadow:0 0 0 5px var(--startup-ring)}
</style>
</head>
<body><main><i></i><div><strong id="startup-title">AgentLens</strong><span id="startup-message">Starting the local runtime. First startup or large datasets may take a few minutes…</span></div></main>
<script>
  // Match the web application's system-language fallback before it is available.
  const language = (navigator.language || '').replaceAll('_', '-').trim().toLowerCase()
  if (language === 'zh' || language.startsWith('zh-')) {
    document.documentElement.lang = 'zh-CN'
    document.title = 'AgentLens · 智能体透镜'
    document.getElementById('startup-title').textContent = 'AgentLens · 智能体透镜'
    document.getElementById('startup-message').textContent = '正在启动本地运行时；首次启动或数据较多时可能需要几分钟…'
  }
</script></body>
</html>
`

export const startupPage = `data:text/html;charset=UTF-8,${encodeURIComponent(startupHtml)}`
