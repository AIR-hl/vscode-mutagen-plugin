import * as path from 'path';
import * as vscode from 'vscode';
import { CreateSessionOptions } from '../models/session';
import { Logger } from '../utils/logger';

const CONNECTION_PROFILE_STORAGE_KEY = 'mutagen.connectionProfiles.v1';

export interface ConnectionProfile {
    id: string;
    name: string;
    localPath: string;
    remotePath: string;
    mode?: CreateSessionOptions['mode'];
    // undefined means keep Mutagen default behavior
    ignoreVcs?: boolean;
    ignorePaths?: string[];
    workspaceFolder: string;
    lastSessionIdentifier?: string;
    updatedAt: string;
}

interface ConnectionProfileRecord {
    [key: string]: unknown;
}

export interface UpsertConnectionProfileInput {
    name: string;
    localPath: string;
    remotePath: string;
    mode?: CreateSessionOptions['mode'];
    ignoreVcs?: boolean;
    ignorePaths?: string[];
    workspaceFolder: string;
    lastSessionIdentifier?: string;
}

export class ConnectionProfileService {
    constructor(private readonly context: vscode.ExtensionContext) {}

    listProfiles(): ConnectionProfile[] {
        const rawValue = this.context.globalState.get<unknown>(CONNECTION_PROFILE_STORAGE_KEY, []);

        if (!Array.isArray(rawValue)) {
            Logger.warn(`Invalid profile storage shape for key ${CONNECTION_PROFILE_STORAGE_KEY}`);
            return [];
        }

        const profiles: ConnectionProfile[] = [];
        for (const candidate of rawValue) {
            const profile = this.parseProfile(candidate);
            if (profile) {
                profiles.push(profile);
            }
        }

        return profiles.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    getProfileById(id: string): ConnectionProfile | undefined {
        return this.listProfiles().find(profile => profile.id === id);
    }

    getProfilesForWorkspace(workspaceFolder: string): ConnectionProfile[] {
        return this.listProfiles().filter(profile => profile.workspaceFolder === this.normalizePath(workspaceFolder));
    }

    async upsertProfile(input: UpsertConnectionProfileInput): Promise<ConnectionProfile> {
        const profiles = this.listProfiles();

        const normalizedInput: UpsertConnectionProfileInput = {
            ...input,
            localPath: this.normalizePath(input.localPath),
            workspaceFolder: this.normalizePath(input.workspaceFolder),
            ignorePaths: this.normalizeIgnorePaths(input.ignorePaths)
        };

        const profileKey = this.getDeduplicationKey(
            normalizedInput.workspaceFolder,
            normalizedInput.localPath,
            normalizedInput.remotePath
        );

        const now = new Date().toISOString();
        const existing = profiles.find(profile =>
            this.getDeduplicationKey(profile.workspaceFolder, profile.localPath, profile.remotePath) === profileKey
        );

        const profile: ConnectionProfile = {
            id: existing?.id ?? this.createProfileId(normalizedInput.workspaceFolder, normalizedInput.localPath, normalizedInput.remotePath),
            name: normalizedInput.name.trim() || path.basename(normalizedInput.localPath),
            localPath: normalizedInput.localPath,
            remotePath: normalizedInput.remotePath,
            mode: normalizedInput.mode,
            ignoreVcs: normalizedInput.ignoreVcs,
            ignorePaths: normalizedInput.ignorePaths,
            workspaceFolder: normalizedInput.workspaceFolder,
            lastSessionIdentifier: normalizedInput.lastSessionIdentifier ?? existing?.lastSessionIdentifier,
            updatedAt: now
        };

        const retained = profiles.filter(item => item.id !== profile.id);
        retained.push(profile);

        await this.saveProfiles(retained);
        return profile;
    }

    async updateLastSessionIdentifier(profileId: string, sessionIdentifier: string): Promise<void> {
        const profiles = this.listProfiles();
        const index = profiles.findIndex(profile => profile.id === profileId);
        if (index < 0) {
            return;
        }

        profiles[index] = {
            ...profiles[index],
            lastSessionIdentifier: sessionIdentifier,
            updatedAt: new Date().toISOString()
        };

        await this.saveProfiles(profiles);
    }

    async removeProfile(profileId: string): Promise<boolean> {
        const profiles = this.listProfiles();
        const retained = profiles.filter(profile => profile.id !== profileId);
        if (retained.length === profiles.length) {
            return false;
        }

        await this.saveProfiles(retained);
        return true;
    }

    private async saveProfiles(profiles: ConnectionProfile[]): Promise<void> {
        await this.context.globalState.update(CONNECTION_PROFILE_STORAGE_KEY, profiles);
    }

    private parseProfile(value: unknown): ConnectionProfile | null {
        if (!value || typeof value !== 'object') {
            Logger.warn('Skipping malformed connection profile: non-object value');
            return null;
        }

        const record = value as ConnectionProfileRecord;
        const id = typeof record.id === 'string' ? record.id : '';
        const name = typeof record.name === 'string' ? record.name : '';
        const localPath = typeof record.localPath === 'string' ? record.localPath : '';
        const remotePath = typeof record.remotePath === 'string' ? record.remotePath : '';
        const workspaceFolder = typeof record.workspaceFolder === 'string' ? record.workspaceFolder : '';
        const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : '';

        if (!id || !name || !localPath || !remotePath || !workspaceFolder || !updatedAt) {
            Logger.warn('Skipping malformed connection profile: missing required fields');
            return null;
        }

        const mode = this.parseMode(record.mode);
        const ignoreVcs = typeof record.ignoreVcs === 'boolean' ? record.ignoreVcs : undefined;
        const ignorePaths = this.normalizeIgnorePaths(record.ignorePaths);
        const lastSessionIdentifier = typeof record.lastSessionIdentifier === 'string'
            ? record.lastSessionIdentifier
            : undefined;

        return {
            id,
            name,
            localPath: this.normalizePath(localPath),
            remotePath,
            mode,
            ignoreVcs,
            ignorePaths,
            workspaceFolder: this.normalizePath(workspaceFolder),
            lastSessionIdentifier,
            updatedAt
        };
    }

    private parseMode(mode: unknown): CreateSessionOptions['mode'] | undefined {
        switch (mode) {
            case 'two-way-safe':
            case 'two-way-resolved':
            case 'one-way-safe':
            case 'one-way-replica':
                return mode;
            default:
                return undefined;
        }
    }

    private normalizePath(rawPath: string): string {
        return path.resolve(rawPath);
    }

    private normalizeIgnorePaths(value: unknown): string[] {
        if (!Array.isArray(value)) {
            return [];
        }

        const deduped = new Set<string>();
        for (const candidate of value) {
            if (typeof candidate !== 'string') {
                continue;
            }

            const normalized = candidate.trim();
            if (normalized.length > 0) {
                deduped.add(normalized);
            }
        }

        return Array.from(deduped);
    }

    private getDeduplicationKey(workspaceFolder: string, localPath: string, remotePath: string): string {
        return `${workspaceFolder}::${localPath}::${remotePath}`;
    }

    private createProfileId(workspaceFolder: string, localPath: string, remotePath: string): string {
        return `${Date.now()}-${Buffer.from(`${workspaceFolder}|${localPath}|${remotePath}`).toString('base64url').slice(0, 16)}`;
    }
}
