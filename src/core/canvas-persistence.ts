import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  elements,
  files,
  snapshots,
  ExcalidrawFile,
  ServerElement,
  Snapshot,
} from '../types.js';

const STATE_SCHEMA_VERSION = 1;
const STATE_FILE_NAME = 'canvas-state-v1.json';
const LOCK_FILE_NAME = 'canvas-state.lock';

interface DurableCanvasState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  stateId: string;
  sceneRevision: number;
  updatedAt: string;
  elements: ServerElement[];
  files: Record<string, ExcalidrawFile>;
  snapshots: Snapshot[];
}

export interface DurableStateStatus {
  enabled: boolean;
  loaded: boolean;
  path: string | null;
  sceneRevision: number;
  elements: number;
  files: number;
  snapshots: number;
}

export class CanvasPersistenceError extends Error {
  override name = 'CanvasPersistenceError';

  constructor(cause: unknown) {
    super('Failed to checkpoint canvas state', { cause });
  }
}

let sceneRevision = 0;
let stateId: string = randomUUID();
let stateLoaded = false;
let ownedLock: { path: string; token: string } | null = null;

export function durableStateDirectory(): string | null {
  const configured = process.env.EXCALIDRAW_DATA_DIR?.trim();
  return configured ? resolve(configured) : null;
}

export function durableStatePath(): string | null {
  const directory = durableStateDirectory();
  return directory ? join(directory, STATE_FILE_NAME) : null;
}

export function getSceneRevision(): number {
  return sceneRevision;
}

export function getStateId(): string {
  return stateId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseDurableState(raw: string): DurableCanvasState {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) {
    throw new Error('Canvas state must be a JSON object');
  }
  // Accept the private prototype's snake_case keys once so existing local
  // checkpoints can move into the public source implementation without data loss.
  const schemaVersion = value.schemaVersion ?? value.schema_version;
  const parsedRevision = value.sceneRevision ?? value.scene_revision;
  const parsedStateId = value.stateId ?? value.state_id;
  const parsedUpdatedAt = value.updatedAt ?? value.persisted_at;

  if (schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported canvas state schema: ${String(schemaVersion)}`);
  }
  if (!Number.isSafeInteger(parsedRevision) || (parsedRevision as number) < 0) {
    throw new Error('Canvas state has an invalid sceneRevision');
  }
  // Early machine-specific checkpoints predated state_id. Accept them once
  // and assign a new epoch; the next mutation writes the complete schema.
  if (parsedStateId !== undefined && (typeof parsedStateId !== 'string' || parsedStateId.length === 0)) {
    throw new Error('Canvas state has an invalid stateId');
  }
  if (!Array.isArray(value.elements)) {
    throw new Error('Canvas state has no elements array');
  }
  if (!isRecord(value.files)) {
    throw new Error('Canvas state has no files object');
  }
  if (!Array.isArray(value.snapshots)) {
    throw new Error('Canvas state has no snapshots array');
  }

  for (const element of value.elements) {
    if (!isRecord(element) || typeof element.id !== 'string') {
      throw new Error('Canvas state contains an invalid element');
    }
  }
  for (const [id, file] of Object.entries(value.files)) {
    if (!isRecord(file) || typeof file.id !== 'string' || file.id !== id) {
      throw new Error(`Canvas state contains an invalid file: ${id}`);
    }
  }
  for (const snapshot of value.snapshots) {
    if (!isRecord(snapshot) || typeof snapshot.name !== 'string' || !Array.isArray(snapshot.elements)) {
      throw new Error('Canvas state contains an invalid snapshot');
    }
  }

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    stateId: typeof parsedStateId === 'string' ? parsedStateId : randomUUID(),
    sceneRevision: parsedRevision as number,
    updatedAt: typeof parsedUpdatedAt === 'string' ? parsedUpdatedAt : new Date(0).toISOString(),
    elements: value.elements as ServerElement[],
    files: value.files as Record<string, ExcalidrawFile>,
    snapshots: value.snapshots as Snapshot[],
  };
}

function serializeFiles(): Record<string, ExcalidrawFile> {
  return Object.fromEntries(files.entries());
}

function currentState(): DurableCanvasState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    stateId,
    sceneRevision,
    updatedAt: new Date().toISOString(),
    elements: Array.from(elements.values()),
    files: serializeFiles(),
    snapshots: Array.from(snapshots.values()),
  };
}

function writeStateFile(statePath: string): void {
  const temporaryPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(currentState(), null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, statePath);
  } catch (error) {
    if (descriptor !== null) {
      closeSync(descriptor);
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created or may already be renamed.
    }
    throw error;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function readLockOwner(lockPath: string): { pid: number; token: string } {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch (error) {
    throw new Error(`Canvas data directory has an unreadable lock file: ${(error as Error).message}`);
  }
  if (!isRecord(value) ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      typeof value.token !== 'string' ||
      value.token.length === 0) {
    throw new Error('Canvas data directory has an invalid lock file');
  }
  return { pid: value.pid as number, token: value.token };
}

export function acquireDurableStateLock(): void {
  const dataDirectory = durableStateDirectory();
  if (!dataDirectory) return;
  if (ownedLock) {
    throw new Error('Canvas data directory lock was already acquired in this process');
  }

  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const lockPath = join(dataDirectory, LOCK_FILE_NAME);
  const token = randomUUID();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let descriptor: number | null = null;
    try {
      descriptor = openSync(lockPath, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      ownedLock = { path: lockPath, token };
      return;
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

      const owner = readLockOwner(lockPath);
      if (processIsRunning(owner.pid)) {
        throw new Error(`Canvas data directory is already owned by process ${owner.pid}`);
      }
      unlinkSync(lockPath);
    }
  }

  throw new Error('Failed to acquire canvas data directory lock');
}

export function releaseDurableStateLock(): void {
  if (!ownedLock) return;
  const lock = ownedLock;
  ownedLock = null;

  try {
    if (!existsSync(lock.path)) return;
    const currentOwner = readLockOwner(lock.path);
    if (currentOwner.token === lock.token) {
      unlinkSync(lock.path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  source.forEach((value, key) => target.set(key, value));
}

interface RuntimeStateBackup {
  sceneRevision: number;
  elements: Map<string, ServerElement>;
  files: Map<string, ExcalidrawFile>;
  snapshots: Map<string, Snapshot>;
}

function captureRuntimeState(): RuntimeStateBackup {
  return {
    sceneRevision,
    elements: structuredClone(elements),
    files: structuredClone(files),
    snapshots: structuredClone(snapshots),
  };
}

function restoreRuntimeState(backup: RuntimeStateBackup): void {
  sceneRevision = backup.sceneRevision;
  replaceMap(elements, backup.elements);
  replaceMap(files, backup.files);
  replaceMap(snapshots, backup.snapshots);
}

export function commitCanvasMutation<T>(
  mutate: () => T,
  options: { advanceSceneRevision?: boolean } = {},
): { value: T; sceneRevision: number } {
  const statePath = durableStatePath();
  const backup = statePath ? captureRuntimeState() : null;

  let value: T;
  try {
    value = mutate();
    if (options.advanceSceneRevision !== false) {
      sceneRevision += 1;
    }
  } catch (error) {
    if (backup) {
      restoreRuntimeState(backup);
    }
    throw error;
  }

  if (statePath) {
    try {
      writeStateFile(statePath);
    } catch (error) {
      restoreRuntimeState(backup!);
      throw new CanvasPersistenceError(error);
    }
  }

  return { value, sceneRevision };
}

export function loadDurableState(): DurableStateStatus {
  if (stateLoaded) {
    throw new Error('Canvas durable state was already loaded in this process');
  }
  stateLoaded = true;

  const statePath = durableStatePath();
  if (!statePath || !existsSync(statePath)) {
    return {
      enabled: Boolean(statePath),
      loaded: false,
      path: statePath,
      sceneRevision,
      elements: elements.size,
      files: files.size,
      snapshots: snapshots.size,
    };
  }

  const state = parseDurableState(readFileSync(statePath, 'utf8'));
  const restoredElements = new Map(state.elements.map(element => [element.id, element]));
  const restoredFiles = new Map(Object.entries(state.files));
  const restoredSnapshots = new Map(state.snapshots.map(snapshot => [snapshot.name, snapshot]));

  replaceMap(elements, restoredElements);
  replaceMap(files, restoredFiles);
  replaceMap(snapshots, restoredSnapshots);
  sceneRevision = state.sceneRevision;
  stateId = state.stateId;

  return {
    enabled: true,
    loaded: true,
    path: statePath,
    sceneRevision,
    elements: elements.size,
    files: files.size,
    snapshots: snapshots.size,
  };
}
