const path = require('path');

function getPackageJsonPath(baseDir = __dirname) {
    const sourceLayoutPath = path.join(baseDir, '..', 'package.json');
    const installLayoutPath = path.join(baseDir, 'package.json');
    try {
        if (require('fs').existsSync(sourceLayoutPath)) return sourceLayoutPath;
    } catch (_) {}
    return installLayoutPath;
}

function getAppInfo(options = {}) {
    const packageJsonPath = options.packageJsonPath || getPackageJsonPath();
    const pkg = require(packageJsonPath);
    const version = pkg.version || '0.0.0';
    return {
        name: pkg.name || 'agent-trace',
        version,
        display_version: `v${version}`,
    };
}

module.exports = { getAppInfo, getPackageJsonPath };
