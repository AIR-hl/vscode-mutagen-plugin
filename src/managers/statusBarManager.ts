import * as vscode from 'vscode';
import { MutagenSession, getStatusIcon, getStatusLabel, formatFileSize } from '../models/session';
import { MutagenService } from '../services/mutagenService';

interface TransferStats {
    bytesTransferred: number;
    timestamp: number;
}

export class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;
    private transferItem: vscode.StatusBarItem;
    private service: MutagenService;
    private refreshInterval: NodeJS.Timeout | null = null;
    private monitors: Map<string, { stop: () => void }> = new Map();
    private lastStats: Map<string, TransferStats> = new Map();
    private currentTransferRate = 0;
    private enabled = true;

    constructor(context: vscode.ExtensionContext) {
        this.service = MutagenService.getInstance();

        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.statusBarItem.command = 'mutagen.showLogs';
        context.subscriptions.push(this.statusBarItem);

        this.transferItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            99
        );
        this.transferItem.command = 'mutagen.refresh';
        context.subscriptions.push(this.transferItem);

        this.updateConfig();
    }

    updateConfig(): void {
        const config = vscode.workspace.getConfiguration('mutagen');
        this.enabled = config.get<boolean>('showStatusBar', true);

        if (this.enabled) {
            this.statusBarItem.show();
        } else {
            this.statusBarItem.hide();
            this.transferItem.hide();
        }
    }

    startAutoRefresh(onRefresh: () => void): void {
        this.stopAutoRefresh();

        const config = vscode.workspace.getConfiguration('mutagen');
        const interval = config.get<number>('refreshInterval', 5000);

        this.refreshInterval = setInterval(() => {
            onRefresh();
        }, interval);
    }

    stopAutoRefresh(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
    }

    updateStatus(sessions: MutagenSession[]): void {
        if (!this.enabled) {
            return;
        }

        if (sessions.length === 0) {
            this.statusBarItem.text = '$(sync) Mutagen: No sessions';
            this.statusBarItem.tooltip = 'No sync sessions active';
            this.transferItem.hide();
            return;
        }

        const activeSessions = sessions.filter(s => !s.paused);
        const pausedSessions = sessions.filter(s => s.paused);
        const syncingSessions = sessions.filter(s => 
            s.status === 'staging-alpha' || 
            s.status === 'staging-beta' || 
            s.status === 'transitioning'
        );
        const errorSessions = sessions.filter(s => 
            s.lastError || 
            s.status.startsWith('halted')
        );

        let icon = 'sync';
        let statusText = '';

        if (errorSessions.length > 0) {
            icon = 'error';
            statusText = `${errorSessions.length} error${errorSessions.length > 1 ? 's' : ''}`;
        } else if (syncingSessions.length > 0) {
            icon = 'sync~spin';
            statusText = `Syncing ${syncingSessions.length}`;
        } else if (activeSessions.length > 0) {
            icon = 'vm-running';
            statusText = `${activeSessions.length} watching`;
        } else {
            icon = 'debug-pause';
            statusText = `${pausedSessions.length} paused`;
        }

        this.statusBarItem.text = `$(${icon}) Mutagen: ${statusText}`;

        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown('**Mutagen Sync Status**\n\n');
        tooltip.appendMarkdown(`- Active: ${activeSessions.length}\n`);
        tooltip.appendMarkdown(`- Paused: ${pausedSessions.length}\n`);
        tooltip.appendMarkdown(`- Syncing: ${syncingSessions.length}\n`);
        if (errorSessions.length > 0) {
            tooltip.appendMarkdown(`- Errors: ${errorSessions.length}\n`);
        }
        tooltip.appendMarkdown('\n*Click to show logs*');
        this.statusBarItem.tooltip = tooltip;

        this.updateTransferRate(sessions);
    }

    private updateTransferRate(sessions: MutagenSession[]): void {
        const syncingSessions = sessions.filter(s => 
            s.stagingProgress && s.stagingProgress.totalSize > 0
        );

        if (syncingSessions.length === 0) {
            this.transferItem.hide();
            return;
        }

        let totalRate = 0;
        const now = Date.now();

        for (const session of syncingSessions) {
            if (!session.stagingProgress) continue;

            const lastStat = this.lastStats.get(session.identifier);
            const currentBytes = session.stagingProgress.receivedSize;

            if (lastStat) {
                const timeDiff = (now - lastStat.timestamp) / 1000;
                if (timeDiff > 0) {
                    const bytesDiff = currentBytes - lastStat.bytesTransferred;
                    totalRate += Math.max(0, bytesDiff / timeDiff);
                }
            }

            this.lastStats.set(session.identifier, {
                bytesTransferred: currentBytes,
                timestamp: now
            });
        }

        if (totalRate > 0) {
            this.currentTransferRate = totalRate;
            this.transferItem.text = `$(cloud-upload) ${formatFileSize(totalRate)}/s`;
            this.transferItem.tooltip = `Transfer rate: ${formatFileSize(totalRate)}/s`;
            this.transferItem.show();
        } else {
            this.transferItem.hide();
        }
    }

    showSyncing(sessionName: string): void {
        if (!this.enabled) return;
        this.statusBarItem.text = `$(sync~spin) Mutagen: Syncing ${sessionName}...`;
    }

    showError(message: string): void {
        if (!this.enabled) return;
        this.statusBarItem.text = `$(error) Mutagen: ${message}`;
        this.statusBarItem.tooltip = message;
    }

    showMessage(message: string, icon = 'info'): void {
        if (!this.enabled) return;
        this.statusBarItem.text = `$(${icon}) Mutagen: ${message}`;
    }

    dispose(): void {
        this.stopAutoRefresh();
        for (const monitor of this.monitors.values()) {
            monitor.stop();
        }
        this.monitors.clear();
    }
}
