from pathlib import Path

claude = Path('packages/source-claude/src/index.ts')
s = claude.read_text()
old = '''    const key = historyCheckpointKey(filePath)
    const previous = await ctx.checkpoint.get<HistoryCheckpoint>(key)
    const reset = !previous || previous.path !== filePath || fileStat.size < previous.offset
'''
new = '''    const key = historyCheckpointKey(filePath)
    const previous = await ctx.checkpoint.get<HistoryCheckpoint>(key)
    const unchanged = previous
      && previous.path === filePath
      && previous.offset === fileStat.size
      && previous.size === fileStat.size
      && previous.mtimeMs === fileStat.mtimeMs
    if (unchanged) continue

    const reset = !previous || previous.path !== filePath || fileStat.size < previous.offset
'''
if old not in s:
    raise SystemExit('Claude history target not found')
claude.write_text(s.replace(old, new, 1))

doc = Path('docs/1.0/PERFORMANCE-BASELINE.md')
s = doc.read_text()
section = r'''
## Source 历史扫描与实时采集基线（2026-08-26）

这一阶段遵守 ADR-0006：Source 的检查点只用于增量读取与扫描跳过，不改变 Canonical Observation / Evidence 的事实来源。

### Pi

优化前，Pi Runtime 每 500ms 重新执行一次完整 `ingestPiHistory()`：递归枚举所有 JSONL、`stat` 每个文件，并为未变化文件重复读取 Session Metadata。50 个小会话的空转 P95 为 **37.05ms**。

第一轮优化后：

- `path + offset + size + mtime` 完全一致时，在读取 Session Metadata 前直接跳过；
- Session Header 从整文件 `readFile()` 改为最多读取前 64KB；
- 50 文件空转 P95：**37.05ms → 2.19ms**；
- 首次同步：**64.06ms → 32.23ms**。

M 级（2000 文件 / 42000 条记录）在“完整历史扫描入口、全部文件未变化”下：

- 首次同步：**1618.05ms**；
- 空转 P50：**85.05ms**；
- 空转 P95：**100.78ms**。

随后 Runtime 改为 `fs.watch` 优先 + 180ms 去抖，只处理变化文件；只有监听不可用/报错时才退回 **5s** 目录轮询。因此上述 M 级 100.78ms 代表历史同步/轮询兜底成本，不再是每 500ms 的常驻成本。

### DSH

历史同步新增文件状态检查点（`path + size + mtime`），并保留原来的 `sessionId + lastSeq` 语义检查点。未变化 `.jsonl/.jsonl.zst` 会在 `readFile`、Zstandard 解压和 JSON 解析之前跳过。

Smoke（50 会话 / 500 事件）：

- 首次同步：**42.11ms**；
- 空转 P50：**3.50ms**；
- 空转 P95：**3.66ms**。

M 级（2000 会话 / 40000 事件）：

- 首次同步：**1154.57ms**；
- 空转 P50：**58.95ms**；
- 空转 P95：**63.96ms**。

DSH Runtime 仍以文件监听为主；文件读取期间若发生再次追加，只有读取前后文件状态一致时才写文件状态检查点，避免把尚未处理的新字节误标为已扫描。

### Codex / Claude Code

两者原本已经按文件 offset / sequence 做内容增量，但未变化旧文件仍会进入后续读取路径。现在统一增加同样的文件状态快速判断：

`path 一致 && offset == size && size 一致 && mtime 一致 → 直接跳过`

其中 Codex 可因此避免对未变化文件重复读取最多 256KB 的 `session_meta` 预览；Claude Code 可避免在 EOF 上重复创建 JSONL 读取流。语义检查点与历史记录归一化逻辑均未改变。
'''
if '## Source 历史扫描与实时采集基线（2026-08-26）' not in s:
    doc.write_text(s.rstrip() + '\n\n' + section.strip() + '\n')

# trigger finalize v2
