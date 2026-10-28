const { WasiHost, VFS, WasiExitError } = require('./src/worker.js');
const fs = require('fs');

class WasmAssembler {
  constructor() {
    this.types = [];
    this.imports = [];
    this.funcs = [];
    this.exports = [];
    this.codes = [];
    this.data = [];
    this.memory = null;
  }

  addType(params, results) {
    const key = `${params.join(',')}=>${results.join(',')}`;
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
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v !== 0) b |= 0x80;
      r.push(b);
    } while (v !== 0);
    return r;
  }

  static sleb(v) {
    const r = [];
    let more = true;
    while (more) {
      let b = v & 0x7f;
      v >>= 7;
      if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) {
        more = false;
      } else {
        b |= 0x80;
      }
      r.push(b);
    }
    return r;
  }

  static sleb64(v) {
    if (typeof v !== 'bigint') v = BigInt(v);
    const r = [];
    let more = true;
    while (more) {
      let b = Number(v & 0x7fn);
      v >>= 7n;
      if ((v === 0n && (b & 0x40) === 0) || (v === -1n && (b & 0x40) !== 0)) {
        more = false;
      } else {
        b |= 0x80;
      }
      r.push(b);
    }
    return r;
  }

  build() {
    const uleb = WasmAssembler.uleb;
    const sleb = WasmAssembler.sleb;
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
      if (this.memory.max !== undefined) {
        p.push(0x01, ...uleb(this.memory.min), ...uleb(this.memory.max));
      } else {
        p.push(0x00, ...uleb(this.memory.min));
      }
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
          const locVec = uleb(c.locals.length).concat(
            c.locals.flatMap(l => [...uleb(l[0]), l[1]])
          );
          const body = [...locVec, ...c.instructions.flat(Infinity), 0x0b];
          return [...uleb(body.length), ...body];
        })
      );
      sections.push([0x0a, ...uleb(p.length), ...p]);
    }

    if (this.data.length) {
      const p = uleb(this.data.length).concat(
        this.data.flatMap(d => [
          0x00,
          0x41, ...sleb(d.offset), 0x0b,
          ...uleb(d.bytes.length),
          ...d.bytes
        ])
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
  i32_load: 0x28, i32_load8_u: 0x2D, i32_store: 0x36, i32_store8: 0x3A, i64_store: 0x37,
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
  le_s: () => [OP.i32_le_s],
  le_u: () => [OP.i32_le_u],
  gt_u: () => [OP.i32_gt_u],
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

// ==========================================
// BUILD DEMO 1: COUNTER
// ==========================================
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

  // Helper: print_stdout(ptr, len) -> i32
  const f_print_stdout = wb.addFunction(t_ii_i, [], [
    I.const(16), I.get(0), I.store(),
    I.const(20), I.get(1), I.store(),
    I.const(1), I.const(16), I.const(1), I.const(24),
    I.call(f_fd_write)
  ]);

  // Helper: format_int(val, outPtr) -> len
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

  // _start
  const f_start = wb.addFunction(t_v_v, [[5, i32]], [
    I.const(3), I.const(0), I.const(PATH_COUNT_OFFSET), I.const(9), I.const(1),
    I.const64(0x1fffffffn), I.const64(0x1fffffffn), I.const(0), I.const(0),
    I.call(f_path_open),
    I.drop(),

    I.const(0), I.load(), I.set(0), // fd = *0

    // read count into 100..
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

    // format into 100
    I.get(1), I.const(100), I.call(f_format_int), I.set(2),
    I.const(100), I.get(2), I.add(), I.const(10), I.store8(),
    I.get(2), I.const(1), I.add(), I.set(2),

    // seek 0
    I.get(0), I.const64(0n), I.const(0), I.const(8), I.call(f_fd_seek),
    I.drop(),

    // write
    I.const(16), I.const(100), I.store(),
    I.const(20), I.get(2), I.store(),
    I.get(0), I.const(16), I.const(1), I.const(4), I.call(f_fd_write),
    I.drop(),

    // close
    I.get(0), I.call(f_fd_close),
    I.drop(),

    // print banner 1
    I.const(BANNER1_OFFSET), I.const(banner1.length), I.call(f_print_stdout),
    I.drop(),

    // print count
    I.const(100), I.get(2), I.const(1), I.sub(), I.call(f_print_stdout),
    I.drop(),

    // print banner 2
    I.const(BANNER2_OFFSET), I.const(banner2.length), I.call(f_print_stdout),
    I.drop(),

    I.const(0), I.call(f_proc_exit)
  ]);

  wb.addExport('_start', 0x00, f_start);
  return wb.build();
}

// ==========================================
// BUILD DEMO 2: CLI-ECHO & STREAM PROCESSOR
// ==========================================
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
  const OFF_TAG_ARGS = 2500; wb.addData(OFF_TAG_ARGS, tagArgs);
  const OFF_TAG_ARROW = 2600; wb.addData(OFF_TAG_ARROW, tagArrow);
  const OFF_TAG_CLOSE = 2650; wb.addData(OFF_TAG_CLOSE, tagClose);
  const OFF_TAG_QUOTENL = 2700; wb.addData(OFF_TAG_QUOTENL, tagQuoteNl);
  const OFF_TAG_TRANS = 2750; wb.addData(OFF_TAG_TRANS, tagTransform);
  const OFF_TAG_DONE = 2850; wb.addData(OFF_TAG_DONE, tagDone);

  // Helper: print_stdout(ptr, len) -> i32
  const f_print_stdout = wb.addFunction(t_ii_i, [], [
    I.const(16), I.get(0), I.store(),
    I.const(20), I.get(1), I.store(),
    I.const(1), I.const(16), I.const(1), I.const(24),
    I.call(f_fd_write)
  ]);

  // Helper: strlen(ptr) -> len
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

  // Helper: format_int(val, outPtr) -> len
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

  // Main _start
  // Memory map:
  // 0: argc_ptr (4 bytes)
  // 4: argv_buf_size_ptr (4 bytes)
  // 8: opened_fd (4 bytes)
  // 12: nread / nwritten (4 bytes)
  // 16..31: iov
  // 32..47: format_int buf
  // 512..1023: argv pointers array (128 pointers)
  // 1024..2047: argv string characters
  // 4096..8191: input/output stream buffer (4KB)
  // Locals: [0: argc, 1: i, 2: argPtr, 3: argLen, 4: inFd, 5: outFd, 6: bytesRead, 7: ch]
  const f_start = wb.addFunction(t_v_v, [[8, i32]], [
    // Print banner
    I.const(OFF_BANNER), I.const(banner.length), I.call(f_print_stdout), I.drop(),
    I.const(OFF_TAG_ARGS), I.const(tagArgs.length), I.call(f_print_stdout), I.drop(),

    // args_sizes_get(0, 4)
    I.const(0), I.const(4), I.call(f_args_sizes), I.drop(),
    I.const(0), I.load(), I.set(0), // argc

    // args_get(512, 1024)
    I.const(512), I.const(1024), I.call(f_args_get), I.drop(),

    // Loop through args
    I.const(0), I.set(1), // i = 0
    I.block(),
      I.loop(),
        I.get(1), I.get(0), I.ge_s(), I.br_if(1), // if i >= argc break
        I.const(512), I.get(1), I.const(4), I.mul(), I.add(), I.load(), I.set(2), // argPtr
        I.get(2), I.const(0), I.call(f_strlen), I.set(3), // argLen

        // Print: "    • argv["
        I.const(OFF_TAG_ARROW), I.const(tagArrow.length), I.call(f_print_stdout), I.drop(),
        // Format & print i
        I.get(1), I.const(32), I.call(f_format_int), I.set(7),
        I.const(32), I.get(7), I.call(f_print_stdout), I.drop(),
        // Print: "] = \""
        I.const(OFF_TAG_CLOSE), I.const(tagClose.length), I.call(f_print_stdout), I.drop(),
        // Print argument string
        I.get(2), I.get(3), I.call(f_print_stdout), I.drop(),
        // Print: "\"\n"
        I.const(OFF_TAG_QUOTENL), I.const(tagQuoteNl.length), I.call(f_print_stdout), I.drop(),

        I.get(1), I.const(1), I.add(), I.set(1),
        I.br(0),
      I.end(),
    I.end(),

    // Print processing stream message
    I.const(OFF_TAG_TRANS), I.const(tagTransform.length), I.call(f_print_stdout), I.drop(),

    // Open /input.txt: path_open(3, 0, OFF_INPUT_NAME, 9, 0, rights, rights, 0, 8)
    I.const(3), I.const(0), I.const(OFF_INPUT_NAME), I.const(9), I.const(0),
    I.const64(0x1fffffffn), I.const64(0x1fffffffn), I.const(0), I.const(8),
    I.call(f_path_open), I.drop(),
    I.const(8), I.load(), I.set(4), // inFd

    // Read input.txt into 4096..
    I.const(16), I.const(4096), I.store(),
    I.const(20), I.const(4096), I.store(),
    I.get(4), I.const(16), I.const(1), I.const(12), I.call(f_fd_read), I.drop(),
    I.const(12), I.load(), I.set(6), // bytesRead

    // Close inFd
    I.get(4), I.call(f_fd_close), I.drop(),

    // Transform stream: convert lowercase 'a'..'z' to uppercase 'A'..'Z'
    I.const(0), I.set(1), // i = 0
    I.block(),
      I.loop(),
        I.get(1), I.get(6), I.ge_s(), I.br_if(1),
        I.const(4096), I.get(1), I.add(), I.load8_u(), I.set(7), // ch
        // if ch >= 97 && ch <= 122 -> ch -= 32
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

    // Open /output.txt with O_CREAT | O_TRUNC (1 | 8 = 9)
    I.const(3), I.const(0), I.const(OFF_OUTPUT_NAME), I.const(10), I.const(9),
    I.const64(0x1fffffffn), I.const64(0x1fffffffn), I.const(0), I.const(8),
    I.call(f_path_open), I.drop(),
    I.const(8), I.load(), I.set(5), // outFd

    // Write transformed buffer to outFd
    I.const(16), I.const(4096), I.store(),
    I.const(20), I.get(6), I.store(),
    I.get(5), I.const(16), I.const(1), I.const(12), I.call(f_fd_write), I.drop(),

    // Close outFd
    I.get(5), I.call(f_fd_close), I.drop(),

    // Print done
    I.const(OFF_TAG_DONE), I.const(tagDone.length), I.call(f_print_stdout), I.drop(),

    // Exit 0
    I.const(0), I.call(f_proc_exit)
  ]);

  wb.addExport('_start', 0x00, f_start);
  return wb.build();
}

// ==========================================
// BUILD DEMO 3: LOGGER (PERSISTENT VS EPHEMERAL)
// ==========================================
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
  const OFF_TAG_APP = 2500; wb.addData(OFF_TAG_APP, tagAppended);

  // Helper: print_stdout(ptr, len) -> i32
  const f_print_stdout = wb.addFunction(t_ii_i, [], [
    I.const(16), I.get(0), I.store(),
    I.const(20), I.get(1), I.store(),
    I.const(1), I.const(16), I.const(1), I.const(24),
    I.call(f_fd_write)
  ]);

  // Main _start
  // Memory layout:
  // 0: opened_fd
  // 8: nwritten
  // 16..31: iov
  // 32..47: time (u64 at 32)
  // 48..63: random bytes (16 bytes)
  // 100..299: log line buffer
  // 512..575: 64 scratch bytes
  // Locals: [0: logFd, 1: scratchFd, 2: i]
  const f_start = wb.addFunction(t_v_v, [[3, i32]], [
    // Print banner
    I.const(OFF_BANNER), I.const(banner.length), I.call(f_print_stdout), I.drop(),

    // clock_time_get(0, 0, 32)
    I.const(0), I.const64(0n), I.const(32), I.call(f_clock), I.drop(),

    // random_get(48, 16)
    I.const(48), I.const(16), I.call(f_rand), I.drop(),

    // Fill log line buffer at 100: "[EVENT] Time tick recorded: id="
    // Let's store static prefix bytes:
    // '[' = 91, 'E'=69, 'V'=86, 'E'=69, 'N'=78, 'T'=84, ']'=93, ' '=32
    I.const(100), I.const(91), I.store8(),
    I.const(101), I.const(69), I.store8(),
    I.const(102), I.const(86), I.store8(),
    I.const(103), I.const(69), I.store8(),
    I.const(104), I.const(78), I.store8(),
    I.const(105), I.const(84), I.store8(),
    I.const(106), I.const(93), I.store8(),
    I.const(107), I.const(32), I.store8(),
    I.const(108), I.const(116), I.store8(), // 't'
    I.const(109), I.const(105), I.store8(), // 'i'
    I.const(110), I.const(99), I.store8(),  // 'c'
    I.const(111), I.const(107), I.store8(), // 'k'
    I.const(112), I.const(32), I.store8(),
    I.const(113), I.const(35), I.store8(),  // '#'

    // write 8 hex chars from random bytes at 48 into 114..121
    I.const(0), I.set(2),
    I.block(),
      I.loop(),
        I.get(2), I.const(8), I.ge_s(), I.br_if(1),
        // hex char = '0' + (byte % 10)
        I.const(114), I.get(2), I.add(),
        I.const(48), I.const(48), I.get(2), I.add(), I.load8_u(), I.const(10), I.rem_u(), I.add(),
        I.store8(),
        I.get(2), I.const(1), I.add(), I.set(2),
        I.br(0),
      I.end(),
    I.end(),
    I.const(122), I.const(10), I.store8(), // '\n'

    // Open /log.txt with O_CREAT (1)
    I.const(3), I.const(0), I.const(OFF_FILE_LOG), I.const(7), I.const(1),
    I.const64(0x1fffffffn), I.const64(0x1fffffffn), I.const(0), I.const(0),
    I.call(f_path_open), I.drop(),
    I.const(0), I.load(), I.set(0), // logFd

    // Seek to end: fd_seek(logFd, 0n, 2, 8)
    I.get(0), I.const64(0n), I.const(2), I.const(8), I.call(f_fd_seek), I.drop(),

    // Write 23 bytes (100..123) to /log.txt
    I.const(16), I.const(100), I.store(),
    I.const(20), I.const(23), I.store(),
    I.get(0), I.const(16), I.const(1), I.const(8), I.call(f_fd_write), I.drop(),

    // Close logFd
    I.get(0), I.call(f_fd_close), I.drop(),

    // Open /tmp/scratch.bin with O_CREAT | O_TRUNC (1 | 8 = 9)
    I.const(3), I.const(0), I.const(OFF_FILE_SCRATCH), I.const(15), I.const(9),
    I.const64(0x1fffffffn), I.const64(0x1fffffffn), I.const(0), I.const(0),
    I.call(f_path_open), I.drop(),
    I.const(0), I.load(), I.set(1), // scratchFd

    // Fill scratch buffer at 512..575
    I.const(0), I.set(2),
    I.block(),
      I.loop(),
        I.get(2), I.const(64), I.ge_s(), I.br_if(1),
        I.const(512), I.get(2), I.add(),
        I.get(2), I.const(65), I.add(), // 'A' + i
        I.store8(),
        I.get(2), I.const(1), I.add(), I.set(2),
        I.br(0),
      I.end(),
    I.end(),

    // Write 64 bytes to scratchFd
    I.const(16), I.const(512), I.store(),
    I.const(20), I.const(64), I.store(),
    I.get(1), I.const(16), I.const(1), I.const(8), I.call(f_fd_write), I.drop(),

    // Close scratchFd
    I.get(1), I.call(f_fd_close), I.drop(),

    // Print summary
    I.const(OFF_TAG_APP), I.const(tagAppended.length), I.call(f_print_stdout), I.drop(),

    // Exit 0
    I.const(0), I.call(f_proc_exit)
  ]);

  wb.addExport('_start', 0x00, f_start);
  return wb.build();
}

console.log("Testing all 3 demos...");
const cBytes = buildCounterWasm();
const eBytes = buildCliEchoWasm();
const lBytes = buildLoggerWasm();

console.log("Counter valid:", WebAssembly.validate(cBytes), "bytes:", cBytes.length);
console.log("Echo valid:", WebAssembly.validate(eBytes), "bytes:", eBytes.length);
console.log("Logger valid:", WebAssembly.validate(lBytes), "bytes:", lBytes.length);

async function runDemo(name, bytes, vfsInit, argv) {
  console.log(`\n=================== RUNNING ${name} ===================`);
  const vfs = new VFS();
  for (const [k, v] of Object.entries(vfsInit)) {
    vfs.set(k, v);
  }
  let out = '';
  const host = new WasiHost({
    vfs,
    argv: argv || ['/main.wasm'],
    onStdout: (b) => { out += new TextDecoder().decode(b); },
    onStderr: (b) => { out += new TextDecoder().decode(b); }
  });

  const { instance } = await WebAssembly.instantiate(bytes, host.getImports());
  host.instance = instance;
  try {
    instance.exports._start();
  } catch (e) {
    if (e instanceof WasiExitError) {
      // expected
    } else {
      throw e;
    }
  }
  console.log(out);
  console.log("Files after run:");
  for (const [p, d] of vfs.entries()) {
    console.log(`  ${p}: (${d.length} bytes) ${d.length < 100 ? JSON.stringify(new TextDecoder().decode(d)) : '[binary/large]'}`);
  }
}

(async () => {
  await runDemo("DEMO 1 (Counter)", cBytes, { '/count.txt': '0\n' });
  await runDemo("DEMO 2 (Cli-Echo)", eBytes, {
    '/input.txt': 'Hello from urlfs virtual filesystem!\nEdit /etc/cmdline or this file in Workbench.\n'
  }, ['/main.wasm', '--prefix', '[DEMO]', '--mode=uppercase']);
  await runDemo("DEMO 3 (Logger)", lBytes, {
    '/log.txt': '# Persistent Event Log\n'
  });
})();

module.exports = { cBytes, eBytes, lBytes };
