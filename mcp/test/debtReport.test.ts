import { describe, expect, it } from 'vitest';
import { parseDiffForTodos } from '../src/debtReport.js';

describe('parseDiffForTodos', () => {
    it('matches markdown task tags that do not have word boundaries', () => {
        const diff = ['+++ b/README.md', '@@ -1,2 +1,3 @@', '+- [ ] new task', '+- [x] done task'].join('\n');

        const items = parseDiffForTodos(diff, ['TODO', 'FIXME', '[ ]', '[x]']);
        expect(items).toMatchObject([
            { file: 'README.md', line: 1, tag: '[ ]', text: '- [ ] new task', status: 'added' },
            { file: 'README.md', line: 2, tag: '[x]', text: '- [x] done task', status: 'added' },
        ]);
    });

    it('does not match word tags inside longer identifiers', () => {
        const diff = ['+++ b/src/app.ts', '@@ -1,2 +1,3 @@', '+const METHODTODO = true;', '+// TODO real'].join('\n');

        const items = parseDiffForTodos(diff, ['TODO']);
        expect(items).toHaveLength(1);
        expect(items[0].text).toBe('// TODO real');
    });

    it('attributes removed TODOs from deleted files to the deleted path', () => {
        const diff = [
            'diff --git a/src/keep.ts b/src/keep.ts',
            '--- a/src/keep.ts',
            '+++ b/src/keep.ts',
            '@@ -1,0 +1,1 @@',
            '+// TODO new',
            'diff --git a/src/deleted.ts b/src/deleted.ts',
            'deleted file mode 100644',
            '--- a/src/deleted.ts',
            '+++ /dev/null',
            '@@ -1,1 +0,0 @@',
            '-// TODO old',
        ].join('\n');

        const items = parseDiffForTodos(diff, ['TODO']);
        expect(items).toMatchObject([
            { file: 'src/keep.ts', status: 'added', text: '// TODO new' },
            { file: 'src/deleted.ts', status: 'removed', text: '// TODO old' },
        ]);
    });
});
