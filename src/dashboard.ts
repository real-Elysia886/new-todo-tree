import * as vscode from 'vscode';
import * as child_process from 'child_process';

interface CountProvider {
    getTagCountsForActivityBar(): Record<string, number>;
}

interface DashboardActions {
    provider: CountProvider;
    rebuild(): void;
    clearTreeFilter(): void;
    applyFilter(value: string): void;
    scanChangedFiles(): void;
    scanStagedFiles(): void;
}

interface DashboardMessage {
    command?: string;
    value?: string;
}

interface TrendPoint {
    date: string;
    count: number;
}

interface DashboardPanelLike {
    webview: {
        html: string;
        cspSource?: string;
    };
}

let panel: vscode.WebviewPanel | undefined;

export function show(context: vscode.ExtensionContext, provider: CountProvider, actions: DashboardActions): void {
    collectTrendData(context, provider);

    if (panel) {
        panel.reveal();
        panel.webview.html = html(context, provider, panel.webview);
        return;
    }

    panel = vscode.window.createWebviewPanel('todoTreeDashboard', 'Todo Tree Dashboard', vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: true,
    });

    panel.webview.html = html(context, provider, panel.webview);

    panel.webview.onDidReceiveMessage((message: DashboardMessage) => {
        handleMessage(message, context, actions);
    });

    panel.onDidDispose(() => {
        panel = undefined;
    });
}

export function refresh(context: vscode.ExtensionContext, provider: CountProvider): void {
    if (panel) {
        panel.webview.html = html(context, provider, panel.webview);
    }
}

function handleMessage(message: DashboardMessage, context: vscode.ExtensionContext, actions: DashboardActions): void {
    const command = message && message.command;

    if (command === 'refresh') {
        actions.rebuild();
    } else if (command === 'clearFilter') {
        actions.clearTreeFilter();
    } else if (command === 'scanMode') {
        vscode.workspace
            .getConfiguration('todo-tree.tree')
            .update('scanMode', message.value, vscode.ConfigurationTarget.Workspace);
    } else if (command === 'scannerEngine') {
        vscode.workspace
            .getConfiguration('todo-tree.scanner')
            .update('engine', message.value, vscode.ConfigurationTarget.Workspace);
    } else if (command === 'maxFileSize') {
        const value = parseInt(message.value || '', 10);
        if (!isNaN(value) && value > 0) {
            vscode.workspace
                .getConfiguration('todo-tree.scanner')
                .update('maxFileSize', value, vscode.ConfigurationTarget.Workspace);
        }
    } else if (command === 'filter') {
        actions.applyFilter(message.value || '');
    } else if (command === 'changedFiles') {
        actions.scanChangedFiles();
    } else if (command === 'stagedFiles') {
        actions.scanStagedFiles();
    }

    setTimeout(() => {
        refresh(context, actions.provider);
    }, 300);
}

function html(context: vscode.ExtensionContext, provider: CountProvider, webview?: { cspSource?: string }): string {
    void context;

    const scanner = vscode.workspace.getConfiguration('todo-tree.scanner');
    const tree = vscode.workspace.getConfiguration('todo-tree.tree');
    const filtering = vscode.workspace.getConfiguration('todo-tree.filtering');
    const counts = provider.getTagCountsForActivityBar();
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const nonce = getNonce();
    const cspSource = webview && webview.cspSource ? webview.cspSource : '';
    const csp = [
        "default-src 'none'",
        'img-src ' + cspSource + ' data:',
        'style-src ' + cspSource + " 'unsafe-inline'",
        "script-src 'nonce-" + nonce + "'",
    ].join('; ');
    const rows = Object.keys(counts)
        .sort()
        .map((tag) => {
            return '<tr><td>' + escapeHtml(tag) + '</td><td>' + counts[tag] + '</td></tr>';
        })
        .join('');

    const pieChart = generatePieChart(counts);
    const barChart = generateBarChart(counts);

    return (
        '<!DOCTYPE html>' +
        '<html><head><meta charset="UTF-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
        '<meta http-equiv="Content-Security-Policy" content="' +
        escapeHtml(csp) +
        '">' +
        '<style>' +
        'body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);margin:0;padding:20px;}' +
        'main{max-width:1040px;margin:0 auto;}' +
        'h1{font-size:22px;font-weight:600;margin:0 0 18px;}' +
        'h2{font-size:16px;font-weight:600;margin:16px 0 10px;}' +
        'section{border-top:1px solid var(--vscode-panel-border);padding:16px 0;}' +
        '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;}' +
        '.chart-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;}' +
        '.metric{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:12px;background:var(--vscode-editorWidget-background);}' +
        '.metric strong{display:block;font-size:26px;line-height:1.2;margin-top:4px;}' +
        'label{display:block;font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:6px;}' +
        'select,input{box-sizing:border-box;width:100%;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:7px;}' +
        'button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:4px;padding:8px 12px;margin:0 8px 8px 0;cursor:pointer;}' +
        'button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);}' +
        'table{width:100%;border-collapse:collapse;}td,th{padding:7px 0;border-bottom:1px solid var(--vscode-panel-border);text-align:left;}' +
        '.muted{color:var(--vscode-descriptionForeground);}' +
        '.chart-container{text-align:center;}' +
        '.legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;justify-content:center;}' +
        '.legend-item{display:flex;align-items:center;gap:4px;font-size:12px;}' +
        '.legend-dot{width:10px;height:10px;border-radius:50%;}' +
        '</style></head><body><main>' +
        '<h1>Todo Tree Dashboard</h1>' +
        '<section class="grid">' +
        metric('Total items', total) +
        metric('Scanner', scanner.get('engine', 'auto')) +
        metric('Scan mode', tree.get('scanMode', 'workspace')) +
        metric('Max file size', scanner.get('maxFileSize', 1048576) + ' bytes') +
        '</section>' +
        '<section><h2>Charts</h2><div class="chart-grid">' +
        '<div class="chart-container"><h3>Tag Distribution</h3>' +
        pieChart +
        '</div>' +
        '<div class="chart-container"><h3>Tag Counts</h3>' +
        barChart +
        '</div>' +
        '</div>' +
        '<div class="chart-container" style="margin-top:16px;"><h3>TODO Trend (recent commits)</h3>' +
        generateTrendChart(context) +
        '</div>' +
        '</section>' +
        '<section><div class="grid">' +
        selectControl('Scanner engine', 'scannerEngine', scanner.get('engine', 'auto'), ['auto', 'rust', 'ripgrep']) +
        selectControl('Scan mode', 'scanMode', tree.get('scanMode', 'workspace'), [
            'workspace',
            'workspace only',
            'open files',
            'current file',
        ]) +
        '<div><label>Max file size</label><input id="maxFileSize" type="number" value="' +
        scanner.get('maxFileSize', 1048576) +
        '"></div>' +
        '<div><label>Smart filter</label><input id="filter" placeholder="tag:TODO path:src priority:P0"></div>' +
        '</div></section>' +
        '<section>' +
        '<button data-command="refresh">Refresh</button>' +
        '<button data-command="changedFiles">Changed Files</button>' +
        '<button data-command="stagedFiles">Staged Files</button>' +
        '<button class="secondary" data-command="clearFilter">Clear Filter</button>' +
        '<button class="secondary" data-command="maxFileSize" data-value-source="maxFileSize">Save Size</button>' +
        '<button class="secondary" data-command="filter" data-value-source="filter">Apply Filter</button>' +
        '<p class="muted">Include globs: ' +
        escapeHtml(JSON.stringify(filtering.get('includeGlobs', []))) +
        '</p>' +
        '<p class="muted">Exclude globs: ' +
        escapeHtml(JSON.stringify(filtering.get('excludeGlobs', []))) +
        '</p>' +
        '</section>' +
        '<section><h2>Tag Counts</h2><table><thead><tr><th>Tag</th><th>Count</th></tr></thead><tbody>' +
        rows +
        '</tbody></table></section>' +
        '</main><script nonce="' +
        nonce +
        '">' +
        'const vscode=acquireVsCodeApi();' +
        'function post(message){vscode.postMessage(message);}' +
        'document.querySelectorAll("select[data-command]").forEach(function(el){el.addEventListener("change",function(){post({command:el.dataset.command,value:el.value});});});' +
        'document.querySelectorAll("button[data-command]").forEach(function(el){el.addEventListener("click",function(){const source=el.dataset.valueSource;post({command:el.dataset.command,value:source?document.getElementById(source).value:undefined});});});' +
        '</script></body></html>'
    );
}

function collectTrendData(context: vscode.ExtensionContext, provider: CountProvider): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;

    const root = folders[0].uri.fsPath;
    const tags = vscode.workspace.getConfiguration('todo-tree.general').get<string[]>('tags') || [
        'TODO',
        'FIXME',
        'BUG',
    ];
    const grepPattern = buildGitGrepPattern(tags);

    // Get last 10 commits with dates
    child_process.execFile(
        'git',
        ['-C', root, 'log', '--oneline', '--format=%H %aI', '-n', '10'],
        { maxBuffer: 1024 * 1024 },
        (err, stdout) => {
            if (err) return;

            const commits = parseGitLog(stdout);

            // Count TODOs at each commit using git grep
            let completed = 0;
            const trend: TrendPoint[] = [];

            commits.forEach(({ hash, date }) => {
                child_process.execFile(
                    'git',
                    ['-C', root, 'grep', '-c', '-E', grepPattern, hash, '--'],
                    { maxBuffer: 5 * 1024 * 1024 },
                    (grepErr, grepOut) => {
                        const count = !grepErr && grepOut ? countGitGrepOutput(grepOut) : 0;
                        trend.push({ date, count });
                        completed++;

                        if (completed === commits.length) {
                            completeTrendData(context, provider, trend);
                        }
                    }
                );
            });
        }
    );
}

function buildGitGrepPattern(tags: string[]): string {
    return tags.map(escapeRegexTag).join('|');
}

function escapeRegexTag(tag: string): string {
    return tag.replace(/[|{}()[\]^$+*?.\\-]/g, '\\$&');
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}

function parseGitLog(stdout: string): Array<{ hash: string; date: string }> {
    return stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            const [hash, date] = line.split(' ');
            return { hash, date: date ? date.substring(0, 10) : '' };
        });
}

function countGitGrepOutput(stdout: string): number {
    return stdout
        .trim()
        .split('\n')
        .reduce((total, line) => {
            const parts = line.split(':');
            const n = parseInt(parts[parts.length - 1], 10);
            return isNaN(n) ? total : total + n;
        }, 0);
}

function completeTrendData(
    context: vscode.ExtensionContext,
    provider: CountProvider,
    trend: TrendPoint[],
    targetPanel: DashboardPanelLike | undefined = panel,
    render: (context: vscode.ExtensionContext, provider: CountProvider) => string = html
): void {
    const sortedTrend = trend.slice().sort((a, b) => a.date.localeCompare(b.date));
    context.workspaceState.update('todoTrend', sortedTrend);
    if (targetPanel) {
        targetPanel.webview.html = render(context, provider);
    }
}

function generateTrendChart(context: vscode.ExtensionContext): string {
    const trend: TrendPoint[] = context.workspaceState.get('todoTrend') || [];
    if (trend.length < 2) return '<p class="muted">Trend data collecting... Refresh to update.</p>';

    const width = 400,
        height = 120,
        padX = 40,
        padY = 20;
    const maxCount = Math.max(...trend.map((t) => t.count), 1);
    const minCount = Math.min(...trend.map((t) => t.count));
    const range = maxCount - minCount || 1;
    const stepX = (width - padX * 2) / (trend.length - 1);

    let pathD = '';
    let dots = '';
    let labels = '';

    trend.forEach((point, i) => {
        const x = padX + i * stepX;
        const y = padY + (1 - (point.count - minCount) / range) * (height - padY * 2);
        if (i === 0) {
            pathD += 'M' + x.toFixed(1) + ',' + y.toFixed(1);
        } else {
            pathD += ' L' + x.toFixed(1) + ',' + y.toFixed(1);
        }
        dots +=
            '<circle cx="' +
            x.toFixed(1) +
            '" cy="' +
            y.toFixed(1) +
            '" r="3" fill="#36A2EB"><title>' +
            point.date +
            ': ' +
            point.count +
            '</title></circle>';
        if (i === 0 || i === trend.length - 1 || i === Math.floor(trend.length / 2)) {
            labels +=
                '<text x="' +
                x.toFixed(1) +
                '" y="' +
                (height - 2) +
                '" text-anchor="middle" font-size="9" fill="currentColor">' +
                point.date.substring(5) +
                '</text>';
        }
    });

    // Y-axis labels
    const yLabels =
        '<text x="2" y="' +
        (padY + 4) +
        '" font-size="9" fill="currentColor">' +
        maxCount +
        '</text>' +
        '<text x="2" y="' +
        (height - padY) +
        '" font-size="9" fill="currentColor">' +
        minCount +
        '</text>';

    return (
        '<svg width="' +
        width +
        '" height="' +
        height +
        '" viewBox="0 0 ' +
        width +
        ' ' +
        height +
        '">' +
        '<path d="' +
        pathD +
        '" fill="none" stroke="#36A2EB" stroke-width="2" opacity="0.9"/>' +
        dots +
        labels +
        yLabels +
        '</svg>'
    );
}

const CHART_COLORS = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#C9CBCF', '#7BC8A4'];

function generatePieChart(counts: Record<string, number>): string {
    const entries = Object.entries(counts).filter(([, v]) => v > 0);
    const total = entries.reduce((s, [, v]) => s + v, 0);
    if (total === 0) return '<p class="muted">No data</p>';

    const cx = 80,
        cy = 80,
        r = 70;
    let startAngle = -Math.PI / 2;
    let paths = '';
    let legend = '<div class="legend">';

    entries.forEach(([tag, count], i) => {
        const slice = (count / total) * 2 * Math.PI;
        const endAngle = startAngle + slice;
        const largeArc = slice > Math.PI ? 1 : 0;
        const x1 = cx + r * Math.cos(startAngle);
        const y1 = cy + r * Math.sin(startAngle);
        const x2 = cx + r * Math.cos(endAngle);
        const y2 = cy + r * Math.sin(endAngle);
        const color = CHART_COLORS[i % CHART_COLORS.length];

        paths +=
            '<path d="M' +
            cx +
            ',' +
            cy +
            ' L' +
            x1.toFixed(2) +
            ',' +
            y1.toFixed(2) +
            ' A' +
            r +
            ',' +
            r +
            ' 0 ' +
            largeArc +
            ',1 ' +
            x2.toFixed(2) +
            ',' +
            y2.toFixed(2) +
            ' Z" fill="' +
            color +
            '" opacity="0.85"><title>' +
            escapeHtml(tag) +
            ': ' +
            count +
            '</title></path>';
        legend +=
            '<span class="legend-item"><span class="legend-dot" style="background:' +
            color +
            '"></span>' +
            escapeHtml(tag) +
            ' (' +
            Math.round((count / total) * 100) +
            '%)</span>';
        startAngle = endAngle;
    });

    legend += '</div>';
    return '<svg width="160" height="160" viewBox="0 0 160 160">' + paths + '</svg>' + legend;
}

function generateBarChart(counts: Record<string, number>): string {
    const entries = Object.entries(counts).filter(([, v]) => v > 0);
    if (entries.length === 0) return '<p class="muted">No data</p>';

    const max = Math.max(...entries.map(([, v]) => v));
    const barWidth = 36,
        gap = 8,
        chartHeight = 120,
        labelHeight = 20;
    const svgWidth = entries.length * (barWidth + gap);
    let bars = '';

    entries.forEach(([tag, count], i) => {
        const barHeight = max > 0 ? (count / max) * (chartHeight - labelHeight) : 0;
        const x = i * (barWidth + gap);
        const y = chartHeight - labelHeight - barHeight;
        const color = CHART_COLORS[i % CHART_COLORS.length];

        bars +=
            '<rect x="' +
            x +
            '" y="' +
            y.toFixed(1) +
            '" width="' +
            barWidth +
            '" height="' +
            barHeight.toFixed(1) +
            '" fill="' +
            color +
            '" opacity="0.85"><title>' +
            escapeHtml(tag) +
            ': ' +
            count +
            '</title></rect>';
        bars +=
            '<text x="' +
            (x + barWidth / 2) +
            '" y="' +
            (y - 4).toFixed(1) +
            '" text-anchor="middle" font-size="10" fill="currentColor">' +
            count +
            '</text>';
        bars +=
            '<text x="' +
            (x + barWidth / 2) +
            '" y="' +
            (chartHeight - 4) +
            '" text-anchor="middle" font-size="9" fill="currentColor">' +
            escapeHtml(tag.substring(0, 5)) +
            '</text>';
    });

    return (
        '<svg width="' +
        svgWidth +
        '" height="' +
        chartHeight +
        '" viewBox="0 0 ' +
        svgWidth +
        ' ' +
        chartHeight +
        '">' +
        bars +
        '</svg>'
    );
}

function metric(label: string, value: unknown): string {
    return (
        '<div class="metric"><span class="muted">' +
        escapeHtml(label) +
        '</span><strong>' +
        escapeHtml(String(value)) +
        '</strong></div>'
    );
}

function selectControl(label: string, command: string, value: string, options: string[]): string {
    return (
        '<div><label>' +
        escapeHtml(label) +
        '</label><select data-command="' +
        command +
        '">' +
        options
            .map((option) => {
                return (
                    '<option value="' +
                    escapeHtml(option) +
                    '"' +
                    (option === value ? ' selected' : '') +
                    '>' +
                    escapeHtml(option) +
                    '</option>'
                );
            })
            .join('') +
        '</select></div>'
    );
}

function escapeHtml(text: unknown): string {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const __test = {
    html,
    parseGitLog,
    countGitGrepOutput,
    completeTrendData,
    buildGitGrepPattern,
};
