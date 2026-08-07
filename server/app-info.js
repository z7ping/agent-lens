const path = require('path');

function getPackageJsonPath() {
    return path.join(__dirname, '..', 'package.json');
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

module.exports = { getAppInfo };
