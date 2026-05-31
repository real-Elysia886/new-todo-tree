require('ts-node/register/transpile-only');

const Module = require('module');

function loadDashboard(vscodeMock) {
    const resolved = require.resolve('../src/dashboard.ts');
    delete require.cache[resolved];

    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') {
            return vscodeMock;
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        return require('../src/dashboard.ts');
    } finally {
        Module._load = originalLoad;
    }
}

function createVscodeMock() {
    return {
        workspace: {
            workspaceFolders: [],
            getConfiguration() {
                return {
                    get(key, fallback) {
                        return fallback;
                    },
                    update() {
                        return Promise.resolve();
                    },
                };
            },
        },
        window: {
            createWebviewPanel() {
                return {
                    webview: {
                        html: '',
                        onDidReceiveMessage() {},
                    },
                    onDidDispose() {},
                    reveal() {},
                };
            },
        },
        ViewColumn: {
            One: 1,
        },
        ConfigurationTarget: {
            Workspace: 2,
        },
    };
}

QUnit.module('dashboard trend helpers', function () {
    QUnit.test('parses git log hashes and ISO dates', function (assert) {
        const dashboard = loadDashboard(createVscodeMock());

        assert.deepEqual(dashboard.__test.parseGitLog('abc123 2026-05-26T10:20:30Z\nfff999 2026-05-25T01:02:03Z\n'), [
            { hash: 'abc123', date: '2026-05-26' },
            { hash: 'fff999', date: '2026-05-25' },
        ]);
    });

    QUnit.test('sums git grep count output', function (assert) {
        const dashboard = loadDashboard(createVscodeMock());

        assert.equal(dashboard.__test.countGitGrepOutput('abc:src/a.ts:2\nabc:src/b.ts:5\n'), 7);
        assert.equal(dashboard.__test.countGitGrepOutput('not-a-count\nabc:src/c.ts:3\n'), 3);
    });

    QUnit.test('escapes tags before building git grep pattern', function (assert) {
        const dashboard = loadDashboard(createVscodeMock());

        assert.equal(dashboard.__test.buildGitGrepPattern(['TODO', '[ ]', '[x]', 'A+B']), 'TODO|\\[ \\]|\\[x\\]|A\\+B');
    });

    QUnit.test('dashboard html uses CSP nonce and data-bound buttons', function (assert) {
        const dashboard = loadDashboard(createVscodeMock());
        const html = dashboard.__test.html(
            {
                workspaceState: {
                    get() {
                        return [];
                    },
                },
            },
            {
                getTagCountsForActivityBar() {
                    return { TODO: 1 };
                },
            },
            { cspSource: 'vscode-resource:' }
        );

        assert.ok(html.includes('Content-Security-Policy'));
        assert.ok(/script-src 'nonce-[A-Za-z0-9]{32}'/.test(html));
        assert.ok(/<script nonce="[A-Za-z0-9]{32}">/.test(html));
        assert.notOk(html.includes('onclick='));
        assert.ok(html.includes('button[data-command]'));
    });

    QUnit.test('completeTrendData stores sorted trend and refreshes panel html', function (assert) {
        const dashboard = loadDashboard(createVscodeMock());
        const updates = [];
        const context = {
            workspaceState: {
                update(key, value) {
                    updates.push({ key, value });
                    return Promise.resolve();
                },
            },
        };
        const provider = {
            getTagCountsForActivityBar() {
                return { TODO: 1 };
            },
        };
        const panel = { webview: { html: 'old' } };

        dashboard.__test.completeTrendData(
            context,
            provider,
            [
                { date: '2026-05-26', count: 9 },
                { date: '2026-05-24', count: 3 },
            ],
            panel,
            function () {
                return 'fresh html';
            }
        );

        assert.deepEqual(updates, [
            {
                key: 'todoTrend',
                value: [
                    { date: '2026-05-24', count: 3 },
                    { date: '2026-05-26', count: 9 },
                ],
            },
        ]);
        assert.equal(panel.webview.html, 'fresh html');
    });
});
