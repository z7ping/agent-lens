const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DEFAULT_OVERVIEW_SCAN_INTERVAL_MS } = require('./config');

const ASSET_TYPES = ['skill', 'mcp', 'plugin', 'extension', 'hook', 'adapter', 'builtin'];

const TOOL_DEFINITIONS = [
    {
        tool: 'pi',
        display_name: 'Pi',
        description: 'Pi 编码智能体历史数据源。',
        config_dir: path.join(os.homedir(), '.pi'),
        order: 10,
        links: {
            homepage: 'https://pi.dev',
            docs: 'https://pi.dev/docs/latest',
            github: 'https://github.com/earendil-works/pi',
        },
        theme: { accent: '#eab308', surface: '#fefce8' },
    },
    {
        tool: 'codex',
        display_name: 'Codex',
        description: 'OpenAI Codex 命令行编码智能体与本地桌面环境。',
        config_dir: path.join(os.homedir(), '.codex'),
        order: 20,
        links: {
            homepage: 'https://openai.com/codex',
            docs: 'https://developers.openai.com/codex',
            github: 'https://github.com/openai/codex',
        },
        theme: { accent: '#10b981', surface: '#ecfdf5' },
    },
    {
        tool: 'claude-code',
        display_name: 'Claude Code CLI',
        description: 'Anthropic Claude Code 命令行编码助手。',
        config_dir: path.join(os.homedir(), '.claude'),
        order: 30,
        links: {
            homepage: 'https://www.anthropic.com/claude-code',
            docs: 'https://docs.anthropic.com/en/docs/claude-code',
            github: 'https://github.com/anthropics/claude-code',
        },
        theme: { accent: '#f97316', surface: '#fff7ed' },
    },
    {
        tool: 'cursor',
        display_name: 'Cursor',
        description: '基于 VS Code 的 AI 代码编辑器。',
        config_dir: path.join(os.homedir(), 'AppData', 'Roaming', 'Cursor', 'User'),
        order: 70,
        links: {
            homepage: 'https://cursor.com',
            docs: 'https://docs.cursor.com',
            github: 'https://github.com/getcursor/cursor',
        },
        theme: { accent: '#6366f1', surface: '#eef2ff' },
    },
    {
        tool: 'opencode',
        display_name: 'OpenCode',
        description: 'OpenCode 终端编码智能体。',
        config_dir: path.join(os.homedir(), '.local', 'share', 'opencode'),
        order: 40,
        links: {
            homepage: 'https://opencode.ai',
            docs: 'https://opencode.ai/docs',
            github: 'https://github.com/sst/opencode',
        },
        theme: { accent: '#06b6d4', surface: '#ecfeff' },
    },
    {
        tool: 'hermes',
        display_name: 'Hermes',
        description: 'Hermes 编码智能体历史数据源。',
        config_dir: path.join(os.homedir(), '.hermes'),
        order: 50,
        links: {},
        theme: { accent: '#8b5cf6', surface: '#f5f3ff' },
    },
    {
        tool: 'openclaw',
        display_name: 'OpenClaw',
        description: 'OpenClaw 编码智能体历史数据源。',
        config_dir: path.join(os.homedir(), '.openclaw'),
        order: 60,
        links: {},
        theme: { accent: '#64748b', surface: '#f8fafc' },
    },
];

const TOOL_DEFINITION_BY_NAME = new Map(TOOL_DEFINITIONS.map(item => [item.tool, item]));

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

function scanFilesByName(baseDir, fileName, type, status = 'enabled', options = {}) {
    const results = [];
    const maxDepth = options.maxDepth ?? 6;
    const base = path.resolve(baseDir || '');
    const visit = (dir, depth) => {
        if (!dir || depth > maxDepth) return;
        for (const entry of safeReadDir(dir)) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                visit(full, depth + 1);
            } else if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
                const assetDir = path.dirname(full);
                const relative = path.relative(base, assetDir).split(path.sep).filter(Boolean);
                const name = relative.length ? relative.join(':') : path.basename(assetDir);
                results.push({
                    name,
                    type,
                    status,
                    path: full,
                });
            }
        }
    };
    visit(base, 0);
    return results;
}

function scanCodexPluginManifests(baseDir) {
    return scanFilesByName(baseDir, 'plugin.json', 'plugin', 'installed', { maxDepth: 8 })
        .map(asset => {
            let name = path.basename(path.dirname(path.dirname(asset.path)));
            let description = 'Codex 插件清单';
            try {
                const manifest = JSON.parse(fs.readFileSync(asset.path, 'utf-8'));
                name = manifest.name || manifest.id || name;
                description = manifest.description || description;
            } catch (_) {}
            return { ...asset, name, description };
        });
}

function scanTomlSections(file, sectionPrefix, type, tool) {
    try {
        if (!fs.existsSync(file)) return [];
        const content = fs.readFileSync(file, 'utf-8');
        const escaped = sectionPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`^\\[${escaped}\\.([^\\]]+)\\]`, 'gm');
        const assets = [];
        let match;
        while ((match = regex.exec(content))) {
            const name = match[1].replace(/^["']|["']$/g, '');
            assets.push({
                name,
                type,
                status: 'configured',
                path: file,
                description: `${tool} 配置条目`,
            });
        }
        return assets;
    } catch (_) {
        return [];
    }
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
        ...scanFilesByName(path.join(configDir, 'skills'), 'SKILL.md', 'skill', 'enabled'),
        ...scanFilesByName(path.join(configDir, 'plugins', 'cache'), 'SKILL.md', 'skill', 'enabled'),
        ...scanCodexPluginManifests(path.join(configDir, 'plugins', 'cache')),
        ...scanNamedDirectories(path.join(configDir, 'plugins'), 'plugin', 'installed'),
        ...scanJsonKeys(path.join(configDir, 'config.json'), 'mcp', 'Codex'),
        ...scanTomlSections(path.join(configDir, 'config.toml'), 'mcp_servers', 'mcp', 'Codex'),
        ...scanTomlSections(path.join(configDir, 'config.toml'), 'plugins', 'plugin', 'Codex'),
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
    const home = options.homeDir || os.homedir();
    const defaultCandidates = includeDefaultCandidates ? [
        configDir,
        process.env.PI_CODING_AGENT_DIR,
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
        || fs.existsSync(path.join(agentDir, 'settings.json'))
        || fs.existsSync(path.join(agentDir, 'skills'))
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

function packageNameFromPiSource(source) {
    const text = typeof source === 'string' ? source : String(source?.source || '');
    const trimmed = text.trim();
    if (!trimmed.startsWith('npm:')) return '';
    return trimmed.slice(4).trim();
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
    const settings = readJsonFile(path.join(agentDir, 'settings.json'));
    const deps = {
        ...(packageJson?.dependencies || {}),
        ...(packageJson?.devDependencies || {}),
        ...(packageJson?.optionalDependencies || {}),
    };
    for (const name of normalizeArray(settings?.packages).map(packageNameFromPiSource).filter(Boolean)) {
        deps[name] = deps[name] || '*';
    }
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

function scanChildSkillDirectories(baseDir, description, options = {}) {
    const assets = [];
    const maxDepth = Number(options.maxDepth ?? 4);
    const includeRootMarkdown = options.includeRootMarkdown !== false;
    const visit = (dir, depth) => {
        const entries = safeReadDir(dir);
        if (depth > 0 && entries.some(entry => entry.isFile() && entry.name === 'SKILL.md')) {
            assets.push({
                name: path.basename(dir),
                type: 'skill',
                status: 'enabled',
                path: dir,
                description,
            });
            return;
        }
        if (includeRootMarkdown && depth === 0) {
            for (const entry of entries) {
                if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name !== 'SKILL.md') {
                    assets.push({
                        name: path.basename(entry.name, path.extname(entry.name)),
                        type: 'skill',
                        status: 'enabled',
                        path: path.join(dir, entry.name),
                        description,
                    });
                }
            }
        }
        if (depth >= maxDepth) return;
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const childDir = path.join(dir, entry.name);
            assets.push({
                name: entry.name,
                type: 'skill',
                status: 'enabled',
                path: childDir,
                description,
            });
            visit(childDir, depth + 1);
        }
    };
    visit(baseDir, 0);
    return assets;
}

function normalizeArray(value) {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null || value === false) return [];
    return [value];
}

function expandHomePath(input, homeDir = os.homedir()) {
    const text = String(input || '').trim();
    if (!text) return '';
    if (text === '~') return homeDir;
    if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(homeDir, text.slice(2));
    return text;
}

function resolvePiPath(input, baseDir, homeDir = os.homedir()) {
    const expanded = expandHomePath(input, homeDir);
    if (!expanded) return '';
    return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseDir, expanded);
}

function packageResourceDirs(pkgDir, pkg, field) {
    const piResources = normalizeArray(pkg?.pi?.[field]);
    const topLevelResources = normalizeArray(pkg?.[field]);
    return [...piResources, ...topLevelResources]
        .filter(item => typeof item === 'string')
        .map(item => resolvePiPath(item, pkgDir));
}

function scanConfiguredPiSkillPaths(agentDir, options = {}) {
    const settings = readJsonFile(path.join(agentDir, 'settings.json'));
    return normalizeArray(settings?.skills).flatMap(item => {
        if (typeof item === 'string') {
            return scanChildSkillDirectories(
                resolvePiPath(item, agentDir, options.homeDir),
                'Pi settings.json 配置的 Skill'
            );
        }
        if (item && typeof item === 'object' && item.path) {
            return scanChildSkillDirectories(
                resolvePiPath(item.path, agentDir, options.homeDir),
                'Pi settings.json 配置的 Skill'
            );
        }
        return [];
    });
}

function scanConfiguredPiExtensionPaths(agentDir, options = {}) {
    const settings = readJsonFile(path.join(agentDir, 'settings.json'));
    return normalizeArray(settings?.extensions).flatMap(item => {
        const source = typeof item === 'string' ? item : String(item?.path || item?.source || '');
        const cleanSource = source.startsWith('+') ? source.slice(1) : source;
        const resolved = resolvePiPath(cleanSource, agentDir, options.homeDir);
        if (!resolved || !fs.existsSync(resolved)) return [];
        const stat = fs.statSync(resolved);
        const assetPath = stat.isDirectory() ? resolved : path.dirname(resolved);
        return [{
            name: path.basename(assetPath),
            type: 'extension',
            status: 'enabled',
            path: assetPath,
            description: 'Pi settings.json 配置的 Extension',
        }];
    });
}

function scanPiExtensionDirectory(baseDir, description = 'Pi Extension') {
    return safeReadDir(baseDir)
        .filter(entry => entry.isDirectory() || (entry.isFile() && /\.(?:[cm]?[jt]s)$/i.test(entry.name)))
        .map(entry => {
            const assetPath = path.join(baseDir, entry.name);
            return {
                name: entry.isDirectory() ? entry.name : path.basename(entry.name, path.extname(entry.name)),
                type: 'extension',
                status: 'enabled',
                path: assetPath,
                description,
            };
        });
}

function scanPiNpmSkills(agentDir) {
    const npmDir = path.join(agentDir, 'npm');
    const packageJson = readJsonFile(path.join(npmDir, 'package.json'));
    const settings = readJsonFile(path.join(agentDir, 'settings.json'));
    const deps = {
        ...(packageJson?.dependencies || {}),
        ...(packageJson?.devDependencies || {}),
        ...(packageJson?.optionalDependencies || {}),
    };
    for (const name of normalizeArray(settings?.packages).map(packageNameFromPiSource).filter(Boolean)) {
        deps[name] = deps[name] || '*';
    }
    const modulesDir = path.join(npmDir, 'node_modules');
    return Object.keys(deps).flatMap(name => {
        const pkgPath = packagePathForDependency(modulesDir, name);
        const pkg = readJsonFile(pkgPath) || { name };
        if (!isPiPackage(name, pkg)) return [];
        const pkgDir = path.dirname(pkgPath);
        const skillDirs = [
            path.join(pkgDir, 'skills'),
            ...packageResourceDirs(pkgDir, pkg, 'skills'),
        ];
        return uniqueDirs(skillDirs).flatMap(dir =>
            scanChildSkillDirectories(dir, `Pi 插件 ${pkg.name || name} 提供的 Skill`)
        );
    });
}

function scanPiNpmExtensions(agentDir) {
    const npmDir = path.join(agentDir, 'npm');
    const packageJson = readJsonFile(path.join(npmDir, 'package.json'));
    const settings = readJsonFile(path.join(agentDir, 'settings.json'));
    const deps = {
        ...(packageJson?.dependencies || {}),
        ...(packageJson?.devDependencies || {}),
        ...(packageJson?.optionalDependencies || {}),
    };
    for (const name of normalizeArray(settings?.packages).map(packageNameFromPiSource).filter(Boolean)) {
        deps[name] = deps[name] || '*';
    }
    const modulesDir = path.join(npmDir, 'node_modules');
    return Object.keys(deps).flatMap(name => {
        const pkgPath = packagePathForDependency(modulesDir, name);
        const pkg = readJsonFile(pkgPath) || { name };
        if (!isPiPackage(name, pkg)) return [];
        const pkgDir = path.dirname(pkgPath);
        const extensionDirs = [
            path.join(pkgDir, 'extensions'),
            ...packageResourceDirs(pkgDir, pkg, 'extensions'),
        ];
        return uniqueDirs(extensionDirs).flatMap(dir =>
            scanPiExtensionDirectory(dir, `Pi 插件 ${pkg.name || name} 提供的 Extension`)
        );
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
    return dedupeAssets(getPiAgentDirs(configDir, options).flatMap(agentDir => [
        ...scanPiNpmPlugins(agentDir),
        ...scanPiExtensionDirectory(path.join(agentDir, 'extensions'), 'Pi settings.json/agent 目录启用的 Extension'),
        ...scanConfiguredPiExtensionPaths(agentDir, options),
        ...scanChildSkillDirectories(path.join(agentDir, 'skills'), 'Pi 用户级默认 Skill'),
        ...scanChildSkillDirectories(path.join(options.homeDir || os.homedir(), '.agents', 'skills'), 'Pi / Agent Skills 共享用户级 Skill'),
        ...scanConfiguredPiSkillPaths(agentDir, options),
        ...scanChildSkillDirectories(path.join(agentDir, 'pi-hermes-memory', 'skills'), 'Pi Hermes Memory 提供的 Skill'),
        ...scanPiNpmSkills(agentDir),
        ...scanPiNpmExtensions(agentDir),
        ...scanPiProjectMemorySkills(agentDir),
    ]));
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

    return tools.map(tool => {
        const definition = TOOL_DEFINITION_BY_NAME.get(tool.tool) || {};
        return {
            tool: tool.tool,
            display_name: tool.display_name || tool.tool,
            description: tool.description || '',
            version: tool.version || '',
            status: tool.status || 'unknown',
            config_dir: tool.config_dir || '',
            order: definition.order ?? 999,
            links: definition.links || {},
            theme: parseJson(tool.theme_json, themeForTool(tool.tool)),
            last_scanned_at: tool.last_scanned_at || '',
            assets: byTool.get(tool.tool) || [],
        };
    });
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
    const definition = TOOL_DEFINITION_BY_NAME.get(toolName);
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
            order: tool.order ?? TOOL_DEFINITION_BY_NAME.get(tool.tool)?.order ?? 999,
            links: tool.links || TOOL_DEFINITION_BY_NAME.get(tool.tool)?.links || {},
            theme: themeForTool(tool.tool, tool.theme),
            assets,
            asset_groups: groupAssets(assets),
        };
    }).sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || a.display_name.localeCompare(b.display_name));
    const toolNames = tools.map(tool => tool.tool);

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
    discoverCodexAssets,
    discoverPiAssets,
    normalizeCapabilityName,
};
