import * as fs from 'fs/promises';
import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { Conflict, MutagenEndpoint, MutagenSession, CreateSessionOptions } from '../models/session';
import { MutagenService } from '../services/mutagenService';
import { SessionsTreeDataProvider, SessionTreeItem } from '../providers/sessionsTreeDataProvider';
import { StatusBarManager } from '../managers/statusBarManager';
import { Logger } from '../utils/logger';
import { SessionDetailsPanel } from '../panels/sessionDetailsPanel';
import {
    ConnectionProfile,
    ConnectionProfileService,
    UpsertConnectionProfileInput
} from '../services/connectionProfileService';
import {
    getMergedGlobalIgnorePatterns,
    getWorkspaceFolderForPath,
    mergeIgnorePatterns,
    isPathRelatedToWorkspaceFolder
} from '../utils/config';

interface SyncModeQuickPickItem extends vscode.QuickPickItem {
    value: NonNullable<CreateSessionOptions['mode']>;
}

interface IgnoreVcsQuickPickItem extends vscode.QuickPickItem {
    value: boolean | undefined;
}

interface LocalPathChoiceQuickPickItem extends vscode.QuickPickItem {
    value: 'keep' | 'change';
}

interface SavedSessionQuickPickItem extends vscode.QuickPickItem {
    profile: ConnectionProfile;
}

interface SessionConfigDraft {
    localPath: string;
    remotePath: string;
    name: string;
    mode: NonNullable<CreateSessionOptions['mode']>;
    ignoreVcs: boolean | undefined;
    sessionIgnorePaths: string[];
}

interface SessionConfigActionQuickPickItem extends vscode.QuickPickItem {
    value: 'editName' | 'editLocalPath' | 'editRemotePath' | 'editMode' | 'editIgnoreVcs' | 'editIgnorePaths' | 'apply' | 'cancel';
}

type ConflictDirection = 'local' | 'remote';

interface HandledConflictRecord {
    direction: ConflictDirection;
    signature: string;
    at: number;
}

interface ConflictEndpoints {
    localEndpoint: MutagenEndpoint;
    remoteEndpoint: MutagenEndpoint;
}

export class CommandManager {
    private service: MutagenService;
    private treeProvider: SessionsTreeDataProvider;
    private statusBar: StatusBarManager;
    private extensionUri: vscode.Uri;
    private profileService: ConnectionProfileService;
    private handledConflictsBySession = new Map<string, Map<string, HandledConflictRecord>>();

    constructor(
        treeProvider: SessionsTreeDataProvider,
        statusBar: StatusBarManager,
        extensionUri: vscode.Uri,
        profileService: ConnectionProfileService
    ) {
        this.service = MutagenService.getInstance();
        this.treeProvider = treeProvider;
        this.statusBar = statusBar;
        this.extensionUri = extensionUri;
        this.profileService = profileService;
    }

    registerCommands(context: vscode.ExtensionContext): void {
        context.subscriptions.push(
            vscode.commands.registerCommand('mutagen.refresh', () => this.refresh()),
            vscode.commands.registerCommand('mutagen.createSession', () => this.createSession()),
            vscode.commands.registerCommand('mutagen.pauseSession', (item: SessionTreeItem) => this.pauseSession(item)),
            vscode.commands.registerCommand('mutagen.resumeSession', (item: SessionTreeItem) => this.resumeSession(item)),
            vscode.commands.registerCommand('mutagen.terminateSession', (item: SessionTreeItem) => this.terminateSession(item)),
            vscode.commands.registerCommand('mutagen.flushSession', (item: SessionTreeItem) => this.flushSession(item)),
            vscode.commands.registerCommand('mutagen.resetSession', (item: SessionTreeItem) => this.resetSession(item)),
            vscode.commands.registerCommand('mutagen.showSessionDetails', (item: SessionTreeItem) => this.showSessionDetails(item)),
            vscode.commands.registerCommand('mutagen.openLocalFolder', (item: SessionTreeItem) => this.openLocalFolder(item)),
            vscode.commands.registerCommand('mutagen.connectSessionInCurrentWindow', (item: SessionTreeItem) => this.connectSessionInCurrentWindow(item)),
            vscode.commands.registerCommand('mutagen.connectSessionInNewWindow', (item: SessionTreeItem) => this.connectSessionInNewWindow(item)),
            vscode.commands.registerCommand('mutagen.showLogs', () => Logger.show()),
            vscode.commands.registerCommand('mutagen.startDaemon', () => this.startDaemon()),
            vscode.commands.registerCommand('mutagen.stopDaemon', () => this.stopDaemon()),
            vscode.commands.registerCommand('mutagen.editSessionConfig', (item: SessionTreeItem) => this.editSessionConfig(item)),
            vscode.commands.registerCommand('mutagen.connectSavedSession', () => this.connectSavedSession()),
            vscode.commands.registerCommand('mutagen.manageSavedSessions', () => this.manageSavedSessions()),
            vscode.commands.registerCommand('mutagen.openConflictLocal', (item: SessionTreeItem) => this.openConflictLocal(item)),
            vscode.commands.registerCommand('mutagen.copyConflictRemotePath', (item: SessionTreeItem) => this.copyConflictRemotePath(item)),
            vscode.commands.registerCommand('mutagen.copyConflictAcceptLocalCommand', (item: SessionTreeItem) => this.copyConflictAcceptCommand(item, 'local')),
            vscode.commands.registerCommand('mutagen.copyConflictAcceptRemoteCommand', (item: SessionTreeItem) => this.copyConflictAcceptCommand(item, 'remote')),
            vscode.commands.registerCommand('mutagen.acceptConflictLocal', (item: SessionTreeItem) => this.acceptConflict(item, 'local')),
            vscode.commands.registerCommand('mutagen.acceptConflictRemote', (item: SessionTreeItem) => this.acceptConflict(item, 'remote')),
            vscode.commands.registerCommand('mutagen.acceptAllConflictsLocal', (item: SessionTreeItem) => this.acceptAllConflicts(item, 'local')),
            vscode.commands.registerCommand('mutagen.acceptAllConflictsRemote', (item: SessionTreeItem) => this.acceptAllConflicts(item, 'remote'))
        );
    }

    async refresh(): Promise<void> {
        await this.treeProvider.loadSessions();
        this.statusBar.updateStatus(this.treeProvider.getSessions());
        this.pruneHandledConflictRecords();
    }

    async createSession(): Promise<void> {
        const localSelection = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Local Folder',
            title: 'Select Local Folder to Sync'
        });

        if (!localSelection || localSelection.length === 0) {
            return;
        }

        const localPath = localSelection[0].fsPath;

        const remotePathInput = await vscode.window.showInputBox({
            prompt: 'Enter remote path (e.g., host:/path or user@host:/path, default user: root)',
            placeHolder: 'hostname:/remote/path',
            validateInput: value => {
                if (!value.trim()) {
                    return 'Remote path is required';
                }
                return null;
            }
        });

        if (remotePathInput === undefined) {
            return;
        }

        const remotePath = this.normalizeRemotePath(remotePathInput.trim());
        if (!remotePath) {
            return;
        }

        const sessionNameInput = await vscode.window.showInputBox({
            prompt: 'Enter a name for this sync session (optional)',
            placeHolder: 'my-project'
        });

        if (sessionNameInput === undefined) {
            return;
        }

        const syncMode = await this.pickSyncMode('Select sync mode', 'two-way-safe');
        if (!syncMode) {
            return;
        }

        const ignoreVcsMode = await this.pickIgnoreVcsMode(
            'Select VCS ignore behavior',
            false
        );
        if (!ignoreVcsMode) {
            return;
        }

        const ignorePathsInput = await vscode.window.showInputBox({
            prompt: 'Enter additional session ignore patterns (comma-separated, optional)',
            placeHolder: 'node_modules, .venv, *.pt'
        });

        if (ignorePathsInput === undefined) {
            return;
        }

        const sessionIgnorePaths = this.parseIgnorePatterns(ignorePathsInput);
        const workspaceFolder = getWorkspaceFolderForPath(localPath);
        const globalIgnorePaths = getMergedGlobalIgnorePatterns(workspaceFolder?.uri);
        const effectiveIgnorePaths = mergeIgnorePatterns(sessionIgnorePaths, globalIgnorePaths);

        const options: CreateSessionOptions = {
            name: sessionNameInput.trim() || undefined,
            mode: syncMode.value,
            ignoreVcs: ignoreVcsMode.value
        };

        if (effectiveIgnorePaths.length > 0) {
            options.ignorePaths = effectiveIgnorePaths;
        }

        try {
            this.statusBar.showMessage('Creating session...', 'sync~spin');
            const createdSessionId = await this.service.createSession(localPath, remotePath, options);

            await this.maybeSaveConnectionProfile({
                name: sessionNameInput.trim() || path.basename(localPath),
                localPath,
                remotePath,
                mode: syncMode.value,
                ignoreVcs: ignoreVcsMode.value,
                ignorePaths: sessionIgnorePaths,
                workspaceFolder: this.resolveWorkspaceFolderPath(localPath),
                lastSessionIdentifier: createdSessionId
            });

            vscode.window.showInformationMessage('Sync session created successfully');
            await this.refresh();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to create session: ${message}`);
            Logger.error(`Create session failed: ${message}`);
        }
    }

    async pauseSession(item: SessionTreeItem): Promise<void> {
        if (!item.session) {
            return;
        }

        try {
            await this.service.pauseSession(item.session.identifier);
            vscode.window.showInformationMessage(`Session "${item.session.name}" paused`);
            await this.refresh();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to pause session: ${message}`);
        }
    }

    async resumeSession(item: SessionTreeItem): Promise<void> {
        if (!item.session) {
            return;
        }

        try {
            await this.service.resumeSession(item.session.identifier);
            vscode.window.showInformationMessage(`Session "${item.session.name}" resumed`);
            await this.refresh();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to resume session: ${message}`);
        }
    }

    async terminateSession(item: SessionTreeItem): Promise<void> {
        if (!item.session) {
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to terminate session "${item.session.name}"?`,
            { modal: true },
            'Terminate'
        );

        if (confirm !== 'Terminate') {
            return;
        }

        try {
            await this.service.terminateSession(item.session.identifier);
            this.clearHandledConflicts(item.session.identifier);
            vscode.window.showInformationMessage(`Session "${item.session.name}" terminated`);
            await this.refresh();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to terminate session: ${message}`);
        }
    }

    async flushSession(item: SessionTreeItem): Promise<void> {
        if (!item.session) {
            return;
        }

        try {
            this.statusBar.showSyncing(item.session.name);
            await this.service.flushSession(item.session.identifier);
            vscode.window.showInformationMessage(`Session "${item.session.name}" flushed`);
            await this.refresh();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to flush session: ${message}`);
        }
    }

    async resetSession(item: SessionTreeItem): Promise<void> {
        if (!item.session) {
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Reset session history for "${item.session.name}"? This will clear sync state and re-scan.`,
            { modal: true },
            'Reset'
        );

        if (confirm !== 'Reset') {
            return;
        }

        try {
            await this.service.resetSession(item.session.identifier);
            this.clearHandledConflicts(item.session.identifier);
            vscode.window.showInformationMessage(`Session "${item.session.name}" history reset`);
            await this.refresh();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to reset session: ${message}`);
        }
    }

    async showSessionDetails(item: SessionTreeItem): Promise<void> {
        if (!item.session) {
            return;
        }

        SessionDetailsPanel.show(this.extensionUri, item.session);
    }

    async openLocalFolder(item: SessionTreeItem): Promise<void> {
        if (!item.session) {
            return;
        }

        await this.openSessionProject(item.session, false);
    }

    async openConflictLocal(item: SessionTreeItem): Promise<void> {
        const conflictData = this.getConflictDataFromItem(item);
        if (!conflictData) {
            return;
        }

        try {
            const endpoints = this.getConflictEndpoints(conflictData.session);
            if (!endpoints) {
                vscode.window.showErrorMessage('Unable to locate local endpoint for this conflict');
                return;
            }

            const localPath = this.resolveLocalConflictPath(endpoints.localEndpoint.path, conflictData.conflict.root);
            const state = await this.getLocalPathState(localPath);
            if (state === 'missing') {
                vscode.window.showWarningMessage(`Local path does not exist: ${localPath}`);
                return;
            }

            if (state === 'directory') {
                await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(localPath));
                return;
            }

            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(localPath));
            await vscode.window.showTextDocument(doc, { preview: false });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to open local conflict path: ${message}`);
        }
    }

    async copyConflictRemotePath(item: SessionTreeItem): Promise<void> {
        const conflictData = this.getConflictDataFromItem(item);
        if (!conflictData) {
            return;
        }

        try {
            const remotePath = this.getConflictRemotePathDisplay(conflictData.session, conflictData.conflict.root);
            await vscode.env.clipboard.writeText(remotePath);
            vscode.window.showInformationMessage(`Copied remote conflict path: ${remotePath}`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to copy remote path: ${message}`);
        }
    }

    async copyConflictAcceptCommand(item: SessionTreeItem, direction: ConflictDirection): Promise<void> {
        const conflictData = this.getConflictDataFromItem(item);
        if (!conflictData) {
            return;
        }

        try {
            const command = this.buildConflictAcceptCommand(conflictData.session, conflictData.conflict, direction);
            await vscode.env.clipboard.writeText(command);
            vscode.window.showInformationMessage(
                `Copied ${direction === 'local' ? 'accept-local' : 'accept-remote'} command`
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to copy command: ${message}`);
        }
    }

    async acceptConflict(item: SessionTreeItem, direction: ConflictDirection): Promise<void> {
        const conflictData = this.getConflictDataFromItem(item);
        if (!conflictData) {
            return;
        }

        try {
            const session = await this.service.getSession(conflictData.session.identifier);
            if (!session) {
                vscode.window.showErrorMessage('Session not found. Try refreshing and retrying.');
                return;
            }

            const latestConflict = this.findConflictInSession(session, conflictData.conflict);
            if (!latestConflict) {
                await this.refresh();
                vscode.window.showInformationMessage(`Conflict "${conflictData.conflict.root}" is already resolved`);
                return;
            }

            await this.applyConflictDirection(session, latestConflict, direction);
            this.markConflictHandled(session.identifier, latestConflict, direction);

            await this.refresh();
            vscode.window.showInformationMessage(
                `Accepted ${direction === 'local' ? 'local' : 'remote'} version for "${latestConflict.root}"`
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to accept conflict: ${message}`);
        }
    }

    async acceptAllConflicts(item: SessionTreeItem, direction: ConflictDirection): Promise<void> {
        if (!item.session) {
            return;
        }

        try {
            const session = await this.service.getSession(item.session.identifier);
            if (!session) {
                vscode.window.showErrorMessage('Session not found. Try refreshing and retrying.');
                return;
            }

            const conflicts = session.conflicts ?? [];
            if (conflicts.length === 0) {
                this.clearHandledConflicts(session.identifier);
                await this.refresh();
                vscode.window.showInformationMessage('No conflicts to process');
                return;
            }

            const exclusion = this.splitHandledConflicts(session.identifier, conflicts);
            if (exclusion.pending.length === 0) {
                vscode.window.showInformationMessage(
                    `No pending conflicts. Total: ${conflicts.length}, skipped handled: ${exclusion.excludedCount}.`
                );
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `Accept ${direction === 'local' ? 'local' : 'remote'} version for ${exclusion.pending.length} conflict(s)? `
                    + `Handled conflicts with unchanged versions will be skipped (${exclusion.excludedCount}).`,
                { modal: true },
                'Accept All'
            );

            if (confirm !== 'Accept All') {
                return;
            }

            let successCount = 0;
            const failed: string[] = [];

            for (const conflict of exclusion.pending) {
                try {
                    await this.applyConflictDirection(session, conflict, direction);
                    this.markConflictHandled(session.identifier, conflict, direction);
                    successCount += 1;
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    failed.push(`${conflict.root}: ${message}`);
                }
            }

            const attemptedCount = exclusion.pending.length;
            const failedCount = failed.length;
            const allSucceeded = attemptedCount > 0 && failedCount === 0;
            let converged = false;
            let convergenceError: string | null = null;

            if (allSucceeded) {
                try {
                    await this.service.resetSession(session.identifier);
                    await this.service.flushSession(session.identifier);
                    this.clearHandledConflicts(session.identifier);
                    converged = true;
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    convergenceError = message;
                }
            }

            await this.refresh();

            const summary = `Total: ${conflicts.length}, skipped handled: ${exclusion.excludedCount}, `
                + `attempted: ${attemptedCount}, success: ${successCount}, failed: ${failedCount}`;

            if (failedCount === 0) {
                const convergenceNote = attemptedCount === 0
                    ? 'No actionable conflicts.'
                    : converged
                        ? 'Auto reset+flush completed.'
                        : `Conflict files processed, but auto reset+flush failed: ${convergenceError}`;
                vscode.window.showInformationMessage(`${summary}. ${convergenceNote}`);
                return;
            }

            const detail = failed.slice(0, 3).join(' | ');
            vscode.window.showWarningMessage(`${summary}. Failed items: ${detail}`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to accept all conflicts: ${message}`);
        }
    }

    async connectSessionInCurrentWindow(item: SessionTreeItem): Promise<void> {
        if (!item.session) {
            return;
        }

        await this.openSessionProject(item.session, false);
    }

    async connectSessionInNewWindow(item: SessionTreeItem): Promise<void> {
        if (!item.session) {
            return;
        }

        await this.openSessionProject(item.session, true);
    }

    async startDaemon(): Promise<void> {
        try {
            await this.service.startDaemon();
            vscode.window.showInformationMessage('Mutagen daemon started');
            await this.refresh();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to start daemon: ${message}`);
        }
    }

    async stopDaemon(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            'Stop Mutagen daemon? All sync sessions will be paused.',
            { modal: true },
            'Stop'
        );

        if (confirm !== 'Stop') {
            return;
        }

        try {
            await this.service.stopDaemon();
            vscode.window.showInformationMessage('Mutagen daemon stopped');
            await this.refresh();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to stop daemon: ${message}`);
        }
    }

    async editSessionConfig(item: SessionTreeItem): Promise<void> {
        if (!item.session) {
            return;
        }

        const defaults = this.extractSessionDefaults(item.session);
        if (!defaults) {
            vscode.window.showErrorMessage('Unable to determine local/remote endpoints for this session');
            return;
        }

        const editedConfig = await this.showSessionConfigEditor(item.session.name, defaults);
        if (!editedConfig) {
            return;
        }

        const { localPath, remotePath, name, mode, ignoreVcs, sessionIgnorePaths } = editedConfig;
        const workspaceFolder = getWorkspaceFolderForPath(localPath);
        const globalIgnorePaths = getMergedGlobalIgnorePatterns(workspaceFolder?.uri);
        const effectiveIgnorePaths = mergeIgnorePatterns(sessionIgnorePaths, globalIgnorePaths);

        const confirm = await vscode.window.showWarningMessage(
            `Recreate session "${item.session.name}" with updated configuration? This will terminate the current session and create a new one with a different identifier.`,
            { modal: true },
            'Recreate Session'
        );

        if (confirm !== 'Recreate Session') {
            return;
        }

        const options: CreateSessionOptions = {
            name: name.trim() || undefined,
            mode,
            ignoreVcs: ignoreVcs ?? false
        };

        if (effectiveIgnorePaths.length > 0) {
            options.ignorePaths = effectiveIgnorePaths;
        }

        try {
            this.statusBar.showMessage('Recreating session...', 'sync~spin');
            const newSessionIdentifier = await this.service.recreateSession(
                item.session.identifier,
                localPath,
                remotePath,
                options
            );

            await this.maybeSaveConnectionProfile({
                name: name.trim() || item.session.name || path.basename(localPath),
                localPath,
                remotePath,
                mode,
                ignoreVcs: ignoreVcs ?? false,
                ignorePaths: sessionIgnorePaths,
                workspaceFolder: this.resolveWorkspaceFolderPath(localPath),
                lastSessionIdentifier: newSessionIdentifier
            });

            vscode.window.showInformationMessage(
                `Session recreated successfully (new identifier: ${newSessionIdentifier || 'unknown'})`
            );
            await this.refresh();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to recreate session: ${message}`);
            Logger.error(`Recreate session failed: ${message}`);
        }
    }

    async connectSavedSession(): Promise<void> {
        const profiles = this.profileService.listProfiles();
        if (profiles.length === 0) {
            vscode.window.showInformationMessage('No saved connection profiles found');
            return;
        }

        const workspaceFolderPaths = new Set(
            (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath)
        );

        const sortedProfiles = [...profiles].sort((a, b) => {
            const aCurrent = workspaceFolderPaths.has(a.workspaceFolder) ? 1 : 0;
            const bCurrent = workspaceFolderPaths.has(b.workspaceFolder) ? 1 : 0;
            if (aCurrent !== bCurrent) {
                return bCurrent - aCurrent;
            }
            return b.updatedAt.localeCompare(a.updatedAt);
        });

        const pickItems: SavedSessionQuickPickItem[] = sortedProfiles.map(profile => ({
            label: profile.name,
            description: profile.remotePath,
            detail: `${profile.localPath}  (${profile.workspaceFolder})`,
            profile
        }));

        const selected = await vscode.window.showQuickPick(pickItems, {
            placeHolder: 'Select a saved session to connect',
            matchOnDescription: true,
            matchOnDetail: true
        });

        if (!selected) {
            return;
        }

        try {
            this.statusBar.showMessage(`Connecting ${selected.profile.name}...`, 'sync~spin');
            const sessionIdentifier = await this.restoreConnectionProfile(selected.profile);
            if (!sessionIdentifier) {
                vscode.window.showWarningMessage(`No session was restored for ${selected.profile.name}`);
                return;
            }

            await this.refresh();
            vscode.window.showInformationMessage(`Connected saved session "${selected.profile.name}"`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Failed to connect saved session: ${message}`);
            Logger.error(`Connect saved session failed: ${message}`);
        }
    }

    async manageSavedSessions(): Promise<void> {
        const profiles = this.profileService.listProfiles();
        if (profiles.length === 0) {
            vscode.window.showInformationMessage('No saved connection profiles found');
            return;
        }

        const profileItems: SavedSessionQuickPickItem[] = profiles.map(profile => ({
            label: profile.name,
            description: profile.remotePath,
            detail: `${profile.localPath}  (${profile.workspaceFolder})`,
            profile
        }));

        const selected = await vscode.window.showQuickPick(profileItems, {
            placeHolder: 'Select a saved session profile to manage',
            matchOnDescription: true,
            matchOnDetail: true
        });

        if (!selected) {
            return;
        }

        const action = await vscode.window.showQuickPick([
            { label: 'Connect', value: 'connect', description: 'Restore this saved session now' },
            { label: 'Delete Profile', value: 'delete', description: 'Remove this saved session profile' }
        ], {
            placeHolder: `Choose action for ${selected.profile.name}`
        });

        if (!action) {
            return;
        }

        if (action.value === 'connect') {
            try {
                await this.restoreConnectionProfile(selected.profile);
                await this.refresh();
                vscode.window.showInformationMessage(`Connected saved session "${selected.profile.name}"`);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Failed to connect saved session: ${message}`);
                Logger.error(`Manage saved session connect failed: ${message}`);
            }
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `Delete saved profile "${selected.profile.name}"?`,
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') {
            return;
        }

        const removed = await this.profileService.removeProfile(selected.profile.id);
        if (removed) {
            vscode.window.showInformationMessage(`Saved profile "${selected.profile.name}" deleted`);
        } else {
            vscode.window.showWarningMessage(`Saved profile "${selected.profile.name}" was not found`);
        }
    }

    async restoreConnectionProfile(profile: ConnectionProfile): Promise<string | null> {
        let session: MutagenSession | null = null;

        if (profile.lastSessionIdentifier) {
            session = await this.service.findSessionByIdentifier(profile.lastSessionIdentifier);
        }

        if (!session) {
            session = await this.service.findSessionByEndpoints(profile.localPath, profile.remotePath);
        }

        if (session) {
            if (session.paused || session.status === 'disconnected') {
                await this.service.resumeSession(session.identifier);
            }

            await this.profileService.updateLastSessionIdentifier(profile.id, session.identifier);
            return session.identifier;
        }

        const options = this.buildCreateOptionsFromProfile(profile);
        const sessionIdentifier = await this.service.createSession(profile.localPath, profile.remotePath, options);
        await this.profileService.updateLastSessionIdentifier(profile.id, sessionIdentifier);
        return sessionIdentifier;
    }

    async restoreConnectionProfileWithRetry(profile: ConnectionProfile): Promise<string | null> {
        const config = vscode.workspace.getConfiguration('mutagen');
        const maxRetries = config.get<number>('maxConnectionRetries', 3);
        
        let lastError: Error | null = null;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                Logger.info(`Attempting to restore connection profile "${profile.name}" (attempt ${attempt}/${maxRetries})`);
                const sessionIdentifier = await this.restoreConnectionProfile(profile);
                
                if (sessionIdentifier) {
                    Logger.info(`Successfully restored connection profile "${profile.name}" on attempt ${attempt}`);
                    return sessionIdentifier;
                }
                
                Logger.warn(`Failed to restore connection profile "${profile.name}" on attempt ${attempt}: no session returned`);
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                Logger.warn(`Failed to restore connection profile "${profile.name}" on attempt ${attempt}/${maxRetries}: ${lastError.message}`);
                
                // If this is not the last attempt, wait a bit before retrying
                if (attempt < maxRetries) {
                    const delayMs = Math.min(1000 * attempt, 5000); // Exponential backoff, max 5s
                    Logger.debug(`Waiting ${delayMs}ms before retry...`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
        }
        
        // All retries failed
        const errorMsg = lastError 
            ? `Failed to restore connection profile "${profile.name}" after ${maxRetries} attempts: ${lastError.message}`
            : `Failed to restore connection profile "${profile.name}" after ${maxRetries} attempts`;
        Logger.error(errorMsg);
        throw new Error(errorMsg);
    }

    async autoResumePausedSessionsForWorkspace(workspaceFolderPath: string): Promise<void> {
        const sessions = await this.service.listSessions();
        const pausedSessions = sessions.filter(session => {
            if (!session.paused) {
                return false;
            }

            return this.isSessionInWorkspaceFolder(session, workspaceFolderPath);
        });

        for (const session of pausedSessions) {
            await this.resumePausedSessionWithRetry(session, 3);
        }
    }

    async pauseSessionsForWorkspaceFolders(workspaceFolderPaths: readonly string[]): Promise<void> {
        if (workspaceFolderPaths.length === 0) {
            return;
        }

        const sessions = await this.service.listSessions();
        const matchedSessions = sessions.filter(session => {
            if (session.paused) {
                return false;
            }

            return workspaceFolderPaths.some(workspaceFolderPath =>
                this.isSessionInWorkspaceFolder(session, workspaceFolderPath)
            );
        });

        for (const session of matchedSessions) {
            try {
                await this.service.pauseSession(session.identifier);
                Logger.info(`Paused session "${session.name}" due to workspace/window close`);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                Logger.warn(`Failed to pause session "${session.name}" on workspace/window close: ${message}`);
            }
        }
    }

    private buildCreateOptionsFromProfile(profile: ConnectionProfile): CreateSessionOptions {
        const workspaceUri = profile.workspaceFolder
            ? vscode.Uri.file(profile.workspaceFolder)
            : undefined;
        const globalIgnorePaths = getMergedGlobalIgnorePatterns(workspaceUri);
        const effectiveIgnorePaths = mergeIgnorePatterns(profile.ignorePaths ?? [], globalIgnorePaths);

        const options: CreateSessionOptions = {
            name: profile.name || undefined,
            mode: profile.mode ?? 'two-way-safe',
            ignoreVcs: profile.ignoreVcs ?? false
        };

        if (effectiveIgnorePaths.length > 0) {
            options.ignorePaths = effectiveIgnorePaths;
        }

        return options;
    }

    private getLocalSessionPath(session: MutagenSession): string | null {
        if (session.alpha.protocol === 'local') {
            return path.resolve(session.alpha.path);
        }

        if (session.beta.protocol === 'local') {
            return path.resolve(session.beta.path);
        }

        return null;
    }

    private isSessionInWorkspaceFolder(session: MutagenSession, workspaceFolderPath: string): boolean {
        const localPath = this.getLocalSessionPath(session);
        if (!localPath) {
            return false;
        }

        return isPathRelatedToWorkspaceFolder(localPath, workspaceFolderPath);
    }

    private async openSessionProject(session: MutagenSession, forceNewWindow: boolean): Promise<void> {
        const localPath = this.getLocalSessionPath(session);
        if (!localPath) {
            vscode.window.showErrorMessage('Unable to find local path for this session');
            return;
        }

        const uri = vscode.Uri.file(localPath);
        await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow });
    }

    private async resumePausedSessionWithRetry(session: MutagenSession, maxRetries: number): Promise<boolean> {
        let lastError: Error | null = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                Logger.info(`Attempting to auto-resume paused session "${session.name}" (attempt ${attempt}/${maxRetries})`);
                await this.service.resumeSession(session.identifier);
                Logger.info(`Auto-resumed paused session "${session.name}" on attempt ${attempt}`);
                return true;
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                Logger.warn(`Failed to auto-resume paused session "${session.name}" on attempt ${attempt}/${maxRetries}: ${lastError.message}`);

                if (attempt < maxRetries) {
                    const delayMs = Math.min(1000 * attempt, 3000);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
        }

        const message = lastError
            ? `Failed to auto-resume paused session "${session.name}" after ${maxRetries} attempts: ${lastError.message}`
            : `Failed to auto-resume paused session "${session.name}" after ${maxRetries} attempts`;
        Logger.error(message);
        return false;
    }

    private async maybeSaveConnectionProfile(input: UpsertConnectionProfileInput): Promise<void> {
        const config = vscode.workspace.getConfiguration('mutagen');
        const enabled = config.get<boolean>('autoSaveConnectionProfiles', true);
        if (!enabled) {
            return;
        }

        try {
            await this.profileService.upsertProfile(input);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`Failed to save connection profile: ${message}`);
        }
    }

    private parseIgnorePatterns(rawInput: string): string[] {
        const entries = rawInput
            .split(/[\n,]/)
            .map(item => item.trim())
            .filter(item => item.length > 0);
        return Array.from(new Set(entries));
    }

    private getConflictDataFromItem(item: SessionTreeItem): { session: MutagenSession; conflict: Conflict } | null {
        if (!item.session || !item.conflict) {
            vscode.window.showWarningMessage('Please select a specific conflict item');
            return null;
        }

        return {
            session: item.session,
            conflict: item.conflict
        };
    }

    private getConflictEndpoints(session: MutagenSession): ConflictEndpoints | null {
        if (session.alpha.protocol === 'local') {
            return {
                localEndpoint: session.alpha,
                remoteEndpoint: session.beta
            };
        }

        if (session.beta.protocol === 'local') {
            return {
                localEndpoint: session.beta,
                remoteEndpoint: session.alpha
            };
        }

        return null;
    }

    private async applyConflictDirection(
        session: MutagenSession,
        conflict: Conflict,
        direction: ConflictDirection
    ): Promise<void> {
        const endpoints = this.getConflictEndpoints(session);
        if (!endpoints) {
            throw new Error('Unable to find a local endpoint for this session');
        }

        const localPath = this.resolveLocalConflictPath(endpoints.localEndpoint.path, conflict.root);
        const remotePath = this.resolveEndpointConflictPath(endpoints.remoteEndpoint, conflict.root);

        if (direction === 'local') {
            await this.applyLocalToEndpoint(localPath, endpoints.remoteEndpoint, remotePath);
            return;
        }

        await this.applyEndpointToLocal(endpoints.remoteEndpoint, remotePath, localPath);
    }

    private async applyLocalToEndpoint(
        localSourcePath: string,
        remoteEndpoint: MutagenEndpoint,
        remoteDestinationPath: string
    ): Promise<void> {
        if (remoteEndpoint.protocol === 'local') {
            await this.copyOrDeleteLocalPath(localSourcePath, remoteDestinationPath);
            return;
        }

        if (remoteEndpoint.protocol === 'ssh') {
            await this.applyLocalToSsh(localSourcePath, remoteEndpoint, remoteDestinationPath);
            return;
        }

        throw new Error('Docker endpoints are not supported for auto-apply. Use copy command fallback.');
    }

    private async applyEndpointToLocal(
        remoteEndpoint: MutagenEndpoint,
        remoteSourcePath: string,
        localDestinationPath: string
    ): Promise<void> {
        if (remoteEndpoint.protocol === 'local') {
            await this.copyOrDeleteLocalPath(remoteSourcePath, localDestinationPath);
            return;
        }

        if (remoteEndpoint.protocol === 'ssh') {
            await this.applySshToLocal(remoteEndpoint, remoteSourcePath, localDestinationPath);
            return;
        }

        throw new Error('Docker endpoints are not supported for auto-apply. Use copy command fallback.');
    }

    private async copyOrDeleteLocalPath(sourcePath: string, destinationPath: string): Promise<void> {
        if (path.resolve(sourcePath) === path.resolve(destinationPath)) {
            return;
        }

        const sourceState = await this.getLocalPathState(sourcePath);
        if (sourceState === 'missing') {
            await fs.rm(destinationPath, { recursive: true, force: true });
            return;
        }

        await fs.rm(destinationPath, { recursive: true, force: true });
        await fs.mkdir(path.dirname(destinationPath), { recursive: true });

        if (sourceState === 'directory') {
            await fs.cp(sourcePath, destinationPath, { recursive: true, force: true });
            return;
        }

        await fs.copyFile(sourcePath, destinationPath);
    }

    private async applyLocalToSsh(
        localSourcePath: string,
        remoteEndpoint: MutagenEndpoint,
        remoteDestinationPath: string
    ): Promise<void> {
        const sourceState = await this.getLocalPathState(localSourcePath);
        const sshTarget = this.getSshTarget(remoteEndpoint);

        if (sourceState === 'missing') {
            await this.runExternalCommand('ssh', [
                sshTarget,
                `rm -rf ${this.quoteShell(remoteDestinationPath)}`
            ]);
            return;
        }

        await this.runExternalCommand('ssh', [
            sshTarget,
            `mkdir -p ${this.quoteShell(path.posix.dirname(remoteDestinationPath))} && rm -rf ${this.quoteShell(remoteDestinationPath)}`
        ]);

        const scpArgs: string[] = [];
        if (sourceState === 'directory') {
            scpArgs.push('-r');
        }
        scpArgs.push(localSourcePath, this.buildScpRemoteSpec(remoteEndpoint, remoteDestinationPath));
        await this.runExternalCommand('scp', scpArgs);
    }

    private async applySshToLocal(
        remoteEndpoint: MutagenEndpoint,
        remoteSourcePath: string,
        localDestinationPath: string
    ): Promise<void> {
        const sourceState = await this.getRemotePathState(remoteEndpoint, remoteSourcePath);

        if (sourceState === 'missing') {
            await fs.rm(localDestinationPath, { recursive: true, force: true });
            return;
        }

        await fs.rm(localDestinationPath, { recursive: true, force: true });
        await fs.mkdir(path.dirname(localDestinationPath), { recursive: true });

        const scpArgs: string[] = [];
        if (sourceState === 'directory') {
            scpArgs.push('-r');
        }
        scpArgs.push(this.buildScpRemoteSpec(remoteEndpoint, remoteSourcePath), localDestinationPath);
        await this.runExternalCommand('scp', scpArgs);
    }

    private async getRemotePathState(
        remoteEndpoint: MutagenEndpoint,
        remotePath: string
    ): Promise<'file' | 'directory' | 'missing'> {
        const sshTarget = this.getSshTarget(remoteEndpoint);
        const checkCommand = [
            `if [ -d ${this.quoteShell(remotePath)} ]; then`,
            'echo directory',
            `elif [ -e ${this.quoteShell(remotePath)} ]; then`,
            'echo file',
            'else',
            'echo missing',
            'fi'
        ].join(' ');

        const result = await this.runExternalCommand('ssh', [sshTarget, checkCommand]);
        const state = result.stdout.trim().split(/\r?\n/).pop() ?? '';
        if (state === 'directory' || state === 'file' || state === 'missing') {
            return state;
        }

        throw new Error(`Unexpected remote path state: ${state || '(empty output)'}`);
    }

    private async getLocalPathState(targetPath: string): Promise<'file' | 'directory' | 'missing'> {
        try {
            const stat = await fs.stat(targetPath);
            return stat.isDirectory() ? 'directory' : 'file';
        } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
                return 'missing';
            }
            throw err;
        }
    }

    private findConflictInSession(session: MutagenSession, referenceConflict: Conflict): Conflict | null {
        const conflicts = session.conflicts ?? [];
        const referenceSignature = this.buildConflictSignature(referenceConflict);
        const exact = conflicts.find(conflict =>
            conflict.root === referenceConflict.root
            && this.buildConflictSignature(conflict) === referenceSignature
        );

        if (exact) {
            return exact;
        }

        return conflicts.find(conflict => conflict.root === referenceConflict.root) ?? null;
    }

    private buildConflictAcceptCommand(
        session: MutagenSession,
        conflict: Conflict,
        direction: ConflictDirection
    ): string {
        const endpoints = this.getConflictEndpoints(session);
        if (!endpoints) {
            throw new Error('Unable to locate local endpoint for this session');
        }

        const localPath = this.resolveLocalConflictPath(endpoints.localEndpoint.path, conflict.root);
        const remotePath = this.resolveEndpointConflictPath(endpoints.remoteEndpoint, conflict.root);

        if (direction === 'local') {
            return this.buildDirectionCommand(
                endpoints.remoteEndpoint,
                localPath,
                remotePath,
                'local-to-remote'
            );
        }

        return this.buildDirectionCommand(
            endpoints.remoteEndpoint,
            localPath,
            remotePath,
            'remote-to-local'
        );
    }

    private buildDirectionCommand(
        remoteEndpoint: MutagenEndpoint,
        localPath: string,
        remotePath: string,
        mode: 'local-to-remote' | 'remote-to-local'
    ): string {
        if (remoteEndpoint.protocol === 'local') {
            return mode === 'local-to-remote'
                ? this.buildLocalCopyCommand(localPath, remotePath)
                : this.buildLocalCopyCommand(remotePath, localPath);
        }

        if (remoteEndpoint.protocol === 'ssh') {
            return mode === 'local-to-remote'
                ? this.buildLocalToSshCommand(localPath, remoteEndpoint, remotePath)
                : this.buildSshToLocalCommand(remoteEndpoint, remotePath, localPath);
        }

        return mode === 'local-to-remote'
            ? this.buildDockerFallbackCommand(localPath, remoteEndpoint, remotePath, 'local-to-remote')
            : this.buildDockerFallbackCommand(localPath, remoteEndpoint, remotePath, 'remote-to-local');
    }

    private buildLocalCopyCommand(sourcePath: string, destinationPath: string): string {
        return [
            `if [ -e ${this.quoteShell(sourcePath)} ]; then`,
            `  rm -rf ${this.quoteShell(destinationPath)}`,
            `  mkdir -p ${this.quoteShell(path.dirname(destinationPath))}`,
            `  cp -R ${this.quoteShell(sourcePath)} ${this.quoteShell(destinationPath)}`,
            'else',
            `  rm -rf ${this.quoteShell(destinationPath)}`,
            'fi'
        ].join('\n');
    }

    private buildLocalToSshCommand(
        localPath: string,
        remoteEndpoint: MutagenEndpoint,
        remotePath: string
    ): string {
        const sshTarget = this.getSshTarget(remoteEndpoint);
        return [
            `LOCAL=${this.quoteShell(localPath)}`,
            `REMOTE=${this.quoteShell(remotePath)}`,
            `HOST=${this.quoteShell(sshTarget)}`,
            'if [ -e "$LOCAL" ]; then',
            '  ssh "$HOST" "mkdir -p ' + this.quoteShell(path.posix.dirname(remotePath)) + ' && rm -rf ' + this.quoteShell(remotePath) + '"',
            '  if [ -d "$LOCAL" ]; then',
            `    scp -r "$LOCAL" "$HOST:${this.quoteShell(remotePath)}"`,
            '  else',
            `    scp "$LOCAL" "$HOST:${this.quoteShell(remotePath)}"`,
            '  fi',
            'else',
            '  ssh "$HOST" "rm -rf ' + this.quoteShell(remotePath) + '"',
            'fi'
        ].join('\n');
    }

    private buildSshToLocalCommand(
        remoteEndpoint: MutagenEndpoint,
        remotePath: string,
        localPath: string
    ): string {
        const sshTarget = this.getSshTarget(remoteEndpoint);
        return [
            `LOCAL=${this.quoteShell(localPath)}`,
            `REMOTE=${this.quoteShell(remotePath)}`,
            `HOST=${this.quoteShell(sshTarget)}`,
            `STATE=$(ssh "$HOST" "if [ -d ${this.quoteShell(remotePath)} ]; then echo directory; elif [ -e ${this.quoteShell(remotePath)} ]; then echo file; else echo missing; fi")`,
            'if [ "$STATE" = "missing" ]; then',
            '  rm -rf "$LOCAL"',
            'else',
            '  rm -rf "$LOCAL"',
            '  mkdir -p "$(dirname "$LOCAL")"',
            '  if [ "$STATE" = "directory" ]; then',
            `    scp -r "$HOST:${this.quoteShell(remotePath)}" "$LOCAL"`,
            '  else',
            `    scp "$HOST:${this.quoteShell(remotePath)}" "$LOCAL"`,
            '  fi',
            'fi'
        ].join('\n');
    }

    private buildDockerFallbackCommand(
        localPath: string,
        remoteEndpoint: MutagenEndpoint,
        remotePath: string,
        mode: 'local-to-remote' | 'remote-to-local'
    ): string {
        const container = remoteEndpoint.host || '<container>';
        if (mode === 'local-to-remote') {
            return [
                '# Docker endpoints are not auto-applied by this extension.',
                '# Run manually:',
                `docker cp ${this.quoteShell(localPath)} ${this.quoteShell(`${container}:${remotePath}`)}`,
                `docker exec ${this.quoteShell(container)} rm -rf ${this.quoteShell(remotePath)} # optional when source is missing`
            ].join('\n');
        }

        return [
            '# Docker endpoints are not auto-applied by this extension.',
            '# Run manually:',
            `docker cp ${this.quoteShell(`${container}:${remotePath}`)} ${this.quoteShell(localPath)}`
        ].join('\n');
    }

    private getConflictRemotePathDisplay(session: MutagenSession, conflictRoot: string): string {
        const endpoints = this.getConflictEndpoints(session);
        if (!endpoints) {
            throw new Error('Unable to locate local endpoint for this session');
        }

        const remotePath = this.resolveEndpointConflictPath(endpoints.remoteEndpoint, conflictRoot);
        if (endpoints.remoteEndpoint.protocol === 'ssh') {
            return `${this.getSshTarget(endpoints.remoteEndpoint)}:${remotePath}`;
        }

        if (endpoints.remoteEndpoint.protocol === 'docker') {
            const container = endpoints.remoteEndpoint.host || '<container>';
            return `docker://${container}${remotePath}`;
        }

        return remotePath;
    }

    private splitHandledConflicts(
        sessionIdentifier: string,
        conflicts: Conflict[]
    ): { pending: Conflict[]; excludedCount: number } {
        const handled = this.handledConflictsBySession.get(sessionIdentifier);
        if (!handled || handled.size === 0) {
            return {
                pending: conflicts,
                excludedCount: 0
            };
        }

        const pending: Conflict[] = [];
        let excludedCount = 0;
        for (const conflict of conflicts) {
            const record = handled.get(conflict.root);
            const signature = this.buildConflictSignature(conflict);
            if (record && record.signature === signature) {
                excludedCount += 1;
                continue;
            }

            pending.push(conflict);
        }

        return {
            pending,
            excludedCount
        };
    }

    private markConflictHandled(
        sessionIdentifier: string,
        conflict: Conflict,
        direction: ConflictDirection
    ): void {
        const signature = this.buildConflictSignature(conflict);
        const records = this.handledConflictsBySession.get(sessionIdentifier) ?? new Map<string, HandledConflictRecord>();
        records.set(conflict.root, {
            direction,
            signature,
            at: Date.now()
        });
        this.handledConflictsBySession.set(sessionIdentifier, records);
    }

    private pruneHandledConflictRecords(): void {
        if (this.handledConflictsBySession.size === 0) {
            return;
        }

        const sessions = this.treeProvider.getSessions();
        const sessionById = new Map(sessions.map(session => [session.identifier, session]));

        for (const [sessionIdentifier, records] of this.handledConflictsBySession) {
            const session = sessionById.get(sessionIdentifier);
            const currentConflicts = session?.conflicts ?? [];
            if (!session || currentConflicts.length === 0) {
                this.handledConflictsBySession.delete(sessionIdentifier);
                continue;
            }

            const signatureByRoot = new Map(
                currentConflicts.map(conflict => [conflict.root, this.buildConflictSignature(conflict)])
            );

            for (const [root, record] of records) {
                const currentSignature = signatureByRoot.get(root);
                if (!currentSignature || currentSignature !== record.signature) {
                    records.delete(root);
                }
            }

            if (records.size === 0) {
                this.handledConflictsBySession.delete(sessionIdentifier);
            }
        }
    }

    private clearHandledConflicts(sessionIdentifier: string): void {
        this.handledConflictsBySession.delete(sessionIdentifier);
    }

    private buildConflictSignature(conflict: Conflict): string {
        const serializeEntry = (entry: unknown): string => {
            if (!entry) {
                return 'null';
            }

            if (typeof entry !== 'object') {
                return String(entry);
            }

            const map = entry as Record<string, unknown>;
            return JSON.stringify(
                Object.keys(map)
                    .sort()
                    .reduce<Record<string, unknown>>((acc, key) => {
                        acc[key] = map[key];
                        return acc;
                    }, {})
            );
        };

        const serializeChanges = (changes: Conflict['alphaChanges']): string[] =>
            (changes ?? [])
                .map(change => `${change.path}|${serializeEntry(change.old)}|${serializeEntry(change.new)}`)
                .sort();

        const payload = {
            root: conflict.root,
            alphaChanges: serializeChanges(conflict.alphaChanges),
            betaChanges: serializeChanges(conflict.betaChanges)
        };

        return JSON.stringify(payload);
    }

    private resolveLocalConflictPath(localRoot: string, conflictRoot: string): string {
        const basePath = path.resolve(localRoot);
        const targetPath = path.resolve(basePath, ...this.splitConflictRoot(conflictRoot));
        if (!this.isSubPath(basePath, targetPath)) {
            throw new Error(`Conflict path escapes local root: ${conflictRoot}`);
        }
        return targetPath;
    }

    private resolveEndpointConflictPath(endpoint: MutagenEndpoint, conflictRoot: string): string {
        if (endpoint.protocol === 'local') {
            return this.resolveLocalConflictPath(endpoint.path, conflictRoot);
        }

        return this.resolveRemoteConflictPath(endpoint.path, conflictRoot);
    }

    private resolveRemoteConflictPath(remoteRoot: string, conflictRoot: string): string {
        const basePath = path.posix.resolve(remoteRoot);
        const targetPath = path.posix.resolve(basePath, ...this.splitConflictRoot(conflictRoot));
        if (!this.isSubPathPosix(basePath, targetPath)) {
            throw new Error(`Conflict path escapes remote root: ${conflictRoot}`);
        }
        return targetPath;
    }

    private splitConflictRoot(conflictRoot: string): string[] {
        return conflictRoot
            .replace(/\\/g, '/')
            .split('/')
            .filter(segment => segment.length > 0 && segment !== '.');
    }

    private isSubPath(basePath: string, targetPath: string): boolean {
        const relative = path.relative(basePath, targetPath);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }

    private isSubPathPosix(basePath: string, targetPath: string): boolean {
        const relative = path.posix.relative(basePath, targetPath);
        return relative === '' || (!relative.startsWith('..') && !path.posix.isAbsolute(relative));
    }

    private getSshTarget(endpoint: MutagenEndpoint): string {
        if (!endpoint.host) {
            throw new Error('SSH endpoint host is missing');
        }

        return endpoint.user ? `${endpoint.user}@${endpoint.host}` : endpoint.host;
    }

    private buildScpRemoteSpec(endpoint: MutagenEndpoint, remotePath: string): string {
        return `${this.getSshTarget(endpoint)}:${this.quoteShell(remotePath)}`;
    }

    private quoteShell(value: string): string {
        return `'${value.replace(/'/g, `'\"'\"'`)}'`;
    }

    private async runExternalCommand(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
        Logger.debug(`Executing external command: ${command} ${args.join(' ')}`);
        return new Promise((resolve, reject) => {
            const proc = cp.spawn(command, args, {
                env: { ...globalThis.process.env }
            });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', data => {
                stdout += data.toString();
            });

            proc.stderr.on('data', data => {
                stderr += data.toString();
            });

            proc.on('error', err => {
                const code = (err as NodeJS.ErrnoException).code;
                if (code === 'ENOENT') {
                    reject(new Error(`Command not found: ${command}`));
                    return;
                }
                reject(err);
            });

            proc.on('close', code => {
                if (code === 0) {
                    resolve({ stdout, stderr });
                    return;
                }

                const message = stderr.trim() || stdout.trim() || `${command} failed with code ${code}`;
                reject(new Error(message));
            });
        });
    }

    private pickSyncMode(
        placeHolder: string,
        currentMode: NonNullable<CreateSessionOptions['mode']>
    ): Thenable<SyncModeQuickPickItem | undefined> {
        const items: SyncModeQuickPickItem[] = [
            {
                label: 'Two-Way Safe',
                value: 'two-way-safe',
                description: 'Bidirectional sync, keeps conflicts for manual resolution (default)'
            },
            {
                label: 'Two-Way Resolved',
                value: 'two-way-resolved',
                description: 'Bidirectional sync, conflicts auto-resolved by Local (Alpha wins)'
            },
            {
                label: 'One-Way Safe',
                value: 'one-way-safe',
                description: 'Local → Remote only (Alpha → Beta), safe mode'
            },
            {
                label: 'One-Way Replica',
                value: 'one-way-replica',
                description: 'Local → Remote only (Alpha → Beta), mirror mode'
            }
        ];

        const current = items.find(item => item.value === currentMode);

        return vscode.window.showQuickPick(items, {
            placeHolder,
            ignoreFocusOut: true,
            ...(current ? { activeItem: current } : {})
        });
    }

    private pickIgnoreVcsMode(
        placeHolder: string,
        currentValue: boolean | undefined
    ): Thenable<IgnoreVcsQuickPickItem | undefined> {
        const items: IgnoreVcsQuickPickItem[] = [
            {
                label: 'Default',
                value: false,
                description: 'Propagate VCS directories (same as Sync VCS)'
            },
            {
                label: 'Ignore VCS',
                value: true,
                description: 'Ignore .git, .svn, etc.'
            }
        ];

        const normalizedCurrentValue = currentValue ?? false;
        const current = items.find(item => item.value === normalizedCurrentValue);

        return vscode.window.showQuickPick(items, {
            placeHolder,
            ignoreFocusOut: true,
            ...(current ? { activeItem: current } : {})
        });
    }

    private async pickLocalPathForRecreate(defaultLocalPath: string): Promise<string | undefined> {
        const choices: LocalPathChoiceQuickPickItem[] = [
            {
                label: 'Keep Current Local Folder',
                value: 'keep',
                description: defaultLocalPath
            },
            {
                label: 'Choose a Different Local Folder',
                value: 'change'
            }
        ];

        const selected = await vscode.window.showQuickPick(choices, {
            placeHolder: 'Select local folder for recreated session',
            ignoreFocusOut: true
        });

        if (!selected) {
            return undefined;
        }

        if (selected.value === 'keep') {
            return defaultLocalPath;
        }

        const localSelection = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Local Folder',
            title: 'Select Local Folder for Recreated Session',
            defaultUri: vscode.Uri.file(defaultLocalPath)
        });

        if (!localSelection || localSelection.length === 0) {
            return undefined;
        }

        return localSelection[0].fsPath;
    }

    private async showSessionConfigEditor(
        sessionDisplayName: string,
        defaults: SessionConfigDraft
    ): Promise<SessionConfigDraft | undefined> {
        const draft: SessionConfigDraft = {
            ...defaults,
            sessionIgnorePaths: [...defaults.sessionIgnorePaths]
        };

        while (true) {
            const selected = await vscode.window.showQuickPick(this.getSessionConfigItems(draft), {
                placeHolder: `Edit configuration for "${sessionDisplayName}"`,
                ignoreFocusOut: true,
                matchOnDescription: true,
                matchOnDetail: true
            });

            if (!selected || selected.value === 'cancel') {
                return undefined;
            }

            if (selected.value === 'apply') {
                return draft;
            }

            if (selected.value === 'editName') {
                const sessionNameInput = await vscode.window.showInputBox({
                    prompt: 'Session name (optional)',
                    value: draft.name,
                    placeHolder: 'my-project'
                });

                if (sessionNameInput !== undefined) {
                    draft.name = sessionNameInput;
                }
                continue;
            }

            if (selected.value === 'editLocalPath') {
                const localPath = await this.pickLocalPathForRecreate(draft.localPath);
                if (localPath) {
                    draft.localPath = localPath;
                }
                continue;
            }

            if (selected.value === 'editRemotePath') {
                const remotePathInput = await vscode.window.showInputBox({
                    prompt: 'Enter remote path (default user: root)',
                    placeHolder: 'hostname:/remote/path',
                    value: draft.remotePath,
                    validateInput: value => {
                        if (!value.trim()) {
                            return 'Remote path is required';
                        }
                        return null;
                    }
                });

                if (remotePathInput !== undefined) {
                    draft.remotePath = this.normalizeRemotePath(remotePathInput.trim());
                }
                continue;
            }

            if (selected.value === 'editMode') {
                const syncMode = await this.pickSyncMode('Select sync mode', draft.mode);
                if (syncMode) {
                    draft.mode = syncMode.value;
                }
                continue;
            }

            if (selected.value === 'editIgnoreVcs') {
                const ignoreVcsMode = await this.pickIgnoreVcsMode(
                    'Select VCS ignore behavior',
                    draft.ignoreVcs
                );
                if (ignoreVcsMode) {
                    draft.ignoreVcs = ignoreVcsMode.value;
                }
                continue;
            }

            if (selected.value === 'editIgnorePaths') {
                const ignorePathsInput = await vscode.window.showInputBox({
                    prompt: 'Enter session-specific ignore patterns (comma-separated, optional)',
                    value: draft.sessionIgnorePaths.join(', '),
                    placeHolder: 'node_modules, .venv, *.pt'
                });

                if (ignorePathsInput !== undefined) {
                    draft.sessionIgnorePaths = this.parseIgnorePatterns(ignorePathsInput);
                }
            }
        }
    }

    private getSessionConfigItems(draft: SessionConfigDraft): SessionConfigActionQuickPickItem[] {
        const ignorePathsDisplay = draft.sessionIgnorePaths.length > 0
            ? draft.sessionIgnorePaths.join(', ')
            : '(none)';

        return [
            {
                label: '$(symbol-string) Session Name',
                description: draft.name.trim() || '(unnamed)',
                value: 'editName'
            },
            {
                label: '$(folder) Local Folder',
                description: draft.localPath,
                // detail: 'Alpha endpoint (used in conflict resolution)',
                value: 'editLocalPath'
            },
            {
                label: '$(cloud) Remote Path',
                description: draft.remotePath,
                // detail: 'Beta endpoint',
                value: 'editRemotePath'
            },
            {
                label: '$(settings-gear) Sync Mode',
                description: this.getSyncModeLabel(draft.mode),
                // detail: 'Two-Way Resolved: Local wins conflicts | One-Way: Local → Remote only',
                value: 'editMode'
            },
            {
                label: '$(git-branch) VCS Ignore',
                description: this.getIgnoreVcsLabel(draft.ignoreVcs),
                // detail: 'Default syncs .git/.svn; Ignore excludes VCS directories',
                value: 'editIgnoreVcs'
            },
            {
                label: '$(exclude) Session Ignore Patterns',
                description: ignorePathsDisplay,
                value: 'editIgnorePaths'
            },
            {
                label: '$(check) Apply Changes',
                // detail: 'Apply the configuration above and recreate this session',
                value: 'apply'
            },
            {
                label: '$(close) Cancel',
                value: 'cancel'
            }
        ];
    }

    private getSyncModeLabel(mode: NonNullable<CreateSessionOptions['mode']>): string {
        switch (mode) {
            case 'two-way-safe':
                return 'Two-Way Safe';
            case 'two-way-resolved':
                return 'Two-Way Resolved';
            case 'one-way-safe':
                return 'One-Way Safe';
            case 'one-way-replica':
                return 'One-Way Replica';
            default:
                return mode;
        }
    }

    private getIgnoreVcsLabel(ignoreVcs: boolean | undefined): string {
        if (ignoreVcs === true) {
            return 'Ignore VCS';
        }

        // Treat undefined as the extension default: Propagate VCS
        return 'Default (Propagate VCS)';
    }

    private extractSessionDefaults(session: MutagenSession): SessionConfigDraft | null {
        const local = session.alpha.protocol === 'local'
            ? session.alpha
            : session.beta.protocol === 'local'
                ? session.beta
                : undefined;

        if (!local) {
            return null;
        }

        const remote = session.alpha.protocol === 'local' ? session.beta : session.alpha;

        return {
            localPath: local.path,
            remotePath: this.formatRemoteEndpoint(remote),
            name: session.name,
            mode: 'two-way-safe',
            ignoreVcs: session.ignore.vcs ?? false,
            sessionIgnorePaths: session.ignore.paths ?? []
        };
    }

    private formatRemoteEndpoint(endpoint: MutagenEndpoint): string {
        if (endpoint.protocol === 'docker' && endpoint.host) {
            return `docker://${endpoint.host}${endpoint.path}`;
        }

        if (endpoint.host) {
            const host = endpoint.user
                ? `${endpoint.user}@${endpoint.host}`
                : endpoint.host;
            return `${host}:${endpoint.path}`;
        }

        return endpoint.path;
    }

    /**
     * Normalize remote path input.
     * If the path is in format "host:/path" (without user@), prepend "root@".
     * Otherwise, return the path as-is.
     */
    private normalizeRemotePath(remotePath: string): string {
        // Skip normalization for docker:// protocol
        if (remotePath.startsWith('docker://')) {
            return remotePath;
        }

        // Skip normalization for local paths (no colon or Windows drive letter)
        if (!remotePath.includes(':') || /^[a-zA-Z]:[/\\]/.test(remotePath)) {
            return remotePath;
        }

        // Check if path already has user@ prefix
        const colonIndex = remotePath.indexOf(':');
        const beforeColon = remotePath.substring(0, colonIndex);
        
        // If there's no @ before the colon, add "root@" prefix
        if (!beforeColon.includes('@')) {
            return `root@${remotePath}`;
        }

        return remotePath;
    }

    private resolveWorkspaceFolderPath(localPath: string): string {
        const workspaceFolder = getWorkspaceFolderForPath(localPath);
        if (workspaceFolder) {
            return workspaceFolder.uri.fsPath;
        }

        return path.dirname(localPath);
    }
}
