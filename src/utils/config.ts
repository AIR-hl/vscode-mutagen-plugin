import * as path from 'path';
import * as vscode from 'vscode';

export function mergeIgnorePatterns(...groups: Array<readonly string[] | undefined>): string[] {
    const merged = new Set<string>();

    for (const group of groups) {
        if (!group) {
            continue;
        }

        for (const item of group) {
            const normalized = item.trim();
            if (normalized.length > 0) {
                merged.add(normalized);
            }
        }
    }

    return Array.from(merged);
}

export function getMergedGlobalIgnorePatterns(workspaceFolderUri?: vscode.Uri): string[] {
    const configuration = vscode.workspace.getConfiguration('mutagen', workspaceFolderUri);
    const inspected = configuration.inspect<unknown>('globalIgnorePatterns');

    const globalValue = Array.isArray(inspected?.globalValue)
        ? inspected.globalValue.filter((item): item is string => typeof item === 'string')
        : undefined;

    const workspaceValue = Array.isArray(inspected?.workspaceValue)
        ? inspected.workspaceValue.filter((item): item is string => typeof item === 'string')
        : undefined;

    const workspaceFolderValue = Array.isArray(inspected?.workspaceFolderValue)
        ? inspected.workspaceFolderValue.filter((item): item is string => typeof item === 'string')
        : undefined;

    return mergeIgnorePatterns(globalValue, workspaceValue, workspaceFolderValue);
}

export function getWorkspaceFolderForPath(localPath: string): vscode.WorkspaceFolder | undefined {
    const localUri = vscode.Uri.file(localPath);
    const directMatch = vscode.workspace.getWorkspaceFolder(localUri);
    if (directMatch) {
        return directMatch;
    }

    const normalizedLocalPath = path.resolve(localPath);
    return vscode.workspace.workspaceFolders?.find(folder => {
        const workspacePath = path.resolve(folder.uri.fsPath);
        return normalizedLocalPath === workspacePath || normalizedLocalPath.startsWith(`${workspacePath}${path.sep}`);
    });
}

function isSameOrSubPath(candidatePath: string, basePath: string): boolean {
    return candidatePath === basePath || candidatePath.startsWith(`${basePath}${path.sep}`);
}

export function isPathRelatedToWorkspaceFolder(localPath: string, workspaceFolderPath: string): boolean {
    const normalizedLocalPath = path.resolve(localPath);
    const normalizedWorkspacePath = path.resolve(workspaceFolderPath);

    return isSameOrSubPath(normalizedLocalPath, normalizedWorkspacePath)
        || isSameOrSubPath(normalizedWorkspacePath, normalizedLocalPath);
}

export function isPathInCurrentWorkspace(localPath: string): boolean {
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.some(folder => isPathRelatedToWorkspaceFolder(localPath, folder.uri.fsPath));
}
