require('ts-node/register/transpile-only');

// Mock vscode module
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
        return {
            workspace: {
                getConfiguration: function (section) {
                    if (section === 'files.exclude') {
                        return { '*.exe': true, '*.dll': true };
                    }
                    if (section === 'search.exclude') {
                        return { node_modules: true };
                    }
                    return {};
                },
            },
        };
    }
    return originalLoad.apply(this, arguments);
};

const { addGlobs, buildGlobsForRipgrep } = require('../src/globUtils.ts');

// Restore original loader
Module._load = originalLoad;

QUnit.module('globUtils.addGlobs');

QUnit.test('adds included globs', function (assert) {
    const source = { '*.js': true, '*.ts': true, '*.md': false };
    const result = addGlobs(source, [], false);
    assert.deepEqual(result, ['*.js', '*.ts']);
});

QUnit.test('adds excluded globs with prefix', function (assert) {
    const source = { node_modules: true, '.git': true };
    const result = addGlobs(source, [], true);
    assert.deepEqual(result, ['!node_modules', '!.git']);
});

QUnit.test('appends to existing target', function (assert) {
    const source = { '*.js': true };
    const result = addGlobs(source, ['*.ts'], false);
    assert.deepEqual(result, ['*.ts', '*.js']);
});

QUnit.test('handles empty source', function (assert) {
    const result = addGlobs({}, [], false);
    assert.deepEqual(result, []);
});

QUnit.module('globUtils.buildGlobsForRipgrep');

QUnit.test('combines include and exclude globs', function (assert) {
    const result = buildGlobsForRipgrep(['*.js', '*.ts'], ['node_modules'], [], [], [], false, false, false);
    assert.ok(result.includes('*.js'));
    assert.ok(result.includes('*.ts'));
    assert.ok(result.includes('!node_modules'));
});

QUnit.test('includes temp globs', function (assert) {
    const result = buildGlobsForRipgrep([], [], ['temp_include'], ['temp_exclude'], [], false, false, false);
    assert.ok(result.includes('temp_include'));
    assert.ok(result.includes('!temp_exclude'));
});

QUnit.test('includes submodule exclude globs when flag is set', function (assert) {
    const result = buildGlobsForRipgrep([], [], [], [], ['submodule'], false, false, true);
    assert.ok(result.includes('!submodule'));
});

QUnit.test('excludes submodule globs when flag is not set', function (assert) {
    const result = buildGlobsForRipgrep([], [], [], [], ['submodule'], false, false, false);
    assert.notOk(result.includes('!submodule'));
});

QUnit.test('uses built-in file excludes when flag is set', function (assert) {
    const result = buildGlobsForRipgrep([], [], [], [], [], true, false, false);
    assert.ok(result.includes('!*.exe'));
    assert.ok(result.includes('!*.dll'));
});

QUnit.test('uses built-in search excludes when flag is set', function (assert) {
    const result = buildGlobsForRipgrep([], [], [], [], [], false, true, false);
    assert.ok(result.includes('!node_modules'));
});
