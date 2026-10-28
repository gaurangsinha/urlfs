function uleb128Encode(val) {
  const bytes = [];
  do {
    let b = val & 0x7f;
    val >>>= 7;
    if (val !== 0) b |= 0x80;
    bytes.push(b);
  } while (val !== 0);
  return bytes;
}

function uleb128Decode(bytes, offset) {
  let result = 0;
  let shift = 0;
  while (true) {
    if (offset >= bytes.length) throw new Error("Unexpected EOF reading LEB128");
    const b = bytes[offset++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [result, offset];
}

async function serializeVFS(vfs) {
  const enc = new TextEncoder();
  const entriesToSerialize = [];

  for (const [path, data] of vfs.entries()) {
    // Exclude /tmp/* and /tmp
    if (path === '/tmp' || path.startsWith('/tmp/')) continue;
    // Strip leading slash
    const normPath = path.replace(/^\/+/, '');
    const pathBytes = enc.encode(normPath);
    entriesToSerialize.push({ pathBytes, data });
  }

  // Header: 0x55, 0x46, 0x01
  const parts = [[0x55, 0x46, 0x01]];
  // Entry count LEB128
  parts.push(uleb128Encode(entriesToSerialize.length));

  for (const entry of entriesToSerialize) {
    parts.push(uleb128Encode(entry.pathBytes.length));
    parts.push(Array.from(entry.pathBytes));
    parts.push(uleb128Encode(entry.data.length));
    parts.push(Array.from(entry.data));
  }

  const rawBytes = new Uint8Array(parts.flat(Infinity));

  // Compress deflate-raw
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(rawBytes);
  writer.close();
  const compressedBuffer = await new Response(cs.readable).arrayBuffer();
  const compressedBytes = new Uint8Array(compressedBuffer);

  // Convert to Base64URL
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < compressedBytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, compressedBytes.subarray(i, i + chunkSize));
  }
  const base64 = btoa(binary);
  const base64url = base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  return {
    rawBytes,
    compressedBytes,
    base64url
  };
}

async function deserializeVFS(base64url, vfs) {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) base64 += '=';
  const binary = atob(base64);
  const compressedBytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    compressedBytes[i] = binary.charCodeAt(i);
  }

  // Decompress deflate-raw
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(compressedBytes);
  writer.close();
  const rawBuffer = await new Response(ds.readable).arrayBuffer();
  const rawBytes = new Uint8Array(rawBuffer);

  // Check header
  if (rawBytes.length < 3 || rawBytes[0] !== 0x55 || rawBytes[1] !== 0x46 || rawBytes[2] !== 0x01) {
    throw new Error("Invalid urlfs binary header");
  }

  let offset = 3;
  let entryCount;
  [entryCount, offset] = uleb128Decode(rawBytes, offset);

  const dec = new TextDecoder();
  for (let i = 0; i < entryCount; i++) {
    let pathLen;
    [pathLen, offset] = uleb128Decode(rawBytes, offset);
    const pathStr = dec.decode(rawBytes.subarray(offset, offset + pathLen));
    offset += pathLen;

    let dataLen;
    [dataLen, offset] = uleb128Decode(rawBytes, offset);
    const dataBytes = rawBytes.slice(offset, offset + dataLen);
    offset += dataLen;

    const fullPath = '/' + pathStr.replace(/^\/+/, '');
    vfs.set(fullPath, dataBytes);
  }
}

// Test serialization & deserialization
(async () => {
  const { VFS } = require('./src/worker.js');
  const v1 = new VFS();
  v1.set('/main.wasm', new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  v1.set('/count.txt', '42\n');
  v1.set('/etc/cmdline', '--step 2');
  v1.set('/tmp/scratch.bin', 'should be omitted');

  console.log("Original entries in VFS:");
  for (const [p, d] of v1.entries()) console.log(" ", p, d.length);

  const { rawBytes, compressedBytes, base64url } = await serializeVFS(v1);
  console.log("Uncompressed size:", rawBytes.length);
  console.log("Compressed size:", compressedBytes.length);
  console.log("Base64URL length:", base64url.length);
  console.log("Payload:", base64url.slice(0, 50) + "...");

  const v2 = new VFS();
  await deserializeVFS(base64url, v2);

  console.log("Deserialized entries in VFS:");
  for (const [p, d] of v2.entries()) {
    console.log(" ", p, d.length, new TextDecoder().decode(d));
  }

  // Check /tmp is excluded
  if (v2.has('/tmp/scratch.bin')) {
    console.error("FAIL: /tmp/scratch.bin was not excluded!");
  } else {
    console.log("PASS: /tmp/scratch.bin excluded correctly!");
  }
  if (new TextDecoder().decode(v2.get('/count.txt')) === '42\n') {
    console.log("PASS: /count.txt content preserved exactly!");
  } else {
    console.error("FAIL: /count.txt content mismatched!");
  }
})();
