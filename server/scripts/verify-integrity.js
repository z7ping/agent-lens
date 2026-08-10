#!/usr/bin/env node
/**
 * 数据完整性验证脚本
 * 对比 JSONL 行数和 SQLite 记录数，检查关键字段一致性
 * 
 * 用法：
 *   node scripts/verify-integrity.js
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getRuntimePaths } = require('../runtime-paths');

const BASE_DIR = path.join(__dirname, '..');
const RUNTIME_PATHS = getRuntimePaths({ baseDir: BASE_DIR });
const LOGS_DIR = RUNTIME_PATHS.logsDir;
const DB_FILE = RUNTIME_PATHS.dbFile;

function main() {
    console.log('🔍 数据完整性验证\n');

    // 检查文件
    if (!fs.existsSync(DB_FILE)) {
        console.log('❌ agent-lens.db 不存在');
        process.exit(1);
    }

    if (!fs.existsSync(LOGS_DIR)) {
        console.log('❌ logs 目录不存在');
        process.exit(1);
    }

    // 读取 JSONL 数据
    const jsonlFiles = fs.readdirSync(LOGS_DIR)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => path.join(LOGS_DIR, f));

    let jsonlTotal = 0;
    let jsonlRecords = [];

    for (const file of jsonlFiles) {
        const content = fs.readFileSync(file, 'utf-8').trim();
        if (!content) continue;
        
        const lines = content.split('\n');
        jsonlTotal += lines.length;
        
        for (const line of lines) {
            try {
                jsonlRecords.push(JSON.parse(line));
            } catch (e) {
                console.log(`⚠️  JSONL 解析错误: ${file}`);
            }
        }
    }

    console.log(`📊 JSONL 统计：${jsonlFiles.length} 个文件，${jsonlTotal} 条记录`);

    // 读取 SQLite 数据
    const db = new Database(DB_FILE, { readonly: true });

    const sqliteStats = {
        projects: db.prepare('SELECT COUNT(*) as count FROM projects').get().count,
        sessions: db.prepare('SELECT COUNT(*) as count FROM sessions').get().count,
        tool_calls: db.prepare('SELECT COUNT(*) as count FROM tool_calls').get().count,
    };

    console.log(`📊 SQLite 统计：${sqliteStats.projects} 个项目，${sqliteStats.sessions} 个会话，${sqliteStats.tool_calls} 条调用记录`);

    // 对比数量
    console.log('\n📋 数量对比：');
    const countMatch = jsonlTotal === sqliteStats.tool_calls;
    console.log(`   JSONL 记录数 vs SQLite tool_calls: ${jsonlTotal} vs ${sqliteStats.tool_calls} ${countMatch ? '✅' : '❌'}`);

    // 抽样检查关键字段
    console.log('\n📋 关键字段一致性检查（抽样 10 条）：');
    
    const sampleSize = Math.min(10, jsonlRecords.length);
    const sampleIndices = [];
    for (let i = 0; i < sampleSize; i++) {
        sampleIndices.push(Math.floor(Math.random() * jsonlRecords.length));
    }

    let fieldErrors = 0;

    for (const idx of sampleIndices) {
        const jsonlRecord = jsonlRecords[idx];
        
        // 在 SQLite 中查找对应记录
        const sqliteRecord = db.prepare(`
            SELECT * FROM tool_calls 
            WHERE ts = ? AND project_key = ? AND tool_name = ?
            LIMIT 1
        `).get(jsonlRecord.ts, jsonlRecord.project_key, jsonlRecord.tool_name);

        if (!sqliteRecord) {
            console.log(`   ❌ 未找到: ${jsonlRecord.ts} ${jsonlRecord.tool_name}`);
            fieldErrors++;
            continue;
        }

        // 检查关键字段
        const errors = [];
        
        if (sqliteRecord.session_id !== (jsonlRecord.session_id || '')) {
            errors.push(`session_id: "${sqliteRecord.session_id}" vs "${jsonlRecord.session_id}"`);
        }
        
        if (sqliteRecord.success !== (jsonlRecord.success ? 1 : 0)) {
            errors.push(`success: ${sqliteRecord.success} vs ${jsonlRecord.success}`);
        }

        if (errors.length > 0) {
            console.log(`   ❌ ${jsonlRecord.ts} ${jsonlRecord.tool_name}: ${errors.join(', ')}`);
            fieldErrors++;
        } else {
            console.log(`   ✅ ${jsonlRecord.ts} ${jsonlRecord.tool_name}`);
        }
    }

    db.close();

    // 总结
    console.log('\n📊 验证总结：');
    console.log(`   数量一致: ${countMatch ? '✅' : '❌'}`);
    console.log(`   字段一致: ${fieldErrors === 0 ? '✅' : `❌ ${fieldErrors} 个错误`}`);
    
    if (countMatch && fieldErrors === 0) {
        console.log('\n✅ 数据完整性验证通过！');
    } else {
        console.log('\n❌ 数据完整性验证失败，请检查日志');
        process.exit(1);
    }
}

main();
