import { execGit } from './git.js';

export interface DebtItem {
    file: string;
    line: number;
    tag: string;
    text: string;
    status: 'added' | 'removed';
}

export interface DebtReport {
    baseBranch: string;
    currentBranch: string;
    generatedAt: string;
    added: DebtItem[];
    removed: DebtItem[];
    summary: { added: number; removed: number; net: number };
}

async function getCurrentBranch(root: string): Promise<string> {
    const out = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], root);
    return out.trim();
}

export async function getDefaultBaseBranch(root: string): Promise<string> {
    for (const candidate of ['main', 'master', 'develop']) {
        try {
            await execGit(['rev-parse', '--verify', candidate], root);
            return candidate;
        } catch {
            /* not found */
        }
    }
    return 'main';
}

function findTodoTag(text: string, tags: string[]): string | undefined {
    if (tags.length === 0) {
        return undefined;
    }
    const tagPattern = new RegExp(
        '(^|[^A-Za-z0-9_])(' +
            tags.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
            ')(?=$|[^A-Za-z0-9_])'
    );
    const match = text.match(tagPattern);
    return match ? match[2] : undefined;
}

export function parseDiffForTodos(diff: string, tags: string[]): DebtItem[] {
    const items: DebtItem[] = [];
    let oldFile = '';
    let currentFile = '';
    let lineNumber = 0;

    for (const rawLine of diff.split('\n')) {
        if (rawLine.startsWith('diff --git ')) {
            oldFile = '';
            currentFile = '';
            lineNumber = 0;
            continue;
        }
        if (rawLine.startsWith('--- a/')) {
            oldFile = rawLine.substring(6);
            continue;
        }
        if (rawLine.startsWith('+++ b/')) {
            currentFile = rawLine.substring(6);
            continue;
        }
        if (rawLine === '+++ /dev/null') {
            currentFile = oldFile;
            continue;
        }
        const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
        if (hunkMatch) {
            lineNumber = parseInt(hunkMatch[1], 10) - 1;
            continue;
        }
        if (rawLine.startsWith('+') || rawLine.startsWith(' ')) {
            lineNumber++;
        }
        if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
            const content = rawLine.substring(1);
            const tag = findTodoTag(content, tags);
            if (tag) {
                items.push({
                    file: currentFile,
                    line: lineNumber,
                    tag,
                    text: content.trim(),
                    status: 'added',
                });
            }
        } else if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
            const content = rawLine.substring(1);
            const tag = findTodoTag(content, tags);
            if (tag) {
                items.push({ file: currentFile, line: 0, tag, text: content.trim(), status: 'removed' });
            }
        }
    }
    return items;
}

export async function generateReport(root: string, baseBranch: string, tags: string[]): Promise<DebtReport> {
    const currentBranch = await getCurrentBranch(root);
    const mergeBase = (await execGit(['merge-base', baseBranch, 'HEAD'], root)).trim();
    const diff = await execGit(['diff', mergeBase, 'HEAD', '-U0'], root);
    const items = parseDiffForTodos(diff, tags);

    const added = items.filter((i) => i.status === 'added');
    const removed = items.filter((i) => i.status === 'removed');

    return {
        baseBranch,
        currentBranch,
        generatedAt: new Date().toISOString(),
        added,
        removed,
        summary: { added: added.length, removed: removed.length, net: added.length - removed.length },
    };
}

export function formatMarkdown(report: DebtReport): string {
    const lines: string[] = [
        '# TODO Debt Report',
        '',
        `Branch: \`${report.currentBranch}\` vs \`${report.baseBranch}\``,
        `Generated: ${report.generatedAt}`,
        '',
        '## Summary',
        '',
        `| Metric | Count |`,
        `| --- | --- |`,
        `| Added | ${report.summary.added} |`,
        `| Removed | ${report.summary.removed} |`,
        `| Net change | ${report.summary.net > 0 ? '+' : ''}${report.summary.net} |`,
        '',
    ];

    if (report.added.length > 0) {
        lines.push('## Added TODOs', '');
        report.added.forEach((item) => {
            lines.push(`- **${item.tag}** \`${item.file}:${item.line}\` ${item.text}`);
        });
        lines.push('');
    }

    if (report.removed.length > 0) {
        lines.push('## Removed TODOs', '');
        report.removed.forEach((item) => {
            lines.push(`- ~~**${item.tag}** \`${item.file}\` ${item.text}~~`);
        });
        lines.push('');
    }

    return lines.join('\n');
}

export function formatJson(report: DebtReport): string {
    return JSON.stringify(report, null, 2);
}
