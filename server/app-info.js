const fs = require('fs');
const path = require('path');

function getPackageJsonPath(baseDir = __dirname) {
    const sourceLayoutPath = path.join(baseDir, '..', 'package.json');
    const installLayoutPath = path.join(baseDir, 'package.json');
    try {
        if (require('fs').existsSync(sourceLayoutPath)) return sourceLayoutPath;
    } catch (_) {}
    return installLayoutPath;
}

function getChangelogPath(baseDir = __dirname) {
    const sourceLayoutPath = path.join(baseDir, '..', 'CHANGELOG.md');
    const installLayoutPath = path.join(baseDir, 'CHANGELOG.md');
    try {
        if (fs.existsSync(sourceLayoutPath)) return sourceLayoutPath;
    } catch (_) {}
    return installLayoutPath;
}

function normalizeRepositoryUrl(repository) {
    const raw = typeof repository === 'string' ? repository : repository?.url;
    if (!raw) return '';
    return String(raw)
        .replace(/^git\+/, '')
        .replace(/\.git$/, '');
}

function getCurrentChangelog(version, changelogPath = getChangelogPath()) {
    try {
        if (!fs.existsSync(changelogPath)) return { current_version: `v${version}`, items: [] };
        const content = fs.readFileSync(changelogPath, 'utf-8');
        const heading = new RegExp(`^##\\s+${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*`, 'm');
        const match = content.match(heading);
        if (!match) return { current_version: `v${version}`, items: [] };
        const start = match.index + match[0].length;
        const next = content.slice(start).search(/^##\s+/m);
        const section = content.slice(start, next >= 0 ? start + next : undefined);
        const items = section
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('- '))
            .map(line => line.slice(2).trim())
            .filter(Boolean)
            .slice(0, 8);
        return { current_version: match[0].replace(/^##\s+/, '').trim(), items };
    } catch (_) {
        return { current_version: `v${version}`, items: [] };
    }
}

function getAppInfo(options = {}) {
    const packageJsonPath = options.packageJsonPath || getPackageJsonPath();
    const pkg = require(packageJsonPath);
    const version = pkg.version || '0.0.0';
    return {
        name: pkg.name || 'agent-trace',
        version,
        display_version: `v${version}`,
        subtitle: '多 Agent 调用链路观测与复盘工具',
        repository_url: normalizeRepositoryUrl(pkg.repository),
        changelog: getCurrentChangelog(version, options.changelogPath),
    };
}

module.exports = { getAppInfo, getPackageJsonPath, getChangelogPath, getCurrentChangelog, normalizeRepositoryUrl };
