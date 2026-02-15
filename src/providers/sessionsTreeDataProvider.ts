import * as vscode from 'vscode';
import * as path from 'path';
import {
    Conflict,
    MutagenSession,
    formatFileSize,
    getStatusIcon,
    getStatusLabel,
    toSessionSummary
} from '../models/session';
import { MutagenService } from '../services/mutagenService';
import { isPathInCurrentWorkspace } from '../utils/config';
import { Logger } from '../utils/logger';

export type TreeItemType =
    | 'session'
    | 'endpoint'
    | 'info'
    | 'error'
    | 'loading'
    | 'conflicts-group'
    | 'conflict-file';

export class SessionTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType: TreeItemType,
        public readonly session?: MutagenSession,
        public readonly parent?: SessionTreeItem,
        itemId?: string,
        public readonly conflict?: Conflict
    ) {
        super(label, collapsibleState);
        // VSCode uses `id` to preserve expand/collapse state across refreshes
        if (itemId) {
            this.id = itemId;
        }
    }
}

export class SessionsTreeDataProvider implements vscode.TreeDataProvider<SessionTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private sessions: MutagenSession[] = [];
    private sessionMap = new Map<string, MutagenSession>();
    private service: MutagenService;
    private isLoading = false;
    private lastError: string | null = null;

    constructor() {
        this.service = MutagenService.getInstance();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    async loadSessions(): Promise<void> {
        if (this.isLoading) {
            return;
        }

        this.isLoading = true;
        this.lastError = null;

        try {
            const newSessions = await this.service.listSessions();
            const hasChanges = this.detectChanges(newSessions);

            if (hasChanges) {
                this.sessions = newSessions;
                this.updateSessionMap(newSessions);
                this.refresh();
                Logger.debug(`Loaded ${this.sessions.length} sessions (changed)`);
            } else {
                Logger.debug(`Loaded ${newSessions.length} sessions (no changes)`);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (this.lastError !== message) {
                this.lastError = message;
                this.refresh();
            }
            Logger.error(`Failed to load sessions: ${message}`);
        } finally {
            this.isLoading = false;
        }
    }

    private updateSessionMap(sessions: MutagenSession[]): void {
        this.sessionMap.clear();
        for (const session of sessions) {
            this.sessionMap.set(session.identifier, session);
        }
    }

    private detectChanges(newSessions: MutagenSession[]): boolean {
        if (newSessions.length !== this.sessions.length) {
            return true;
        }

        for (const newSession of newSessions) {
            const oldSession = this.sessionMap.get(newSession.identifier);
            if (!oldSession || this.sessionChanged(oldSession, newSession)) {
                return true;
            }
        }

        return false;
    }

    private sessionChanged(oldSession: MutagenSession, newSession: MutagenSession): boolean {
        const oldStagingReceived = oldSession.stagingProgress?.receivedSize
            ?? oldSession.alpha.stagingProgress?.receivedSize
            ?? oldSession.beta.stagingProgress?.receivedSize
            ?? 0;
        const newStagingReceived = newSession.stagingProgress?.receivedSize
            ?? newSession.alpha.stagingProgress?.receivedSize
            ?? newSession.beta.stagingProgress?.receivedSize
            ?? 0;

        return (
            oldSession.status !== newSession.status ||
            oldSession.paused !== newSession.paused ||
            oldSession.successfulCycles !== newSession.successfulCycles ||
            oldSession.lastError !== newSession.lastError ||
            oldSession.alpha.connected !== newSession.alpha.connected ||
            oldSession.beta.connected !== newSession.beta.connected ||
            this.getConflictFingerprint(oldSession) !== this.getConflictFingerprint(newSession) ||
            oldStagingReceived !== newStagingReceived
        );
    }

    private getConflictFingerprint(session: MutagenSession): string {
        const conflicts = session.conflicts ?? [];
        return conflicts
            .map(conflict => {
                const serializeChanges = (changes: Conflict['alphaChanges']): string[] =>
                    (changes ?? [])
                        .map(change => {
                            const oldEntry = change.old ? JSON.stringify(change.old) : 'null';
                            const newEntry = change.new ? JSON.stringify(change.new) : 'null';
                            return `${change.path}:${oldEntry}:${newEntry}`;
                        })
                        .sort();

                return JSON.stringify({
                    root: conflict.root,
                    alphaChanges: serializeChanges(conflict.alphaChanges),
                    betaChanges: serializeChanges(conflict.betaChanges)
                });
            })
            .sort()
            .join('|');
    }

    getSessions(): MutagenSession[] {
        return this.sessions;
    }

    getSessionById(id: string): MutagenSession | undefined {
        return this.sessions.find(s => s.identifier === id || s.name === id);
    }

    getTreeItem(element: SessionTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SessionTreeItem): Promise<SessionTreeItem[]> {
        if (!element) {
            return this.getRootItems();
        }

        if (element.itemType === 'session' && element.session) {
            return this.getSessionDetails(element.session, element);
        }

        if (element.itemType === 'conflicts-group' && element.session) {
            return this.getConflictItems(element.session, element);
        }

        return [];
    }

    private getRootItems(): SessionTreeItem[] {
        if (this.isLoading) {
            const loading = new SessionTreeItem(
                'Loading...',
                vscode.TreeItemCollapsibleState.None,
                'loading',
                undefined,
                undefined,
                'loading-indicator'
            );
            loading.iconPath = new vscode.ThemeIcon('sync~spin');
            return [loading];
        }

        if (this.lastError) {
            const error = new SessionTreeItem(
                `Error: ${this.lastError}`,
                vscode.TreeItemCollapsibleState.None,
                'error',
                undefined,
                undefined,
                'error-indicator'
            );
            error.iconPath = new vscode.ThemeIcon('error');
            error.tooltip = this.lastError;
            return [error];
        }

        if (this.sessions.length === 0) {
            return [];
        }

        return this.sessions.map(session => this.createSessionItem(session));
    }

    private createSessionItem(session: MutagenSession): SessionTreeItem {
        const summary = toSessionSummary(session);
        const displayName = summary.name;
        const isInCurrentWorkspace = isPathInCurrentWorkspace(summary.localPath);

        const item = new SessionTreeItem(
            displayName,
            vscode.TreeItemCollapsibleState.Collapsed,
            'session',
            session,
            undefined,
            `session-${session.identifier}`
        );

        const statusLabel = getStatusLabel(session.status, session.paused);

        item.iconPath = new vscode.ThemeIcon('vm');

        const remoteInfo = summary.remoteHost || path.basename(summary.remotePath);
        item.description = remoteInfo;

        const localPath = summary.localPath;
        const remotePart = summary.remoteHost
            ? `${summary.remoteHost}:${summary.remotePath}`
            : summary.remotePath;

        item.tooltip = new vscode.MarkdownString();
        item.tooltip.appendMarkdown(`**${displayName}**\n\n`);
        item.tooltip.appendMarkdown(`- **Status:** ${statusLabel}\n`);
        item.tooltip.appendMarkdown(`- **Local:** \`${localPath}\`\n`);
        item.tooltip.appendMarkdown(`- **Remote:** \`${remotePart}\`\n`);
        item.tooltip.appendMarkdown(`- **Files:** ${summary.fileCount.toLocaleString()}\n`);
        item.tooltip.appendMarkdown(`- **Size:** ${formatFileSize(summary.totalSize)}\n`);

        if (summary.hasErrors) {
            item.tooltip.appendMarkdown('\n⚠️ **Has Errors**\n');
        }
        if (summary.hasConflicts) {
            item.tooltip.appendMarkdown('\n⚡ **Has Conflicts**\n');
        }

        if (isInCurrentWorkspace) {
            item.contextValue = session.paused ? 'session-paused-local' : 'session-active-local';
        } else {
            item.contextValue = 'session-foreign';
        }

        return item;
    }

    private getSessionDetails(session: MutagenSession, parent: SessionTreeItem): SessionTreeItem[] {
        const items: SessionTreeItem[] = [];
        const summary = toSessionSummary(session);
        const sid = session.identifier;
        const statusIcon = getStatusIcon(session.status, session.paused);
        const statusLabel = getStatusLabel(session.status, session.paused);
        const successfulCycles = typeof session.successfulCycles === 'number' ? session.successfulCycles : 0;

        // Determine local/remote by protocol, not by alpha/beta position
        const isAlphaLocal = session.alpha.protocol === 'local';
        const localEndpoint = isAlphaLocal ? session.alpha : session.beta;
        const remoteEndpoint = isAlphaLocal ? session.beta : session.alpha;

        const statusItem = new SessionTreeItem(
            `Status: ${statusLabel}`,
            vscode.TreeItemCollapsibleState.None,
            'info',
            session,
            parent,
            `${sid}-status`
        );
        statusItem.iconPath = new vscode.ThemeIcon(statusIcon);
        items.push(statusItem);

        const localItem = new SessionTreeItem(
            `Local: ${path.basename(localEndpoint.path)}`,
            vscode.TreeItemCollapsibleState.None,
            'endpoint',
            session,
            parent,
            `${sid}-local`
        );
        localItem.iconPath = new vscode.ThemeIcon('folder');
        localItem.description = localEndpoint.connected ? 'Connected' : 'Disconnected';
        localItem.tooltip = localEndpoint.path;
        items.push(localItem);

        const remoteLabel = remoteEndpoint.host
            ? `Remote: ${remoteEndpoint.host}`
            : `Remote: ${path.basename(remoteEndpoint.path)}`;
        const remoteItem = new SessionTreeItem(
            remoteLabel,
            vscode.TreeItemCollapsibleState.None,
            'endpoint',
            session,
            parent,
            `${sid}-remote`
        );
        remoteItem.iconPath = new vscode.ThemeIcon('remote');
        remoteItem.description = remoteEndpoint.connected ? 'Connected' : 'Disconnected';
        remoteItem.tooltip = remoteEndpoint.host
            ? `${remoteEndpoint.host}:${remoteEndpoint.path}`
            : remoteEndpoint.path;
        items.push(remoteItem);

        const filesItem = new SessionTreeItem(
            `Files: ${summary.fileCount.toLocaleString()}`,
            vscode.TreeItemCollapsibleState.None,
            'info',
            session,
            parent,
            `${sid}-files`
        );
        filesItem.iconPath = new vscode.ThemeIcon('file');
        filesItem.description = formatFileSize(summary.totalSize);
        items.push(filesItem);

        const cyclesItem = new SessionTreeItem(
            `Successful Cycles: ${successfulCycles}`,
            vscode.TreeItemCollapsibleState.None,
            'info',
            session,
            parent,
            `${sid}-cycles`
        );
        cyclesItem.iconPath = new vscode.ThemeIcon('check');
        items.push(cyclesItem);

        if (session.conflicts && session.conflicts.length > 0) {
            const conflictsItem = new SessionTreeItem(
                `Conflicts: ${session.conflicts.length}`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'conflicts-group',
                session,
                parent,
                `${sid}-conflicts-group`
            );
            conflictsItem.iconPath = new vscode.ThemeIcon('warning');
            conflictsItem.contextValue = 'conflicts-group';
            conflictsItem.tooltip = 'Expand to view individual conflict paths';
            items.push(conflictsItem);
        }

        if (session.lastError) {
            const errorItem = new SessionTreeItem(
                `Error: ${session.lastError.substring(0, 50)}...`,
                vscode.TreeItemCollapsibleState.None,
                'error',
                session,
                parent,
                `${sid}-error`
            );
            errorItem.iconPath = new vscode.ThemeIcon('error');
            errorItem.tooltip = session.lastError;
            items.push(errorItem);
        }

        return items;
    }

    private getConflictItems(session: MutagenSession, parent: SessionTreeItem): SessionTreeItem[] {
        const conflicts = session.conflicts ?? [];
        if (conflicts.length === 0) {
            return [];
        }

        const isAlphaLocal = session.alpha.protocol === 'local';
        const localRoot = path.resolve(isAlphaLocal ? session.alpha.path : session.beta.path);
        const remoteEndpoint = isAlphaLocal ? session.beta : session.alpha;

        return conflicts.map((conflict, index) => {
            const conflictRoot = conflict.root || '.';
            const conflictItem = new SessionTreeItem(
                conflictRoot,
                vscode.TreeItemCollapsibleState.None,
                'conflict-file',
                session,
                parent,
                `${session.identifier}-conflict-${index}-${encodeURIComponent(conflictRoot)}`,
                conflict
            );

            conflictItem.iconPath = new vscode.ThemeIcon('warning');
            conflictItem.contextValue = 'conflict-file';
            conflictItem.command = {
                command: 'mutagen.openConflictLocal',
                title: 'Open Local Conflict',
                arguments: [conflictItem]
            };

            const localPath = path.resolve(localRoot, ...this.splitConflictRoot(conflictRoot));
            const remotePath = path.posix.resolve(
                remoteEndpoint.path,
                ...this.splitConflictRoot(conflictRoot)
            );
            const alphaChanges = conflict.alphaChanges?.length ?? 0;
            const betaChanges = conflict.betaChanges?.length ?? 0;

            conflictItem.description = `A:${alphaChanges} B:${betaChanges}`;
            conflictItem.tooltip = new vscode.MarkdownString();
            conflictItem.tooltip.appendMarkdown(`**Conflict:** \`${conflictRoot}\`\n\n`);
            conflictItem.tooltip.appendMarkdown(`- **Local:** \`${localPath}\`\n`);
            conflictItem.tooltip.appendMarkdown(
                `- **Remote:** \`${remoteEndpoint.host ? `${remoteEndpoint.host}:${remotePath}` : remotePath}\`\n`
            );
            conflictItem.tooltip.appendMarkdown(`- **Alpha changes:** ${alphaChanges}\n`);
            conflictItem.tooltip.appendMarkdown(`- **Beta changes:** ${betaChanges}\n`);

            return conflictItem;
        });
    }

    private splitConflictRoot(conflictRoot: string): string[] {
        return conflictRoot
            .replace(/\\/g, '/')
            .split('/')
            .filter(segment => segment.length > 0 && segment !== '.');
    }
}
