class VFS {
  constructor() {
    this.files = new Map();
    this.dirs = new Set(["/"]);
  }
  normalizePath(p) {
    if (!p) return "/";
    while (p.startsWith("/")) p = p.slice(1);
    const parts = p.split("/").filter(x => x.length > 0 && x !== ".");
    const res = [];
    for (const part of parts) {
      if (part === "..") { if (res.length > 0) res.pop(); }
      else { res.push(part); }
    }
    return "/" + res.join("/");
  }
  get(p) { return this.files.get(this.normalizePath(p)); }
  set(p, data) {
    if (typeof data === "string") data = new TextEncoder().encode(data);
    this.files.set(this.normalizePath(p), data);
  }
  has(p) { return this.files.has(this.normalizePath(p)); }
  delete(p) { return this.files.delete(this.normalizePath(p)); }
  createDir(p) { this.dirs.add(this.normalizePath(p)); }
  deleteDir(p) { this.dirs.delete(this.normalizePath(p)); }
  entries() { return Array.from(this.files.entries()); }
  keys() { return this.files.keys(); }
  isDir(p) {
    const norm = this.normalizePath(p);
    if (norm === "/" || this.dirs.has(norm)) return true;
    const prefix = norm + "/";
    for (const k of this.files.keys()) {
      if (k.startsWith(prefix)) return true;
    }
    for (const d of this.dirs) {
      if (d !== norm && d.startsWith(prefix)) return true;
    }
    return false;
  }
  readDir(p) {
    const norm = this.normalizePath(p);
    const prefix = norm === "/" ? "/" : norm + "/";
    const map = new Map();
    for (const k of this.files.keys()) {
      if (k.startsWith(prefix)) {
        const rest = k.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash !== -1) map.set(rest.slice(0, slash), "dir");
        else map.set(rest, "file");
      }
    }
    for (const d of this.dirs) {
      if (d !== norm && d.startsWith(prefix)) {
        const rest = d.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash !== -1) map.set(rest.slice(0, slash), "dir");
        else if (rest.length > 0) map.set(rest, "dir");
      }
    }
    return Array.from(map.entries()).map(([name, type]) => ({ name, type }));
  }
}

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
  let result = 0, shift = 0;
  while (true) {
    if (offset >= bytes.length) throw new Error("Unexpected EOF reading LEB128");
    const b = bytes[offset++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [result, offset];
}

function bytesToBase64Url(bytes) {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(base64url) {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) base64 += '=';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function serializeVFS(vfs) {
  const enc = new TextEncoder();
  const entriesToSerialize = [];

  for (const [path, data] of vfs.entries()) {
    if (path === '/tmp' || path.startsWith('/tmp/')) continue;
    const norm = path.replace(/^\/+/, '');
    entriesToSerialize.push({ pathBytes: enc.encode(norm), data });
  }

  const parts = [[0x55, 0x46, 0x01]];
  parts.push(uleb128Encode(entriesToSerialize.length));

  for (const entry of entriesToSerialize) {
    parts.push(uleb128Encode(entry.pathBytes.length));
    parts.push(Array.from(entry.pathBytes));
    parts.push(uleb128Encode(entry.data.length));
    parts.push(Array.from(entry.data));
  }

  const rawBytes = new Uint8Array(parts.flat(Infinity));

  let compressedBytes;
  try {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(rawBytes);
    writer.close();
    compressedBytes = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  } catch (err) {
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    writer.write(rawBytes);
    writer.close();
    const full = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    compressedBytes = full.length >= 6 ? full.subarray(2, full.length - 4) : full;
  }

  const base64url = bytesToBase64Url(compressedBytes);
  return { rawBytes, compressedBytes, base64url };
}

async function deserializeVFS(base64url, vfs) {
  const compressedBytes = base64UrlToBytes(base64url);
  let rawBytes;
  try {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(compressedBytes);
    writer.close();
    rawBytes = new Uint8Array(await new Response(ds.readable).arrayBuffer());
  } catch (err) {
    throw new Error('Failed to decompress urlfs payload: ' + err.message);
  }

  if (rawBytes.length < 3 || rawBytes[0] !== 0x55 || rawBytes[1] !== 0x46 || rawBytes[2] !== 0x01) {
    throw new Error("Invalid urlfs binary header (expected 'UF' v1)");
  }

  let offset = 3;
  let count;
  [count, offset] = uleb128Decode(rawBytes, offset);
  const dec = new TextDecoder();

  for (let i = 0; i < count; i++) {
    let pathLen;
    [pathLen, offset] = uleb128Decode(rawBytes, offset);
    const pathStr = dec.decode(rawBytes.subarray(offset, offset + pathLen));
    offset += pathLen;

    let dataLen;
    [dataLen, offset] = uleb128Decode(rawBytes, offset);
    const dataBytes = rawBytes.slice(offset, offset + dataLen);
    offset += dataLen;

    vfs.set('/' + pathStr.replace(/^\/+/, ''), dataBytes);
  }
}

class WasmAssembler {
  constructor() {
    this.types = []; this.imports = []; this.funcs = [];
    this.exports = []; this.codes = []; this.data = []; this.memory = null;
  }
  addType(params, results) {
    const key = params.join(',') + '=>' + results.join(',');
    for (let i = 0; i < this.types.length; i++) {
      if (this.types[i].key === key) return i;
    }
    const idx = this.types.length;
    this.types.push({ key, params, results });
    return idx;
  }
  addImport(mod, name, typeIdx) {
    const idx = this.imports.length;
    this.imports.push({ mod, name, typeIdx });
    return idx;
  }
  setMemory(minPages = 2, maxPages) {
    this.memory = { min: minPages, max: maxPages };
  }
  addExport(name, kind, index) {
    this.exports.push({ name, kind, index });
  }
  addFunction(typeIdx, locals, instructions) {
    const funcIdx = this.imports.length + this.funcs.length;
    this.funcs.push(typeIdx);
    this.codes.push({ locals, instructions });
    return funcIdx;
  }
  addData(offset, bytes) {
    this.data.push({ offset, bytes });
  }
  static uleb(v) {
    const r = [];
    do { let b = v & 0x7f; v >>>= 7; if (v !== 0) b |= 0x80; r.push(b); } while (v !== 0);
    return r;
  }
  static sleb(v) {
    const r = []; let more = true;
    while (more) {
      let b = v & 0x7f; v >>= 7;
      if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) more = false;
      else b |= 0x80;
      r.push(b);
    }
    return r;
  }
  static sleb64(v) {
    if (typeof v !== 'bigint') v = BigInt(v);
    const r = []; let more = true;
    while (more) {
      let b = Number(v & 0x7fn); v >>= 7n;
      if ((v === 0n && (b & 0x40) === 0) || (v === -1n && (b & 0x40) !== 0)) more = false;
      else b |= 0x80;
      r.push(b);
    }
    return r;
  }
  build() {
    const uleb = WasmAssembler.uleb, sleb = WasmAssembler.sleb;
    const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    const sections = [];
    if (this.types.length) {
      const p = uleb(this.types.length).concat(
        this.types.flatMap(t => [0x60, ...uleb(t.params.length), ...t.params, ...uleb(t.results.length), ...t.results])
      );
      sections.push([0x01, ...uleb(p.length), ...p]);
    }
    if (this.imports.length) {
      const p = uleb(this.imports.length).concat(
        this.imports.flatMap(imp => {
          const modB = Array.from(new TextEncoder().encode(imp.mod));
          const nameB = Array.from(new TextEncoder().encode(imp.name));
          return [...uleb(modB.length), ...modB, ...uleb(nameB.length), ...nameB, 0x00, ...uleb(imp.typeIdx)];
        })
      );
      sections.push([0x02, ...uleb(p.length), ...p]);
    }
    if (this.funcs.length) {
      const p = uleb(this.funcs.length).concat(this.funcs.flatMap(t => uleb(t)));
      sections.push([0x03, ...uleb(p.length), ...p]);
    }
    if (this.memory) {
      const p = [0x01];
      if (this.memory.max !== undefined) p.push(0x01, ...uleb(this.memory.min), ...uleb(this.memory.max));
      else p.push(0x00, ...uleb(this.memory.min));
      sections.push([0x05, ...uleb(p.length), ...p]);
    }
    if (this.exports.length) {
      const p = uleb(this.exports.length).concat(
        this.exports.flatMap(exp => {
          const nameB = Array.from(new TextEncoder().encode(exp.name));
          return [...uleb(nameB.length), ...nameB, exp.kind, ...uleb(exp.index)];
        })
      );
      sections.push([0x07, ...uleb(p.length), ...p]);
    }
    if (this.codes.length) {
      const p = uleb(this.codes.length).concat(
        this.codes.flatMap(c => {
          const locVec = uleb(c.locals.length).concat(c.locals.flatMap(l => [...uleb(l[0]), l[1]]));
          const body = [...locVec, ...c.instructions.flat(Infinity), 0x0b];
          return [...uleb(body.length), ...body];
        })
      );
      sections.push([0x0a, ...uleb(p.length), ...p]);
    }
    if (this.data.length) {
      const p = uleb(this.data.length).concat(
        this.data.flatMap(d => [0x00, 0x41, ...sleb(d.offset), 0x0b, ...uleb(d.bytes.length), ...d.bytes])
      );
      sections.push([0x0b, ...uleb(p.length), ...p]);
    }
    return new Uint8Array(magic.concat(...sections));
  }
}

const OP = {
  unreachable: 0x00, nop: 0x01, block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0B,
  br: 0x0C, br_if: 0x0D, return: 0x0F, call: 0x10, drop: 0x1A,
  local_get: 0x20, local_set: 0x21, local_tee: 0x22,
  i32_load: 0x28, i64_load: 0x29, i32_load8_u: 0x2D, i32_store: 0x36, i32_store8: 0x3A, i64_store: 0x37,
  i32_const: 0x41, i64_const: 0x42,
  i32_eqz: 0x45, i32_eq: 0x46, i32_ne: 0x47, i32_lt_s: 0x48, i32_lt_u: 0x49,
  i32_gt_s: 0x4A, i32_gt_u: 0x4B, i32_le_s: 0x4C, i32_le_u: 0x4D, i32_ge_s: 0x4E, i32_ge_u: 0x4F,
  i32_add: 0x6A, i32_sub: 0x6B, i32_mul: 0x6C, i32_div_u: 0x6E, i32_rem_u: 0x70,
  i32_and: 0x71, i32_or: 0x72, i32_xor: 0x73,
};

const I = {
  const: (v) => [OP.i32_const, ...WasmAssembler.sleb(v)],
  const64: (v) => [OP.i64_const, ...WasmAssembler.sleb64(v)],
  get: (idx) => [OP.local_get, ...WasmAssembler.uleb(idx)],
  set: (idx) => [OP.local_set, ...WasmAssembler.uleb(idx)],
  tee: (idx) => [OP.local_tee, ...WasmAssembler.uleb(idx)],
  call: (idx) => [OP.call, ...WasmAssembler.uleb(idx)],
  drop: () => [OP.drop],
  load: (offset = 0) => [OP.i32_load, 2, ...WasmAssembler.uleb(offset)],
  load64: (offset = 0) => [OP.i64_load, 3, ...WasmAssembler.uleb(offset)],
  load8_u: (offset = 0) => [OP.i32_load8_u, 0, ...WasmAssembler.uleb(offset)],
  store: (offset = 0) => [OP.i32_store, 2, ...WasmAssembler.uleb(offset)],
  store8: (offset = 0) => [OP.i32_store8, 0, ...WasmAssembler.uleb(offset)],
  store64: (offset = 0) => [OP.i64_store, 3, ...WasmAssembler.uleb(offset)],
  add: () => [OP.i32_add],
  sub: () => [OP.i32_sub],
  mul: () => [OP.i32_mul],
  div_u: () => [OP.i32_div_u],
  rem_u: () => [OP.i32_rem_u],
  and: () => [OP.i32_and],
  or: () => [OP.i32_or],
  xor: () => [OP.i32_xor],
  eqz: () => [OP.i32_eqz],
  eq: () => [OP.i32_eq],
  ne: () => [OP.i32_ne],
  lt_s: () => [OP.i32_lt_s],
  lt_u: () => [OP.i32_lt_u],
  gt_s: () => [OP.i32_gt_s],
  gt_u: () => [OP.i32_gt_u],
  le_s: () => [OP.i32_le_s],
  le_u: () => [OP.i32_le_u],
  ge_s: () => [OP.i32_ge_s],
  ge_u: () => [OP.i32_ge_u],
  block: () => [OP.block, 0x40],
  loop: () => [OP.loop, 0x40],
  if: () => [OP.if, 0x40],
  else: () => [OP.else],
  end: () => [OP.end],
  br: (d) => [OP.br, ...WasmAssembler.uleb(d)],
  br_if: (d) => [OP.br_if, ...WasmAssembler.uleb(d)],
  return: () => [OP.return],
};

function buildCounterWasm() {
  const wb = new WasmAssembler();
  const i32 = 0x7f, i64 = 0x7e;
  const t_v_v = wb.addType([], []);
  const t_ii_i = wb.addType([i32, i32], [i32]);
  const t_wasi_write = wb.addType([i32, i32, i32, i32], [i32]);
  const t_wasi_read = wb.addType([i32, i32, i32, i32], [i32]);
  const t_wasi_open = wb.addType([i32, i32, i32, i32, i32, i64, i64, i32, i32], [i32]);
  const t_wasi_close = wb.addType([i32], [i32]);
  const t_wasi_seek = wb.addType([i32, i64, i32, i32], [i32]);
  const t_wasi_exit = wb.addType([i32], []);

  const f_fd_write = wb.addImport('wasi_snapshot_preview1', 'fd_write', t_wasi_write);
  const f_fd_read = wb.addImport('wasi_snapshot_preview1', 'fd_read', t_wasi_read);
  const f_path_open = wb.addImport('wasi_snapshot_preview1', 'path_open', t_wasi_open);
  const f_fd_close = wb.addImport('wasi_snapshot_preview1', 'fd_close', t_wasi_close);
  const f_fd_seek = wb.addImport('wasi_snapshot_preview1', 'fd_seek', t_wasi_seek);
  const f_proc_exit = wb.addImport('wasi_snapshot_preview1', 'proc_exit', t_wasi_exit);

  wb.setMemory(2);
  wb.addExport('memory', 0x02, 0);

  const enc = new TextEncoder();
  const countFile = Array.from(enc.encode("count.txt"));
  const PATH_COUNT_OFFSET = 2048;
  wb.addData(PATH_COUNT_OFFSET, countFile);

  const banner1 = Array.from(enc.encode(
    "\n\x1b[1;36m╔══════════════════════════════════════════════════════════════════╗\x1b[0m\n" +
    "\x1b[1;36m║\x1b[0m            \x1b[1;33m⚡  urlfs STATEFUL URL COUNTER DEMO  ⚡\x1b[0m               \x1b[1;36m║\x1b[0m\n" +
    "\x1b[1;36m╚══════════════════════════════════════════════════════════════════╝\x1b[0m\n\n" +
    "  \x1b[32m▶\x1b[0m Current Run Count: \x1b[1;32m"
  ));
  const BANNER1_OFFSET = 2100;
  wb.addData(BANNER1_OFFSET, banner1);

  const banner2 = Array.from(enc.encode(
    "\x1b[0m\n\n" +
    "  \x1b[34m✓\x1b[0m Virtual filesystem mutated: \x1b[33m/count.txt\x1b[0m\n" +
    "  \x1b[34m✓\x1b[0m URL hash synchronized:      \x1b[2mlocation.hash (#UF...)\x1b[0m\n\n" +
    "  \x1b[90mTip: Click \x1b[1;37mRun (⌘↵)\x1b[90m again or reload this tab to see state persist.\x1b[0m\n\n"
  ));
  const BANNER2_OFFSET = 3000;
  wb.addData(BANNER2_OFFSET, banner2);

  const f_print_stdout = wb.addFunction(t_ii_i, [], [
    I.const(16), I.get(0), I.store(),
    I.const(20), I.get(1), I.store(),
    I.const(1), I.const(16), I.const(1), I.const(24),
    I.call(f_fd_write)
  ]);

  const f_format_int = wb.addFunction(t_ii_i, [[6, i32]], [
    I.get(0), I.eqz(),
    I.if(),
      I.get(1), I.const(48), I.store8(),
      I.const(1), I.return(),
    I.end(),
    I.get(0), I.set(3),
    I.const(0), I.set(4),
    I.loop(),
      I.get(1), I.get(4), I.add(),
      I.get(3), I.const(10), I.rem_u(), I.const(48), I.add(),
      I.store8(),
      I.get(3), I.const(10), I.div_u(), I.set(3),
      I.get(4), I.const(1), I.add(), I.set(4),
      I.get(3), I.const(0), I.gt_u(),
      I.br_if(0),
    I.end(),
    I.const(0), I.set(5),
    I.get(4), I.const(1), I.sub(), I.set(6),
    I.block(),
      I.loop(),
        I.get(5), I.get(6), I.ge_s(),
        I.br_if(1),
        I.get(1), I.get(5), I.add(), I.load8_u(), I.set(7),
        I.get(1), I.get(5), I.add(),
        I.get(1), I.get(6), I.add(), I.load8_u(),
        I.store8(),
        I.get(1), I.get(6), I.add(), I.get(7), I.store8(),
        I.get(5), I.const(1), I.add(), I.set(5),
        I.get(6), I.const(1), I.sub(), I.set(6),
        I.br(0),
      I.end(),
    I.end(),
    I.get(4), I.return()
  ]);

  const f_start = wb.addFunction(t_v_v, [[5, i32]], [
    I.const(3), I.const(0), I.const(PATH_COUNT_OFFSET), I.const(9), I.const(1),
    I.const64(0x1fffffffn), I.const64(0x1fffffffn), I.const(0), I.const(0),
    I.call(f_path_open),
    I.drop(),

    I.const(0), I.load(), I.set(0),

    I.const(16), I.const(100), I.store(),
    I.const(20), I.const(32), I.store(),
    I.get(0), I.const(16), I.const(1), I.const(4), I.call(f_fd_read),
    I.drop(),

    I.const(0), I.set(1),
    I.const(0), I.set(4),
    I.block(),
      I.loop(),
        I.get(4), I.const(4), I.load(), I.ge_s(),
        I.br_if(1),
        I.const(100), I.get(4), I.add(), I.load8_u(), I.set(3),
        I.get(3), I.const(48), I.lt_s(), I.br_if(1),
        I.get(3), I.const(57), I.gt_s(), I.br_if(1),
        I.get(1), I.const(10), I.mul(), I.get(3), I.const(48), I.sub(), I.add(), I.set(1),
        I.get(4), I.const(1), I.add(), I.set(4),
        I.br(0),
      I.end(),
    I.end(),

    I.get(1), I.const(1), I.add(), I.set(1),

    I.get(1), I.const(100), I.call(f_format_int), I.set(2),
    I.const(100), I.get(2), I.add(), I.const(10), I.store8(),
    I.get(2), I.const(1), I.add(), I.set(2),

    I.get(0), I.const64(0n), I.const(0), I.const(8), I.call(f_fd_seek),
    I.drop(),

    I.const(16), I.const(100), I.store(),
    I.const(20), I.get(2), I.store(),
    I.get(0), I.const(16), I.const(1), I.const(4), I.call(f_fd_write),
    I.drop(),

    I.get(0), I.call(f_fd_close),
    I.drop(),

    I.const(BANNER1_OFFSET), I.const(banner1.length), I.call(f_print_stdout),
    I.drop(),

    I.const(100), I.get(2), I.const(1), I.sub(), I.call(f_print_stdout),
    I.drop(),

    I.const(BANNER2_OFFSET), I.const(banner2.length), I.call(f_print_stdout),
    I.drop(),

    I.const(0), I.call(f_proc_exit)
  ]);

  wb.addExport('_start', 0x00, f_start);
  return wb.build();
}

function buildCliEchoWasm() {
  const wb = new WasmAssembler();
  const i32 = 0x7f, i64 = 0x7e;

  const t_v_v = wb.addType([], []);
  const t_ii_i = wb.addType([i32, i32], [i32]);
  const t_wasi_args_sizes = wb.addType([i32, i32], [i32]);
  const t_wasi_args_get = wb.addType([i32, i32], [i32]);
  const t_wasi_write = wb.addType([i32, i32, i32, i32], [i32]);
  const t_wasi_read = wb.addType([i32, i32, i32, i32], [i32]);
  const t_wasi_open = wb.addType([i32, i32, i32, i32, i32, i64, i64, i32, i32], [i32]);
  const t_wasi_close = wb.addType([i32], [i32]);
  const t_wasi_exit = wb.addType([i32], []);

  const f_args_sizes = wb.addImport('wasi_snapshot_preview1', 'args_sizes_get', t_wasi_args_sizes);
  const f_args_get = wb.addImport('wasi_snapshot_preview1', 'args_get', t_wasi_args_get);
  const f_fd_write = wb.addImport('wasi_snapshot_preview1', 'fd_write', t_wasi_write);
  const f_fd_read = wb.addImport('wasi_snapshot_preview1', 'fd_read', t_wasi_read);
  const f_path_open = wb.addImport('wasi_snapshot_preview1', 'path_open', t_wasi_open);
  const f_fd_close = wb.addImport('wasi_snapshot_preview1', 'fd_close', t_wasi_close);
  const f_proc_exit = wb.addImport('wasi_snapshot_preview1', 'proc_exit', t_wasi_exit);

  wb.setMemory(2);
  wb.addExport('memory', 0x02, 0);

  const enc = new TextEncoder();
  const fileInput = Array.from(enc.encode("input.txt"));
  const fileOutput = Array.from(enc.encode("output.txt"));
  const banner = Array.from(enc.encode(
    "\n\x1b[1;35m╔══════════════════════════════════════════════════════════════════╗\x1b[0m\n" +
    "\x1b[1;35m║\x1b[0m          \x1b[1;33m⚡  urlfs CLI ARGUMENT & STREAM PROCESSOR  ⚡\x1b[0m          \x1b[1;35m║\x1b[0m\n" +
    "\x1b[1;35m╚══════════════════════════════════════════════════════════════════╝\x1b[0m\n\n"
  ));
  const tagArgs = Array.from(enc.encode("  \x1b[36m▶ Command-line arguments (/etc/cmdline):\x1b[0m\n"));
  const tagArrow = Array.from(enc.encode("    \x1b[90m•\x1b[0m argv["));
  const tagClose = Array.from(enc.encode("] = \x1b[33m\""));
  const tagQuoteNl = Array.from(enc.encode("\"\x1b[0m\n"));
  const tagTransform = Array.from(enc.encode("\n  \x1b[32m▶ Processing Stream: /input.txt ➔ /output.txt ...\x1b[0m\n"));
  const tagDone = Array.from(enc.encode("  \x1b[34m✓ Pipeline complete!\x1b[0m Output written and synced to URL hash.\n\n"));

  const OFF_INPUT_NAME = 2048; wb.addData(OFF_INPUT_NAME, fileInput);
  const OFF_OUTPUT_NAME = 2060; wb.addData(OFF_OUTPUT_NAME, fileOutput);
  const OFF_BANNER = 2100; wb.addData(OFF_BANNER, banner);
  const OFF_TAG_ARGS = 2600; wb.addData(OFF_TAG_ARGS, tagArgs);
  const OFF_TAG_ARROW = 2700; wb.addData(OFF_TAG_ARROW, tagArrow);
  const OFF_TAG_CLOSE = 2750; wb.addData(OFF_TAG_CLOSE, tagClose);
  const OFF_TAG_QUOTENL = 2800; wb.addData(OFF_TAG_QUOTENL, tagQuoteNl);
  const OFF_TAG_TRANS = 2850; wb.addData(OFF_TAG_TRANS, tagTransform);
  const OFF_TAG_DONE = 2950; wb.addData(OFF_TAG_DONE, tagDone);

  const f_print_stdout = wb.addFunction(t_ii_i, [], [
    I.const(16), I.get(0), I.store(),
    I.const(20), I.get(1), I.store(),
    I.const(1), I.const(16), I.const(1), I.const(24),
    I.call(f_fd_write)
  ]);

  const f_strlen = wb.addFunction(t_ii_i, [[1, i32]], [
    I.const(0), I.set(1),
    I.block(),
      I.loop(),
        I.get(0), I.get(1), I.add(), I.load8_u(),
        I.eqz(),
        I.br_if(1),
        I.get(1), I.const(1), I.add(), I.set(1),
        I.br(0),
      I.end(),
    I.end(),
    I.get(1), I.return()
  ]);

  const f_format_int = wb.addFunction(t_ii_i, [[6, i32]], [
    I.get(0), I.eqz(),
    I.if(),
      I.get(1), I.const(48), I.store8(),
      I.const(1), I.return(),
    I.end(),
    I.get(0), I.set(3),
    I.const(0), I.set(4),
    I.loop(),
      I.get(1), I.get(4), I.add(),
      I.get(3), I.const(10), I.rem_u(), I.const(48), I.add(),
      I.store8(),
      I.get(3), I.const(10), I.div_u(), I.set(3),
      I.get(4), I.const(1), I.add(), I.set(4),
      I.get(3), I.const(0), I.gt_u(),
      I.br_if(0),
    I.end(),
    I.const(0), I.set(5),
    I.get(4), I.const(1), I.sub(), I.set(6),
    I.block(),
      I.loop(),
        I.get(5), I.get(6), I.ge_s(),
        I.br_if(1),
        I.get(1), I.get(5), I.add(), I.load8_u(), I.set(7),
        I.get(1), I.get(5), I.add(),
        I.get(1), I.get(6), I.add(), I.load8_u(),
        I.store8(),
        I.get(1), I.get(6), I.add(), I.get(7), I.store8(),
        I.get(5), I.const(1), I.add(), I.set(5),
        I.get(6), I.const(1), I.sub(), I.set(6),
        I.br(0),
      I.end(),
    I.end(),
    I.get(4), I.return()
  ]);

  const f_start = wb.addFunction(t_v_v, [[8, i32]], [
    I.const(OFF_BANNER), I.const(banner.length), I.call(f_print_stdout), I.drop(),
    I.const(OFF_TAG_ARGS), I.const(tagArgs.length), I.call(f_print_stdout), I.drop(),

    I.const(0), I.const(4), I.call(f_args_sizes), I.drop(),
    I.const(0), I.load(), I.set(0),

    I.const(512), I.const(1024), I.call(f_args_get), I.drop(),

    I.const(0), I.set(1),
    I.block(),
      I.loop(),
        I.get(1), I.get(0), I.ge_s(), I.br_if(1),
        I.const(512), I.get(1), I.const(4), I.mul(), I.add(), I.load(), I.set(2),
        I.get(2), I.const(0), I.call(f_strlen), I.set(3),

        I.const(OFF_TAG_ARROW), I.const(tagArrow.length), I.call(f_print_stdout), I.drop(),
        I.get(1), I.const(32), I.call(f_format_int), I.set(7),
        I.const(32), I.get(7), I.call(f_print_stdout), I.drop(),
        I.const(OFF_TAG_CLOSE), I.const(tagClose.length), I.call(f_print_stdout), I.drop(),
        I.get(2), I.get(3), I.call(f_print_stdout), I.drop(),
        I.const(OFF_TAG_QUOTENL), I.const(tagQuoteNl.length), I.call(f_print_stdout), I.drop(),

        I.get(1), I.const(1), I.add(), I.set(1),
        I.br(0),
      I.end(),
    I.end(),

    I.const(OFF_TAG_TRANS), I.const(tagTransform.length), I.call(f_print_stdout), I.drop(),

    I.const(3), I.const(0), I.const(OFF_INPUT_NAME), I.const(9), I.const(0),
    I.const64(0x1fffffffn), I.const64(0x1fffffffn), I.const(0), I.const(8),
    I.call(f_path_open), I.drop(),
    I.const(8), I.load(), I.set(4),

    I.const(16), I.const(4096), I.store(),
    I.const(20), I.const(4096), I.store(),
    I.get(4), I.const(16), I.const(1), I.const(12), I.call(f_fd_read), I.drop(),
    I.const(12), I.load(), I.set(6),

    I.get(4), I.call(f_fd_close), I.drop(),

    I.const(0), I.set(1),
    I.block(),
      I.loop(),
        I.get(1), I.get(6), I.ge_s(), I.br_if(1),
        I.const(4096), I.get(1), I.add(), I.load8_u(), I.set(7),
        I.get(7), I.const(97), I.ge_s(),
        I.if(),
          I.get(7), I.const(122), I.le_s(),
          I.if(),
            I.const(4096), I.get(1), I.add(),
            I.get(7), I.const(32), I.sub(),
            I.store8(),
          I.end(),
        I.end(),
        I.get(1), I.const(1), I.add(), I.set(1),
        I.br(0),
      I.end(),
    I.end(),

    I.const(3), I.const(0), I.const(OFF_OUTPUT_NAME), I.const(10), I.const(9),
    I.const64(0x1fffffffn), I.const64(0x1fffffffn), I.const(0), I.const(8),
    I.call(f_path_open), I.drop(),
    I.const(8), I.load(), I.set(5),

    I.const(16), I.const(4096), I.store(),
    I.const(20), I.get(6), I.store(),
    I.get(5), I.const(16), I.const(1), I.const(12), I.call(f_fd_write), I.drop(),

    I.get(5), I.call(f_fd_close), I.drop(),

    I.const(OFF_TAG_DONE), I.const(tagDone.length), I.call(f_print_stdout), I.drop(),
    I.const(0), I.call(f_proc_exit)
  ]);

  wb.addExport('_start', 0x00, f_start);
  return wb.build();
}

function buildLoggerWasm() {
  const wb = new WasmAssembler();
  const i32 = 0x7f, i64 = 0x7e;

  const t_v_v = wb.addType([], []);
  const t_ii_i = wb.addType([i32, i32], [i32]);
  const t_wasi_clock = wb.addType([i32, i64, i32], [i32]);
  const t_wasi_rand = wb.addType([i32, i32], [i32]);
  const t_wasi_write = wb.addType([i32, i32, i32, i32], [i32]);
  const t_wasi_open = wb.addType([i32, i32, i32, i32, i32, i64, i64, i32, i32], [i32]);
  const t_wasi_close = wb.addType([i32], [i32]);
  const t_wasi_seek = wb.addType([i32, i64, i32, i32], [i32]);
  const t_wasi_exit = wb.addType([i32], []);

  const f_clock = wb.addImport('wasi_snapshot_preview1', 'clock_time_get', t_wasi_clock);
  const f_rand = wb.addImport('wasi_snapshot_preview1', 'random_get', t_wasi_rand);
  const f_fd_write = wb.addImport('wasi_snapshot_preview1', 'fd_write', t_wasi_write);
  const f_path_open = wb.addImport('wasi_snapshot_preview1', 'path_open', t_wasi_open);
  const f_fd_close = wb.addImport('wasi_snapshot_preview1', 'fd_close', t_wasi_close);
  const f_fd_seek = wb.addImport('wasi_snapshot_preview1', 'fd_seek', t_wasi_seek);
  const f_proc_exit = wb.addImport('wasi_snapshot_preview1', 'proc_exit', t_wasi_exit);

  wb.setMemory(2);
  wb.addExport('memory', 0x02, 0);

  const enc = new TextEncoder();
  const fileLog = Array.from(enc.encode("log.txt"));
  const fileScratch = Array.from(enc.encode("tmp/scratch.bin"));
  const banner = Array.from(enc.encode(
    "\n\x1b[1;32m╔══════════════════════════════════════════════════════════════════╗\x1b[0m\n" +
    "\x1b[1;32m║\x1b[0m      \x1b[1;33m⚡  urlfs EPHEMERAL SCRATCH VS PERSISTENT LOG  ⚡\x1b[0m         \x1b[1;32m║\x1b[0m\n" +
    "\x1b[1;32m╚══════════════════════════════════════════════════════════════════╝\x1b[0m\n\n"
  ));
  const tagAppended = Array.from(enc.encode(
    "  \x1b[32m✓ Appended\x1b[0m event record to \x1b[1;33m/log.txt\x1b[0m (PERSISTED in URL hash)\n" +
    "  \x1b[35m✓ Generated\x1b[0m 64-byte buffer in \x1b[1;35m/tmp/scratch.bin\x1b[0m \x1b[31m[EPHEMERAL]\x1b[0m\n\n" +
    "  \x1b[90mObservation:\x1b[0m\n" +
    "  • \x1b[1m/tmp/scratch.bin\x1b[0m exists in memory during execution but is \x1b[1;31mEXCLUDED\x1b[0m from URL.\n" +
    "  • Check the VFS Tree in Workbench (\x1b[1m⌘I / Ctrl+I\x1b[0m) to see the ephemeral badge!\n\n"
  ));

  const OFF_FILE_LOG = 2048; wb.addData(OFF_FILE_LOG, fileLog);
  const OFF_FILE_SCRATCH = 2060; wb.addData(OFF_FILE_SCRATCH, fileScratch);
  const OFF_BANNER = 2100; wb.addData(OFF_BANNER, banner);
  const OFF_TAG_APP = 2600; wb.addData(OFF_TAG_APP, tagAppended);

  const f_print_stdout = wb.addFunction(t_ii_i, [], [
    I.const(16), I.get(0), I.store(),
    I.const(20), I.get(1), I.store(),
    I.const(1), I.const(16), I.const(1), I.const(24),
    I.call(f_fd_write)
  ]);

  const f_start = wb.addFunction(t_v_v, [[3, i32]], [
    I.const(OFF_BANNER), I.const(banner.length), I.call(f_print_stdout), I.drop(),

    I.const(0), I.const64(0n), I.const(32), I.call(f_clock), I.drop(),
    I.const(48), I.const(16), I.call(f_rand), I.drop(),

    I.const(100), I.const(91), I.store8(),
    I.const(101), I.const(69), I.store8(),
    I.const(102), I.const(86), I.store8(),
    I.const(103), I.const(69), I.store8(),
    I.const(104), I.const(78), I.store8(),
    I.const(105), I.const(84), I.store8(),
    I.const(106), I.const(93), I.store8(),
    I.const(107), I.const(32), I.store8(),
    I.const(108), I.const(116), I.store8(),
    I.const(109), I.const(105), I.store8(),
    I.const(110), I.const(99), I.store8(),
    I.const(111), I.const(107), I.store8(),
    I.const(112), I.const(32), I.store8(),
    I.const(113), I.const(35), I.store8(),

    I.const(0), I.set(2),
    I.block(),
      I.loop(),
        I.get(2), I.const(8), I.ge_s(), I.br_if(1),
        I.const(114), I.get(2), I.add(),
        I.const(48), I.const(48), I.get(2), I.add(), I.load8_u(), I.const(10), I.rem_u(), I.add(),
        I.store8(),
        I.get(2), I.const(1), I.add(), I.set(2),
        I.br(0),
      I.end(),
    I.end(),
    I.const(122), I.const(10), I.store8(),

    I.const(3), I.const(0), I.const(OFF_FILE_LOG), I.const(7), I.const(1),
    I.const64(0x1fffffffn), I.const64(0x1fffffffn), I.const(0), I.const(0),
    I.call(f_path_open), I.drop(),
    I.const(0), I.load(), I.set(0),

    I.get(0), I.const64(0n), I.const(2), I.const(8), I.call(f_fd_seek), I.drop(),

    I.const(16), I.const(100), I.store(),
    I.const(20), I.const(23), I.store(),
    I.get(0), I.const(16), I.const(1), I.const(8), I.call(f_fd_write), I.drop(),

    I.get(0), I.call(f_fd_close), I.drop(),

    I.const(3), I.const(0), I.const(OFF_FILE_SCRATCH), I.const(15), I.const(9),
    I.const64(0x1fffffffn), I.const64(0x1fffffffn), I.const(0), I.const(0),
    I.call(f_path_open), I.drop(),
    I.const(0), I.load(), I.set(1),

    I.const(0), I.set(2),
    I.block(),
      I.loop(),
        I.get(2), I.const(64), I.ge_s(), I.br_if(1),
        I.const(512), I.get(2), I.add(),
        I.get(2), I.const(65), I.add(),
        I.store8(),
        I.get(2), I.const(1), I.add(), I.set(2),
        I.br(0),
      I.end(),
    I.end(),

    I.const(16), I.const(512), I.store(),
    I.const(20), I.const(64), I.store(),
    I.get(1), I.const(16), I.const(1), I.const(8), I.call(f_fd_write), I.drop(),

    I.get(1), I.call(f_fd_close), I.drop(),

    I.const(OFF_TAG_APP), I.const(tagAppended.length), I.call(f_print_stdout), I.drop(),
    I.const(0), I.call(f_proc_exit)
  ]);

  wb.addExport('_start', 0x00, f_start);
  return wb.build();
}

function buildBusyBoxWasm() {
  const wb = new WasmAssembler();
  const i32 = 0x7f, i64 = 0x7e;

  const t_v_v = wb.addType([], []);
  const t_i_v = wb.addType([i32], []);
  const t_i_i = wb.addType([i32], [i32]);
  const t_ii_i = wb.addType([i32, i32], [i32]);
  const t_wasi_args_sizes = wb.addType([i32, i32], [i32]);
  const t_wasi_args_get = wb.addType([i32, i32], [i32]);
  const t_wasi_environ_sizes = wb.addType([i32, i32], [i32]);
  const t_wasi_environ_get = wb.addType([i32, i32], [i32]);
  const t_wasi_write = wb.addType([i32, i32, i32, i32], [i32]);
  const t_wasi_read = wb.addType([i32, i32, i32, i32], [i32]);
  const t_wasi_open = wb.addType([i32, i32, i32, i32, i32, i64, i64, i32, i32], [i32]);
  const t_wasi_close = wb.addType([i32], [i32]);
  const t_wasi_unlink = wb.addType([i32, i32, i32], [i32]);
  const t_wasi_mkdir = wb.addType([i32, i32, i32], [i32]);
  const t_wasi_rename = wb.addType([i32, i32, i32, i32, i32, i32], [i32]);
  const t_wasi_readdir = wb.addType([i32, i32, i32, i64, i32], [i32]);
  const t_wasi_filestat = wb.addType([i32, i32, i32, i32, i32], [i32]);
  const t_wasi_clock = wb.addType([i32, i64, i32], [i32]);
  const t_wasi_exit = wb.addType([i32], []);

  const f_args_sizes = wb.addImport('wasi_snapshot_preview1', 'args_sizes_get', t_wasi_args_sizes);
  const f_args_get = wb.addImport('wasi_snapshot_preview1', 'args_get', t_wasi_args_get);
  const f_environ_sizes = wb.addImport('wasi_snapshot_preview1', 'environ_sizes_get', t_wasi_environ_sizes);
  const f_environ_get = wb.addImport('wasi_snapshot_preview1', 'environ_get', t_wasi_environ_get);
  const f_fd_write = wb.addImport('wasi_snapshot_preview1', 'fd_write', t_wasi_write);
  const f_fd_read = wb.addImport('wasi_snapshot_preview1', 'fd_read', t_wasi_read);
  const f_path_open = wb.addImport('wasi_snapshot_preview1', 'path_open', t_wasi_open);
  const f_fd_close = wb.addImport('wasi_snapshot_preview1', 'fd_close', t_wasi_close);
  const f_path_unlink = wb.addImport('wasi_snapshot_preview1', 'path_unlink_file', t_wasi_unlink);
  const f_path_mkdir = wb.addImport('wasi_snapshot_preview1', 'path_create_directory', t_wasi_mkdir);
  const f_path_rename = wb.addImport('wasi_snapshot_preview1', 'path_rename', t_wasi_rename);
  const f_fd_readdir = wb.addImport('wasi_snapshot_preview1', 'fd_readdir', t_wasi_readdir);
  const f_path_filestat = wb.addImport('wasi_snapshot_preview1', 'path_filestat_get', t_wasi_filestat);
  const f_clock_time = wb.addImport('wasi_snapshot_preview1', 'clock_time_get', t_wasi_clock);
  const f_proc_exit = wb.addImport('wasi_snapshot_preview1', 'proc_exit', t_wasi_exit);

  wb.setMemory(2);
  wb.addExport('memory', 0x02, 0);

  // Strings
  const enc = new TextEncoder();
  const banner = Array.from(enc.encode(
    "\n\x1b[1;36m╔══════════════════════════════════════════════════════════════════╗\x1b[0m\n" +
    "\x1b[1;36m║\x1b[0m               \x1b[1;33m🐧  urlfs BusyBox v1.36.1 (wasm32)\x1b[0m                 \x1b[1;36m║\x1b[0m\n" +
    "\x1b[1;36m║\x1b[0m      \x1b[37mMulti-call binary & interactive POSIX shell environment\x1b[0m     \x1b[1;36m║\x1b[0m\n" +
    "\x1b[1;36m╚══════════════════════════════════════════════════════════════════╝\x1b[0m\n\n" +
    "BusyBox v1.36.1 (urlfs-wasip1) multi-call binary.\n" +
    "Type '\x1b[32mhelp\x1b[0m' or '\x1b[32mbusybox\x1b[0m' to see available built-in applets.\n\n"
  ));
  const prompt = Array.from(enc.encode("\x1b[1;32murlfs\x1b[0m:\x1b[1;34m/\x1b[0m# "));
  const helpText = Array.from(enc.encode(
    "BusyBox v1.36.1 (urlfs-wasip1) multi-call binary.\n\n" +
    "Usage: busybox [applet [arguments...]]\n" +
    "   or: [applet [arguments...]]\n" +
    "   or: busybox sh (interactive POSIX shell)\n\n" +
    "Currently defined functions (30 applets):\n" +
    "\tbase64, busybox, cat, clear, cp, date, df, echo,\n" +
    "\tenv, false, free, grep, head, help, hostname, id,\n" +
    "\tls, mkdir, mv, ps, pwd, rm, sh, stat,\n" +
    "\ttail, touch, true, uname, uptime, wc, whoami\n\n"
  ));

  const strUname = Array.from(enc.encode("Linux urlfs-box 6.1.0-wasi #1 SMP wasm32 GNU/Linux\n"));
  const strWhoami = Array.from(enc.encode("root\n"));
  const strHostname = Array.from(enc.encode("urlfs-box\n"));
  const strClear = Array.from(enc.encode("\x1b[2J\x1b[H"));
  const strPwd = Array.from(enc.encode("/\n"));
  const strId = Array.from(enc.encode("uid=0(root) gid=0(root) groups=0(root),10(wheel)\n"));
  const strPs = Array.from(enc.encode("PID   USER     TIME  COMMAND\n    1 root     0:00  /sbin/init\n    2 root     0:00  /bin/sh\n    3 root     0:00  /main.wasm\n"));
  const strDf = Array.from(enc.encode("Filesystem           1K-blocks      Used Available Use% Mounted on\nurlfs-rootfs             65536         8     65528   1% /\ndevtmpfs                  1024         0      1024   0% /dev\ntmpfs                    16384         1     16383   1% /tmp\n"));
  const strFree = Array.from(enc.encode("              total        used        free      shared  buff/cache   available\nMem:         131072        5120      125952           0        1024      125952\nSwap:             0           0           0\n"));
  const strErrCmd = Array.from(enc.encode(": command not found\n"));
  const strErrNoFile = Array.from(enc.encode(": No such file or directory\n"));
  const strErrMissing = Array.from(enc.encode(": missing operand\n"));
  const strDirTag = Array.from(enc.encode("\x1b[1;34m[DIR]  \x1b[0m"));
  const strFileTag = Array.from(enc.encode("\x1b[90m[FILE] \x1b[0m"));
  const strSlash = Array.from(enc.encode("/\n"));
  const strNl = Array.from(enc.encode("\n"));
  const strSpace = Array.from(enc.encode(" "));
  const strUp = Array.from(enc.encode("up "));
  const strSecs = Array.from(enc.encode(" seconds, load average: 0.08, 0.03, 0.01\n"));
  const strRedirect = Array.from(enc.encode(">\0"));

  // Applet names
  const aBusybox = Array.from(enc.encode("busybox\0"));
  const aSh = Array.from(enc.encode("sh\0"));
  const aHelp = Array.from(enc.encode("help\0"));
  const aLs = Array.from(enc.encode("ls\0"));
  const aCat = Array.from(enc.encode("cat\0"));
  const aEcho = Array.from(enc.encode("echo\0"));
  const aTouch = Array.from(enc.encode("touch\0"));
  const aMkdir = Array.from(enc.encode("mkdir\0"));
  const aRm = Array.from(enc.encode("rm\0"));
  const aCp = Array.from(enc.encode("cp\0"));
  const aMv = Array.from(enc.encode("mv\0"));
  const aGrep = Array.from(enc.encode("grep\0"));
  const aTail = Array.from(enc.encode("tail\0"));
  const aStat = Array.from(enc.encode("stat\0"));
  const aDf = Array.from(enc.encode("df\0"));
  const aFree = Array.from(enc.encode("free\0"));
  const aId = Array.from(enc.encode("id\0"));
  const aPs = Array.from(enc.encode("ps\0"));
  const aBase64 = Array.from(enc.encode("base64\0"));
  const aTrue = Array.from(enc.encode("true\0"));
  const aFalse = Array.from(enc.encode("false\0"));
  const aPwd = Array.from(enc.encode("pwd\0"));
  const aUname = Array.from(enc.encode("uname\0"));
  const aWhoami = Array.from(enc.encode("whoami\0"));
  const aHostname = Array.from(enc.encode("hostname\0"));
  const aDate = Array.from(enc.encode("date\0"));
  const aUptime = Array.from(enc.encode("uptime\0"));
  const aWc = Array.from(enc.encode("wc\0"));
  const aHead = Array.from(enc.encode("head\0"));
  const aEnv = Array.from(enc.encode("env\0"));
  const aClear = Array.from(enc.encode("clear\0"));

  const b64chars = Array.from(enc.encode("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"));

  let off = 4096;
  function allocStr(arr) {
    const o = off;
    wb.addData(o, arr);
    off += arr.length + 4;
    return o;
  }

  const OFF_BANNER = allocStr(banner);
  const OFF_PROMPT = allocStr(prompt);
  const OFF_HELP = allocStr(helpText);
  const OFF_UNAME = allocStr(strUname);
  const OFF_WHOAMI = allocStr(strWhoami);
  const OFF_HOSTNAME = allocStr(strHostname);
  const OFF_CLEAR = allocStr(strClear);
  const OFF_PWD = allocStr(strPwd);
  const OFF_ID = allocStr(strId);
  const OFF_PS = allocStr(strPs);
  const OFF_DF = allocStr(strDf);
  const OFF_FREE = allocStr(strFree);
  const OFF_ERR_CMD = allocStr(strErrCmd);
  const OFF_ERR_NOFILE = allocStr(strErrNoFile);
  const OFF_ERR_MISSING = allocStr(strErrMissing);
  const OFF_DIR_TAG = allocStr(strDirTag);
  const OFF_FILE_TAG = allocStr(strFileTag);
  const OFF_SLASH = allocStr(strSlash);
  const OFF_NL = allocStr(strNl);
  const OFF_SPACE = allocStr(strSpace);
  const OFF_UP = allocStr(strUp);
  const OFF_SECS = allocStr(strSecs);
  const OFF_REDIRECT = allocStr(strRedirect);
  const OFF_B64CHARS = allocStr(b64chars);

  const OFF_A_BUSYBOX = allocStr(aBusybox);
  const OFF_A_SH = allocStr(aSh);
  const OFF_A_HELP = allocStr(aHelp);
  const OFF_A_LS = allocStr(aLs);
  const OFF_A_CAT = allocStr(aCat);
  const OFF_A_ECHO = allocStr(aEcho);
  const OFF_A_TOUCH = allocStr(aTouch);
  const OFF_A_MKDIR = allocStr(aMkdir);
  const OFF_A_RM = allocStr(aRm);
  const OFF_A_CP = allocStr(aCp);
  const OFF_A_MV = allocStr(aMv);
  const OFF_A_GREP = allocStr(aGrep);
  const OFF_A_TAIL = allocStr(aTail);
  const OFF_A_STAT = allocStr(aStat);
  const OFF_A_DF = allocStr(aDf);
  const OFF_A_FREE = allocStr(aFree);
  const OFF_A_ID = allocStr(aId);
  const OFF_A_PS = allocStr(aPs);
  const OFF_A_BASE64 = allocStr(aBase64);
  const OFF_A_TRUE = allocStr(aTrue);
  const OFF_A_FALSE = allocStr(aFalse);
  const OFF_A_PWD = allocStr(aPwd);
  const OFF_A_UNAME = allocStr(aUname);
  const OFF_A_WHOAMI = allocStr(aWhoami);
  const OFF_A_HOSTNAME = allocStr(aHostname);
  const OFF_A_DATE = allocStr(aDate);
  const OFF_A_UPTIME = allocStr(aUptime);
  const OFF_A_WC = allocStr(aWc);
  const OFF_A_HEAD = allocStr(aHead);
  const OFF_A_ENV = allocStr(aEnv);
  const OFF_A_CLEAR = allocStr(aClear);

  // 1. f_print_stdout(ptr, len) -> i32
  const f_print_stdout = wb.addFunction(t_ii_i, [], [
    I.const(16), I.get(0), I.store(),
    I.const(20), I.get(1), I.store(),
    I.const(1), I.const(16), I.const(1), I.const(24),
    I.call(f_fd_write),
    I.return()
  ]);

  // 2. f_strlen(ptr) -> i32
  const f_strlen = wb.addFunction(t_i_i, [[1, i32]], [
    I.const(0), I.set(1),
    I.block(),
      I.loop(),
        I.get(0), I.get(1), I.add(), I.load8_u(),
        I.eqz(),
        I.br_if(1),
        I.get(1), I.const(1), I.add(), I.set(1),
        I.br(0),
      I.end(),
    I.end(),
    I.get(1), I.return()
  ]);

  // 3. f_print_str(ptr)
  const f_print_str = wb.addFunction(t_i_v, [[1, i32]], [
    I.get(0), I.call(f_strlen), I.set(1),
    I.get(1), I.eqz(),
    I.if(), I.return(), I.end(),
    I.get(0), I.get(1), I.call(f_print_stdout), I.drop(),
    I.return()
  ]);

  // 4. f_strcmp(ptr1, ptr2) -> i32 (0 if equal)
  const f_strcmp = wb.addFunction(t_ii_i, [[2, i32]], [
    I.block(),
      I.loop(),
        I.get(0), I.load8_u(), I.set(2),
        I.get(1), I.load8_u(), I.set(3),
        I.get(2), I.get(3), I.ne(),
        I.br_if(1),
        I.get(2), I.eqz(),
        I.br_if(1),
        I.get(0), I.const(1), I.add(), I.set(0),
        I.get(1), I.const(1), I.add(), I.set(1),
        I.br(0),
      I.end(),
    I.end(),
    I.get(2), I.get(3), I.sub(), I.return()
  ]);

  // 5. f_strstr(str_ptr, pat_ptr) -> i32 (1 if found, 0 if not)
  const f_strstr = wb.addFunction(t_ii_i, [[4, i32]], [
    // 0: str, 1: pat
    // locals: 2: i, 3: j, 4: ch1, 5: ch2
    I.const(0), I.set(2),
    I.block(),
      I.loop(),
        I.get(0), I.get(2), I.add(), I.load8_u(), I.set(4),
        I.get(4), I.eqz(),
        I.br_if(1),
        I.const(0), I.set(3),
        I.block(),
          I.loop(),
            I.get(1), I.get(3), I.add(), I.load8_u(), I.set(5),
            I.get(5), I.eqz(),
            I.if(), I.const(1), I.return(), I.end(), // found
            I.get(0), I.get(2), I.add(), I.get(3), I.add(), I.load8_u(),
            I.get(5), I.ne(),
            I.br_if(1), // mismatch
            I.get(3), I.const(1), I.add(), I.set(3),
            I.br(0),
          I.end(),
        I.end(),
        I.get(2), I.const(1), I.add(), I.set(2),
        I.br(0),
      I.end(),
    I.end(),
    I.const(0), I.return()
  ]);

  // 6. f_format_int(val, buf_ptr) -> i32 (len)
  const f_format_int = wb.addFunction(t_ii_i, [[6, i32]], [
    I.get(0), I.eqz(),
    I.if(),
      I.get(1), I.const(48), I.store8(),
      I.get(1), I.const(1), I.add(), I.const(0), I.store8(),
      I.const(1), I.return(),
    I.end(),
    I.get(0), I.set(2),
    I.const(0), I.set(3),
    I.loop(),
      I.get(1), I.get(3), I.add(),
      I.get(2), I.const(10), I.rem_u(), I.const(48), I.add(),
      I.store8(),
      I.get(3), I.const(1), I.add(), I.set(3),
      I.get(2), I.const(10), I.div_u(), I.set(2),
      I.get(2), I.const(0), I.gt_u(),
      I.br_if(0),
    I.end(),
    I.const(0), I.set(4),
    I.get(3), I.const(1), I.sub(), I.set(5),
    I.block(),
      I.loop(),
        I.get(4), I.get(5), I.ge_s(),
        I.br_if(1),
        I.get(1), I.get(4), I.add(), I.load8_u(), I.set(6),
        I.get(1), I.get(4), I.add(),
        I.get(1), I.get(5), I.add(), I.load8_u(),
        I.store8(),
        I.get(1), I.get(5), I.add(), I.get(6), I.store8(),
        I.get(4), I.const(1), I.add(), I.set(4),
        I.get(5), I.const(1), I.sub(), I.set(5),
        I.br(0),
      I.end(),
    I.end(),
    I.get(1), I.get(3), I.add(), I.const(0), I.store8(),
    I.get(3), I.return()
  ]);

  // 7. f_parse_line(line_ptr, line_len) -> argc
  const f_parse_line = wb.addFunction(t_ii_i, [[4, i32]], [
    I.const(0), I.set(2),
    I.const(0), I.set(3),
    I.const(0), I.set(4),
    I.block(),
      I.loop(),
        I.get(2), I.get(1), I.ge_u(),
        I.br_if(1),
        I.get(0), I.get(2), I.add(), I.load8_u(), I.set(5),
        I.get(5), I.const(32), I.eq(),
        I.get(5), I.const(9), I.eq(), I.or(),
        I.get(5), I.const(10), I.eq(), I.or(),
        I.get(5), I.const(13), I.eq(), I.or(),
        I.if(),
          I.get(0), I.get(2), I.add(), I.const(0), I.store8(),
          I.const(0), I.set(3),
        I.else(),
          I.get(3), I.eqz(),
          I.if(),
            I.const(2048), I.get(4), I.const(4), I.mul(), I.add(),
            I.get(0), I.get(2), I.add(),
            I.store(),
            I.get(4), I.const(1), I.add(), I.set(4),
            I.const(1), I.set(3),
          I.end(),
        I.end(),
        I.get(2), I.const(1), I.add(), I.set(2),
        I.br(0),
      I.end(),
    I.end(),
    I.get(0), I.get(1), I.add(), I.const(0), I.store8(),
    I.get(4), I.return()
  ]);

  // --- Applets ---

  // echo
  const f_applet_echo = wb.addFunction(t_ii_i, [[5, i32]], [
    I.const(1), I.set(3),
    I.const(0), I.set(5),
    I.const(1), I.set(2),
    I.block(),
      I.loop(),
        I.get(2), I.get(0), I.ge_s(),
        I.br_if(1),
        I.get(1), I.get(2), I.const(4), I.mul(), I.add(), I.load(), I.set(6),
        I.get(6), I.const(OFF_REDIRECT), I.call(f_strcmp), I.eqz(),
        I.if(),
          I.get(2), I.set(5),
          I.get(2), I.const(1), I.add(), I.get(0), I.lt_s(),
          I.if(),
            I.get(1), I.get(2), I.const(1), I.add(), I.const(4), I.mul(), I.add(), I.load(), I.set(4),
            I.const(3), I.const(0), I.get(4), I.get(4), I.call(f_strlen),
            I.const(9), I.const64(0), I.const64(0), I.const(0), I.const(32),
            I.call(f_path_open),
            I.eqz(),
            I.if(),
              I.const(32), I.load(), I.set(3),
            I.end(),
          I.end(),
        I.end(),
        I.get(5), I.const(0), I.gt_s(),
        I.br_if(1),
        I.get(2), I.const(1), I.add(), I.set(2),
        I.br(0),
      I.end(),
    I.end(),

    I.const(1), I.set(2),
    I.block(),
      I.loop(),
        I.get(2), I.get(0), I.ge_s(),
        I.br_if(1),
        I.get(5), I.const(0), I.gt_s(),
        I.get(2), I.get(5), I.ge_s(),
        I.and(),
        I.br_if(1),
        I.get(1), I.get(2), I.const(4), I.mul(), I.add(), I.load(), I.set(6),
        I.const(16), I.get(6), I.store(),
        I.const(20), I.get(6), I.call(f_strlen), I.store(),
        I.get(3), I.const(16), I.const(1), I.const(24),
        I.call(f_fd_write), I.drop(),

        I.get(2), I.const(1), I.add(), I.get(0), I.lt_s(),
        I.if(),
          I.const(16), I.const(OFF_SPACE), I.store(),
          I.const(20), I.const(1), I.store(),
          I.get(3), I.const(16), I.const(1), I.const(24),
          I.call(f_fd_write), I.drop(),
        I.end(),

        I.get(2), I.const(1), I.add(), I.set(2),
        I.br(0),
      I.end(),
    I.end(),

    I.const(16), I.const(OFF_NL), I.store(),
    I.const(20), I.const(1), I.store(),
    I.get(3), I.const(16), I.const(1), I.const(24),
    I.call(f_fd_write), I.drop(),

    I.get(3), I.const(1), I.gt_s(),
    I.if(),
      I.get(3), I.call(f_fd_close), I.drop(),
    I.end(),
    I.const(0), I.return()
  ]);

  // cat
  const f_applet_cat = wb.addFunction(t_ii_i, [[5, i32]], [
    I.get(0), I.const(2), I.lt_s(),
    I.if(),
      I.const(OFF_A_CAT), I.call(f_print_str),
      I.const(OFF_ERR_MISSING), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.const(1), I.set(2),
    I.block(),
      I.loop(),
        I.get(2), I.get(0), I.ge_s(),
        I.br_if(1),
        I.get(1), I.get(2), I.const(4), I.mul(), I.add(), I.load(), I.set(3),
        I.const(3), I.const(0), I.get(3), I.get(3), I.call(f_strlen),
        I.const(0), I.const64(0), I.const64(0), I.const(0), I.const(32),
        I.call(f_path_open), I.set(6),
        I.get(6), I.eqz(),
        I.if(),
          I.const(32), I.load(), I.set(4),
          I.block(),
            I.loop(),
              I.const(16), I.const(16384), I.store(),
              I.const(20), I.const(4096), I.store(),
              I.get(4), I.const(16), I.const(1), I.const(24),
              I.call(f_fd_read), I.drop(),
              I.const(24), I.load(), I.set(5),
              I.get(5), I.eqz(),
              I.br_if(1),
              I.const(16384), I.get(5), I.call(f_print_stdout), I.drop(),
              I.br(0),
            I.end(),
          I.end(),
          I.get(4), I.call(f_fd_close), I.drop(),
        I.else(),
          I.const(OFF_A_CAT), I.call(f_print_str),
          I.const(OFF_ERR_NOFILE), I.call(f_print_str),
        I.end(),
        I.get(2), I.const(1), I.add(), I.set(2),
        I.br(0),
      I.end(),
    I.end(),
    I.const(0), I.return()
  ]);

  // cp <src> <dst>
  const f_applet_cp = wb.addFunction(t_ii_i, [[6, i32]], [
    // 0: argc, 1: argv_table
    // locals: 2: src, 3: dst, 4: src_fd, 5: dst_fd, 6: nread
    I.get(0), I.const(3), I.lt_s(),
    I.if(),
      I.const(OFF_A_CP), I.call(f_print_str),
      I.const(OFF_ERR_MISSING), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.get(1), I.const(4), I.add(), I.load(), I.set(2),
    I.get(1), I.const(8), I.add(), I.load(), I.set(3),
    // open src
    I.const(3), I.const(0), I.get(2), I.get(2), I.call(f_strlen),
    I.const(0), I.const64(0), I.const64(0), I.const(0), I.const(32),
    I.call(f_path_open),
    I.if(),
      I.const(OFF_A_CP), I.call(f_print_str),
      I.const(OFF_ERR_NOFILE), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.const(32), I.load(), I.set(4),
    // open dst: O_CREAT | O_TRUNC (9)
    I.const(3), I.const(0), I.get(3), I.get(3), I.call(f_strlen),
    I.const(9), I.const64(0), I.const64(0), I.const(0), I.const(32),
    I.call(f_path_open),
    I.if(),
      I.get(4), I.call(f_fd_close), I.drop(),
      I.const(OFF_A_CP), I.call(f_print_str),
      I.const(OFF_ERR_NOFILE), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.const(32), I.load(), I.set(5),
    // copy loop
    I.block(),
      I.loop(),
        I.const(16), I.const(16384), I.store(),
        I.const(20), I.const(4096), I.store(),
        I.get(4), I.const(16), I.const(1), I.const(24),
        I.call(f_fd_read), I.drop(),
        I.const(24), I.load(), I.set(6),
        I.get(6), I.eqz(),
        I.br_if(1),
        I.const(16), I.const(16384), I.store(),
        I.const(20), I.get(6), I.store(),
        I.get(5), I.const(16), I.const(1), I.const(24),
        I.call(f_fd_write), I.drop(),
        I.br(0),
      I.end(),
    I.end(),
    I.get(4), I.call(f_fd_close), I.drop(),
    I.get(5), I.call(f_fd_close), I.drop(),
    I.const(0), I.return()
  ]);

  // mv <src> <dst>
  const f_applet_mv = wb.addFunction(t_ii_i, [[3, i32]], [
    // 0: argc, 1: argv_table
    // locals: 2: src, 3: dst, 4: ret
    I.get(0), I.const(3), I.lt_s(),
    I.if(),
      I.const(OFF_A_MV), I.call(f_print_str),
      I.const(OFF_ERR_MISSING), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.get(1), I.const(4), I.add(), I.load(), I.set(2),
    I.get(1), I.const(8), I.add(), I.load(), I.set(3),
    I.const(3), I.get(2), I.get(2), I.call(f_strlen),
    I.const(3), I.get(3), I.get(3), I.call(f_strlen),
    I.call(f_path_rename),
    I.if(),
      I.const(OFF_A_MV), I.call(f_print_str),
      I.const(OFF_ERR_NOFILE), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.const(0), I.return()
  ]);

  // grep <pat> <file>
  const f_applet_grep = wb.addFunction(t_ii_i, [[9, i32]], [
    // 0: argc, 1: argv_table
    // locals: 2: pat, 3: path, 4: fd, 5: nread, 6: line_start, 7: i, 8: ch, 9: has_match
    I.get(0), I.const(3), I.lt_s(),
    I.if(),
      I.const(OFF_A_GREP), I.call(f_print_str),
      I.const(OFF_ERR_MISSING), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.get(1), I.const(4), I.add(), I.load(), I.set(2),
    I.get(1), I.const(8), I.add(), I.load(), I.set(3),
    // open file
    I.const(3), I.const(0), I.get(3), I.get(3), I.call(f_strlen),
    I.const(0), I.const64(0), I.const64(0), I.const(0), I.const(32),
    I.call(f_path_open),
    I.if(),
      I.const(OFF_A_GREP), I.call(f_print_str),
      I.const(OFF_ERR_NOFILE), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.const(32), I.load(), I.set(4),
    I.const(16), I.const(16384), I.store(),
    I.const(20), I.const(8192), I.store(),
    I.get(4), I.const(16), I.const(1), I.const(24),
    I.call(f_fd_read), I.drop(),
    I.const(24), I.load(), I.set(5), // nread
    I.get(4), I.call(f_fd_close), I.drop(),
    // null terminate buffer
    I.const(16384), I.get(5), I.add(), I.const(0), I.store8(),

    I.const(0), I.set(6), // line_start = 0
    I.const(0), I.set(7), // i = 0
    I.block(),
      I.loop(),
        I.get(7), I.get(5), I.ge_u(),
        I.br_if(1),
        I.const(16384), I.get(7), I.add(), I.load8_u(), I.set(8),
        I.get(8), I.const(10), I.eq(), // newline
        I.if(),
          I.const(16384), I.get(7), I.add(), I.const(0), I.store8(), // null terminate line
          // check if pat matches line
          I.const(16384), I.get(6), I.add(), I.get(2), I.call(f_strstr),
          I.if(),
            I.const(16384), I.get(6), I.add(), I.call(f_print_str),
            I.const(OFF_NL), I.call(f_print_str),
          I.end(),
          I.get(7), I.const(1), I.add(), I.set(6), // next line start
        I.end(),
        I.get(7), I.const(1), I.add(), I.set(7),
        I.br(0),
      I.end(),
    I.end(),
    I.const(0), I.return()
  ]);

  // tail <file>
  const f_applet_tail = wb.addFunction(t_ii_i, [[7, i32]], [
    // 0: argc, 1: argv_table
    // locals: 2: path, 3: fd, 4: nread, 5: total_lines, 6: i, 7: skip_lines
    I.get(0), I.const(2), I.lt_s(),
    I.if(),
      I.const(OFF_A_TAIL), I.call(f_print_str),
      I.const(OFF_ERR_MISSING), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.get(1), I.const(4), I.add(), I.load(), I.set(2),
    I.const(3), I.const(0), I.get(2), I.get(2), I.call(f_strlen),
    I.const(0), I.const64(0), I.const64(0), I.const(0), I.const(32),
    I.call(f_path_open),
    I.if(),
      I.const(OFF_A_TAIL), I.call(f_print_str),
      I.const(OFF_ERR_NOFILE), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.const(32), I.load(), I.set(3),
    I.const(16), I.const(16384), I.store(),
    I.const(20), I.const(8192), I.store(),
    I.get(3), I.const(16), I.const(1), I.const(24),
    I.call(f_fd_read), I.drop(),
    I.const(24), I.load(), I.set(4),
    I.get(3), I.call(f_fd_close), I.drop(),

    // count total lines
    I.const(0), I.set(5), // total_lines
    I.const(0), I.set(6),
    I.block(),
      I.loop(),
        I.get(6), I.get(4), I.ge_u(),
        I.br_if(1),
        I.const(16384), I.get(6), I.add(), I.load8_u(), I.const(10), I.eq(),
        I.if(),
          I.get(5), I.const(1), I.add(), I.set(5),
        I.end(),
        I.get(6), I.const(1), I.add(), I.set(6),
        I.br(0),
      I.end(),
    I.end(),

    // if lines <= 10, print all
    I.get(5), I.const(10), I.le_s(),
    I.if(),
      I.const(16384), I.get(4), I.call(f_print_stdout), I.drop(),
      I.const(0), I.return(),
    I.end(),

    // find start of last 10 lines
    I.get(5), I.const(10), I.sub(), I.set(7), // skip_lines
    I.const(0), I.set(5), // current line counter
    I.const(0), I.set(6),
    I.block(),
      I.loop(),
        I.get(6), I.get(4), I.ge_u(),
        I.br_if(1),
        I.const(16384), I.get(6), I.add(), I.load8_u(), I.const(10), I.eq(),
        I.if(),
          I.get(5), I.const(1), I.add(), I.set(5),
          I.get(5), I.get(7), I.eq(),
          I.if(),
            // start printing from 6 + 1
            I.const(16384), I.get(6), I.const(1), I.add(), I.add(),
            I.get(4), I.get(6), I.const(1), I.add(), I.sub(),
            I.call(f_print_stdout), I.drop(),
            I.const(0), I.return(),
          I.end(),
        I.end(),
        I.get(6), I.const(1), I.add(), I.set(6),
        I.br(0),
      I.end(),
    I.end(),
    I.const(0), I.return()
  ]);

  // stat <file>
  const f_applet_stat = wb.addFunction(t_ii_i, [[3, i32]], [
    // 0: argc, 1: argv_table
    // locals: 2: path, 3: size, 4: type
    I.get(0), I.const(2), I.lt_s(),
    I.if(),
      I.const(OFF_A_STAT), I.call(f_print_str),
      I.const(OFF_ERR_MISSING), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.get(1), I.const(4), I.add(), I.load(), I.set(2),
    I.const(3), I.const(0), I.get(2), I.get(2), I.call(f_strlen), I.const(48),
    I.call(f_path_filestat),
    I.if(),
      I.const(OFF_A_STAT), I.call(f_print_str),
      I.const(OFF_ERR_NOFILE), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.const(48), I.const(32), I.add(), I.load(), I.set(3), // size
    I.const(48), I.const(16), I.add(), I.load8_u(), I.set(4), // type

    // Print formatted stat
    I.const(allocStr(Array.from(enc.encode("  File: ")))), I.call(f_print_str),
    I.get(2), I.call(f_print_str),
    I.const(OFF_NL), I.call(f_print_str),
    I.const(allocStr(Array.from(enc.encode("  Size: ")))), I.call(f_print_str),
    I.get(3), I.const(120), I.call(f_format_int), I.drop(),
    I.const(120), I.call(f_print_str),
    I.const(allocStr(Array.from(enc.encode("       Blocks: 8          IO Block: 4096   ")))), I.call(f_print_str),
    I.get(4), I.const(3), I.eq(),
    I.if(),
      I.const(allocStr(Array.from(enc.encode("directory\n")))), I.call(f_print_str),
    I.else(),
      I.const(allocStr(Array.from(enc.encode("regular file\n")))), I.call(f_print_str),
    I.end(),
    I.const(allocStr(Array.from(enc.encode("Device: 1h/1d     Inode: 42         Links: 1\nAccess: (0644/-rw-r--r--)  Uid: ( 0/ root)   Gid: ( 0/ root)\n")))),
    I.call(f_print_str),
    I.const(0), I.return()
  ]);

  // base64 <file>
  const f_applet_base64 = wb.addFunction(t_ii_i, [[8, i32]], [
    // 0: argc, 1: argv_table
    // locals: 2: path, 3: fd, 4: nread, 5: i, 6: b0, 7: b1, 8: b2
    I.get(0), I.const(2), I.lt_s(),
    I.if(),
      I.const(OFF_A_BASE64), I.call(f_print_str),
      I.const(OFF_ERR_MISSING), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.get(1), I.const(4), I.add(), I.load(), I.set(2),
    I.const(3), I.const(0), I.get(2), I.get(2), I.call(f_strlen),
    I.const(0), I.const64(0), I.const64(0), I.const(0), I.const(32),
    I.call(f_path_open),
    I.if(),
      I.const(OFF_A_BASE64), I.call(f_print_str),
      I.const(OFF_ERR_NOFILE), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.const(32), I.load(), I.set(3),
    I.const(16), I.const(16384), I.store(),
    I.const(20), I.const(4096), I.store(),
    I.get(3), I.const(16), I.const(1), I.const(24),
    I.call(f_fd_read), I.drop(),
    I.const(24), I.load(), I.set(4),
    I.get(3), I.call(f_fd_close), I.drop(),

    // base64 encode buffer 16384..16384+nread into 24576
    I.const(0), I.set(5), // i = 0
    I.const(24576), I.set(6), // out_ptr
    I.block(),
      I.loop(),
        I.get(5), I.get(4), I.ge_u(),
        I.br_if(1),
        // read up to 3 bytes
        I.const(16384), I.get(5), I.add(), I.load8_u(), I.set(7), // b0
        I.get(5), I.const(1), I.add(), I.get(4), I.lt_u(),
        I.if(), I.const(16384), I.get(5), I.const(1), I.add(), I.add(), I.load8_u(), I.set(8),
        I.else(), I.const(0), I.set(8), I.end(), // b1
        I.get(5), I.const(2), I.add(), I.get(4), I.lt_u(),
        I.if(), I.const(16384), I.get(5), I.const(2), I.add(), I.add(), I.load8_u(), I.set(9),
        I.else(), I.const(0), I.set(9), I.end(), // b2

        // char 0: (b0 >> 2) & 0x3f => b0 / 4
        I.get(6),
        I.const(OFF_B64CHARS), I.get(7), I.const(4), I.div_u(), I.const(0x3f), I.and(), I.add(), I.load8_u(),
        I.store8(),

        // char 1: ((b0 & 3) * 16) | ((b1 / 16) & 0x0f)
        I.get(6), I.const(1), I.add(),
        I.const(OFF_B64CHARS),
        I.get(7), I.const(3), I.and(), I.const(16), I.mul(),
        I.get(8), I.const(16), I.div_u(), I.const(0x0f), I.and(), I.or(), I.const(0x3f), I.and(),
        I.add(), I.load8_u(),
        I.store8(),

        // char 2: ((b1 & 0x0f) * 4) | ((b2 / 64) & 0x03)
        I.get(5), I.const(1), I.add(), I.get(4), I.lt_u(),
        I.if(),
          I.get(6), I.const(2), I.add(),
          I.const(OFF_B64CHARS),
          I.get(8), I.const(0x0f), I.and(), I.const(4), I.mul(),
          I.get(9), I.const(64), I.div_u(), I.const(0x03), I.and(), I.or(), I.const(0x3f), I.and(),
          I.add(), I.load8_u(),
          I.store8(),
        I.else(),
          I.get(6), I.const(2), I.add(),
          I.const(61), // '='
          I.store8(),
        I.end(),

        // char 3: b2 & 0x3f
        I.get(5), I.const(2), I.add(), I.get(4), I.lt_u(),
        I.if(),
          I.get(6), I.const(3), I.add(),
          I.const(OFF_B64CHARS), I.get(9), I.const(0x3f), I.and(), I.add(), I.load8_u(),
          I.store8(),
        I.else(),
          I.get(6), I.const(3), I.add(),
          I.const(61), // '='
          I.store8(),
        I.end(),

        I.get(6), I.const(4), I.add(), I.set(6),
        I.get(5), I.const(3), I.add(), I.set(5),
        I.br(0),
      I.end(),
    I.end(),
    // write output + newline
    I.get(6), I.const(10), I.store8(), // newline
    I.get(6), I.const(1), I.add(), I.set(6),
    I.const(24576), I.get(6), I.const(24576), I.sub(), I.call(f_print_stdout), I.drop(),
    I.const(0), I.return()
  ]);

  // touch
  const f_applet_touch = wb.addFunction(t_ii_i, [[4, i32]], [
    I.get(0), I.const(2), I.lt_s(),
    I.if(),
      I.const(OFF_A_TOUCH), I.call(f_print_str),
      I.const(OFF_ERR_MISSING), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.const(1), I.set(2),
    I.block(),
      I.loop(),
        I.get(2), I.get(0), I.ge_s(),
        I.br_if(1),
        I.get(1), I.get(2), I.const(4), I.mul(), I.add(), I.load(), I.set(3),
        I.const(3), I.const(0), I.get(3), I.get(3), I.call(f_strlen),
        I.const(1), I.const64(0), I.const64(0), I.const(0), I.const(32),
        I.call(f_path_open),
        I.eqz(),
        I.if(),
          I.const(32), I.load(), I.call(f_fd_close), I.drop(),
        I.end(),
        I.get(2), I.const(1), I.add(), I.set(2),
        I.br(0),
      I.end(),
    I.end(),
    I.const(0), I.return()
  ]);

  // rm
  const f_applet_rm = wb.addFunction(t_ii_i, [[4, i32]], [
    I.get(0), I.const(2), I.lt_s(),
    I.if(),
      I.const(OFF_A_RM), I.call(f_print_str),
      I.const(OFF_ERR_MISSING), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.const(1), I.set(2),
    I.block(),
      I.loop(),
        I.get(2), I.get(0), I.ge_s(),
        I.br_if(1),
        I.get(1), I.get(2), I.const(4), I.mul(), I.add(), I.load(), I.set(3),
        I.const(3), I.get(3), I.get(3), I.call(f_strlen),
        I.call(f_path_unlink),
        I.if(),
          I.const(OFF_A_RM), I.call(f_print_str),
          I.const(OFF_ERR_NOFILE), I.call(f_print_str),
        I.end(),
        I.get(2), I.const(1), I.add(), I.set(2),
        I.br(0),
      I.end(),
    I.end(),
    I.const(0), I.return()
  ]);

  // mkdir
  const f_applet_mkdir = wb.addFunction(t_ii_i, [[4, i32]], [
    I.get(0), I.const(2), I.lt_s(),
    I.if(),
      I.const(OFF_A_MKDIR), I.call(f_print_str),
      I.const(OFF_ERR_MISSING), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.const(1), I.set(2),
    I.block(),
      I.loop(),
        I.get(2), I.get(0), I.ge_s(),
        I.br_if(1),
        I.get(1), I.get(2), I.const(4), I.mul(), I.add(), I.load(), I.set(3),
        I.const(3), I.get(3), I.get(3), I.call(f_strlen),
        I.call(f_path_mkdir),
        I.drop(),
        I.get(2), I.const(1), I.add(), I.set(2),
        I.br(0),
      I.end(),
    I.end(),
    I.const(0), I.return()
  ]);

  // ls
  const f_applet_ls = wb.addFunction(t_ii_i, [[6, i32]], [
    I.const(3), I.set(2),
    I.get(0), I.const(1), I.gt_s(),
    I.if(),
      I.get(1), I.const(4), I.add(), I.load(), I.set(7),
      I.get(7), I.load8_u(), I.const(45), I.ne(),
      I.if(),
        I.const(3), I.const(0), I.get(7), I.get(7), I.call(f_strlen),
        I.const(2), I.const64(0), I.const64(0), I.const(0), I.const(32),
        I.call(f_path_open),
        I.eqz(),
        I.if(),
          I.const(32), I.load(), I.set(2),
        I.end(),
      I.end(),
    I.end(),

    I.get(2), I.const(3072), I.const(1024), I.const64(0), I.const(24),
    I.call(f_fd_readdir),
    I.drop(),
    I.const(24), I.load(), I.set(3),
    I.const(0), I.set(4),
    I.block(),
      I.loop(),
        I.get(4), I.get(3), I.ge_u(),
        I.br_if(1),
        I.const(3072), I.get(4), I.add(), I.const(16), I.add(), I.load(), I.set(5),
        I.const(3072), I.get(4), I.add(), I.const(20), I.add(), I.load8_u(), I.set(6),
        I.const(3072), I.get(4), I.add(), I.const(24), I.add(), I.set(7),

        I.get(6), I.const(3), I.eq(),
        I.if(),
          I.const(OFF_DIR_TAG), I.call(f_print_str),
          I.get(7), I.get(5), I.call(f_print_stdout), I.drop(),
          I.const(OFF_SLASH), I.call(f_print_str),
        I.else(),
          I.const(OFF_FILE_TAG), I.call(f_print_str),
          I.get(7), I.get(5), I.call(f_print_stdout), I.drop(),
          I.const(OFF_NL), I.call(f_print_str),
        I.end(),

        I.get(4), I.const(24), I.add(), I.get(5), I.add(), I.set(4),
        I.br(0),
      I.end(),
    I.end(),

    I.get(2), I.const(3), I.ne(),
    I.if(),
      I.get(2), I.call(f_fd_close), I.drop(),
    I.end(),
    I.const(0), I.return()
  ]);

  // wc
  const f_applet_wc = wb.addFunction(t_ii_i, [[6, i32]], [
    I.get(0), I.const(2), I.lt_s(),
    I.if(),
      I.const(OFF_A_WC), I.call(f_print_str),
      I.const(OFF_ERR_MISSING), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.get(1), I.const(4), I.add(), I.load(), I.set(2),
    I.const(3), I.const(0), I.get(2), I.get(2), I.call(f_strlen),
    I.const(0), I.const64(0), I.const64(0), I.const(0), I.const(32),
    I.call(f_path_open),
    I.if(),
      I.const(OFF_A_WC), I.call(f_print_str),
      I.const(OFF_ERR_NOFILE), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.const(32), I.load(), I.set(3),
    I.const(0), I.set(4),
    I.const(0), I.set(5),
    I.block(),
      I.loop(),
        I.const(16), I.const(16384), I.store(),
        I.const(20), I.const(4096), I.store(),
        I.get(3), I.const(16), I.const(1), I.const(24),
        I.call(f_fd_read), I.drop(),
        I.const(24), I.load(), I.set(6),
        I.get(6), I.eqz(),
        I.br_if(1),
        I.get(5), I.get(6), I.add(), I.set(5),
        I.const(0), I.set(7),
        I.loop(),
          I.get(7), I.get(6), I.ge_u(),
          I.br_if(1),
          I.const(16384), I.get(7), I.add(), I.load8_u(),
          I.const(10), I.eq(),
          I.if(),
            I.get(4), I.const(1), I.add(), I.set(4),
          I.end(),
          I.get(7), I.const(1), I.add(), I.set(7),
          I.br(0),
        I.end(),
        I.br(0),
      I.end(),
    I.end(),
    I.get(3), I.call(f_fd_close), I.drop(),
    I.const(OFF_SPACE), I.call(f_print_str),
    I.const(OFF_SPACE), I.call(f_print_str),
    I.get(4), I.const(120), I.call(f_format_int), I.drop(),
    I.const(120), I.call(f_print_str),
    I.const(OFF_SPACE), I.call(f_print_str),
    I.const(OFF_SPACE), I.call(f_print_str),
    I.get(5), I.const(120), I.call(f_format_int), I.drop(),
    I.const(120), I.call(f_print_str),
    I.const(OFF_SPACE), I.call(f_print_str),
    I.get(2), I.call(f_print_str),
    I.const(OFF_NL), I.call(f_print_str),
    I.const(0), I.return()
  ]);

  // head
  const f_applet_head = wb.addFunction(t_ii_i, [[5, i32]], [
    I.get(0), I.const(2), I.lt_s(),
    I.if(),
      I.const(OFF_A_HEAD), I.call(f_print_str),
      I.const(OFF_ERR_MISSING), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.get(1), I.const(4), I.add(), I.load(), I.set(2),
    I.const(3), I.const(0), I.get(2), I.get(2), I.call(f_strlen),
    I.const(0), I.const64(0), I.const64(0), I.const(0), I.const(32),
    I.call(f_path_open),
    I.if(),
      I.const(OFF_A_HEAD), I.call(f_print_str),
      I.const(OFF_ERR_NOFILE), I.call(f_print_str),
      I.const(1), I.return(),
    I.end(),
    I.const(32), I.load(), I.set(3),
    I.const(0), I.set(4),
    I.block(),
      I.loop(),
        I.const(16), I.const(16384), I.store(),
        I.const(20), I.const(4096), I.store(),
        I.get(3), I.const(16), I.const(1), I.const(24),
        I.call(f_fd_read), I.drop(),
        I.const(24), I.load(), I.set(5),
        I.get(5), I.eqz(),
        I.br_if(1),
        I.const(16384), I.get(5), I.call(f_print_stdout), I.drop(),
        I.br(0),
      I.end(),
    I.end(),
    I.get(3), I.call(f_fd_close), I.drop(),
    I.const(0), I.return()
  ]);

  // uptime
  const f_applet_uptime = wb.addFunction(t_v_v, [[1, i32]], [
    I.const(1), I.const64(1000), I.const(40), I.call(f_clock_time), I.drop(),
    I.const(OFF_UP), I.call(f_print_str),
    I.const(44), I.load(), I.const(4), I.mul(), I.const(120), I.call(f_format_int), I.drop(),
    I.const(120), I.call(f_print_str),
    I.const(OFF_SECS), I.call(f_print_str),
    I.return()
  ]);

  // env
  const f_applet_env = wb.addFunction(t_v_v, [[3, i32]], [
    I.const(120), I.const(124), I.call(f_environ_sizes), I.drop(),
    I.const(120), I.load(), I.set(0),
    I.const(2048), I.const(8192), I.call(f_environ_get), I.drop(),
    I.const(0), I.set(1),
    I.block(),
      I.loop(),
        I.get(1), I.get(0), I.ge_u(),
        I.br_if(1),
        I.const(2048), I.get(1), I.const(4), I.mul(), I.add(), I.load(), I.set(2),
        I.get(2), I.call(f_print_str),
        I.const(OFF_NL), I.call(f_print_str),
        I.get(1), I.const(1), I.add(), I.set(1),
        I.br(0),
      I.end(),
    I.end(),
    I.return()
  ]);

  // f_dispatch(argc, argv_table)
  const f_dispatch_idx = wb.imports.length + wb.funcs.length;
  const f_dispatch = wb.addFunction(t_ii_i, [[1, i32]], [
    I.get(0), I.eqz(),
    I.if(), I.const(0), I.return(), I.end(),
    I.get(1), I.load(), I.set(2),

    I.get(2), I.const(OFF_A_BUSYBOX), I.call(f_strcmp), I.eqz(),
    I.get(2), I.const(OFF_A_SH), I.call(f_strcmp), I.eqz(), I.or(),
    I.if(),
      I.get(0), I.const(1), I.gt_s(),
      I.if(),
        I.get(0), I.const(1), I.sub(),
        I.get(1), I.const(4), I.add(),
        I.call(f_dispatch_idx), // call f_dispatch itself
        I.return(),
      I.else(),
        I.const(OFF_HELP), I.call(f_print_str),
        I.const(0), I.return(),
      I.end(),
    I.end(),

    // ls
    I.get(2), I.const(OFF_A_LS), I.call(f_strcmp), I.eqz(),
    I.if(), I.get(0), I.get(1), I.call(f_applet_ls), I.return(), I.end(),

    // cat
    I.get(2), I.const(OFF_A_CAT), I.call(f_strcmp), I.eqz(),
    I.if(), I.get(0), I.get(1), I.call(f_applet_cat), I.return(), I.end(),

    // echo
    I.get(2), I.const(OFF_A_ECHO), I.call(f_strcmp), I.eqz(),
    I.if(), I.get(0), I.get(1), I.call(f_applet_echo), I.return(), I.end(),

    // cp
    I.get(2), I.const(OFF_A_CP), I.call(f_strcmp), I.eqz(),
    I.if(), I.get(0), I.get(1), I.call(f_applet_cp), I.return(), I.end(),

    // mv
    I.get(2), I.const(OFF_A_MV), I.call(f_strcmp), I.eqz(),
    I.if(), I.get(0), I.get(1), I.call(f_applet_mv), I.return(), I.end(),

    // grep
    I.get(2), I.const(OFF_A_GREP), I.call(f_strcmp), I.eqz(),
    I.if(), I.get(0), I.get(1), I.call(f_applet_grep), I.return(), I.end(),

    // tail
    I.get(2), I.const(OFF_A_TAIL), I.call(f_strcmp), I.eqz(),
    I.if(), I.get(0), I.get(1), I.call(f_applet_tail), I.return(), I.end(),

    // stat
    I.get(2), I.const(OFF_A_STAT), I.call(f_strcmp), I.eqz(),
    I.if(), I.get(0), I.get(1), I.call(f_applet_stat), I.return(), I.end(),

    // df
    I.get(2), I.const(OFF_A_DF), I.call(f_strcmp), I.eqz(),
    I.if(), I.const(OFF_DF), I.call(f_print_str), I.const(0), I.return(), I.end(),

    // free
    I.get(2), I.const(OFF_A_FREE), I.call(f_strcmp), I.eqz(),
    I.if(), I.const(OFF_FREE), I.call(f_print_str), I.const(0), I.return(), I.end(),

    // id
    I.get(2), I.const(OFF_A_ID), I.call(f_strcmp), I.eqz(),
    I.if(), I.const(OFF_ID), I.call(f_print_str), I.const(0), I.return(), I.end(),

    // ps
    I.get(2), I.const(OFF_A_PS), I.call(f_strcmp), I.eqz(),
    I.if(), I.const(OFF_PS), I.call(f_print_str), I.const(0), I.return(), I.end(),

    // base64
    I.get(2), I.const(OFF_A_BASE64), I.call(f_strcmp), I.eqz(),
    I.if(), I.get(0), I.get(1), I.call(f_applet_base64), I.return(), I.end(),

    // true
    I.get(2), I.const(OFF_A_TRUE), I.call(f_strcmp), I.eqz(),
    I.if(), I.const(0), I.return(), I.end(),

    // false
    I.get(2), I.const(OFF_A_FALSE), I.call(f_strcmp), I.eqz(),
    I.if(), I.const(1), I.return(), I.end(),

    // touch
    I.get(2), I.const(OFF_A_TOUCH), I.call(f_strcmp), I.eqz(),
    I.if(), I.get(0), I.get(1), I.call(f_applet_touch), I.return(), I.end(),

    // mkdir
    I.get(2), I.const(OFF_A_MKDIR), I.call(f_strcmp), I.eqz(),
    I.if(), I.get(0), I.get(1), I.call(f_applet_mkdir), I.return(), I.end(),

    // rm
    I.get(2), I.const(OFF_A_RM), I.call(f_strcmp), I.eqz(),
    I.if(), I.get(0), I.get(1), I.call(f_applet_rm), I.return(), I.end(),

    // pwd
    I.get(2), I.const(OFF_A_PWD), I.call(f_strcmp), I.eqz(),
    I.if(), I.const(OFF_PWD), I.call(f_print_str), I.const(0), I.return(), I.end(),

    // uname
    I.get(2), I.const(OFF_A_UNAME), I.call(f_strcmp), I.eqz(),
    I.if(), I.const(OFF_UNAME), I.call(f_print_str), I.const(0), I.return(), I.end(),

    // whoami
    I.get(2), I.const(OFF_A_WHOAMI), I.call(f_strcmp), I.eqz(),
    I.if(), I.const(OFF_WHOAMI), I.call(f_print_str), I.const(0), I.return(), I.end(),

    // hostname
    I.get(2), I.const(OFF_A_HOSTNAME), I.call(f_strcmp), I.eqz(),
    I.if(), I.const(OFF_HOSTNAME), I.call(f_print_str), I.const(0), I.return(), I.end(),

    // date
    I.get(2), I.const(OFF_A_DATE), I.call(f_strcmp), I.eqz(),
    I.if(),
      I.const(0), I.const64(1000), I.const(40), I.call(f_clock_time), I.drop(),
      I.const(OFF_UNAME), I.call(f_print_str),
      I.const(0), I.return(),
    I.end(),

    // uptime
    I.get(2), I.const(OFF_A_UPTIME), I.call(f_strcmp), I.eqz(),
    I.if(), I.call(f_applet_uptime), I.const(0), I.return(), I.end(),

    // wc
    I.get(2), I.const(OFF_A_WC), I.call(f_strcmp), I.eqz(),
    I.if(), I.get(0), I.get(1), I.call(f_applet_wc), I.return(), I.end(),

    // head
    I.get(2), I.const(OFF_A_HEAD), I.call(f_strcmp), I.eqz(),
    I.if(), I.get(0), I.get(1), I.call(f_applet_head), I.return(), I.end(),

    // env
    I.get(2), I.const(OFF_A_ENV), I.call(f_strcmp), I.eqz(),
    I.if(), I.call(f_applet_env), I.const(0), I.return(), I.end(),

    // clear
    I.get(2), I.const(OFF_A_CLEAR), I.call(f_strcmp), I.eqz(),
    I.if(), I.const(OFF_CLEAR), I.call(f_print_str), I.const(0), I.return(), I.end(),

    // help
    I.get(2), I.const(OFF_A_HELP), I.call(f_strcmp), I.eqz(),
    I.if(), I.const(OFF_HELP), I.call(f_print_str), I.const(0), I.return(), I.end(),

    // unknown command
    I.get(2), I.call(f_print_str),
    I.const(OFF_ERR_CMD), I.call(f_print_str),
    I.const(127), I.return()
  ]);

  // Main entrypoint: _start
  const f_start = wb.addFunction(t_v_v, [[2, i32]], [
    I.const(120), I.const(124), I.call(f_args_sizes), I.drop(),
    I.const(120), I.load(), I.set(0),
    I.get(0), I.const(1), I.gt_s(),
    I.if(),
      I.const(2048), I.const(4096), I.call(f_args_get), I.drop(),
      I.get(0), I.const(1), I.sub(),
      I.const(2052),
      I.call(f_dispatch), I.drop(),
      I.const(0), I.call(f_proc_exit),
      I.return(),
    I.end(),

    I.const(16), I.const(1024), I.store(),
    I.const(20), I.const(1024), I.store(),
    I.const(0), I.const(16), I.const(1), I.const(24),
    I.call(f_fd_read), I.drop(),
    I.const(24), I.load(), I.set(1),

    I.get(1), I.eqz(),
    I.if(),
      I.const(OFF_BANNER), I.call(f_print_str),
      I.const(OFF_PROMPT), I.call(f_print_str),
      I.const(0), I.call(f_proc_exit),
      I.return(),
    I.end(),

    I.const(1024), I.get(1), I.call(f_parse_line), I.set(0),
    I.get(0), I.const(0), I.gt_s(),
    I.if(),
      I.get(0), I.const(2048), I.call(f_dispatch), I.drop(),
    I.end(),

    I.const(OFF_PROMPT), I.call(f_print_str),
    I.const(0), I.call(f_proc_exit),
    I.return()
  ]);

  wb.addExport('_start', 0x00, f_start);
  return wb.build();
}

function ansiToHtml(str) {
  const escaped = str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const colorMap = {
    30: '#1e222a', 31: '#ff6b6b', 32: '#51cf66', 33: '#fcc419',
    34: '#339af0', 35: '#cc5de8', 36: '#22b8cf', 37: '#e9ecef',
    90: '#868e96', 91: '#ff8787', 92: '#69db7c', 93: '#ffd43b',
    94: '#74c0fc', 95: '#da77f2', 96: '#66d9e8', 97: '#ffffff'
  };

  let currentFg = null, currentBg = null, isBold = false, isDim = false;
  const re = /\x1b\[([0-9;]*)m/g;
  let html = '';
  let lastIndex = 0;
  let match;

  while ((match = re.exec(escaped)) !== null) {
    html += escaped.substring(lastIndex, match.index);
    lastIndex = re.lastIndex;

    const codes = match[1] ? match[1].split(';').map(Number) : [0];
    for (const code of codes) {
      if (code === 0) {
        currentFg = null; currentBg = null; isBold = false; isDim = false;
      } else if (code === 1) isBold = true;
      else if (code === 2) isDim = true;
      else if (colorMap[code]) currentFg = colorMap[code];
      else if (code >= 40 && code <= 47) currentBg = colorMap[code - 10];
    }

    html += '</span>';
    const styles = [];
    if (currentFg) styles.push('color:' + currentFg);
    if (currentBg) styles.push('background-color:' + currentBg);
    if (isBold) styles.push('font-weight:700');
    if (isDim) styles.push('opacity:0.6');
    html += styles.length ? '<span style="' + styles.join(';') + '">' : '<span>';
  }

  html += escaped.substring(lastIndex);
  return html;
}

function parseWasmSections(bytes) {
  if (!bytes || bytes.length < 8) return null;
  if (bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) return null;
  const version = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);

  function rUleb(offset) {
    let res = 0, shift = 0;
    while (true) {
      if (offset >= bytes.length) return [res, offset];
      const b = bytes[offset++];
      res |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    return [res, offset];
  }

  function rStr(offset) {
    let len; [len, offset] = rUleb(offset);
    const sBytes = bytes.subarray(offset, offset + len);
    const str = new TextDecoder().decode(sBytes);
    return [str, offset + len];
  }

  const sectionNames = ['Custom', 'Type', 'Import', 'Function', 'Table', 'Memory', 'Global', 'Export', 'Start', 'Element', 'Code', 'Data', 'DataCount'];
  const info = { version, sections: [], imports: [], exports: [], memories: [], functionCount: 0, dataCount: 0 };

  let offset = 8;
  while (offset < bytes.length) {
    const secId = bytes[offset++];
    let secLen; [secLen, offset] = rUleb(offset);
    const secEnd = offset + secLen;
    info.sections.push({ id: secId, name: sectionNames[secId] || ('Sec_' + secId), length: secLen });

    if (secId === 2) {
      let count; [count, offset] = rUleb(offset);
      for (let i = 0; i < count; i++) {
        let mod, field; [mod, offset] = rStr(offset); [field, offset] = rStr(offset);
        const kind = bytes[offset++];
        const kindNames = ['function', 'table', 'memory', 'global'];
        let typeIdx; [typeIdx, offset] = rUleb(offset);
        info.imports.push({ mod, field, kind: kindNames[kind] || 'unknown', typeIdx });
      }
    } else if (secId === 5) {
      let count; [count, offset] = rUleb(offset);
      for (let i = 0; i < count; i++) {
        const flag = bytes[offset++];
        let minP; [minP, offset] = rUleb(offset);
        let maxP = null;
        if (flag & 1) [maxP, offset] = rUleb(offset);
        info.memories.push({ minPages: minP, maxPages: maxP, minBytes: minP * 65536, maxBytes: maxP ? maxP * 65536 : null });
      }
    } else if (secId === 7) {
      let count; [count, offset] = rUleb(offset);
      for (let i = 0; i < count; i++) {
        let name; [name, offset] = rStr(offset);
        const kind = bytes[offset++];
        const kindNames = ['function', 'table', 'memory', 'global'];
        let idx; [idx, offset] = rUleb(offset);
        info.exports.push({ name, kind: kindNames[kind] || 'unknown', index: idx });
      }
    } else if (secId === 10) {
      let count; [count, offset] = rUleb(offset);
      info.functionCount = count;
    } else if (secId === 11) {
      let count; [count, offset] = rUleb(offset);
      info.dataCount = count;
    }

    offset = secEnd;
  }
  return info;
}

function renderHexDump(bytes, page = 0, pageSize = 512) {
  if (!bytes) return { html: '', totalPages: 1, start: 0, end: 0 };
  const totalPages = Math.max(1, Math.ceil(bytes.length / pageSize));
  page = Math.max(0, Math.min(page, totalPages - 1));
  const start = page * pageSize;
  const end = Math.min(bytes.length, start + pageSize);
  const slice = bytes.subarray(start, end);

  let html = '';
  for (let i = 0; i < slice.length; i += 16) {
    const rowOffset = start + i;
    const hexOff = rowOffset.toString(16).padStart(8, '0');
    const g1 = [], g2 = [];
    let ascii = '';

    for (let j = 0; j < 16; j++) {
      if (i + j < slice.length) {
        const b = slice[i + j];
        const hex = b.toString(16).padStart(2, '0');
        if (j < 8) g1.push(hex);
        else g2.push(hex);
        ascii += (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.';
      } else {
        if (j < 8) g1.push('  ');
        else g2.push('  ');
        ascii += ' ';
      }
    }

    html += '<div class="hex-row">' +
      '<span class="hex-offset">' + hexOff + ':</span>' +
      '<div class="hex-bytes"><div class="hex-group">' + g1.join(' ') + '</div><div class="hex-group">' + g2.join(' ') + '</div></div>' +
      '<span class="hex-ascii">' + ascii.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span>' +
      '</div>';
  }

  return { html, totalPages, start, end };
}

const state = {
  vfs: new VFS(),
  activeFile: null,
  workbenchOpen: false,
  isRunning: false,
  activeWorker: null,
  activeWorkerBlobUrl: null,
  hexPage: 0,
  activeWasmTab: 'overview',
  isDirty: false,
  stdinQueue: ''
};

let el = {};

function initElements() {
  el = {
    root: document.getElementById('app-root'),
    termViewport: document.getElementById('terminal-viewport'),
    stdinInput: document.getElementById('stdin-input'),
    btnStdinSend: document.getElementById('btn-stdin-send'),
    btnRun: document.getElementById('btn-run'),
    btnStop: document.getElementById('btn-stop'),
    btnClear: document.getElementById('btn-clear'),
    btnShare: document.getElementById('btn-share'),
    btnWorkbenchToggle: document.getElementById('btn-workbench-toggle'),
    demoSelect: document.getElementById('demo-select'),
    statusBadge: document.getElementById('status-badge'),
    statusText: document.getElementById('status-text'),
    epArgs: document.getElementById('ep-args'),
    splitter: document.getElementById('layout-splitter'),
    vfsFileList: document.getElementById('vfs-file-list'),
    btnNewFile: document.getElementById('btn-new-file'),
    btnUploadFile: document.getElementById('btn-upload-file'),
    fileUploadInput: document.getElementById('file-upload-input'),
    btnDeleteFile: document.getElementById('btn-delete-file'),
    btnRenameFile: document.getElementById('btn-rename-file'),
    btnDownloadFile: document.getElementById('btn-download-file'),
    inspectorFileTitle: document.getElementById('inspector-file-title'),
    inspectorFileType: document.getElementById('inspector-file-type'),
    saveDot: document.getElementById('save-dot'),
    saveStatus: document.getElementById('save-status'),
    btnSave: document.getElementById('btn-save'),
    btnSaveRun: document.getElementById('btn-save-run'),
    btnRevert: document.getElementById('btn-revert'),
    editorView: document.getElementById('editor-view'),
    editorGutter: document.getElementById('editor-gutter'),
    editorTextarea: document.getElementById('editor-textarea'),
    wasmView: document.getElementById('wasm-view'),
    tabWasmOverview: document.getElementById('tab-wasm-overview'),
    tabWasmHex: document.getElementById('tab-wasm-hex'),
    wasmOverviewContent: document.getElementById('wasm-overview-content'),
    wasmImportCount: document.getElementById('wasm-import-count'),
    wasmImportsTable: document.getElementById('wasm-imports-table').querySelector('tbody'),
    wasmExportCount: document.getElementById('wasm-export-count'),
    wasmExportsTable: document.getElementById('wasm-exports-table').querySelector('tbody'),
    wasmMemoryDetails: document.getElementById('wasm-memory-details'),
    wasmSectionsTable: document.getElementById('wasm-sections-table').querySelector('tbody'),
    hexView: document.getElementById('hex-view'),
    hexPageInfo: document.getElementById('hex-page-info'),
    btnHexPrev: document.getElementById('btn-hex-prev'),
    btnHexNext: document.getElementById('btn-hex-next'),
    hexDumpContent: document.getElementById('hex-dump-content'),
    metricUncompressed: document.getElementById('metric-uncompressed'),
    metricCompressed: document.getElementById('metric-compressed'),
    metricUrlLen: document.getElementById('metric-url-len'),
    telemetryPill: document.getElementById('telemetry-pill'),
    telemetryBarFill: document.getElementById('telemetry-bar-fill'),
    dropOverlay: document.getElementById('drop-overlay'),
    toastContainer: document.getElementById('toast-container')
  };
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = '<span>' + (type === 'success' ? '✓' : 'ℹ') + '</span><span>' + message + '</span>';
  el.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    toast.style.transition = 'all 0.2s ease';
    setTimeout(() => toast.remove(), 200);
  }, 2500);
}

function termPrint(rawStr) {
  const html = ansiToHtml(rawStr);
  el.termViewport.insertAdjacentHTML('beforeend', html);
  el.termViewport.scrollTop = el.termViewport.scrollHeight;
}

function setStatus(status, text) {
  el.statusBadge.className = 'status-badge status-' + status;
  el.statusText.textContent = text;
  el.btnRun.disabled = (status === 'running');
  el.btnStop.disabled = (status !== 'running');
}

async function syncVFSAndURL(updateHistory = true) {
  try {
    const { rawBytes, compressedBytes, base64url } = await serializeVFS(state.vfs);
    const urlChars = location.origin.length + location.pathname.length + 1 + base64url.length;

    el.metricUncompressed.textContent = (rawBytes.length >= 1024 ? (rawBytes.length / 1024).toFixed(1) + ' KB' : rawBytes.length + ' B');
    el.metricCompressed.textContent = (compressedBytes.length >= 1024 ? (compressedBytes.length / 1024).toFixed(1) + ' KB' : compressedBytes.length + ' B');
    el.metricUrlLen.textContent = urlChars.toLocaleString() + ' / 65,536';

    let pct = (urlChars / 65536) * 100;
    if (pct < 1.5) pct = 1.5;
    el.telemetryBarFill.style.width = Math.min(100, pct) + '%';

    if (urlChars < 2000) {
      el.telemetryBarFill.style.backgroundColor = 'var(--accent-green)';
      el.telemetryPill.textContent = 'Safe for SMS & all messengers (< 2KB)';
      el.telemetryPill.style.color = 'var(--accent-green)';
      el.telemetryPill.style.background = 'rgba(63, 185, 80, 0.15)';
    } else if (urlChars < 8000) {
      el.telemetryBarFill.style.backgroundColor = 'var(--accent-blue)';
      el.telemetryPill.textContent = 'Safe for Discord/Slack/Email (< 8KB)';
      el.telemetryPill.style.color = 'var(--accent-blue)';
      el.telemetryPill.style.background = 'rgba(88, 166, 255, 0.15)';
    } else if (urlChars < 65536) {
      el.telemetryBarFill.style.backgroundColor = 'var(--accent-yellow)';
      el.telemetryPill.textContent = 'Browser address bar safe (< 64KB)';
      el.telemetryPill.style.color = 'var(--accent-yellow)';
      el.telemetryPill.style.background = 'rgba(210, 153, 34, 0.15)';
    } else {
      el.telemetryBarFill.style.backgroundColor = 'var(--accent-red)';
      el.telemetryPill.textContent = 'Large URL Payload (> 64KB warning)';
      el.telemetryPill.style.color = 'var(--accent-red)';
      el.telemetryPill.style.background = 'rgba(248, 81, 73, 0.15)';
    }

    if (updateHistory) {
      history.replaceState(null, '', '#' + base64url);
    }

    if (state.vfs.has('/etc/cmdline')) {
      const args = new TextDecoder().decode(state.vfs.get('/etc/cmdline')).trim();
      el.epArgs.textContent = args ? args : '';
    } else {
      el.epArgs.textContent = '';
    }

    renderVFSFileList();
  } catch (err) {
    console.error('URL sync error:', err);
  }
}

function renderVFSFileList() {
  el.vfsFileList.innerHTML = '';
  const entries = state.vfs.entries();
  entries.sort((a, b) => a[0].localeCompare(b[0]));

  for (const [path, data] of entries) {
    const li = document.createElement('li');
    li.className = 'vfs-file-item' + (state.activeFile === path ? ' active' : '');
    li.dataset.path = path;

    let icon = '📄';
    if (path.endsWith('.wasm')) icon = '⚡';
    else if (path.startsWith('/etc/')) icon = '⚙';
    else if (path.startsWith('/tmp/')) icon = '⏱';

    const isEphemeral = path.startsWith('/tmp/') || path === '/tmp';
    const sizeStr = data.length >= 1024 ? (data.length / 1024).toFixed(1) + 'K' : data.length + 'B';

    li.innerHTML = '<div class="file-item-left">' +
      '<span class="file-icon">' + icon + '</span>' +
      '<span class="file-name" title="' + path + '">' + path + '</span>' +
      '</div>' +
      '<div class="file-item-right">' +
      (isEphemeral ? '<span class="badge-ephemeral">ephemeral</span>' : '') +
      '<span class="file-size">' + sizeStr + '</span>' +
      '</div>';

    li.onclick = () => selectFile(path);
    el.vfsFileList.appendChild(li);
  }
}

function isTextContent(bytes) {
  if (!bytes || bytes.length === 0) return true;
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) return false;
  let nullCount = 0;
  const len = Math.min(bytes.length, 512);
  for (let i = 0; i < len; i++) {
    if (bytes[i] === 0) nullCount++;
  }
  return nullCount === 0;
}

function selectFile(path) {
  if (!state.vfs.has(path)) {
    if (state.vfs.has('/main.wasm')) path = '/main.wasm';
    else if (state.vfs.entries().length > 0) path = state.vfs.entries()[0][0];
    else return;
  }

  state.activeFile = path;
  state.isDirty = false;
  state.hexPage = 0;
  updateSaveIndicator();

  renderVFSFileList();

  const data = state.vfs.get(path) || new Uint8Array(0);
  el.inspectorFileTitle.textContent = path;
  const isWasm = (data.length >= 4 && data[0] === 0x00 && data[1] === 0x61 && data[2] === 0x73 && data[3] === 0x6d);
  const isText = isTextContent(data);

  if (isText) {
    el.inspectorFileType.textContent = 'Text / UTF-8';
    el.editorView.style.display = 'flex';
    el.wasmView.style.display = 'none';
    el.hexView.style.display = 'none';
    el.editorTextarea.value = new TextDecoder().decode(data);
    updateEditorGutter();
  } else if (isWasm) {
    el.inspectorFileType.textContent = 'WebAssembly Binary';
    el.editorView.style.display = 'none';
    el.wasmView.style.display = 'flex';
    el.hexView.style.display = 'none';
    renderWasmOverview(data);
  } else {
    el.inspectorFileType.textContent = 'Binary';
    el.editorView.style.display = 'none';
    el.wasmView.style.display = 'none';
    el.hexView.style.display = 'flex';
    renderHexView(data);
  }
}

function updateEditorGutter() {
  const lines = el.editorTextarea.value.split('\n').length;
  let gutterHtml = '';
  for (let i = 1; i <= lines; i++) {
    gutterHtml += i + '<br>';
  }
  el.editorGutter.innerHTML = gutterHtml;
}

function updateSaveIndicator() {
  if (state.isDirty) {
    el.saveDot.className = 'save-dot dirty';
    el.saveStatus.textContent = 'Modified';
  } else {
    el.saveDot.className = 'save-dot';
    el.saveStatus.textContent = 'Saved';
  }
}

function renderWasmOverview(data) {
  const parsed = parseWasmSections(data);
  if (!parsed) return;

  el.wasmImportCount.textContent = parsed.imports.length;
  el.wasmImportsTable.innerHTML = parsed.imports.map(imp =>
    '<tr><td>' + imp.mod + '</td><td><strong>' + imp.field + '</strong></td><td><span class="badge-kind">' + imp.kind + '</span></td><td>type #' + imp.typeIdx + '</td></tr>'
  ).join('');

  el.wasmExportCount.textContent = parsed.exports.length;
  el.wasmExportsTable.innerHTML = parsed.exports.map(exp =>
    '<tr><td><strong>' + exp.name + '</strong></td><td><span class="badge-kind">' + exp.kind + '</span></td><td>#' + exp.index + '</td></tr>'
  ).join('');

  let memStr = 'Memory: ';
  if (parsed.memories.length > 0) {
    const m = parsed.memories[0];
    memStr += m.minPages + ' pages (' + (m.minBytes / 1024) + ' KB)' + (m.maxPages ? ' up to ' + m.maxPages + ' pages' : '');
  } else {
    memStr += 'Imported / None defined';
  }
  memStr += ' • Defined Functions: ' + parsed.functionCount;
  el.wasmMemoryDetails.textContent = memStr;

  el.wasmSectionsTable.innerHTML = parsed.sections.map(s =>
    '<tr><td>#' + s.id + '</td><td><strong>' + s.name + '</strong></td><td>' + s.length + ' B</td></tr>'
  ).join('');
}

function renderHexView(data) {
  const res = renderHexDump(data, state.hexPage, 512);
  el.hexDumpContent.innerHTML = res.html;
  el.hexPageInfo.textContent = 'Offset 0x' + res.start.toString(16).padStart(4, '0') + ' - 0x' + res.end.toString(16).padStart(4, '0') + ' (Page ' + (state.hexPage + 1) + ' of ' + res.totalPages + ')';
  el.btnHexPrev.disabled = (state.hexPage <= 0);
  el.btnHexNext.disabled = (state.hexPage >= res.totalPages - 1);
}

async function saveActiveFile() {
  if (!state.activeFile) return;
  const text = el.editorTextarea.value;
  state.vfs.set(state.activeFile, text);
  state.isDirty = false;
  updateSaveIndicator();
  await syncVFSAndURL(true);
  showToast('Saved ' + state.activeFile, 'success');
}

function terminateWorker() {
  if (state.activeWorker) {
    state.activeWorker.terminate();
    state.activeWorker = null;
  }
  if (state.activeWorkerBlobUrl) {
    URL.revokeObjectURL(state.activeWorkerBlobUrl);
    state.activeWorkerBlobUrl = null;
  }
  state.isRunning = false;
  setStatus('ready', 'Terminated');
  termPrint('\n\x1b[31m[Worker halted by user]\x1b[0m\n');
}

async function runActiveWasm(extraStdin = '') {
  if (state.isRunning) {
    terminateWorker();
  }

  if (!state.vfs.has('/main.wasm')) {
    setStatus('error', 'No /main.wasm');
    termPrint('\n\x1b[31mDiagnostic: /main.wasm not found in root filesystem.\x1b[0m\n' +
              'Please select a built-in demo or upload a .wasm file in Workbench Mode (⌘I).\n\n');
    return;
  }

  if (state.isDirty) {
    await saveActiveFile();
  }

  setStatus('running', 'Running...');

  let stdinBytes = new Uint8Array(0);
  if (extraStdin) {
    stdinBytes = new TextEncoder().encode(extraStdin);
  } else if (state.stdinQueue) {
    stdinBytes = new TextEncoder().encode(state.stdinQueue);
    state.stdinQueue = '';
  }

  const workerCodeEl = document.getElementById('worker-code');
  const workerCode = workerCodeEl ? workerCodeEl.textContent : '';
  const blob = new Blob([workerCode], { type: 'application/javascript' });
  state.activeWorkerBlobUrl = URL.createObjectURL(blob);
  const worker = new Worker(state.activeWorkerBlobUrl);
  state.activeWorker = worker;
  state.isRunning = true;

  worker.onmessage = async (e) => {
    const msg = e.data;
    if (msg.type === 'stdout') {
      const text = new TextDecoder().decode(msg.data);
      termPrint(text);
    } else if (msg.type === 'stderr') {
      const text = new TextDecoder().decode(msg.data);
      termPrint('\x1b[33m' + text + '\x1b[0m');
    } else if (msg.type === 'vfs_sync') {
      const incomingKeys = new Set(msg.vfsEntries.map(e => e[0]));
      for (const key of Array.from(state.vfs.keys())) {
        if (!incomingKeys.has(key)) state.vfs.delete(key);
      }
      for (const [p, d] of msg.vfsEntries) {
        state.vfs.set(p, d);
      }
      await syncVFSAndURL(true);
    } else if (msg.type === 'exit') {
      state.isRunning = false;
      const incomingKeys = new Set(msg.vfsEntries.map(e => e[0]));
      for (const key of Array.from(state.vfs.keys())) {
        if (!incomingKeys.has(key)) state.vfs.delete(key);
      }
      for (const [p, d] of msg.vfsEntries) {
        state.vfs.set(p, d);
      }
      await syncVFSAndURL(true);
      if (state.activeFile) selectFile(state.activeFile);

      if (msg.code === 0) {
        setStatus('exited', 'Exited (0)');
      } else {
        setStatus('error', 'Exited (' + msg.code + ')');
      }
    } else if (msg.type === 'crash') {
      state.isRunning = false;
      setStatus('error', 'Crash');
      termPrint('\n\x1b[31m[Wasm Runtime Crash]: ' + msg.error + '\x1b[0m\n');
    } else if (msg.type === 'missing_main') {
      state.isRunning = false;
      setStatus('error', 'No /main.wasm');
      termPrint('\n\x1b[31m' + msg.message + '\x1b[0m\n');
    }
  };

  worker.onerror = (err) => {
    state.isRunning = false;
    setStatus('error', 'Worker Error');
    termPrint('\n\x1b[31m[Worker Host Error]: ' + err.message + '\x1b[0m\n');
  };

  worker.postMessage({
    type: 'run',
    vfsEntries: state.vfs.entries(),
    stdinBytes
  });
}

function loadDemo(demoKey) {
  state.vfs = new VFS();
  if (demoKey === 'counter') {
    const wasm = buildCounterWasm();
    state.vfs.set('/main.wasm', wasm);
    state.vfs.set('/etc/cmdline', '--step 1');
    state.vfs.set('/count.txt', '0\n');
  } else if (demoKey === 'echo') {
    const wasm = buildCliEchoWasm();
    state.vfs.set('/main.wasm', wasm);
    state.vfs.set('/etc/cmdline', '--prefix [PROCESSED] --uppercase');
    state.vfs.set('/input.txt', 'Hello from urlfs virtual filesystem!\nEdit /etc/cmdline or this file in Workbench.\n');
    state.vfs.set('/output.txt', '');
  } else if (demoKey === 'logger') {
    const wasm = buildLoggerWasm();
    state.vfs.set('/main.wasm', wasm);
    state.vfs.set('/etc/cmdline', '--level=debug');
    state.vfs.set('/log.txt', '# Persistent Event Log\n');
    state.vfs.set('/tmp/scratch.bin', new Uint8Array(64));
  } else if (demoKey === 'busybox') {
    const wasm = buildBusyBoxWasm();
    state.vfs.set('/main.wasm', wasm);
    state.vfs.set('/etc/cmdline', '');
    state.vfs.set('/etc/passwd', 'root:x:0:0:root:/root:/bin/sh\nuser:x:1000:1000:User:/home/user:/bin/sh\n');
    state.vfs.set('/etc/group', 'root:x:0:\nusers:x:100:\n');
    state.vfs.set('/etc/hostname', 'urlfs-box\n');
    state.vfs.set('/etc/motd',
      '   ___        __ _         _     _                  \n' +
      '  / _ \\ _ _  / _| |___ ___| |   (_)_ _ _  ___ _____ \n' +
      ' | (_) | \x27 \\|  _| (_-</ -_) |__ | | \x27 \\ || \\ \\ / -_)\n' +
      '  \\___/|_||_|_| |_/__/\\___|____||_|_||_\\_,_/\\_\\___|\n' +
      '  urlfs BusyBox v1.36.1 (wasm32-wasi) Linux Simulation\n\n' +
      'Welcome to your URL-encoded Linux container!\n' +
      '• Every file modification updates the browser URL hash.\n' +
      '• 30 Commands: ls, cat, echo, cp, mv, grep, tail, stat, df, free, id, ps, base64, wc, head, touch, mkdir, rm, uname, whoami, help\n' +
      '• Try: grep root /etc/passwd\n' +
      '• Try: cp /etc/motd /home/user/motd.bak\n' +
      '• Try: df -h  or  free -m\n' +
      '• Try: echo "Hello Linux" > /home/user/hello.txt\n'
    );
    state.vfs.set('/etc/os-release',
      'NAME="urlfs Linux"\n' +
      'ID=urlfs\n' +
      'VERSION="1.0"\n' +
      'VERSION_ID=1.0\n' +
      'PRETTY_NAME="urlfs Linux 1.0 (wasm32-wasi)"\n' +
      'HOME_URL="https://github.com/urlfs"\n'
    );
    state.vfs.set('/etc/issue', 'urlfs Linux 6.1 (wasm32-wasi) \\n \\l\\n');
    state.vfs.set('/home/user/welcome.txt',
      'Welcome to urlfs!\n' +
      'This filesystem is completely encoded in your browser address bar.\n' +
      'You can view, edit, or create files using the shell or the Workbench drawer (⌘I / Ctrl+I).\n'
    );
    state.vfs.set('/home/user/notes.txt',
      '# URLFS Notes\n' +
      '1. Root filesystem is compressed with deflate-raw into URL hash.\n' +
      '2. Runs entirely client-side via WebAssembly & Web Workers.\n' +
      '3. Ephemeral files in /tmp/ are never saved to the URL.\n' +
      '4. Try commands: grep, cp, mv, tail, stat, df, free, id, ps, base64.\n'
    );
    state.vfs.set('/tmp/scratch.log',
      '# System scratch log (ephemeral - will not be saved to URL)\n' +
      '[boot] kernel initialized\n' +
      '[boot] mounting rootfs (wasm32-wasi)\n'
    );
    state.vfs.set('/bin/busybox', '#!/bin/sh\nexec /main.wasm "$@"\n');
    state.vfs.set('/bin/sh', '#!/bin/sh\nexec /main.wasm sh "$@"\n');
  }

  el.termViewport.innerHTML = '';
  selectFile('/main.wasm');
  syncVFSAndURL(true);
  runActiveWasm();
}

function toggleWorkbench(force) {
  state.workbenchOpen = (force !== undefined) ? force : !state.workbenchOpen;
  if (state.workbenchOpen) {
    el.root.classList.add('workbench-active');
    el.btnWorkbenchToggle.classList.add('active');
    if (!state.activeFile) selectFile('/main.wasm');
  } else {
    el.root.classList.remove('workbench-active');
    el.btnWorkbenchToggle.classList.remove('active');
  }
}

function setupApp() {
  initElements();

  el.btnRun.onclick = () => runActiveWasm();
  el.btnStop.onclick = () => terminateWorker();
  el.btnClear.onclick = () => { el.termViewport.innerHTML = ''; };
  el.btnShare.onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      showToast('Shareable URL copied to clipboard!', 'success');
    } catch (e) {
      showToast('URL: ' + location.href);
    }
  };

  el.btnWorkbenchToggle.onclick = () => toggleWorkbench();

  el.demoSelect.onchange = (e) => {
    loadDemo(e.target.value);
  };

  function submitStdin() {
    const val = el.stdinInput.value;
    el.stdinInput.value = '';
    termPrint('\x1b[32mstdin > \x1b[0m' + val + '\n');
    runActiveWasm(val + '\n');
  }
  el.btnStdinSend.onclick = submitStdin;
  el.stdinInput.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitStdin();
    }
  };

  el.editorTextarea.oninput = () => {
    state.isDirty = true;
    updateSaveIndicator();
    updateEditorGutter();
  };
  el.editorTextarea.onkeydown = (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = el.editorTextarea.selectionStart;
      const end = el.editorTextarea.selectionEnd;
      el.editorTextarea.value = el.editorTextarea.value.substring(0, start) + '  ' + el.editorTextarea.value.substring(end);
      el.editorTextarea.selectionStart = el.editorTextarea.selectionEnd = start + 2;
      el.editorTextarea.dispatchEvent(new Event('input'));
    } else if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      saveActiveFile();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      saveActiveFile().then(() => runActiveWasm());
    }
  };
  el.editorTextarea.onscroll = () => {
    el.editorGutter.scrollTop = el.editorTextarea.scrollTop;
  };

  el.btnSave.onclick = () => saveActiveFile();
  el.btnSaveRun.onclick = () => saveActiveFile().then(() => runActiveWasm());
  el.btnRevert.onclick = () => {
    if (state.activeFile) selectFile(state.activeFile);
  };

  el.btnHexPrev.onclick = () => {
    if (state.hexPage > 0) {
      state.hexPage--;
      const data = state.vfs.get(state.activeFile);
      if (data) renderHexView(data);
    }
  };
  el.btnHexNext.onclick = () => {
    state.hexPage++;
    const data = state.vfs.get(state.activeFile);
    if (data) renderHexView(data);
  };

  el.tabWasmOverview.onclick = () => {
    el.tabWasmOverview.classList.add('active');
    el.tabWasmHex.classList.remove('active');
    el.wasmOverviewContent.style.display = 'block';
    el.hexView.style.display = 'none';
  };
  el.tabWasmHex.onclick = () => {
    el.tabWasmHex.classList.add('active');
    el.tabWasmOverview.classList.remove('active');
    el.wasmOverviewContent.style.display = 'none';
    el.hexView.style.display = 'flex';
    const data = state.vfs.get(state.activeFile);
    if (data) renderHexView(data);
  };

  el.btnNewFile.onclick = () => {
    const name = prompt('Enter filename (e.g. /etc/config.json):', '/new_file.txt');
    if (name) {
      const norm = state.vfs.normalizePath(name);
      state.vfs.set(norm, '');
      syncVFSAndURL(true);
      selectFile(norm);
    }
  };

  el.btnUploadFile.onclick = () => el.fileUploadInput.click();
  el.fileUploadInput.onchange = (e) => {
    for (const file of e.target.files) {
      const reader = new FileReader();
      reader.onload = () => {
        const data = new Uint8Array(reader.result);
        const path = '/' + file.name;
        state.vfs.set(path, data);
        syncVFSAndURL(true);
        selectFile(path);
        showToast('Imported ' + path, 'success');
      };
      reader.readAsArrayBuffer(file);
    }
    el.fileUploadInput.value = '';
  };

  el.btnDeleteFile.onclick = () => {
    if (!state.activeFile) return;
    if (confirm('Delete ' + state.activeFile + '?')) {
      state.vfs.delete(state.activeFile);
      state.activeFile = null;
      syncVFSAndURL(true);
      const entries = state.vfs.entries();
      if (entries.length > 0) selectFile(entries[0][0]);
    }
  };

  el.btnRenameFile.onclick = () => {
    if (!state.activeFile) return;
    const newName = prompt('New path for ' + state.activeFile + ':', state.activeFile);
    if (newName && newName !== state.activeFile) {
      const norm = state.vfs.normalizePath(newName);
      const data = state.vfs.get(state.activeFile);
      state.vfs.delete(state.activeFile);
      state.vfs.set(norm, data);
      syncVFSAndURL(true);
      selectFile(norm);
    }
  };

  el.btnDownloadFile.onclick = () => {
    if (!state.activeFile) return;
    const data = state.vfs.get(state.activeFile) || new Uint8Array(0);
    const blob = new Blob([data], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.activeFile.split('/').pop() || 'file.bin';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.dropOverlay.classList.add('visible');
  });
  el.dropOverlay.addEventListener('dragleave', () => {
    el.dropOverlay.classList.remove('visible');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    el.dropOverlay.classList.remove('visible');
    if (e.dataTransfer && e.dataTransfer.files) {
      for (const file of e.dataTransfer.files) {
        const reader = new FileReader();
        reader.onload = () => {
          const data = new Uint8Array(reader.result);
          const path = '/' + file.name;
          state.vfs.set(path, data);
          syncVFSAndURL(true);
          selectFile(path);
          showToast('Dropped & mounted ' + path, 'success');
        };
        reader.readAsArrayBuffer(file);
      }
    }
  });

  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      runActiveWasm();
    } else if ((e.metaKey || e.ctrlKey) && (e.key === 'i' || e.key === 'I')) {
      e.preventDefault();
      toggleWorkbench();
    }
  });

  let isDraggingSplitter = false;
  el.splitter.addEventListener('mousedown', () => {
    isDraggingSplitter = true;
    el.splitter.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
  });
  window.addEventListener('mousemove', (e) => {
    if (!isDraggingSplitter) return;
    const totalWidth = el.root.clientWidth;
    const rightWidth = totalWidth - e.clientX;
    const pct = (rightWidth / totalWidth) * 100;
    if (pct >= 20 && pct <= 80) {
      document.getElementById('workbench-pane').style.width = pct + '%';
    }
  });
  window.addEventListener('mouseup', () => {
    if (isDraggingSplitter) {
      isDraggingSplitter = false;
      el.splitter.classList.remove('dragging');
      document.body.style.cursor = '';
    }
  });

  const hash = location.hash.replace(/^#/, '');
  if (hash && hash.length > 3) {
    deserializeVFS(hash, state.vfs).then(() => {
      el.demoSelect.value = 'custom';
      syncVFSAndURL(false);
      selectFile('/main.wasm');
      runActiveWasm();
    }).catch(err => {
      termPrint('\x1b[31m[URL Hash Load Error]: ' + err.message + '\x1b[0m\nLoading Demo 1 fallback...\n');
      el.demoSelect.value = 'counter';
      loadDemo('counter');
    });
  } else {
    el.demoSelect.value = 'counter';
    loadDemo('counter');
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', setupApp);
  } else {
    setupApp();
  }
}