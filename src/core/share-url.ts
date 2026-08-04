import { deflateSync } from 'zlib';
import { webcrypto } from 'crypto';
import { ServerElement } from '../types.js';
import { expandElementsForExport } from './expand-elements.js';

// Excalidraw's concatBuffers: [4-byte version=1][4-byte len][chunk]...
function concatBuffers(...bufs: Uint8Array[]): Uint8Array {
  let total = 4; // version header
  for (const b of bufs) total += 4 + b.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 1); // CONCAT_BUFFERS_VERSION = 1
  let off = 4;
  for (const b of bufs) {
    dv.setUint32(off, b.length);
    off += 4;
    out.set(b, off);
    off += b.length;
  }
  return out;
}

// Export elements to a shareable excalidraw.com URL. The diagram is
// encrypted client-side (AES-GCM 128) and uploaded; the decryption key only
// lives in the URL fragment.
export async function exportToExcalidrawUrl(urlExportElements: ServerElement[]): Promise<string> {
  if (urlExportElements.length === 0) {
    throw new Error('Canvas is empty — nothing to export');
  }

  const cleanedExportElements = expandElementsForExport(urlExportElements);

  // Build .excalidraw scene JSON
  const excalidrawScene = {
    type: 'excalidraw',
    version: 2,
    source: 'https://excalidraw.com',
    elements: cleanedExportElements,
    appState: {
      viewBackgroundColor: '#ffffff',
      gridSize: null
    },
    files: {}
  };
  const sceneJson = JSON.stringify(excalidrawScene);
  const dataBytes = new TextEncoder().encode(sceneJson);

  const encoder = new TextEncoder();

  // Inner data: concatBuffers(fileMetadata, dataJSON)
  const fileMetadata = encoder.encode('{}');
  const innerData = concatBuffers(fileMetadata, dataBytes);

  // Compress with zlib deflate
  const compressed = deflateSync(Buffer.from(innerData));

  // Encrypt with AES-GCM 128-bit key
  const cryptoKey = await webcrypto.subtle.generateKey(
    { name: 'AES-GCM', length: 128 },
    true,
    ['encrypt']
  );

  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encrypted = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    cryptoKey,
    compressed
  );

  // Outer payload: concatBuffers(encodingMeta, iv, ciphertext)
  const encodingMeta = encoder.encode(JSON.stringify({
    version: 2,
    compression: 'pako@1',
    encryption: 'AES-GCM'
  }));
  const ciphertext = new Uint8Array(encrypted);
  const payload = concatBuffers(encodingMeta, iv, ciphertext);

  // POST to excalidraw.com JSON store
  const uploadResponse = await fetch('https://json.excalidraw.com/api/v2/post/', {
    method: 'POST',
    body: Buffer.from(payload)
  });

  if (!uploadResponse.ok) {
    throw new Error(`Upload to excalidraw.com failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
  }

  const uploadResult = await uploadResponse.json() as { id: string };

  // Export key as JWK to get the "k" field
  const jwk = await webcrypto.subtle.exportKey('jwk', cryptoKey);

  // Build shareable URL
  return `https://excalidraw.com/#json=${uploadResult.id},${jwk.k}`;
}
