import * as vscode from 'vscode';
import * as path from 'path';
import { 
    MutagenSession, 
    toSessionSummary, 
    getStatusIcon, 
    getStatusLabel,
    formatFileSize,
    SessionSummary
} from '../models/session';
import { MutagenService } from '../services/mutagenService';
import { Logger } from '../utils/logger';
import { isPathInCurrentWorkspace } from '../utils/config';

export type TreeItemType = 'session' | 'endpoint' | 'info' | 'error' | 'loading';

export class SessionTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType: TreeItemType,
        public readonly session?: MutagenSession,
        public readonly parent?: SessionTreeItem,
        itemId?: string
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
        return (
            oldSession.status !== newSession.status ||
            oldSession.paused !== newSession.paused ||
            oldSession.successfulCycles !== newSession.successfulCycles ||
            oldSession.lastError !== newSession.lastError ||
            oldSession.alpha.connected !== newSession.alpha.connected ||
            oldSession.beta.connected !== newSession.beta.connected ||
            (oldSession.conflicts?.length ?? 0) !== (newSession.conflicts?.length ?? 0) ||
            (oldSession.stagingProgress?.receivedSize ?? 0) !== (newSession.stagingProgress?.receivedSize ?? 0)
        );
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
            item.tooltip.appendMarkdown(`\n⚠️ **Has Errors**\n`);
        }
        if (summary.hasConflicts) {
            item.tooltip.appendMarkdown(`\n⚡ **Has Conflicts**\n`);
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
            `Local: ${path.basename(session.alpha.path)}`,
            vscode.TreeItemCollapsibleState.None,
            'endpoint',
            session,
            parent,
            `${sid}-local`
        );
        localItem.iconPath = new vscode.ThemeIcon('folder');
        localItem.description = session.alpha.connected ? 'Connected' : 'Disconnected';
        localItem.tooltip = session.alpha.path;
        items.push(localItem);

        const remoteLabel = session.beta.host 
            ? `Remote: ${session.beta.host}` 
            : `Remote: ${path.basename(session.beta.path)}`;
        const remoteItem = new SessionTreeItem(
            remoteLabel,
            vscode.TreeItemCollapsibleState.None,
            'endpoint',
            session,
            parent,
            `${sid}-remote`
        );
        remoteItem.iconPath = new vscode.ThemeIcon('remote');
        remoteItem.description = session.beta.connected ? 'Connected' : 'Disconnected';
        remoteItem.tooltip = session.beta.host 
            ? `${session.beta.host}:${session.beta.path}`
            : session.beta.path;
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
                vscode.TreeItemCollapsibleState.None,
                'error',
                session,
                parent,
                `${sid}-conflicts`
            );
            conflictsItem.iconPath = new vscode.ThemeIcon('warning');
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
}
