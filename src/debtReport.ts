import * as vscode from 'vscode';
import * as child_process from 'child_process';

interface DebtItem {
    file: string;
    line: number;
    tag: string;
    text: string;
    status: 'added' | 'removed';
}

interface DebtReport {
    baseBranch: string;
    currentBranch: string;
    generatedAt: string;
    added: DebtItem[];
    removed: DebtItem[];
    summary: { added: number; removed: number; net: number };
}

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

function execGit(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        child_process.execFile(
            'git',
            args,
            { cwd, maxBuffer: GIT_MAX_BUFFER, timeout: GIT_TIMEOUT_MS },
            (err, stdout) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(stdout);
            }
        );
    });
}

async function getCurrentBranch(root: string): Promise<string> {
    const out = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], root);
    return out.trim();
}

async function getDefaultBaseBranch(root: string): Promise<string> {
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
        // Track file
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
        // Track hunk line numbers
        const hunkMatch = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
        if (hunkMatch) {
            lineNumber = parseInt(hunkMatch[1], 10) - 1;
            continue;
        }
        // Count lines
        if (rawLine.startsWith('+') || rawLine.startsWith(' ')) {
            lineNumber++;
        }
        // Check added/removed lines for TODO tags
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

async function generateReport(root: string, baseBranch: string, tags: string[]): Promise<DebtReport> {
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

function formatMarkdown(report: DebtReport): string {
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

function formatJson(report: DebtReport): string {
    return JSON.stringify(report, null, 2);
}

export function registerCommand(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('todo-tree.exportDebtReport', async () => {
            const folders = vscode.workspace.workspaceFolders;
            if (!folders || folders.length === 0) {
                vscode.window.showWarningMessage('Todo Tree: No workspace folder open.');
                return;
            }

            const root = folders[0].uri.fsPath;
            const tags = vscode.workspace.getConfiguration('todo-tree.general').get<string[]>('tags') || [
                'TODO',
                'FIXME',
                'BUG',
            ];

            let baseBranch: string;
            try {
                baseBranch = await getDefaultBaseBranch(root);
            } catch {
                vscode.window.showErrorMessage('Todo Tree: Not a Git repository.');
                return;
            }

            const input = await vscode.window.showInputBox({
                prompt: 'Base branch to compare against',
                value: baseBranch,
            });
            if (!input) return;

            try {
                const report = await generateReport(root, input, tags);
                const format = await vscode.window.showQuickPick(['Markdown', 'JSON'], {
                    placeHolder: 'Export format',
                });
                if (!format) return;

                const content = format === 'JSON' ? formatJson(report) : formatMarkdown(report);

                const doc = await vscode.workspace.openTextDocument({
                    content,
                    language: format === 'JSON' ? 'json' : 'markdown',
                });
                await vscode.window.showTextDocument(doc, { preview: true });

                const net = report.summary.net;
                vscode.window.showInformationMessage(
                    `TODO Debt: +${report.summary.added} / -${report.summary.removed} (net ${net > 0 ? '+' : ''}${net})`
                );
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                vscode.window.showErrorMessage('Todo Tree: Debt report failed: ' + msg);
            }
        })
    );
}
