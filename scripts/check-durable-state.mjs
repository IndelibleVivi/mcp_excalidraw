#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = join(__dirname, '..');
const serverPath = join(repoRoot, 'dist', 'server.js');
const runtime = process.env.CANVAS_RUNTIME || process.execPath;
const runtimeName = basename(runtime).toLowerCase();
const runtimeArgs = runtimeName.includes('bun') ? ['run', serverPath] : [serverPath];
const port = Number(process.env.PORT || 34000 + Math.floor(Math.random() * 2000));
const baseUrl = `http://127.0.0.1:${port}`;
const fixtureRoot = mkdtempSync(join(tmpdir(), 'mcp excalidraw 状态-'));
const dataDirectory = join(fixtureRoot, 'canvas data');
const statePath = join(dataDirectory, 'canvas-state-v1.json');
const lockPath = join(dataDirectory, 'canvas-state.lock');

function spawnCanvas(canvasDataDirectory = dataDirectory, serverPort = port) {
  const child = spawn(runtime, runtimeArgs, {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(serverPort),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
      EXCALIDRAW_DATA_DIR: canvasDataDirectory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  return { child, getOutput: () => output.trim() };
}

async function waitForHealth(processInfo, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processInfo.child.exitCode !== null || processInfo.child.signalCode !== null) {
      throw new Error(`Canvas server exited before health check.\n${processInfo.getOutput()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${baseUrl}/health.\n${processInfo.getOutput()}`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      resolve(null);
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    };
    child.once('exit', onExit);
  });
}

async function stopCanvas(processInfo) {
  if (processInfo.child.exitCode !== null || processInfo.child.signalCode !== null) return;
  processInfo.child.kill('SIGTERM');
  const exit = await waitForExit(processInfo.child, 3000);
  if (!exit) {
    processInfo.child.kill('SIGKILL');
    throw new Error(`Canvas server did not stop after SIGTERM.\n${processInfo.getOutput()}`);
  }
}

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json();
  return { response, body };
}

async function postJson(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let first;
let second;
let lockContender;
let writeFailure;
let invalidState;

try {
  first = spawnCanvas();
  await waitForHealth(first);

  lockContender = spawnCanvas(dataDirectory, port + 1);
  const lockExit = await waitForExit(lockContender.child, 3000);
  assert.ok(lockExit, 'second server acquired the same canvas data directory');
  assert.notEqual(lockExit.code, 0);
  assert.match(lockContender.getOutput(), /already owned by process/);
  lockContender = null;

  const initial = await request('/api/scene');
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.sceneRevision, 0);
  assert.equal(typeof initial.body.stateId, 'string');
  assert.deepEqual(initial.body.elements, []);
  assert.deepEqual(initial.body.files, {});

  const missingPrecondition = await postJson('/api/elements/sync', { elements: [] });
  assert.equal(missingPrecondition.response.status, 428);
  assert.equal(missingPrecondition.body.code, 'SCENE_PRECONDITION_REQUIRED');

  const created = await postJson('/api/elements', {
    id: 'persisted-rectangle',
    type: 'rectangle',
    x: 10,
    y: 20,
    width: 120,
    height: 80,
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.body.sceneRevision, 1);

  const staleRevision = await postJson('/api/elements/sync', {
    elements: [],
    timestamp: new Date().toISOString(),
    baseStateId: initial.body.stateId,
    baseRevision: 0,
  });
  assert.equal(staleRevision.response.status, 409);
  assert.equal(staleRevision.body.sceneRevision, 1);
  assert.deepEqual(staleRevision.body.elements.map(element => element.id), ['persisted-rectangle']);

  const staleEpoch = await postJson('/api/elements/sync', {
    elements: [],
    timestamp: new Date().toISOString(),
    baseStateId: 'stale-server-epoch',
    baseRevision: 1,
  });
  assert.equal(staleEpoch.response.status, 409);
  assert.deepEqual(staleEpoch.body.elements.map(element => element.id), ['persisted-rectangle']);

  const accepted = await postJson('/api/elements/sync', {
    elements: [
      { id: 'persisted-rectangle', type: 'rectangle', x: 15, y: 25, width: 120, height: 80, version: 7 },
      { id: 'persisted-text', type: 'text', x: 40, y: 50, text: 'survives restart', version: 3 },
    ],
    timestamp: new Date().toISOString(),
    baseStateId: initial.body.stateId,
    baseRevision: 1,
  });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.sceneRevision, 2);

  const fileWrite = await postJson('/api/files', [{
    id: 'image-file',
    dataURL: 'data:image/png;base64,AA==',
    mimeType: 'image/png',
    created: 1,
  }]);
  assert.equal(fileWrite.response.status, 200);
  assert.equal(fileWrite.body.sceneRevision, 3);

  const snapshotWrite = await postJson('/api/snapshots', { name: 'before-restart' });
  assert.equal(snapshotWrite.response.status, 200);
  assert.equal(snapshotWrite.body.sceneRevision, 3);

  const checkpoint = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(checkpoint.schemaVersion, 1);
  assert.equal(checkpoint.stateId, initial.body.stateId);
  assert.equal(checkpoint.sceneRevision, 3);
  assert.deepEqual(checkpoint.elements.map(element => element.id), ['persisted-rectangle', 'persisted-text']);
  assert.equal(checkpoint.elements[0].version, 7);
  assert.deepEqual(Object.keys(checkpoint.files), ['image-file']);
  assert.deepEqual(checkpoint.snapshots.map(snapshot => snapshot.name), ['before-restart']);
  assert.equal(
    readdirSync(dirname(statePath)).some(name => name.includes('.tmp-')),
    false,
    'atomic checkpoint left a temporary file behind',
  );
  if (process.platform !== 'win32') {
    assert.equal(statSync(statePath).mode & 0o777, 0o600);
  }

  await stopCanvas(first);
  first = null;
  assert.equal(existsSync(lockPath), false, 'graceful shutdown left the data-directory lock behind');

  second = spawnCanvas();
  await waitForHealth(second);

  const restored = await request('/api/scene');
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.stateId, initial.body.stateId);
  assert.equal(restored.body.sceneRevision, 3);
  assert.deepEqual(restored.body.elements.map(element => element.id), ['persisted-rectangle', 'persisted-text']);
  assert.equal(restored.body.elements[0].version, 7);
  assert.deepEqual(Object.keys(restored.body.files), ['image-file']);

  const restoredFiles = await request('/api/files');
  assert.deepEqual(Object.keys(restoredFiles.body.files), ['image-file']);
  const restoredSnapshots = await request('/api/snapshots');
  assert.deepEqual(restoredSnapshots.body.snapshots.map(snapshot => snapshot.name), ['before-restart']);

  const deletedFile = await request('/api/files/image-file', { method: 'DELETE' });
  assert.equal(deletedFile.response.status, 200);
  assert.equal(deletedFile.body.sceneRevision, 4);
  const checkpointAfterFileDelete = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(checkpointAfterFileDelete.sceneRevision, 4);
  assert.deepEqual(checkpointAfterFileDelete.files, {});

  await stopCanvas(second);
  second = null;

  const writeFailureDirectory = join(fixtureRoot, 'write failure');
  writeFailure = spawnCanvas(writeFailureDirectory);
  await waitForHealth(writeFailure);
  mkdirSync(join(writeFailureDirectory, 'canvas-state-v1.json'));
  const rejectedWrite = await postJson('/api/elements', {
    id: 'must-roll-back',
    type: 'rectangle',
    x: 1,
    y: 2,
  });
  assert.equal(rejectedWrite.response.status, 500);
  assert.equal(rejectedWrite.body.error, 'Failed to checkpoint canvas state');
  const rolledBack = await request('/api/elements');
  assert.equal(rolledBack.body.sceneRevision, 0);
  assert.deepEqual(rolledBack.body.elements, []);
  await stopCanvas(writeFailure);
  writeFailure = null;

  const invalidStateDirectory = join(fixtureRoot, 'invalid state');
  mkdirSync(invalidStateDirectory);
  writeFileSync(join(invalidStateDirectory, 'canvas-state-v1.json'), '{"schemaVersion":999}\n');
  invalidState = spawnCanvas(invalidStateDirectory);
  const invalidExit = await waitForExit(invalidState.child, 3000);
  assert.ok(invalidExit, 'server with an unsupported checkpoint stayed running');
  assert.notEqual(invalidExit.code, 0);
  assert.match(invalidState.getOutput(), /Unsupported canvas state schema/);
  invalidState = null;

  console.log(
    'Durable state check passed: atomic checkpoint, restart recovery, state epoch, ' +
    'scene revision CAS, stale-client rejection, single-writer locking, rollback on write failure, fail-closed loading, ' +
    'files, snapshots, and element versions.'
  );
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
} finally {
  if (second) await stopCanvas(second).catch(error => console.error(error.message));
  if (lockContender) await stopCanvas(lockContender).catch(error => console.error(error.message));
  if (writeFailure) await stopCanvas(writeFailure).catch(error => console.error(error.message));
  if (invalidState) await stopCanvas(invalidState).catch(error => console.error(error.message));
  if (first) await stopCanvas(first).catch(error => console.error(error.message));
}
