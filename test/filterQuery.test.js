require('ts-node/register/transpile-only');
const { parse, createMatcher, matchesNode } = require('../src/filterQuery.ts');

QUnit.module('filterQuery.parse');

QUnit.test('parses plain text terms', function(assert) {
    const q = parse('hello world');
    assert.deepEqual(q.terms, ['hello', 'world']);
    assert.deepEqual(q.fields, {});
});

QUnit.test('parses field:value pairs', function(assert) {
    const q = parse('tag:TODO path:src');
    assert.deepEqual(q.terms, []);
    assert.deepEqual(q.fields.tag, ['TODO']);
    assert.deepEqual(q.fields.path, ['src']);
});

QUnit.test('parses mixed terms and fields', function(assert) {
    const q = parse('refactor tag:FIXME path:lib');
    assert.deepEqual(q.terms, ['refactor']);
    assert.deepEqual(q.fields.tag, ['FIXME']);
    assert.deepEqual(q.fields.path, ['lib']);
});

QUnit.test('handles multiple values for same field', function(assert) {
    const q = parse('tag:TODO tag:FIXME');
    assert.deepEqual(q.fields.tag, ['TODO', 'FIXME']);
});

QUnit.test('handles quoted strings', function(assert) {
    const q = parse('"hello world" tag:TODO');
    assert.deepEqual(q.terms, ['hello world']);
    assert.deepEqual(q.fields.tag, ['TODO']);
});

QUnit.test('handles empty input', function(assert) {
    const q = parse('');
    assert.deepEqual(q.terms, []);
    assert.deepEqual(q.fields, {});
});

QUnit.test('handles undefined input', function(assert) {
    const q = parse(undefined);
    assert.deepEqual(q.terms, []);
    assert.deepEqual(q.fields, {});
});

QUnit.test('field keys are lowercased', function(assert) {
    const q = parse('Tag:TODO Priority:P0');
    assert.deepEqual(q.fields.tag, ['TODO']);
    assert.deepEqual(q.fields.priority, ['P0']);
});

QUnit.module('filterQuery.createMatcher');

QUnit.test('matches plain text in node fields', function(assert) {
    const matcher = createMatcher('auth', false);
    assert.true(matcher({ label: 'fix auth bug', fsPath: '/src/main.ts' }));
    assert.false(matcher({ label: 'fix database', fsPath: '/src/db.ts' }));
});

QUnit.test('matches tag field', function(assert) {
    const matcher = createMatcher('tag:TODO', false);
    assert.true(matcher({ actualTag: 'TODO', label: 'something' }));
    assert.false(matcher({ actualTag: 'FIXME', label: 'something' }));
});

QUnit.test('matches path field', function(assert) {
    const matcher = createMatcher('path:src', false);
    assert.true(matcher({ fsPath: '/project/src/main.ts' }));
    assert.false(matcher({ fsPath: '/project/lib/util.ts' }));
});

QUnit.test('matches file field (basename only)', function(assert) {
    const matcher = createMatcher('file:main.ts', false);
    assert.true(matcher({ fsPath: '/project/src/main.ts' }));
    assert.false(matcher({ fsPath: '/project/src/util.ts' }));
});

QUnit.test('matches priority field', function(assert) {
    const matcher = createMatcher('priority:P0', false);
    assert.true(matcher({ priority: 'P0', label: 'urgent' }));
    assert.false(matcher({ priority: 'P2', label: 'low' }));
});

QUnit.test('matches status field for markdown tasks', function(assert) {
    const matcher = createMatcher('status:done', false);
    assert.true(matcher({ actualTag: '[x]', label: 'done task' }));
    assert.false(matcher({ actualTag: '[ ]', label: 'open task' }));
});

QUnit.test('status:open only matches open markdown tasks', function(assert) {
    const matcher = createMatcher('status:open', false);
    assert.true(matcher({ actualTag: '[ ]', label: 'open task' }));
    assert.false(matcher({ actualTag: '[x]', label: 'done task' }));
    assert.false(matcher({ actualTag: 'TODO', label: 'plain todo task' }));
});

QUnit.test('case insensitive matching by default', function(assert) {
    const matcher = createMatcher('tag:todo', false);
    assert.true(matcher({ actualTag: 'TODO', label: 'test' }));
});

QUnit.test('case sensitive matching when enabled', function(assert) {
    const matcher = createMatcher('tag:todo', true);
    assert.false(matcher({ actualTag: 'TODO', label: 'test' }));
    assert.true(matcher({ actualTag: 'todo', label: 'test' }));
});

QUnit.test('multiple fields must all match (AND)', function(assert) {
    const matcher = createMatcher('tag:TODO path:src', false);
    assert.true(matcher({ actualTag: 'TODO', fsPath: '/src/main.ts' }));
    assert.false(matcher({ actualTag: 'TODO', fsPath: '/lib/main.ts' }));
    assert.false(matcher({ actualTag: 'FIXME', fsPath: '/src/main.ts' }));
});
