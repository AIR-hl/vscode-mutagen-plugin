import * as vscode from 'vscode';
import { Logger } from './utils/logger';
import { MutagenService } from './services/mutagenService';
import { SessionsTreeDataProvider } from './providers/sessionsTreeDataProvider';
import { StatusBarManager } from './managers/statusBarManager';
import { CommandManager } from './managers/commandManager';
import { ConnectionProfileService } from './services/connectionProfileService';

let statusBarManager: StatusBarManager | undefined;
let mutagenService: MutagenService | undefined;
let connectionProfileService: ConnectionProfileService | undefined;
let commandManager: CommandManager | undefined;

const restoredSessionIds = new Set<string>();
const restoredProfilesByWorkspace = new Map<string, Set<string>>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    Logger.init(context);
    Logger.info('Mutagen extension activating...');

    const service = MutagenService.getInstance();
    mutagenService = service;

    const isInstalled = await service.checkInstallation();
    if (!isInstalled) {
        const action = await vscode.window.showErrorMessage(
            'Mutagen is not installed or not in PATH. Please install Mutagen first.',
            'Install Instructions',
            'Configure Path'
        );

        if (action === 'Install Instructions') {
            vscode.env.openExternal(vscode.Uri.parse('https://mutagen.io/documentation/introduction/installation'));
        } else if (action === 'Configure Path') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'mutagen.executablePath');
        }
        return;
    }

    const version = await service.getVersion();
    Logger.info(`Mutagen version: ${version}`);

    const config = vscode.workspace.getConfiguration('mutagen');
    if (config.get<boolean>('autoStartDaemon', true)) {
        const daemonStatus = await service.getDaemonStatus();
        if (!daemonStatus.running) {
            try {
                await service.startDaemon();
                Logger.info('Mutagen daemon auto-started');
            } catch (err) {
                Logger.warn(`Failed to auto-start daemon: ${err}`);
            }
        }
    }

    const treeProvider = new SessionsTreeDataProvider();
    const treeView = vscode.window.createTreeView('mutagen.sessions', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });
    context.subscriptions.push(treeView);

    statusBarManager = new StatusBarManager(context);
    connectionProfileService = new ConnectionProfileService(context);
    commandManager = new CommandManager(treeProvider, statusBarManager, context.extensionUri, connectionProfileService);
    commandManager.registerCommands(context);

    await treeProvider.loadSessions();
    statusBarManager.updateStatus(treeProvider.getSessions());

    statusBarManager.startAutoRefresh(async () => {
        await treeProvider.loadSessions();
        statusBarManager?.updateStatus(treeProvider.getSessions());
    });

    await autoRestoreConnections();
    await commandManager.refresh();

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('mutagen')) {
                service.updateConfig();
                statusBarManager?.updateConfig();
                Logger.updateConfig();
                statusBarManager?.startAutoRefresh(async () => {
                    await treeProvider.loadSessions();
                    statusBarManager?.updateStatus(treeProvider.getSessions());
                });
            }
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(e => {
            void handleWorkspaceFolderChanges(e);
        })
    );

    Logger.info('Mutagen extension activated');
}

export async function deactivate(): Promise<void> {
    const workspaceFolderPaths = (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.fsPath);
    if (commandManager && workspaceFolderPaths.length > 0) {
        await commandManager.pauseSessionsForWorkspaceFolders(workspaceFolderPaths);
    }

    if (vscode.workspace.getConfiguration('mutagen').get<boolean>('terminateRestoredSessionsOnClose', false)) {
        await terminateTrackedSessions();
    }

    if (statusBarManager) {
        statusBarManager.dispose();
    }

    Logger.info('Mutagen extension deactivated');
}

async function autoRestoreConnections(): Promise<void> {
    const shouldRestore = vscode.workspace
        .getConfiguration('mutagen')
        .get<boolean>('autoRestoreConnections', true);

    if (!shouldRestore || !commandManager || !connectionProfileService) {
        return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

    for (const workspaceFolder of workspaceFolders) {
        try {
            await commandManager.autoResumePausedSessionsForWorkspace(workspaceFolder.uri.fsPath);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`Failed to auto-resume paused sessions for workspace ${workspaceFolder.name}: ${message}`);
        }

        const profiles = connectionProfileService.getProfilesForWorkspace(workspaceFolder.uri.fsPath);

        for (const profile of profiles) {
            try {
                const sessionIdentifier = await commandManager.restoreConnectionProfileWithRetry(profile);
                if (!sessionIdentifier) {
                    continue;
                }

                trackRestoredProfile(workspaceFolder.uri.fsPath, profile.id, sessionIdentifier);
                Logger.info(`Restored session profile: ${profile.name}`);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                Logger.warn(`Failed to auto-restore profile ${profile.name}: ${message}`);
            }
        }
    }
}

async function handleWorkspaceFolderChanges(event: vscode.WorkspaceFoldersChangeEvent): Promise<void> {
    for (const removed of event.removed) {
        if (commandManager) {
            await commandManager.pauseSessionsForWorkspaceFolders([removed.uri.fsPath]);
        }
        await terminateRestoredProfilesForWorkspace(removed.uri.fsPath);
    }

    const shouldRestore = vscode.workspace
        .getConfiguration('mutagen')
        .get<boolean>('autoRestoreConnections', true);

    if (shouldRestore && commandManager && connectionProfileService) {
        for (const added of event.added) {
            try {
                await commandManager.autoResumePausedSessionsForWorkspace(added.uri.fsPath);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                Logger.warn(`Failed to auto-resume paused sessions for added workspace ${added.name}: ${message}`);
            }

            const profiles = connectionProfileService.getProfilesForWorkspace(added.uri.fsPath);
            for (const profile of profiles) {
                try {
                    const sessionIdentifier = await commandManager.restoreConnectionProfileWithRetry(profile);
                    if (!sessionIdentifier) {
                        continue;
                    }

                    trackRestoredProfile(added.uri.fsPath, profile.id, sessionIdentifier);
                    Logger.info(`Restored session profile after workspace add: ${profile.name}`);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    Logger.warn(`Failed to restore profile ${profile.name} on workspace add: ${message}`);
                }
            }
        }
    }

    if (commandManager) {
        await commandManager.refresh();
    }
}

function trackRestoredProfile(workspaceFolder: string, profileId: string, sessionIdentifier: string): void {
    restoredSessionIds.add(sessionIdentifier);

    const profileSet = restoredProfilesByWorkspace.get(workspaceFolder) ?? new Set<string>();
    profileSet.add(profileId);
    restoredProfilesByWorkspace.set(workspaceFolder, profileSet);
}

async function terminateRestoredProfilesForWorkspace(workspaceFolder: string): Promise<void> {
    if (!connectionProfileService || !mutagenService) {
        return;
    }

    const trackedProfiles = restoredProfilesByWorkspace.get(workspaceFolder);
    if (!trackedProfiles || trackedProfiles.size === 0) {
        return;
    }

    for (const profileId of trackedProfiles) {
        const profile = connectionProfileService.getProfileById(profileId);
        if (!profile?.lastSessionIdentifier) {
            continue;
        }

        try {
            await mutagenService.terminateSession(profile.lastSessionIdentifier);
            Logger.info(`Terminated restored session for profile ${profile.name}`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`Failed to terminate restored session for profile ${profileId}: ${message}`);
        }

        restoredSessionIds.delete(profile.lastSessionIdentifier);
    }

    restoredProfilesByWorkspace.delete(workspaceFolder);
}

async function terminateTrackedSessions(): Promise<void> {
    if (!mutagenService || !connectionProfileService) {
        return;
    }

    const sessionIdentifiers = new Set<string>(restoredSessionIds);

    for (const profileIds of restoredProfilesByWorkspace.values()) {
        for (const profileId of profileIds) {
            const profile = connectionProfileService.getProfileById(profileId);
            if (profile?.lastSessionIdentifier) {
                sessionIdentifiers.add(profile.lastSessionIdentifier);
            }
        }
    }

    for (const sessionIdentifier of sessionIdentifiers) {
        try {
            await mutagenService.terminateSession(sessionIdentifier);
            Logger.info(`Terminated restored session on deactivate: ${sessionIdentifier}`);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.warn(`Failed to terminate session on deactivate ${sessionIdentifier}: ${message}`);
        }
    }

    restoredSessionIds.clear();
    restoredProfilesByWorkspace.clear();
}
