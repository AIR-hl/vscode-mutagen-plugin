import * as vscode from 'vscode';
import { MutagenSession, formatFileSize, getStatusLabel } from '../models/session';

export class SessionDetailsPanel {
    public static currentPanel: SessionDetailsPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private session: MutagenSession;
    private disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, session: MutagenSession) {
        this.panel = panel;
        this.session = session;

        this.update();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    public static show(extensionUri: vscode.Uri, session: MutagenSession): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (SessionDetailsPanel.currentPanel) {
            SessionDetailsPanel.currentPanel.session = session;
            SessionDetailsPanel.currentPanel.update();
            SessionDetailsPanel.currentPanel.panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'mutagenSessionDetails',
            `Mutagen: ${session.name}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        SessionDetailsPanel.currentPanel = new SessionDetailsPanel(panel, session);
    }

    public updateSession(session: MutagenSession): void {
        this.session = session;
        this.update();
    }

    private update(): void {
        this.panel.title = `Mutagen: ${this.session.name}`;
        this.panel.webview.html = this.getHtmlContent();
    }

    private getHtmlContent(): string {
        const session = this.session;
        const isAlphaLocal = session.alpha.protocol === 'local';
        const local = isAlphaLocal ? session.alpha : session.beta;
        const remote = isAlphaLocal ? session.beta : session.alpha;
        const localFiles = typeof local.files === 'number' ? local.files : 0;
        const localDirectories = typeof local.directories === 'number' ? local.directories : 0;
        const localTotalSize = typeof local.totalFileSize === 'number' ? local.totalFileSize : 0;
        const successfulCycles = typeof session.successfulCycles === 'number' ? session.successfulCycles : 0;

        const statusClass = session.paused ? 'paused' : 
            session.status === 'watching' ? 'active' : 
            session.lastError ? 'error' : 'syncing';

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Session Details</title>
    <style>
        :root {
            --vscode-font-family: var(--vscode-editor-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
        }
        body {
            font-family: var(--vscode-font-family);
            padding: 20px;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
        }
        .header {
            display: flex;
            align-items: center;
            gap: 12px;
            margin-bottom: 24px;
            padding-bottom: 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .status-badge {
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 500;
        }
        .status-badge.active { background: var(--vscode-testing-iconPassed); color: white; }
        .status-badge.paused { background: var(--vscode-testing-iconQueued); color: white; }
        .status-badge.syncing { background: var(--vscode-testing-iconUnset); color: white; }
        .status-badge.error { background: var(--vscode-testing-iconFailed); color: white; }
        h1 {
            margin: 0;
            font-size: 24px;
            font-weight: 600;
        }
        .section {
            margin-bottom: 24px;
        }
        .section-title {
            font-size: 14px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .card {
            background: var(--vscode-input-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 8px;
            padding: 16px;
        }
        .endpoint {
            display: flex;
            align-items: flex-start;
            gap: 12px;
            padding: 12px;
            background: var(--vscode-editor-background);
            border-radius: 6px;
            margin-bottom: 8px;
        }
        .endpoint:last-child { margin-bottom: 0; }
        .endpoint-icon {
            font-size: 24px;
            width: 32px;
            text-align: center;
        }
        .endpoint-info { flex: 1; }
        .endpoint-label {
            font-weight: 500;
            margin-bottom: 4px;
        }
        .endpoint-path {
            font-family: var(--vscode-editor-font-family);
            font-size: 13px;
            color: var(--vscode-descriptionForeground);
            word-break: break-all;
        }
        .endpoint-status {
            font-size: 12px;
            padding: 2px 8px;
            border-radius: 4px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 12px;
        }
        .stat-item {
            background: var(--vscode-editor-background);
            padding: 12px;
            border-radius: 6px;
            text-align: center;
        }
        .stat-value {
            font-size: 24px;
            font-weight: 600;
            margin-bottom: 4px;
        }
        .stat-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        .config-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .config-item {
            display: flex;
            justify-content: space-between;
            padding: 8px 12px;
            background: var(--vscode-editor-background);
            border-radius: 4px;
        }
        .config-key {
            color: var(--vscode-descriptionForeground);
        }
        .config-value {
            font-family: var(--vscode-editor-font-family);
        }
        .error-box {
            background: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder);
            border-radius: 6px;
            padding: 12px;
            margin-top: 12px;
        }
        .error-title {
            font-weight: 500;
            margin-bottom: 8px;
            color: var(--vscode-errorForeground);
        }
        .conflict-item {
            background: var(--vscode-inputValidation-warningBackground);
            border: 1px solid var(--vscode-inputValidation-warningBorder);
            border-radius: 4px;
            padding: 8px;
            margin-top: 8px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>${this.escapeHtml(session.name)}</h1>
        <span class="status-badge ${statusClass}">${getStatusLabel(session.status, session.paused)}</span>
    </div>

    <div class="section">
        <div class="section-title">Endpoints</div>
        <div class="card">
            <div class="endpoint">
                <div class="endpoint-icon">📁</div>
                <div class="endpoint-info">
                    <div class="endpoint-label">Alpha${isAlphaLocal ? ' (Local)' : ''}</div>
                    <div class="endpoint-path">${this.escapeHtml(session.alpha.path)}${session.alpha.host ? ` @ ${this.escapeHtml(session.alpha.host)}` : ''}</div>
                </div>
                <span class="endpoint-status">${session.alpha.connected ? '✓ Connected' : '✗ Disconnected'}</span>
            </div>
            <div class="endpoint">
                <div class="endpoint-icon">🌐</div>
                <div class="endpoint-info">
                    <div class="endpoint-label">Beta${!isAlphaLocal ? ' (Local)' : ''} ${remote.host ? `(${this.escapeHtml(remote.host)})` : ''}</div>
                    <div class="endpoint-path">${this.escapeHtml(session.beta.path)}</div>
                </div>
                <span class="endpoint-status">${session.beta.connected ? '✓ Connected' : '✗ Disconnected'}</span>
            </div>
            <p style="margin: 12px 0 0; font-size: 12px; color: var(--vscode-descriptionForeground);">Alpha/Beta are Mutagen endpoint names. In two-way-resolved mode, Alpha wins conflicts.</p>
        </div>
    </div>

    <div class="section">
        <div class="section-title">Statistics</div>
        <div class="stats-grid">
            <div class="stat-item">
                <div class="stat-value">${localFiles.toLocaleString()}</div>
                <div class="stat-label">Files</div>
            </div>
            <div class="stat-item">
                <div class="stat-value">${localDirectories.toLocaleString()}</div>
                <div class="stat-label">Directories</div>
            </div>
            <div class="stat-item">
                <div class="stat-value">${formatFileSize(localTotalSize)}</div>
                <div class="stat-label">Total Size</div>
            </div>
            <div class="stat-item">
                <div class="stat-value">${successfulCycles}</div>
                <div class="stat-label">Sync Cycles</div>
            </div>
        </div>
    </div>

    <div class="section">
        <div class="section-title">Configuration</div>
        <div class="card">
            <div class="config-list">
                <div class="config-item">
                    <span class="config-key">Session ID</span>
                    <span class="config-value">${session.identifier.substring(0, 20)}...</span>
                </div>
                <div class="config-item">
                    <span class="config-key">Version</span>
                    <span class="config-value">${session.creatingVersion}</span>
                </div>
                <div class="config-item">
                    <span class="config-key">Created</span>
                    <span class="config-value">${new Date(session.creationTime).toLocaleString()}</span>
                </div>
                <div class="config-item">
                    <span class="config-key">Symlink Mode</span>
                    <span class="config-value">${session.symlink.mode || 'default'}</span>
                </div>
                <div class="config-item">
                    <span class="config-key">Watch Mode</span>
                    <span class="config-value">${session.watch.mode || 'portable'}</span>
                </div>
                ${session.ignore.paths && session.ignore.paths.length > 0 ? `
                <div class="config-item">
                    <span class="config-key">Ignore Paths</span>
                    <span class="config-value">${session.ignore.paths.join(', ')}</span>
                </div>
                ` : ''}
            </div>
        </div>
    </div>

    ${session.lastError ? `
    <div class="section">
        <div class="section-title">Errors</div>
        <div class="error-box">
            <div class="error-title">Last Error</div>
            <div>${this.escapeHtml(session.lastError)}</div>
        </div>
    </div>
    ` : ''}

    ${session.conflicts && session.conflicts.length > 0 ? `
    <div class="section">
        <div class="section-title">Conflicts (${session.conflicts.length})</div>
        <div class="card">
            ${session.conflicts.map(c => `
                <div class="conflict-item">
                    <strong>${this.escapeHtml(c.root)}</strong>
                </div>
            `).join('')}
        </div>
    </div>
    ` : ''}
</body>
</html>`;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    private dispose(): void {
        SessionDetailsPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const x = this.disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}
