#!/usr/bin/env node
/**
 * JSONL 历史数据迁移脚本
 * 扫描 logs/*.jsonl，批量导入 SQLite
 * 
 * 用法：
 *   node scripts/migrate-jsonl.js              # 迁移所有 JSONL 文件
 *   node scripts/migrate-jsonl.js --dry-run    # 预览模式，不实际写入
 *   node scripts/migrate-jsonl.js --force      # 全量覆盖（清空现有数据后导入）
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getRuntimePaths } = require('../runtime-paths');

const BASE_DIR = path.join(__dirname, '..');
const RUNTIME_PATHS = getRuntimePaths({ baseDir: BASE_DIR });
const LOGS_DIR = RUNTIME_PATHS.logsDir;
const DB_FILE = RUNTIME_PATHS.dbFile;

// 解析命令行参数
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

function main() {
    // 检查 logs 目录
    if (!fs.existsSync(LOGS_DIR)) {
        console.log('❌ logs 目录不存在，无需迁移');
        process.exit(0);
    }

    // 获取所有 JSONL 文件
    const jsonlFiles = fs.readdirSync(LOGS_DIR)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => path.join(LOGS_DIR, f));

    if (jsonlFiles.length === 0) {
        console.log('❌ 没有找到 JSONL 文件，无需迁移');
        process.exit(0);
    }

    console.log(`📁 找到 ${jsonlFiles.length} 个 JSONL 文件`);

    // 检查数据库
    if (!fs.existsSync(DB_FILE)) {
        console.log('❌ agent-lens.db 不存在，请先运行 schema.sql 创建数据库');
        process.exit(1);
    }

    // 打开数据库
    const db = new Database(DB_FILE);
    
    // 如果 force 模式，清空现有数据
    if (force && !dryRun) {
        console.log('⚠️  --force 模式：清空现有数据...');
        db.exec('DELETE FROM tool_calls');
        db.exec('DELETE FROM sessions');
        db.exec('DELETE FROM projects');
        db.exec("DELETE FROM sqlite_sequence WHERE name IN ('tool_calls', 'sessions', 'projects')");
    }

    // 准备 SQL 语句
    const insertProject = db.prepare(`
        INSERT OR IGNORE INTO projects (project_key, name, cwd, last_seen)
        VALUES (?, ?, ?, ?)
    `);
    const updateProject = db.prepare(`
        UPDATE projects SET last_seen = ? WHERE project_key = ?
    `);
    const insertSession = db.prepare(`
        INSERT OR IGNORE INTO sessions (session_id, project_key, start_time, tool_count)
        VALUES (?, ?, ?, 0)
    `);
    const updateSessionCount = db.prepare(`
        UPDATE sessions SET tool_count = tool_count + 1 WHERE session_id = ?
    `);
    const insertCall = db.prepare(`
        INSERT INTO tool_calls (ts, session_id, project_key, tool_name, input_summary, success, seq, parent_seq, duration_ms, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let totalRecords = 0;
    let importedRecords = 0;
    let skippedRecords = 0;
    let errorRecords = 0;

    // 使用事务批量导入
    const migrate = db.transaction(() => {
        for (const jsonlFile of jsonlFiles) {
            const fileName = path.basename(jsonlFile);
            console.log(`\n📄 处理 ${fileName}...`);

            const content = fs.readFileSync(jsonlFile, 'utf-8').trim();
            if (!content) {
                console.log('   ⏭️  空文件，跳过');
                continue;
            }

            const lines = content.split('\n');
            let fileImported = 0;
            let fileSkipped = 0;
            let fileError = 0;

            for (const line of lines) {
                totalRecords++;
                
                try {
                    const record = JSON.parse(line);
                    
                    // 验证必填字段
                    if (!record.ts || !record.project_key) {
                        fileSkipped++;
                        skippedRecords++;
                        continue;
                    }

                    if (dryRun) {
                        fileImported++;
                        importedRecords++;
                        continue;
                    }

                    // 插入项目
                    insertProject.run(
                        record.project_key,
                        record.project_name || 'unknown',
                        '',  // cwd 不在 JSONL 中
                        record.ts
                    );
                    updateProject.run(record.ts, record.project_key);

                    // 插入会话
                    if (record.session_id) {
                        insertSession.run(
                            record.session_id,
                            record.project_key,
                            record.ts
                        );
                        updateSessionCount.run(record.session_id);
                    }

                    // 插入工具调用
                    insertCall.run(
                        record.ts,
                        record.session_id || '',
                        record.project_key,
                        record.tool_name || '',
                        typeof record.input_summary === 'object' 
                            ? JSON.stringify(record.input_summary) 
                            : (record.input_summary || ''),
                        record.success ? 1 : 0,
                        record.seq || null,
                        record.parent_seq || null,
                        record.duration_ms || null,
                        record.error || null
                    );

                    fileImported++;
                    importedRecords++;
                } catch (e) {
                    fileError++;
                    errorRecords++;
                }
            }

            console.log(`   ✅ 导入 ${fileImported} 条，跳过 ${fileSkipped} 条，错误 ${fileError} 条`);
        }
    });

    // 执行迁移
    if (dryRun) {
        console.log('\n🔍 预览模式（--dry-run）：');
        migrate();
        console.log(`\n📊 统计：共 ${totalRecords} 条，将导入 ${importedRecords} 条，跳过 ${skippedRecords} 条，错误 ${errorRecords} 条`);
    } else {
        console.log('\n🚀 开始迁移...');
        migrate();
        console.log(`\n📊 迁移完成：共 ${totalRecords} 条，导入 ${importedRecords} 条，跳过 ${skippedRecords} 条，错误 ${errorRecords} 条`);
    }

    db.close();
}

main();
