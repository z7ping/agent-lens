const fs = require('fs');
const os = require('os');
const path = require('path');

const ASSET_TYPES = ['skill', 'mcp', 'plugin', 'extension', 'hook', 'adapter', 'builtin'];

const TOOL_DEFINITIONS = [
    {
        tool: 'codex',
        display_name: 'Codex',
        description: 'OpenAI Codex coding agent and local desktop environment.',
        config_dir: path.join(os.homedir(), '.codex'),
    },
    {
        tool: 'claude-code',
        display_name: 'Claude Code',
        description: 'Anthropic Claude Code command-line coding assistant.',
        config_dir: path.join(os.homedir(), '.claude'),
    },
    {
        tool: 'cursor',
        display_name: 'Cursor',
        description: 'AI code editor based on VS Code.',
        config_dir: path.join(os.homedir(), 'AppData', 'Roaming', 'Cursor', 'User'),
    },
    {
        tool: 'opencode',
        display_name: 'OpenCode',
        description: 'OpenCode terminal coding agent.',
        config_dir: path.join(os.homedir(), '.local', 'share', 'opencode'),
    },
    {
        tool: 'hermes',
        display_name: 'Hermes',
        description: 'Hermes coding agent history source.',
        config_dir: path.join(os.homedir(), '.hermes'),
    },
    {
        tool: 'pi',
        display_name: 'Pi',
        description: 'Pi coding agent history source.',
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
            description: `${tool} configuration entry`,
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
            version: '',
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
