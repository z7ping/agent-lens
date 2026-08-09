const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DEFAULT_OVERVIEW_SCAN_INTERVAL_MS } = require('./config');

const ASSET_TYPES = ['skill', 'mcp', 'plugin', 'extension', 'hook', 'adapter', 'builtin'];

const TOOL_DEFINITIONS = [
    {
        tool: 'codex',
        display_name: 'Codex',
        description: 'OpenAI Codex 命令行编码智能体与本地桌面环境。',
        config_dir: path.join(os.homedir(), '.codex'),
        theme: { accent: '#10b981', surface: '#ecfdf5' },
    },
    {
        tool: 'claude-code',
        display_name: 'Claude Code',
        description: 'Anthropic Claude Code 命令行编码助手。',
        config_dir: path.join(os.homedir(), '.claude'),
        theme: { accent: '#f97316', surface: '#fff7ed' },
    },
    {
        tool: 'cursor',
        display_name: 'Cursor',
        description: '基于 VS Code 的 AI 代码编辑器。',
        config_dir: path.join(os.homedir(), 'AppData', 'Roaming', 'Cursor', 'User'),
        theme: { accent: '#6366f1', surface: '#eef2ff' },
    },
    {
        tool: 'opencode',
        display_name: 'OpenCode',
        description: 'OpenCode 终端编码智能体。',
        config_dir: path.join(os.homedir(), '.local', 'share', 'opencode'),
        theme: { accent: '#06b6d4', surface: '#ecfeff' },
    },
    {
        tool: 'hermes',
        display_name: 'Hermes',
        description: 'Hermes 编码智能体历史数据源。',
        config_dir: path.join(os.homedir(), '.hermes'),
        theme: { accent: '#8b5cf6', surface: '#f5f3ff' },
    },
    {
        tool: 'pi',
        display_name: 'Pi',
        description: 'Pi 编码智能体历史数据源。',
        config_dir: path.join(os.homedir(), '.pi'),
        theme: { accent: '#eab308', surface: '#fefce8' },
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

function readJsonFile(file) {
    try {
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (_) {
        return null;
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

function uniqueDirs(dirs) {
    const seen = new Set();
    const result = [];
    for (const dir of dirs) {
        if (!dir) continue;
        const resolved = path.resolve(dir);
        const key = isWin() ? resolved.toLowerCase() : resolved;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(resolved);
    }
    return result;
}

function getPiRootCandidates(configDir = '', options = {}) {
    const includeDefaultCandidates = options.includeDefaultCandidates || !configDir;
    const home = os.homedir();
    const defaultCandidates = includeDefaultCandidates ? [
        configDir,
        process.env.PI_HOME,
        process.env.PI_AGENT_HOME,
        process.env.PI_CONFIG_HOME,
        process.env.PI_DATA_HOME,
        path.join(home, '.pi'),
        path.join(home, '.pi', 'agent'),
        path.join(home, '.config', 'pi'),
        path.join(home, '.local', 'share', 'pi'),
        process.env.APPDATA && path.join(process.env.APPDATA, 'Pi'),
        process.env.APPDATA && path.join(process.env.APPDATA, 'pi'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Pi'),
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'pi'),
        path.join(home, 'Library', 'Application Support', 'Pi'),
        path.join(home, 'Library', 'Application Support', 'pi'),
    ] : [configDir];
    return uniqueDirs(defaultCandidates);
}

function hasPiAgentMarkers(agentDir) {
    return fs.existsSync(path.join(agentDir, 'npm', 'package.json'))
        || fs.existsSync(path.join(agentDir, 'extensions'))
        || fs.existsSync(path.join(agentDir, 'pi-hermes-memory'))
        || fs.existsSync(path.join(agentDir, 'projects-memory'));
}

function getPiAgentDirs(configDir = '', options = {}) {
    const candidates = getPiRootCandidates(configDir, options).flatMap(root => [
        root,
        path.join(root, 'agent'),
    ]);
    return uniqueDirs(candidates).filter(hasPiAgentMarkers);
}

function packagePathForDependency(modulesDir, name) {
    return path.join(modulesDir, ...String(name).split('/'), 'package.json');
}

function isPiPackage(name, pkg = {}) {
    const packageName = String(pkg.name || name || '');
    const keywords = Array.isArray(pkg.keywords) ? pkg.keywords.map(item => String(item).toLowerCase()) : [];
    return packageName.startsWith('pi-')
        || packageName.includes('/pi-')
        || !!pkg.pi
        || keywords.some(item => item === 'pi-extension' || item === 'pi-package' || item.startsWith('pi-'));
}

function scanPiNpmPlugins(agentDir) {
    const npmDir = path.join(agentDir, 'npm');
    const packageJson = readJsonFile(path.join(npmDir, 'package.json'));
    const deps = {
        ...(packageJson?.dependencies || {}),
        ...(packageJson?.devDependencies || {}),
        ...(packageJson?.optionalDependencies || {}),
    };
    const modulesDir = path.join(npmDir, 'node_modules');
    return Object.keys(deps)
        .map(name => {
            const pkgPath = packagePathForDependency(modulesDir, name);
            const pkg = readJsonFile(pkgPath) || { name };
            if (!isPiPackage(name, pkg)) return null;
            const version = pkg.version ? `v${pkg.version}` : '';
            return {
                name: pkg.name || name,
                type: 'plugin',
                status: 'installed',
                path: path.dirname(pkgPath),
                description: [pkg.description || 'Pi npm 插件', version].filter(Boolean).join(' · '),
            };
        })
        .filter(Boolean);
}

function scanChildSkillDirectories(baseDir, description) {
    return safeReadDir(baseDir)
        .filter(entry => entry.isDirectory())
        .map(entry => ({
            name: entry.name,
            type: 'skill',
            status: 'enabled',
            path: path.join(baseDir, entry.name),
            description,
        }));
}

function scanPiNpmSkills(agentDir) {
    const npmDir = path.join(agentDir, 'npm');
    const packageJson = readJsonFile(path.join(npmDir, 'package.json'));
    const deps = {
        ...(packageJson?.dependencies || {}),
        ...(packageJson?.devDependencies || {}),
        ...(packageJson?.optionalDependencies || {}),
    };
    const modulesDir = path.join(npmDir, 'node_modules');
    return Object.keys(deps).flatMap(name => {
        const pkgPath = packagePathForDependency(modulesDir, name);
        const pkg = readJsonFile(pkgPath) || { name };
        if (!isPiPackage(name, pkg)) return [];
        return scanChildSkillDirectories(path.join(path.dirname(pkgPath), 'skills'), `Pi 插件 ${pkg.name || name} 提供的 Skill`);
    });
}

function scanPiProjectMemorySkills(agentDir) {
    const projectsDir = path.join(agentDir, 'projects-memory');
    return safeReadDir(projectsDir)
        .filter(entry => entry.isDirectory())
        .flatMap(entry => scanChildSkillDirectories(
            path.join(projectsDir, entry.name, 'skills'),
            `Pi 项目记忆 ${entry.name} 提供的 Skill`
        ));
}

function discoverPiAssets(configDir, options = {}) {
    return getPiAgentDirs(configDir, options).flatMap(agentDir => [
        ...scanPiNpmPlugins(agentDir),
        ...scanNamedDirectories(path.join(agentDir, 'extensions'), 'extension', 'enabled'),
        ...scanNamedDirectories(path.join(agentDir, 'skills'), 'skill', 'enabled'),
        ...scanNamedDirectories(path.join(agentDir, 'pi-hermes-memory', 'skills'), 'skill', 'enabled'),
        ...scanPiNpmSkills(agentDir),
        ...scanPiProjectMemorySkills(agentDir),
    ]);
}

function discoverInventory() {
    return TOOL_DEFINITIONS.map(definition => {
        let assets = [];
        let configDir = definition.config_dir;
        let status = fs.existsSync(configDir) ? 'detected' : 'not_found';
        if (definition.tool === 'codex') assets = discoverCodexAssets(definition.config_dir);
        else if (definition.tool === 'claude-code') assets = discoverClaudeAssets(definition.config_dir);
        else if (definition.tool === 'cursor') assets = discoverCursorAssets(definition.config_dir);
        else if (definition.tool === 'pi') {
            const piOptions = { includeDefaultCandidates: true };
            const agentDirs = getPiAgentDirs(definition.config_dir, piOptions);
            const detectedDir = agentDirs[0] || firstExisting(getPiRootCandidates(definition.config_dir, piOptions));
            configDir = detectedDir || definition.config_dir;
            status = detectedDir ? 'detected' : 'not_found';
            assets = discoverPiAssets(definition.config_dir, piOptions);
        }
        else assets = discoverGenericAssets(definition.config_dir);

        return {
            ...definition,
            config_dir: configDir,
            version: detectVersion(definition.tool, configDir),
            status,
            assets: dedupeAssets(assets),
        };
    });
}

function parseJson(value, fallback = {}) {
    try {
        return value ? JSON.parse(value) : fallback;
    } catch (_) {
        return fallback;
    }
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

function readOverviewInventory(db) {
    if (!db) return [];
    const tools = db.prepare(`
        SELECT tool, display_name, description, version, status, config_dir, theme_json, last_scanned_at
        FROM overview_tools
        ORDER BY tool ASC
    `).all();
    if (!tools.length) return [];

    const assets = db.prepare(`
        SELECT tool, name, capability, type, status, path, description, last_scanned_at
        FROM overview_assets
        ORDER BY tool ASC, type ASC, name ASC
    `).all();
    const byTool = new Map();
    for (const asset of assets) {
        if (!byTool.has(asset.tool)) byTool.set(asset.tool, []);
        byTool.get(asset.tool).push({
            name: asset.name,
            capability: asset.capability,
            type: asset.type,
            status: asset.status,
            path: asset.path || '',
            description: asset.description || '',
            last_scanned_at: asset.last_scanned_at || '',
        });
    }

    return tools.map(tool => ({
        tool: tool.tool,
        display_name: tool.display_name || tool.tool,
        description: tool.description || '',
        version: tool.version || '',
        status: tool.status || 'unknown',
        config_dir: tool.config_dir || '',
        theme: parseJson(tool.theme_json, themeForTool(tool.tool)),
        last_scanned_at: tool.last_scanned_at || '',
        assets: byTool.get(tool.tool) || [],
    }));
}

function writeOverviewInventory(db, inventory = [], now = new Date().toISOString()) {
    if (!db) return { tool_count: 0, asset_count: 0 };
    const write = db.transaction((items) => {
        db.prepare('DELETE FROM overview_assets').run();
        db.prepare('DELETE FROM overview_tools').run();

        const insertTool = db.prepare(`
            INSERT INTO overview_tools (tool, display_name, description, version, status, config_dir, theme_json, last_scanned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const insertAsset = db.prepare(`
            INSERT INTO overview_assets (tool, name, capability, type, status, path, description, last_scanned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        let assetCount = 0;
        for (const tool of items) {
            insertTool.run(
                tool.tool,
                tool.display_name || tool.tool,
                tool.description || '',
                tool.version || '',
                tool.status || 'unknown',
                tool.config_dir || '',
                JSON.stringify(themeForTool(tool.tool, tool.theme)),
                now
            );
            for (const asset of dedupeAssets(tool.assets || [])) {
                insertAsset.run(
                    tool.tool,
                    asset.name || 'unknown',
                    normalizeCapabilityName(asset.name || 'unknown'),
                    asset.type || 'builtin',
                    asset.status || 'unknown',
                    asset.path || '',
                    asset.description || '',
                    now
                );
                assetCount += 1;
            }
        }
        return { tool_count: items.length, asset_count: assetCount };
    });
    return write(inventory);
}

function refreshOverviewInventory(db, options = {}) {
    const startedAt = options.now || new Date().toISOString();
    try {
        const inventory = options.inventory || discoverInventory();
        const counts = writeOverviewInventory(db, inventory, startedAt);
        const finishedAt = options.finishedAt || new Date().toISOString();
        if (db) {
            db.prepare(`
                INSERT INTO overview_scan_runs (started_at, finished_at, status, tool_count, asset_count, error_message)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(startedAt, finishedAt, 'success', counts.tool_count, counts.asset_count, null);
        }
        return { ok: true, ...counts };
    } catch (e) {
        const finishedAt = options.finishedAt || new Date().toISOString();
        if (db) {
            db.prepare(`
                INSERT INTO overview_scan_runs (started_at, finished_at, status, tool_count, asset_count, error_message)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(startedAt, finishedAt, 'error', 0, 0, e.message);
        }
        return { ok: false, error: e.message, tool_count: 0, asset_count: 0 };
    }
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

function themeForTool(toolName, explicitTheme) {
    if (explicitTheme) return explicitTheme;
    const definition = TOOL_DEFINITIONS.find(item => item.tool === toolName);
    return definition?.theme || { accent: '#64748b', surface: '#f8fafc' };
}

function stableInventoryShell() {
    return TOOL_DEFINITIONS.map(tool => ({
        ...tool,
        version: '',
        status: fs.existsSync(tool.config_dir) ? 'detected' : 'unknown',
        assets: [],
    }));
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
            theme: themeForTool(tool.tool, tool.theme),
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
    let inventory = [];
    if (db) {
        const sinceClause = options.since ? 'AND timestamp >= ?' : '';
        const params = options.since ? [options.since] : [];
        usageRows = db.prepare(`
            SELECT source, tool_name, COUNT(*) as call_count
            FROM timeline
            WHERE role IN ('tool_result', 'tool_error') AND tool_name IS NOT NULL ${sinceClause}
            GROUP BY source, tool_name
        `).all(...params);
        inventory = readOverviewInventory(db);
    }
    if (!inventory.length) inventory = db ? stableInventoryShell() : discoverInventory();
    return buildOverview({ inventory, usageRows, priorityThreshold: options.priorityThreshold || 5 });
}

let overviewRefreshInFlight = false;
let overviewRefreshTimer = null;

function scheduleOverviewRefresh(db, options = {}) {
    if (!db || overviewRefreshInFlight) return false;
    const delayMs = Math.max(0, Number(options.delayMs || 0));
    const timer = setTimeout(() => {
        overviewRefreshInFlight = true;
        try {
            refreshOverviewInventory(db);
        } finally {
            overviewRefreshInFlight = false;
        }
    }, delayMs);
    if (timer.unref) timer.unref();
    return true;
}

function startOverviewScanner(db, options = {}) {
    if (!db) return null;
    const intervalMs = Number(options.intervalMs ?? DEFAULT_OVERVIEW_SCAN_INTERVAL_MS);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
    if (overviewRefreshTimer) clearInterval(overviewRefreshTimer);
    scheduleOverviewRefresh(db, { delayMs: Number(options.initialDelayMs ?? 3000) });
    overviewRefreshTimer = setInterval(() => {
        scheduleOverviewRefresh(db);
    }, intervalMs);
    if (overviewRefreshTimer.unref) overviewRefreshTimer.unref();
    return overviewRefreshTimer;
}

function stopOverviewScanner() {
    if (overviewRefreshTimer) {
        clearInterval(overviewRefreshTimer);
        overviewRefreshTimer = null;
    }
}

module.exports = {
    buildOverview,
    queryOverview,
    readOverviewInventory,
    refreshOverviewInventory,
    scheduleOverviewRefresh,
    startOverviewScanner,
    stopOverviewScanner,
    writeOverviewInventory,
    discoverPiAssets,
    normalizeCapabilityName,
};
