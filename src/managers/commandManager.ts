import * as path from 'path';
import * as vscode from 'vscode';
import { MutagenEndpoint, MutagenSession, CreateSessionOptions } from '../models/session';
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

export class CommandManager {
    private service: MutagenService;
    private treeProvider: SessionsTreeDataProvider;
    private statusBar: StatusBarManager;
    private extensionUri: vscode.Uri;
    private profileService: ConnectionProfileService;

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
            vscode.commands.registerCommand('mutagen.manageSavedSessions', () => this.manageSavedSessions())
        );
    }

    async refresh(): Promise<void> {
        await this.treeProvider.loadSessions();
        this.statusBar.updateStatus(this.treeProvider.getSessions());
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
            undefined
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
            ignoreVcs
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
                ignoreVcs,
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
            ignoreVcs: profile.ignoreVcs
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

    private pickSyncMode(
        placeHolder: string,
        currentMode: NonNullable<CreateSessionOptions['mode']>
    ): Thenable<SyncModeQuickPickItem | undefined> {
        const items: SyncModeQuickPickItem[] = [
            {
                label: 'Two-Way Safe',
                value: 'two-way-safe',
                description: 'Bidirectional sync, safe mode (default)'
            },
            {
                label: 'Two-Way Resolved',
                value: 'two-way-resolved',
                description: 'Bidirectional sync, auto-resolve conflicts'
            },
            {
                label: 'One-Way Safe',
                value: 'one-way-safe',
                description: 'Local to remote only, safe mode'
            },
            {
                label: 'One-Way Replica',
                value: 'one-way-replica',
                description: 'Local to remote only, mirror mode'
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
                value: undefined,
                description: 'Use Mutagen default behavior'
            },
            {
                label: 'Ignore VCS',
                value: true,
                description: 'Ignore .git, .svn, etc.'
            },
            {
                label: 'Propagate VCS',
                value: false,
                description: 'Sync VCS directories'
            }
        ];

        const current = items.find(item => item.value === currentValue);

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
                detail: 'Optional display name',
                value: 'editName'
            },
            {
                label: '$(folder) Local Folder',
                description: draft.localPath,
                detail: 'Local endpoint path',
                value: 'editLocalPath'
            },
            {
                label: '$(cloud) Remote Path',
                description: draft.remotePath,
                detail: 'Remote endpoint path',
                value: 'editRemotePath'
            },
            {
                label: '$(settings-gear) Sync Mode',
                description: this.getSyncModeLabel(draft.mode),
                detail: draft.mode,
                value: 'editMode'
            },
            {
                label: '$(git-branch) VCS Ignore',
                description: this.getIgnoreVcsLabel(draft.ignoreVcs),
                value: 'editIgnoreVcs'
            },
            {
                label: '$(exclude) Session Ignore Patterns',
                description: ignorePathsDisplay,
                value: 'editIgnorePaths'
            },
            {
                label: '$(check) Recreate Session',
                detail: 'Apply the configuration above and recreate this session',
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

        if (ignoreVcs === false) {
            return 'Propagate VCS';
        }

        return 'Default';
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
            ignoreVcs: session.ignore.vcs,
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
