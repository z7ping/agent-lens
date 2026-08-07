const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ASSET_TYPES = ['skill', 'mcp', 'plugin', 'extension', 'hook', 'adapter', 'builtin'];

const TOOL_DEFINITIONS = [
    {
        tool: 'codex',
        display_name: 'Codex',
        description: 'OpenAI Codex 命令行编码智能体与本地桌面环境。',
        config_dir: path.join(os.homedir(), '.codex'),
    },
    {
        tool: 'claude-code',
        display_name: 'Claude Code',
        description: 'Anthropic Claude Code 命令行编码助手。',
        config_dir: path.join(os.homedir(), '.claude'),
    },
    {
        tool: 'cursor',
        display_name: 'Cursor',
        description: '基于 VS Code 的 AI 代码编辑器。',
        config_dir: path.join(os.homedir(), 'AppData', 'Roaming', 'Cursor', 'User'),
    },
    {
        tool: 'opencode',
        display_name: 'OpenCode',
        description: 'OpenCode 终端编码智能体。',
        config_dir: path.join(os.homedir(), '.local', 'share', 'opencode'),
    },
    {
        tool: 'hermes',
        display_name: 'Hermes',
        description: 'Hermes 编码智能体历史数据源。',
        config_dir: path.join(os.homedir(), '.hermes'),
    },
    {
        tool: 'pi',
        display_name: 'Pi',
        description: 'Pi 编码智能体历史数据源。',
        config_dir: path.join(os.homedir(), '.pi'),
    },
];

function normalizeCapabilityName(name = '') {
    return String(name)
        .replace(/^mcp__/, '')
        .replace(/^skills?:/i, '')
        .replace(/^plugins?:/i, '')
        .trim()
        .toLowerCase();
}

function safeReadDir(dir) {
    try {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
        return [];
    }
}

function firstExisting(paths) {
    return paths.find(item => {
        try { return item && fs.existsSync(item); } catch (_) { return false; }
    }) || '';
}

function isWin() { return process.platform === 'win32'; }

function extractVersion(text) {
    const match = String(text || '').match(/\bv?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
    return match ? match[0] : '';
}

function runVersionCommand(binary) {
    try {
        const res = spawnSync(binary, ['--version'], { encoding: 'utf-8', timeout: 4000, shell: isWin() });
        if (res.error || res.status !== 0) return '';
        const firstLine = String(res.stdout || '').trim().split(/\r?\n/)[0];
        return extractVersion(firstLine);
    } catch (_) {
        return '';
    }
}

function readJsonVersion(file) {
    try {
        if (!fs.existsSync(file)) return '';
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        return extractVersion(data.version || data.productVersion || '');
    } catch (_) {
        return '';
    }
}

function readExeVersion(exePath) {
    try {
        if (!exePath || !fs.existsSync(exePath) || !isWin()) return '';
        const { execFileSync } = require('child_process');
        const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${exePath}').VersionInfo.FileVersion`], { encoding: 'utf-8', timeout: 4000 }).trim();
        return extractVersion(out);
    } catch (_) {
        return '';
    }
}

function findExeDir(name) {
    // 通过注册表卸载信息查找自定义安装目录（如非默认路径安装的 Cursor）
    if (!isWin()) return [];
    const hives = [
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ];
    const dirs = [];
    for (const hive of hives) {
        try {
            const { execFileSync } = require('child_process');
            const out = execFileSync('reg', ['query', hive, '/s', '/f', name, '/d'], { encoding: 'utf-8', timeout: 5000, windowsHide: true });
            for (const m of out.matchAll(/InstallLocation\s+REG_\w+\s+([^\r\n]+)/g)) {
                const dir = m[1].trim();
                if (dir) dirs.push(dir);
            }
        } catch (_) {}
    }
    return [...new Set(dirs)];
}

function detectCursorVersion() {
    const cli = runVersionCommand('cursor');
    if (cli) return cli;
    for (const dir of findExeDir('Cursor')) {
        const v = readExeVersion(path.join(dir, 'Cursor.exe'));
        if (v) return v;
    }
    return readJsonVersion(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Cursor', 'resources', 'app', 'package.json'))
        || readExeVersion(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Cursor', 'Cursor.exe'));
}

function detectVersion(tool, configDir) {
    if (!fs.existsSync(configDir)) return '';
    switch (tool) {
        case 'codex':
            return runVersionCommand('codex');
        case 'claude-code':
            return runVersionCommand('claude');
        case 'hermes':
            return runVersionCommand('hermes');
        case 'pi':
            return runVersionCommand('pi');
        case 'cursor':
            return detectCursorVersion();
        case 'opencode':
            return runVersionCommand('opencode')
                || readExeVersion(path.join(os.homedir(), 'AppData', 'Local', 'Programs', '@opencode-aidesktop', 'OpenCode.exe'));
        default:
            return '';
    }
}

function scanNamedDirectories(baseDir, type, status = 'installed') {
    return safeReadDir(baseDir)
        .filter(entry => entry.isDirectory())
        .map(entry => ({
            name: entry.name,
            type,
            status,
            path: path.join(baseDir, entry.name),
        }));
}

function scanJsonKeys(file, type, tool) {
    try {
        if (!fs.existsSync(file)) return [];
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const keys = new Set();
        const visit = (value, hint = '') => {
            if (!value || typeof value !== 'object') return;
            for (const [key, child] of Object.entries(value)) {
                const lower = key.toLowerCase();
                if (lower.includes(type) || hint.includes(type)) keys.add(key);
                if (typeof child === 'object') visit(child, lower);
            }
        };
        visit(data);
        return Array.from(keys).map(name => ({
            name,
            type,
            status: 'configured',
            path: file,
            description: `${tool} 配置条目`,
        }));
    } catch (_) {
        return [];
    }
}

function discoverCodexAssets(configDir) {
    return [
        ...scanNamedDirectories(path.join(configDir, 'skills'), 'skill', 'enabled'),
        ...scanNamedDirectories(path.join(configDir, 'plugins', 'cache'), 'plugin', 'installed'),
        ...scanNamedDirectories(path.join(configDir, 'plugins'), 'plugin', 'installed'),
        ...scanJsonKeys(path.join(configDir, 'config.json'), 'mcp', 'Codex'),
    ];
}

function discoverClaudeAssets(configDir) {
    return [
        ...scanNamedDirectories(path.join(configDir, 'skills'), 'skill', 'enabled'),
        ...scanNamedDirectories(path.join(configDir, 'commands'), 'builtin', 'available'),
        ...scanJsonKeys(path.join(configDir, 'settings.json'), 'mcp', 'Claude Code'),
        ...scanJsonKeys(path.join(os.homedir(), '.claude.json'), 'mcp', 'Claude Code'),
    ];
}

function discoverCursorAssets(configDir) {
    const extensionsDir = firstExisting([
        path.join(os.homedir(), '.cursor', 'extensions'),
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Cursor', 'resources', 'app', 'extensions'),
    ]);
    return [
        ...scanNamedDirectories(extensionsDir, 'extension', 'enabled'),
        ...scanJsonKeys(path.join(configDir, 'settings.json'), 'mcp', 'Cursor'),
    ];
}

function discoverGenericAssets(configDir) {
    return [
        ...scanJsonKeys(path.join(configDir, 'config.json'), 'mcp', 'AI tool'),
        ...scanNamedDirectories(path.join(configDir, 'plugins'), 'plugin', 'installed'),
    ];
}

function discoverInventory() {
    return TOOL_DEFINITIONS.map(definition => {
        let assets = [];
        if (definition.tool === 'codex') assets = discoverCodexAssets(definition.config_dir);
        else if (definition.tool === 'claude-code') assets = discoverClaudeAssets(definition.config_dir);
        else if (definition.tool === 'cursor') assets = discoverCursorAssets(definition.config_dir);
        else assets = discoverGenericAssets(definition.config_dir);

        return {
            ...definition,
            version: detectVersion(definition.tool, definition.config_dir),
            status: fs.existsSync(definition.config_dir) ? 'detected' : 'not_found',
            assets: dedupeAssets(assets),
        };
    });
}

function dedupeAssets(assets = []) {
    const seen = new Set();
    const result = [];
    for (const asset of assets) {
        const key = `${asset.type || ''}::${asset.name || ''}::${asset.path || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(asset);
    }
    return result;
}

function buildUsageMap(rows = []) {
    const usage = new Map();
    for (const row of rows) {
        const tool = row.source || row.tool || '';
        const name = row.tool_name || row.name || '';
        if (!tool || !name) continue;
        const key = `${tool}::${normalizeCapabilityName(name)}`;
        usage.set(key, (usage.get(key) || 0) + Number(row.call_count || row.count || 1));
    }
    return usage;
}

function buildObservedAssets(rows = []) {
    const byTool = new Map();
    for (const row of rows) {
        const tool = row.source || row.tool || '';
        const name = row.tool_name || row.name || '';
        if (!tool || !name) continue;
        const capability = normalizeCapabilityName(name);
        if (!byTool.has(tool)) byTool.set(tool, new Map());
        const assets = byTool.get(tool);
        const existing = assets.get(capability) || {
            name,
            type: 'builtin',
            status: 'observed',
            path: '',
            description: '从历史调用记录中发现',
        };
        assets.set(capability, existing);
    }
    return byTool;
}

function groupAssets(assets = []) {
    const groups = {};
    for (const type of ASSET_TYPES) groups[type] = { count: 0, items: [] };
    for (const asset of assets) {
        const type = ASSET_TYPES.includes(asset.type) ? asset.type : 'builtin';
        if (!groups[type]) groups[type] = { count: 0, items: [] };
        groups[type].count += 1;
        groups[type].items.push(asset);
    }
    return groups;
}

function buildOverview(options = {}) {
    const inventory = options.inventory || discoverInventory();
    const usageMap = buildUsageMap(options.usageRows || []);
    const observedAssets = buildObservedAssets(options.usageRows || []);
    const priorityThreshold = Number(options.priorityThreshold || 5);
    const toolNames = inventory.map(tool => tool.tool);
    const assetIndex = new Map();

    const tools = inventory.map(tool => {
        const discovered = dedupeAssets(tool.assets || []);
        const discoveredCapabilities = new Set(discovered.map(asset => normalizeCapabilityName(asset.name)));
        const observed = Array.from(observedAssets.get(tool.tool)?.values() || [])
            .filter(asset => !discoveredCapabilities.has(normalizeCapabilityName(asset.name)));
        const assets = [...discovered, ...observed].map(asset => {
            const capability = normalizeCapabilityName(asset.name);
            const callCount = usageMap.get(`${tool.tool}::${capability}`) || 0;
            const item = {
                name: asset.name || 'unknown',
                capability,
                type: asset.type || 'builtin',
                tool: tool.tool,
                status: asset.status || 'unknown',
                path: asset.path || '',
                description: asset.description || '',
                call_count: callCount,
                is_priority: callCount >= priorityThreshold,
            };
            if (!assetIndex.has(capability)) assetIndex.set(capability, new Map());
            assetIndex.get(capability).set(tool.tool, item);
            return item;
        }).sort((a, b) => b.call_count - a.call_count || a.name.localeCompare(b.name));

        return {
            tool: tool.tool,
            display_name: tool.display_name || tool.tool,
            description: tool.description || '',
            version: tool.version || '',
            status: tool.status || 'unknown',
            config_dir: tool.config_dir || '',
            assets,
            asset_groups: groupAssets(assets),
        };
    });

    const priorityAssets = tools
        .flatMap(tool => tool.assets)
        .filter(asset => asset.is_priority)
        .sort((a, b) => b.call_count - a.call_count || a.name.localeCompare(b.name));

    const priorityCapabilities = new Set(priorityAssets.map(asset => asset.capability));
    const capabilityMatrix = Array.from(priorityCapabilities).map(capability => {
        const sourceAsset = priorityAssets.find(asset => asset.capability === capability);
        const coverage = {};
        for (const toolName of toolNames) {
            const asset = assetIndex.get(capability)?.get(toolName);
            coverage[toolName] = asset
                ? { status: '已有', asset_name: asset.name, type: asset.type, call_count: asset.call_count }
                : { status: '缺失', asset_name: '', type: '', call_count: 0 };
        }
        return {
            name: sourceAsset?.name || capability,
            capability,
            source_tool: sourceAsset?.tool || '',
            call_count: sourceAsset?.call_count || 0,
            coverage,
        };
    }).sort((a, b) => b.call_count - a.call_count || a.name.localeCompare(b.name));

    return {
        tools,
        priority_assets: priorityAssets,
        capability_matrix: capabilityMatrix,
    };
}

function queryOverview(db, options = {}) {
    let usageRows = [];
    if (db) {
        const sinceClause = options.since ? 'AND timestamp >= ?' : '';
        const params = options.since ? [options.since] : [];
        usageRows = db.prepare(`
            SELECT source, tool_name, COUNT(*) as call_count
            FROM timeline
            WHERE role IN ('tool_result', 'tool_error') AND tool_name IS NOT NULL ${sinceClause}
            GROUP BY source, tool_name
        `).all(...params);
    }
    return buildOverview({ usageRows, priorityThreshold: options.priorityThreshold || 5 });
}

module.exports = {
    buildOverview,
    queryOverview,
    normalizeCapabilityName,
};
