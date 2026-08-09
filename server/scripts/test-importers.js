#!/usr/bin/env node
/**
 * test-importers.js - JSONL 历史导入器解析与水位线测试
 *
 * 运行：npm test  或  node server/scripts/test-importers.js
 * 纯 Node（无需浏览器 / 数据库），保证可离线执行。
 */

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fixturesDir = path.join(__dirname, '..', 'importers', '__tests__', 'fixtures');
const { parseClaudeLines, extractText } = require('../importers/claude-code');
const { parseCodexLines, parseFunctionOutput, sessionIdFromFilename } = require('../importers/codex');
const { JsonlImporter } = require('../importers/base');

let passed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(e.stack || e.message);
        process.exitCode = 1;
    }
}

async function main() {
console.log('── Claude Code JSONL 解析 ──');
await test('解析 user/assistant/tool 配对', () => {
    const lines = fs.readFileSync(path.join(fixturesDir, 'claude-sample.jsonl'), 'utf-8').split('\n').filter(Boolean);
    const { records } = parseClaudeLines(lines, {});
    const users = records.filter(r => r.role === 'user');
    const assistants = records.filter(r => r.role === 'assistant');
    const tools = records.filter(r => r.role === 'tool_result' || r.role === 'tool_error');

    assert.strictEqual(users.length, 1, '应有 1 条用户消息');
    assert.strictEqual(users[0].content, '帮我修复测试失败');
    assert.strictEqual(assistants.length, 1, '应有 1 条助手文本');
    assert.strictEqual(assistants[0].content, '好的，先看看测试结果');
    assert.strictEqual(tools.length, 2, '应有 2 条工具记录');

    const ok = tools.find(t => t.tool_use_id === 'call_1');
    const err = tools.find(t => t.tool_use_id === 'call_2');
    assert.ok(ok, 'call_1 应存在');
    assert.strictEqual(ok.role, 'tool_result');
    assert.strictEqual(ok.tool_name, 'Bash');
    assert.strictEqual(ok.success, true);
    assert.strictEqual(ok.output_snippet, '1 failing test');
    assert.strictEqual(ok.duration_ms, 2000, 'call_1 耗时应为 2s');

    assert.ok(err, 'call_2 应存在');
    assert.strictEqual(err.role, 'tool_error');
    assert.strictEqual(err.tool_name, 'Edit');
    assert.strictEqual(err.success, false);
    assert.strictEqual(err.error_message, 'Error: file not found');
});

await test('tool_use/tool_result 跨批次配对（meta 持久化）', () => {
    const lines = fs.readFileSync(path.join(fixturesDir, 'claude-sample.jsonl'), 'utf-8').split('\n').filter(Boolean);
    // 第一批：只有前 2 行（user + assistant/tool_use）
    const first = parseClaudeLines(lines.slice(0, 2), {});
    assert.strictEqual(first.records.length, 2);
    assert.ok(first.meta.pendingTools.call_1, 'call_1 应进入 pending');
    // 第二批：tool_result 通过 meta.pendingTools 配对
    const second = parseClaudeLines(lines.slice(2), { meta: first.meta });
    const tools = second.records.filter(r => r.role === 'tool_result' || r.role === 'tool_error');
    assert.strictEqual(tools.length, 2, '跨批次后应能配对出 2 条工具记录');
    assert.ok(tools.every(t => t.tool_name), '配对后的工具应有工具名');
});

await test('extractText 处理 string 与 block 数组', () => {
    assert.strictEqual(extractText('plain'), 'plain');
    assert.strictEqual(extractText([{ type: 'text', text: 'a' }, { type: 'thinking', thinking: 'b' }]), 'a\n\nb');
    assert.strictEqual(extractText(null), '');
});

console.log('── Codex JSONL 解析 ──');
await test('解析 session_meta/message/function_call', () => {
    const lines = fs.readFileSync(path.join(fixturesDir, 'codex-sample.jsonl'), 'utf-8').split('\n').filter(Boolean);
    const { records } = parseCodexLines(lines, {});
    const users = records.filter(r => r.role === 'user');
    const assistants = records.filter(r => r.role === 'assistant');
    const tools = records.filter(r => r.role === 'tool_result' || r.role === 'tool_error');

    assert.strictEqual(users.length, 1, '应只有 1 条真实用户消息（环境上下文被跳过）');
    assert.strictEqual(users[0].content, '运行测试并修复');
    assert.strictEqual(assistants.length, 1, '应有 1 条助手回复');
    assert.strictEqual(assistants[0].content, '好的，先跑测试');
    assert.strictEqual(tools.length, 1, '应有 1 条工具记录');
    const tool = tools[0];
    assert.strictEqual(tool.role, 'tool_error', 'Exit code 1 应为 tool_error');
    assert.strictEqual(tool.tool_name, 'shell_command');
    assert.strictEqual(tool.exit_code, 1);
    assert.strictEqual(tool.success, false);
    assert.strictEqual(tool.output_snippet, 'failed 1 test');
    assert.strictEqual(tool.duration_ms, 2, 'codex 耗时按秒取整为 2s');
    assert.strictEqual(tool.project_key, require('../adapters/base').prototype.getProjectKey('F:\\proj'));
});

await test('Codex 长消息与新版 content block 不截断', () => {
    const longText = `开头\n${'长内容'.repeat(1200)}\n结尾`;
    const lines = [
        JSON.stringify({ type: 'session_meta', payload: { id: '019e347c-6583-7852-8aa5-bbc490cd4986', cwd: 'F:\\proj' } }),
        JSON.stringify({
            type: 'response_item',
            timestamp: '2026-08-09T10:00:00.000Z',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [
                    { type: 'output_text', output_text: longText },
                    { type: 'text', text: '第二段' },
                ],
            },
        }),
        JSON.stringify({
            type: 'response_item',
            timestamp: '2026-08-09T10:00:01.000Z',
            payload: { type: 'message', role: 'user', content: '字符串内容' },
        }),
    ];
    const { records } = parseCodexLines(lines, {});
    const assistant = records.find(r => r.role === 'assistant');
    const user = records.find(r => r.role === 'user');

    assert.ok(assistant.content.length > 2000, '助手长文本不应在导入器截断');
    assert.ok(assistant.content.includes('结尾'));
    assert.ok(assistant.content.includes('第二段'));
    assert.strictEqual(user.content, '字符串内容');
    assert.ok(assistant.tool_use_id.startsWith('codex-msg-'));
});

await test('parseFunctionOutput 解析 Exit code / 无 Exit code', () => {
    assert.deepStrictEqual(parseFunctionOutput('Exit code: 0\nOutput:\nok'), { exitCode: 0, snippet: 'ok', success: true });
    assert.deepStrictEqual(parseFunctionOutput('Exit code: 2\nOutput:\nboom'), { exitCode: 2, snippet: 'boom', success: false });
    const noExit = parseFunctionOutput('some raw text');
    assert.strictEqual(noExit.exitCode, null);
    assert.strictEqual(noExit.success, true);
    assert.strictEqual(noExit.snippet, 'some raw text');
});

await test('sessionIdFromFilename 提取 UUID', () => {
    assert.strictEqual(
        sessionIdFromFilename('rollout-2026-05-17T13-50-28-019e347c-6583-7852-8aa5-bbc490cd4986.jsonl'),
        '019e347c-6583-7852-8aa5-bbc490cd4986'
    );
});

console.log('── 水位线增量扫描 ──');
await test('首次全量 + 未变跳过 + 追加增量', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'importer-test-'));
    const stateFile = path.join(dir, 'state.json');
    const dataFile = path.join(dir, 'a.jsonl');
    fs.writeFileSync(dataFile, 'line1\nline2\n', 'utf-8');

    class CountingImporter extends JsonlImporter {
        constructor() {
            super({ source: 'test', rootDir: dir, stateFile, parseLines: (lines) => ({
                records: lines.map(() => ({ session_id: 's1', ts: '2026-07-01T00:00:00.000Z', role: 'tool_result', tool_name: 'Bash' })),
                meta: null,
            }) });
            this.imported = 0;
        }
        _ingest(records) { this.imported += records.length; }
        _recomputeSessions() {}
    }

    const importer = new CountingImporter();

    const first = await importer.pollOnce();
    assert.strictEqual(first, 2, '首次应导入 2 条');
    assert.strictEqual(importer.imported, 2);

    const second = await importer.pollOnce();
    assert.strictEqual(second, 0, '文件未变时应跳过');

    // 追加一行并强制更新 mtime
    fs.appendFileSync(dataFile, 'line3\n', 'utf-8');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(dataFile, future, future);

    const third = await importer.pollOnce();
    assert.strictEqual(third, 1, '追加后应只导入 1 条新增');
    assert.strictEqual(importer.imported, 3);

    // 清空后应从头重读（文件被截断/重写）
    fs.writeFileSync(dataFile, 'new1\n', 'utf-8');
    const future2 = new Date(Date.now() + 4000);
    fs.utimesSync(dataFile, future2, future2);
    const fourth = await importer.pollOnce();
    assert.strictEqual(fourth, 1, '截断重写后应从头重读');
    assert.strictEqual(importer.imported, 4);

    fs.rmSync(dir, { recursive: true, force: true });
});

await test('解析版本变化时重扫已处理文件', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'importer-version-'));
    const stateFile = path.join(dir, 'state.json');
    const dataFile = path.join(dir, 'a.jsonl');
    fs.writeFileSync(dataFile, 'line1\nline2\n', 'utf-8');

    class VersionedImporter extends JsonlImporter {
        constructor(parserVersion) {
            super({
                source: 'test',
                rootDir: dir,
                stateFile,
                parserVersion,
                parseLines: (lines) => ({
                    records: lines.map((_, idx) => ({ session_id: 's1', ts: `2026-07-01T00:00:0${idx}.000Z`, role: 'tool_result', tool_name: 'Bash' })),
                    meta: null,
                }),
            });
        }
        _ingest(records) { this.imported = (this.imported || 0) + records.length; }
        _recomputeSessions() {}
    }

    const firstImporter = new VersionedImporter(1);
    assert.strictEqual(await firstImporter.pollOnce(), 2);
    assert.strictEqual(await firstImporter.pollOnce(), 0);

    const upgradedImporter = new VersionedImporter(2);
    assert.strictEqual(await upgradedImporter.pollOnce(), 2, '解析版本变化后应重扫旧文件');

    fs.rmSync(dir, { recursive: true, force: true });
});

await test('hasHistory 检测', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'importer-has-'));
    const imp = new JsonlImporter({ source: 'test', rootDir: dir, stateFile: path.join(dir, 's.json'), parseLines: () => ({ records: [], meta: null }) });
    assert.strictEqual(imp.hasHistory(), false);
    fs.writeFileSync(path.join(dir, 'x.jsonl'), '{}', 'utf-8');
    assert.strictEqual(imp.hasHistory(), true);
    fs.rmSync(dir, { recursive: true, force: true });
});

console.log(`\n结果: ${passed} 项通过${process.exitCode ? '，存在失败' : ''}`);
if (process.exitCode) process.exit(process.exitCode);
}

main();
