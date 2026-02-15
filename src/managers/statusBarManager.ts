import * as vscode from 'vscode';
import { MutagenSession, StagingProgress, formatFileSize } from '../models/session';
import { MutagenService } from '../services/mutagenService';
import { isPathInCurrentWorkspace } from '../utils/config';
import { Logger } from '../utils/logger';

interface TransferStats {
    bytesTransferred: number;
    timestamp: number;
}

type TransferDirection = 'upload' | 'download';

interface DirectionalRateState {
    lastReceivedSize: number;
    lastTimestamp: number;
    uploadRate: number;
    downloadRate: number;
    isLocalAlpha: boolean;
    hasSample: boolean;
}

export class StatusBarManager {
    private static readonly FIXED_STATUS_ICON = 'device-desktop';
    private static readonly RATE_SAMPLE_INTERVAL_MS = 500;
    private statusBarItem: vscode.StatusBarItem;
    private transferItem: vscode.StatusBarItem;
    private service: MutagenService;
    private refreshInterval: NodeJS.Timeout | null = null;
    private monitors: Map<string, { stop: () => void }> = new Map();
    private workspaceRates: Map<string, DirectionalRateState> = new Map();
    private workspaceSessionIds: Set<string> = new Set();
    private sessionCache: Map<string, MutagenSession> = new Map();
    private lastStats: Map<string, TransferStats> = new Map();
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
            this.stopWorkspaceMonitoring();
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

        this.cacheSessions(sessions);

        if (sessions.length === 0) {
            this.stopWorkspaceMonitoring();
            this.setStatusText('No sessions');
            this.statusBarItem.tooltip = 'No sync sessions active';
            this.transferItem.hide();
            return;
        }

        const workspaceSessions = sessions.filter(session => this.isSessionInCurrentWorkspace(session));
        if (workspaceSessions.length > 0) {
            this.ensureWorkspaceMonitoring(workspaceSessions);
            this.normalizeWorkspaceRates(workspaceSessions);
            this.updateWorkspaceStatus(workspaceSessions);
            return;
        }

        this.stopWorkspaceMonitoring();
        this.updateGlobalStatus(sessions);
    }

    private updateGlobalStatus(sessions: MutagenSession[]): void {
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

        let statusText = '';

        if (errorSessions.length > 0) {
            statusText = `${errorSessions.length} error${errorSessions.length > 1 ? 's' : ''}`;
        } else if (syncingSessions.length > 0) {
            statusText = `Syncing ${syncingSessions.length}`;
        } else if (activeSessions.length > 0) {
            statusText = `${activeSessions.length} watching`;
        } else {
            statusText = `${pausedSessions.length} paused`;
        }

        this.setStatusText(statusText);

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

    private updateWorkspaceStatus(sessions: MutagenSession[]): void {
        const activeSessions = sessions.filter(s => !s.paused);
        const pausedSessions = sessions.filter(s => s.paused);
        const errorSessions = sessions.filter(s =>
            s.lastError ||
            s.status.startsWith('halted')
        );

        const { uploadRate, downloadRate } = this.aggregateWorkspaceRates(sessions);

        if (errorSessions.length > 0) {
            this.setStatusText(`${errorSessions.length} error${errorSessions.length > 1 ? 's' : ''}`);
        } else if (activeSessions.length === 0 && pausedSessions.length > 0) {
            this.setStatusText(`${pausedSessions.length} paused`);
        } else {
            this.setStatusText(`↑${formatFileSize(uploadRate)}/s ↓${formatFileSize(downloadRate)}/s`);
        }

        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown('**Mutagen Sync Status (Current Workspace)**\n\n');
        tooltip.appendMarkdown(`- Sessions: ${sessions.length}\n`);
        tooltip.appendMarkdown(`- Active: ${activeSessions.length}\n`);
        tooltip.appendMarkdown(`- Paused: ${pausedSessions.length}\n`);
        tooltip.appendMarkdown(`- Errors: ${errorSessions.length}\n`);
        tooltip.appendMarkdown(`- Upload: ${formatFileSize(uploadRate)}/s\n`);
        tooltip.appendMarkdown(`- Download: ${formatFileSize(downloadRate)}/s\n`);
        tooltip.appendMarkdown('\n*Current window sessions only. Click to show logs*');
        this.statusBarItem.tooltip = tooltip;

        // Current workspace mode renders transfer directly in the main status item.
        this.transferItem.hide();
    }

    private ensureWorkspaceMonitoring(sessions: MutagenSession[]): void {
        const targetSessionIds = new Set(sessions.map(session => session.identifier));

        for (const [identifier, monitor] of this.monitors) {
            if (targetSessionIds.has(identifier)) {
                continue;
            }

            monitor.stop();
            this.monitors.delete(identifier);
            this.workspaceRates.delete(identifier);
        }

        for (const session of sessions) {
            const existingRate = this.workspaceRates.get(session.identifier);
            if (existingRate) {
                existingRate.isLocalAlpha = this.isLocalAlpha(session);
                this.workspaceRates.set(session.identifier, existingRate);
            } else {
                this.workspaceRates.set(session.identifier, this.createRateState(session));
            }

            if (this.monitors.has(session.identifier)) {
                continue;
            }

            const monitor = this.service.startMonitor(
                session.identifier,
                (updatedSession) => this.handleWorkspaceMonitorUpdate(updatedSession),
                (error) => {
                    Logger.warn(`Monitor error for session ${session.identifier}: ${error.message}`);
                    this.monitors.delete(session.identifier);
                    const state = this.workspaceRates.get(session.identifier);
                    if (state) {
                        state.uploadRate = 0;
                        state.downloadRate = 0;
                        this.workspaceRates.set(session.identifier, state);
                    }
                }
            );

            this.monitors.set(session.identifier, monitor);
        }

        this.workspaceSessionIds = targetSessionIds;
    }

    private handleWorkspaceMonitorUpdate(session: MutagenSession): void {
        if (!this.workspaceSessionIds.has(session.identifier)) {
            return;
        }

        this.sessionCache.set(session.identifier, session);
        this.updateWorkspaceRateFromMonitor(session);

        const workspaceSessions = this.getWorkspaceSessionsFromCache();
        if (workspaceSessions.length > 0) {
            this.updateWorkspaceStatus(workspaceSessions);
        }
    }

    private updateWorkspaceRateFromMonitor(session: MutagenSession): void {
        const now = Date.now();
        const currentReceivedSize = this.getStagingReceivedSize(session);
        const rateState = this.workspaceRates.get(session.identifier) ?? this.createRateState(session);
        rateState.isLocalAlpha = this.isLocalAlpha(session);

        if (typeof currentReceivedSize !== 'number' || !Number.isFinite(currentReceivedSize)) {
            rateState.uploadRate = 0;
            rateState.downloadRate = 0;
            rateState.lastTimestamp = now;
            this.workspaceRates.set(session.identifier, rateState);
            return;
        }

        const direction = this.resolveTransferDirection(session, rateState.isLocalAlpha);
        if (!direction) {
            rateState.uploadRate = 0;
            rateState.downloadRate = 0;
            rateState.lastReceivedSize = currentReceivedSize;
            rateState.lastTimestamp = now;
            rateState.hasSample = true;
            this.workspaceRates.set(session.identifier, rateState);
            return;
        }

        if (!rateState.hasSample) {
            rateState.lastReceivedSize = currentReceivedSize;
            rateState.lastTimestamp = now;
            rateState.uploadRate = 0;
            rateState.downloadRate = 0;
            rateState.hasSample = true;
            this.workspaceRates.set(session.identifier, rateState);
            return;
        }

        const elapsedMilliseconds = now - rateState.lastTimestamp;
        if (elapsedMilliseconds < StatusBarManager.RATE_SAMPLE_INTERVAL_MS) {
            this.workspaceRates.set(session.identifier, rateState);
            return;
        }

        const elapsedSeconds = elapsedMilliseconds / 1000;
        const transferredBytes = currentReceivedSize - rateState.lastReceivedSize;
        const currentRate = elapsedSeconds > 0 ? Math.max(0, transferredBytes / elapsedSeconds) : 0;

        rateState.uploadRate = direction === 'upload' ? currentRate : 0;
        rateState.downloadRate = direction === 'download' ? currentRate : 0;
        rateState.lastReceivedSize = currentReceivedSize;
        rateState.lastTimestamp = now;
        rateState.hasSample = true;

        this.workspaceRates.set(session.identifier, rateState);
    }

    private normalizeWorkspaceRates(sessions: MutagenSession[]): void {
        const now = Date.now();

        for (const session of sessions) {
            const existing = this.workspaceRates.get(session.identifier) ?? this.createRateState(session);
            const direction = this.resolveTransferDirection(session, existing.isLocalAlpha);
            const currentReceivedSize = this.getStagingReceivedSize(session);

            if (!direction) {
                existing.uploadRate = 0;
                existing.downloadRate = 0;
            }

            if (typeof currentReceivedSize === 'number') {
                if (!existing.hasSample || currentReceivedSize < existing.lastReceivedSize) {
                    existing.lastReceivedSize = currentReceivedSize;
                    existing.lastTimestamp = now;
                    existing.hasSample = true;
                }
            }

            this.workspaceRates.set(session.identifier, existing);
        }
    }

    private aggregateWorkspaceRates(sessions: MutagenSession[]): { uploadRate: number; downloadRate: number } {
        let uploadRate = 0;
        let downloadRate = 0;

        for (const session of sessions) {
            const rate = this.workspaceRates.get(session.identifier);
            if (!rate) {
                continue;
            }

            uploadRate += rate.uploadRate;
            downloadRate += rate.downloadRate;
        }

        return { uploadRate, downloadRate };
    }

    private createRateState(session: MutagenSession): DirectionalRateState {
        const receivedSize = this.getStagingReceivedSize(session) ?? 0;

        return {
            lastReceivedSize: receivedSize,
            lastTimestamp: Date.now(),
            uploadRate: 0,
            downloadRate: 0,
            isLocalAlpha: this.isLocalAlpha(session),
            hasSample: receivedSize > 0
        };
    }

    private resolveTransferDirection(session: MutagenSession, isLocalAlpha: boolean): TransferDirection | null {
        if (session.status === 'staging-alpha') {
            return isLocalAlpha ? 'upload' : 'download';
        }

        if (session.status === 'staging-beta') {
            return isLocalAlpha ? 'download' : 'upload';
        }

        if (session.alpha.stagingProgress && !session.beta.stagingProgress) {
            return isLocalAlpha ? 'upload' : 'download';
        }

        if (session.beta.stagingProgress && !session.alpha.stagingProgress) {
            return isLocalAlpha ? 'download' : 'upload';
        }

        return null;
    }

    private isSessionInCurrentWorkspace(session: MutagenSession): boolean {
        const localPath = this.getLocalPath(session);
        if (!localPath) {
            return false;
        }

        return isPathInCurrentWorkspace(localPath);
    }

    private getLocalPath(session: MutagenSession): string | null {
        if (session.alpha.protocol === 'local') {
            return session.alpha.path;
        }

        if (session.beta.protocol === 'local') {
            return session.beta.path;
        }

        return null;
    }

    private isLocalAlpha(session: MutagenSession): boolean {
        if (session.alpha.protocol === 'local' && session.beta.protocol !== 'local') {
            return true;
        }

        if (session.beta.protocol === 'local' && session.alpha.protocol !== 'local') {
            return false;
        }

        return session.alpha.protocol === 'local';
    }

    private getWorkspaceSessionsFromCache(): MutagenSession[] {
        const workspaceSessions: MutagenSession[] = [];

        for (const identifier of this.workspaceSessionIds) {
            const session = this.sessionCache.get(identifier);
            if (session) {
                workspaceSessions.push(session);
            }
        }

        return workspaceSessions;
    }

    private cacheSessions(sessions: MutagenSession[]): void {
        this.sessionCache.clear();
        for (const session of sessions) {
            this.sessionCache.set(session.identifier, session);
        }
    }

    private stopWorkspaceMonitoring(): void {
        for (const monitor of this.monitors.values()) {
            monitor.stop();
        }
        this.monitors.clear();
        this.workspaceRates.clear();
        this.workspaceSessionIds.clear();
    }

    private updateTransferRate(sessions: MutagenSession[]): void {
        const syncingSessions = sessions.filter(s => this.getStagingExpectedSize(s) > 0);

        if (syncingSessions.length === 0) {
            this.transferItem.hide();
            return;
        }

        let totalRate = 0;
        const now = Date.now();

        for (const session of syncingSessions) {
            const currentBytes = this.getStagingReceivedSize(session);
            if (typeof currentBytes !== 'number') continue;

            const lastStat = this.lastStats.get(session.identifier);

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
            this.transferItem.text = `$(cloud-upload) ${formatFileSize(totalRate)}/s`;
            this.transferItem.tooltip = `Transfer rate: ${formatFileSize(totalRate)}/s`;
            this.transferItem.show();
        } else {
            this.transferItem.hide();
        }
    }

    private getSessionStagingProgress(session: MutagenSession): StagingProgress | undefined {
        if (session.status === 'staging-alpha') {
            return session.alpha.stagingProgress ?? session.stagingProgress;
        }

        if (session.status === 'staging-beta') {
            return session.beta.stagingProgress ?? session.stagingProgress;
        }

        return session.stagingProgress
            ?? session.alpha.stagingProgress
            ?? session.beta.stagingProgress;
    }

    private getStagingReceivedSize(session: MutagenSession): number | null {
        const progress = this.getSessionStagingProgress(session);
        const receivedSize = progress?.receivedSize;

        if (typeof receivedSize === 'number' && Number.isFinite(receivedSize)) {
            return receivedSize;
        }

        return null;
    }

    private getStagingExpectedSize(session: MutagenSession): number {
        const progress = this.getSessionStagingProgress(session);
        const expectedSize = progress?.expectedSize ?? progress?.totalSize;

        if (typeof expectedSize === 'number' && Number.isFinite(expectedSize) && expectedSize > 0) {
            return expectedSize;
        }

        return 0;
    }

    showSyncing(sessionName: string): void {
        if (!this.enabled) return;
        this.setStatusText(`Syncing ${sessionName}...`);
    }

    showError(message: string): void {
        if (!this.enabled) return;
        this.setStatusText(message);
        this.statusBarItem.tooltip = message;
    }

    showMessage(message: string, _icon = 'info'): void {
        if (!this.enabled) return;
        this.setStatusText(message);
    }

    private setStatusText(message: string): void {
        this.statusBarItem.text = `$(${StatusBarManager.FIXED_STATUS_ICON}) Mutagen: ${message}`;
    }

    dispose(): void {
        this.stopAutoRefresh();
        this.stopWorkspaceMonitoring();
    }
}
