/**
 * Mutagen Session Data Models
 * Based on mutagen sync list --template '{{json .}}' output
 */

export interface MutagenEndpoint {
    protocol: 'local' | 'ssh' | 'docker';
    host?: string;
    user?: string;
    path: string;
    connected: boolean;
    scanned: boolean;
    directories: number;
    files: number;
    totalFileSize: number;
    scanProblems?: ScanProblem[];
    transitionProblems?: TransitionProblem[];
}

export interface ScanProblem {
    path: string;
    error: string;
}

export interface TransitionProblem {
    path: string;
    error: string;
}

export interface IgnoreConfig {
    paths?: string[];
    vcs?: boolean;
}

export interface SymlinkConfig {
    mode?: 'ignore' | 'portable' | 'posix-raw';
}

export interface WatchConfig {
    mode?: 'portable' | 'force-poll' | 'no-watch';
    pollingInterval?: number;
}

export interface PermissionsConfig {
    mode?: 'portable' | 'manual';
    defaultFileMode?: number;
    defaultDirectoryMode?: number;
    defaultOwner?: string;
    defaultGroup?: string;
}

export interface CompressionConfig {
    algorithm?: 'none' | 'deflate' | 'zstandard';
}

export interface Conflict {
    root: string;
    alphaChanges: string[];
    betaChanges: string[];
}

export type SessionStatus = 
    | 'disconnected'
    | 'halted-on-root-emptied'
    | 'halted-on-root-deletion'
    | 'halted-on-root-type-change'
    | 'connecting-alpha'
    | 'connecting-beta'
    | 'watching'
    | 'scanning'
    | 'waiting-for-rescan'
    | 'reconciling'
    | 'staging-alpha'
    | 'staging-beta'
    | 'transitioning'
    | 'saving';

export interface MutagenSession {
    identifier: string;
    version: number;
    creationTime: string;
    creatingVersion: string;
    alpha: MutagenEndpoint;
    beta: MutagenEndpoint;
    ignore: IgnoreConfig;
    symlink: SymlinkConfig;
    watch: WatchConfig;
    permissions: PermissionsConfig;
    compression: CompressionConfig;
    name: string;
    labels?: Record<string, string>;
    paused: boolean;
    status: SessionStatus;
    lastError?: string;
    successfulCycles: number;
    conflicts?: Conflict[];
    // Extended fields from monitor
    stagingProgress?: StagingProgress;
}

export interface StagingProgress {
    path: string;
    receivedSize: number;
    totalSize: number;
    receivedCount: number;
    totalCount: number;
}

export interface MonitorState {
    session: MutagenSession;
    // Calculated transfer rate (bytes per second)
    alphaTransferRate?: number;
    betaTransferRate?: number;
}

// Daemon status
export interface DaemonStatus {
    running: boolean;
    version?: string;
}

// Create session options
export interface CreateSessionOptions {
    name?: string;
    labels?: Record<string, string>;
    paused?: boolean;
    mode?: 'two-way-safe' | 'two-way-resolved' | 'one-way-safe' | 'one-way-replica';
    // undefined keeps Mutagen's default behavior, true/false force explicit modes
    ignoreVcs?: boolean;
    ignorePaths?: string[];
    symlinkMode?: 'ignore' | 'portable' | 'posix-raw';
    watchMode?: 'portable' | 'force-poll' | 'no-watch';
    compression?: 'none' | 'deflate' | 'zstandard';
}

// Session summary for quick display
export interface SessionSummary {
    id: string;
    name: string;
    status: SessionStatus;
    paused: boolean;
    localPath: string;
    remotePath: string;
    remoteHost?: string;
    fileCount: number;
    totalSize: number;
    hasErrors: boolean;
    hasConflicts: boolean;
}

export function toSessionSummary(session: MutagenSession): SessionSummary {
    const isAlphaLocal = session.alpha.protocol === 'local';
    const local = isAlphaLocal ? session.alpha : session.beta;
    const remote = isAlphaLocal ? session.beta : session.alpha;
    const fileCount = typeof local.files === 'number' ? local.files : 0;
    const totalSize = typeof local.totalFileSize === 'number' ? local.totalFileSize : 0;

    return {
        id: session.identifier,
        name: session.name || session.identifier.substring(0, 8),
        status: session.status,
        paused: session.paused,
        localPath: local.path,
        remotePath: remote.path,
        remoteHost: remote.host,
        fileCount,
        totalSize,
        hasErrors: !!(session.lastError || 
            (session.alpha.scanProblems && session.alpha.scanProblems.length > 0) ||
            (session.beta.scanProblems && session.beta.scanProblems.length > 0) ||
            (session.alpha.transitionProblems && session.alpha.transitionProblems.length > 0) ||
            (session.beta.transitionProblems && session.beta.transitionProblems.length > 0)),
        hasConflicts: !!(session.conflicts && session.conflicts.length > 0)
    };
}

export function formatFileSize(bytes: number): string {
    const safeBytes = typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
    if (safeBytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(safeBytes) / Math.log(k));
    return parseFloat((safeBytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function getStatusIcon(status: SessionStatus, paused: boolean): string {
    if (paused) {
        return 'debug-start';
    }
    switch (status) {
        case 'watching':
            return 'debug-pause';
        case 'scanning':
        case 'waiting-for-rescan':
            return 'search';
        case 'staging-alpha':
        case 'staging-beta':
            return 'cloud-download';
        case 'transitioning':
            return 'sync~spin';
        case 'reconciling':
            return 'git-compare';
        case 'saving':
            return 'save';
        case 'connecting-alpha':
        case 'connecting-beta':
            return 'plug';
        case 'disconnected':
            return 'debug-disconnect';
        case 'halted-on-root-emptied':
        case 'halted-on-root-deletion':
        case 'halted-on-root-type-change':
            return 'error';
        default:
            return 'circle-outline';
    }
}

export function getStatusLabel(status: SessionStatus, paused: boolean): string {
    if (paused) {
        return 'Paused';
    }
    switch (status) {
        case 'watching':
            return 'Watching';
        case 'scanning':
            return 'Scanning';
        case 'waiting-for-rescan':
            return 'Waiting for rescan';
        case 'staging-alpha':
            return 'Staging (local)';
        case 'staging-beta':
            return 'Staging (remote)';
        case 'transitioning':
            return 'Syncing';
        case 'reconciling':
            return 'Reconciling';
        case 'saving':
            return 'Saving';
        case 'connecting-alpha':
            return 'Connecting (local)';
        case 'connecting-beta':
            return 'Connecting (remote)';
        case 'disconnected':
            return 'Disconnected';
        case 'halted-on-root-emptied':
            return 'Halted: Root emptied';
        case 'halted-on-root-deletion':
            return 'Halted: Root deleted';
        case 'halted-on-root-type-change':
            return 'Halted: Root type changed';
        default:
            return status;
    }
}
