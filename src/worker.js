class VFS {
  constructor() {
    this.files = new Map();
    this.dirs = new Set(['/']);
  }

  normalizePath(p) {
    if (!p) return '/';
    while (p.startsWith('/')) p = p.slice(1);
    const parts = p.split('/').filter(x => x.length > 0 && x !== '.');
    const res = [];
    for (const part of parts) {
      if (part === '..') {
        if (res.length > 0) res.pop();
      } else {
        res.push(part);
      }
    }
    return '/' + res.join('/');
  }

  get(p) {
    return this.files.get(this.normalizePath(p));
  }

  set(p, data) {
    if (typeof data === 'string') {
      data = new TextEncoder().encode(data);
    }
    this.files.set(this.normalizePath(p), data);
  }

  has(p) {
    return this.files.has(this.normalizePath(p));
  }

  delete(p) {
    return this.files.delete(this.normalizePath(p));
  }

  createDir(p) {
    this.dirs.add(this.normalizePath(p));
  }

  deleteDir(p) {
    this.dirs.delete(this.normalizePath(p));
  }

  entries() {
    return Array.from(this.files.entries());
  }

  keys() {
    return this.files.keys();
  }

  isDir(p) {
    const norm = this.normalizePath(p);
    if (norm === '/' || this.dirs.has(norm)) return true;
    const prefix = norm + '/';
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
    const prefix = norm === '/' ? '/' : norm + '/';
    const map = new Map();
    for (const k of this.files.keys()) {
      if (k.startsWith(prefix)) {
        const rest = k.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash !== -1) {
          map.set(rest.slice(0, slash), 'dir');
        } else {
          map.set(rest, 'file');
        }
      }
    }
    for (const d of this.dirs) {
      if (d !== norm && d.startsWith(prefix)) {
        const rest = d.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash !== -1) {
          map.set(rest.slice(0, slash), 'dir');
        } else if (rest.length > 0) {
          map.set(rest, 'dir');
        }
      }
    }
    return Array.from(map.entries()).map(([name, type]) => ({ name, type }));
  }
}

class WasiExitError extends Error {
  constructor(code) {
    super('WASI exit code ' + code);
    this.code = code;
  }
}

class WasiHost {
  constructor({ vfs, argv = ['/main.wasm'], env = {}, stdinBuffer = new Uint8Array(0), onStdout, onStderr, onSync }) {
    this.vfs = vfs;
    this.argv = argv;
    this.env = env;
    this.stdinBuffer = stdinBuffer;
    this.stdinOffset = 0;
    this.onStdout = onStdout || (() => {});
    this.onStderr = onStderr || (() => {});
    this.onSync = onSync || (() => {});

    this.nextFd = 4;
    this.fds = new Map();
    this.fds.set(0, { type: 'stdin', offset: 0 });
    this.fds.set(1, { type: 'stdout' });
    this.fds.set(2, { type: 'stderr' });
    this.fds.set(3, { type: 'dir', path: '/' });

    this.instance = null;
  }

  get mem() {
    return this.instance.exports.memory;
  }

  get view() {
    return new DataView(this.mem.buffer);
  }

  get u8() {
    return new Uint8Array(this.mem.buffer);
  }

  fillFilestat(ptr, filetype, size, ino = 1) {
    this.view.setBigUint64(ptr, 0n, true);
    this.view.setBigUint64(ptr + 8, BigInt(ino), true);
    this.view.setUint8(ptr + 16, filetype);
    this.view.setBigUint64(ptr + 24, 1n, true);
    this.view.setBigUint64(ptr + 32, size, true);
    const now = BigInt(Date.now()) * 1000000n;
    this.view.setBigUint64(ptr + 40, now, true);
    this.view.setBigUint64(ptr + 48, now, true);
    this.view.setBigUint64(ptr + 56, now, true);
  }

  getImports() {
    const enc = new TextEncoder();
    const dec = new TextDecoder();

    return {
      wasi_snapshot_preview1: {
        args_sizes_get: (argc_ptr, argv_buf_size_ptr) => {
          this.view.setUint32(argc_ptr, this.argv.length, true);
          let totalBytes = 0;
          for (const a of this.argv) {
            totalBytes += enc.encode(a).length + 1;
          }
          this.view.setUint32(argv_buf_size_ptr, totalBytes, true);
          return 0;
        },

        args_get: (argv_ptr, argv_buf_ptr) => {
          let bufOffset = argv_buf_ptr;
          for (let i = 0; i < this.argv.length; i++) {
            this.view.setUint32(argv_ptr + i * 4, bufOffset, true);
            const bytes = enc.encode(this.argv[i]);
            this.u8.set(bytes, bufOffset);
            this.u8[bufOffset + bytes.length] = 0;
            bufOffset += bytes.length + 1;
          }
          return 0;
        },

        environ_sizes_get: (environc_ptr, environ_buf_size_ptr) => {
          const entries = Object.entries(this.env);
          this.view.setUint32(environc_ptr, entries.length, true);
          let total = 0;
          for (const [k, v] of entries) {
            total += enc.encode(k + '=' + v).length + 1;
          }
          this.view.setUint32(environ_buf_size_ptr, total, true);
          return 0;
        },

        environ_get: (environ_ptr, environ_buf_ptr) => {
          const entries = Object.entries(this.env);
          let bufOffset = environ_buf_ptr;
          for (let i = 0; i < entries.length; i++) {
            this.view.setUint32(environ_ptr + i * 4, bufOffset, true);
            const bytes = enc.encode(entries[i][0] + '=' + entries[i][1]);
            this.u8.set(bytes, bufOffset);
            this.u8[bufOffset + bytes.length] = 0;
            bufOffset += bytes.length + 1;
          }
          return 0;
        },

        fd_prestat_get: (fd, prestat_ptr) => {
          if (fd === 3) {
            this.view.setUint8(prestat_ptr, 0);
            this.view.setUint32(prestat_ptr + 4, 1, true);
            return 0;
          }
          return 8; // EBADF
        },

        fd_prestat_dir_name: (fd, path_buf_ptr, path_len) => {
          if (fd === 3) {
            this.u8[path_buf_ptr] = 47; // '/'
            return 0;
          }
          return 8;
        },

        path_open: (fd, dirflags, path_ptr, path_len, oflags, fs_rights_base, fs_rights_inheriting, fdflags, opened_fd_ptr) => {
          const dirFd = this.fds.get(fd);
          if (!dirFd || dirFd.type !== 'dir') return 8;
          const pathBytes = this.u8.subarray(path_ptr, path_ptr + path_len);
          const relPath = dec.decode(pathBytes);
          const fullPath = relPath.startsWith('/')
            ? this.vfs.normalizePath(relPath)
            : this.vfs.normalizePath(dirFd.path + '/' + relPath);

          const O_CREAT = 1, O_DIRECTORY = 2, O_EXCL = 4, O_TRUNC = 8;
          const exists = this.vfs.has(fullPath);
          const isDir = this.vfs.isDir(fullPath);

          if ((oflags & O_DIRECTORY) && exists && !isDir) return 54; // ENOTDIR
          if ((oflags & O_CREAT) && (oflags & O_EXCL) && (exists || isDir)) return 20; // EEXIST

          if (!exists && !isDir) {
            if (oflags & O_CREAT) {
              this.vfs.set(fullPath, new Uint8Array(0));
              this.onSync(fullPath);
            } else {
              return 44; // ENOENT
            }
          }

          if (oflags & O_TRUNC) {
            this.vfs.set(fullPath, new Uint8Array(0));
            this.onSync(fullPath);
          }

          const newFd = this.nextFd++;
          const isDirectory = isDir && !(oflags & O_CREAT && !exists);
          const fdObj = {
            fd: newFd,
            path: fullPath,
            type: isDirectory ? 'dir' : 'file',
            offset: (fdflags & 1) && !isDirectory ? (this.vfs.get(fullPath)?.length || 0) : 0,
            flags: fdflags
          };
          this.fds.set(newFd, fdObj);
          this.view.setUint32(opened_fd_ptr, newFd, true);
          return 0;
        },

        fd_read: (fd, iovs_ptr, iovs_len, nread_ptr) => {
          const fdEntry = this.fds.get(fd);
          if (!fdEntry) return 8;
          if (fdEntry.type === 'dir') return 31;

          let totalRead = 0;
          if (fdEntry.type === 'stdin') {
            for (let i = 0; i < iovs_len; i++) {
              const ptr = this.view.getUint32(iovs_ptr + i * 8, true);
              const len = this.view.getUint32(iovs_ptr + i * 8 + 4, true);
              const avail = this.stdinBuffer.length - this.stdinOffset;
              if (avail <= 0) break;
              const toRead = Math.min(len, avail);
              this.u8.set(this.stdinBuffer.subarray(this.stdinOffset, this.stdinOffset + toRead), ptr);
              this.stdinOffset += toRead;
              totalRead += toRead;
              if (toRead < len) break;
            }
            this.view.setUint32(nread_ptr, totalRead, true);
            return 0;
          }

          const data = this.vfs.get(fdEntry.path) || new Uint8Array(0);
          for (let i = 0; i < iovs_len; i++) {
            const ptr = this.view.getUint32(iovs_ptr + i * 8, true);
            const len = this.view.getUint32(iovs_ptr + i * 8 + 4, true);
            const avail = Math.max(0, data.length - fdEntry.offset);
            if (avail <= 0) break;
            const toRead = Math.min(len, avail);
            this.u8.set(data.subarray(fdEntry.offset, fdEntry.offset + toRead), ptr);
            fdEntry.offset += toRead;
            totalRead += toRead;
            if (toRead < len) break;
          }
          this.view.setUint32(nread_ptr, totalRead, true);
          return 0;
        },

        fd_write: (fd, iovs_ptr, iovs_len, nwritten_ptr) => {
          const fdEntry = this.fds.get(fd);
          if (!fdEntry) return 8;
          if (fdEntry.type === 'dir') return 31;

          let totalWritten = 0;
          const chunks = [];
          for (let i = 0; i < iovs_len; i++) {
            const ptr = this.view.getUint32(iovs_ptr + i * 8, true);
            const len = this.view.getUint32(iovs_ptr + i * 8 + 4, true);
            if (len > 0) {
              chunks.push(this.u8.slice(ptr, ptr + len));
              totalWritten += len;
            }
          }
          const combined = new Uint8Array(totalWritten);
          let off = 0;
          for (const c of chunks) {
            combined.set(c, off);
            off += c.length;
          }

          if (fdEntry.type === 'stdout') {
            this.onStdout(combined);
            this.view.setUint32(nwritten_ptr, totalWritten, true);
            return 0;
          }
          if (fdEntry.type === 'stderr') {
            this.onStderr(combined);
            this.view.setUint32(nwritten_ptr, totalWritten, true);
            return 0;
          }

          const existing = this.vfs.get(fdEntry.path) || new Uint8Array(0);
          const newLen = Math.max(existing.length, fdEntry.offset + totalWritten);
          const newData = new Uint8Array(newLen);
          newData.set(existing, 0);
          newData.set(combined, fdEntry.offset);
          this.vfs.set(fdEntry.path, newData);
          fdEntry.offset += totalWritten;
          this.onSync(fdEntry.path);

          this.view.setUint32(nwritten_ptr, totalWritten, true);
          return 0;
        },

        fd_pwrite: (fd, iovs_ptr, iovs_len, offset_bigint, nwritten_ptr) => {
          const fdEntry = this.fds.get(fd);
          if (!fdEntry || fdEntry.type !== 'file') return 8;
          let totalWritten = 0;
          const chunks = [];
          for (let i = 0; i < iovs_len; i++) {
            const ptr = this.view.getUint32(iovs_ptr + i * 8, true);
            const len = this.view.getUint32(iovs_ptr + i * 8 + 4, true);
            if (len > 0) {
              chunks.push(this.u8.slice(ptr, ptr + len));
              totalWritten += len;
            }
          }
          const combined = new Uint8Array(totalWritten);
          let off = 0;
          for (const c of chunks) {
            combined.set(c, off);
            off += c.length;
          }
          const writeOffset = Number(offset_bigint);
          const existing = this.vfs.get(fdEntry.path) || new Uint8Array(0);
          const newLen = Math.max(existing.length, writeOffset + totalWritten);
          const newData = new Uint8Array(newLen);
          newData.set(existing, 0);
          newData.set(combined, writeOffset);
          this.vfs.set(fdEntry.path, newData);
          this.onSync(fdEntry.path);
          this.view.setUint32(nwritten_ptr, totalWritten, true);
          return 0;
        },

        fd_pread: (fd, iovs_ptr, iovs_len, offset_bigint, nread_ptr) => {
          const fdEntry = this.fds.get(fd);
          if (!fdEntry || fdEntry.type !== 'file') return 8;
          const data = this.vfs.get(fdEntry.path) || new Uint8Array(0);
          let curOffset = Number(offset_bigint);
          let totalRead = 0;
          for (let i = 0; i < iovs_len; i++) {
            const ptr = this.view.getUint32(iovs_ptr + i * 8, true);
            const len = this.view.getUint32(iovs_ptr + i * 8 + 4, true);
            const avail = Math.max(0, data.length - curOffset);
            if (avail <= 0) break;
            const toRead = Math.min(len, avail);
            this.u8.set(data.subarray(curOffset, curOffset + toRead), ptr);
            curOffset += toRead;
            totalRead += toRead;
            if (toRead < len) break;
          }
          this.view.setUint32(nread_ptr, totalRead, true);
          return 0;
        },

        fd_seek: (fd, offset_bigint, whence, newoffset_ptr) => {
          const fdEntry = this.fds.get(fd);
          if (!fdEntry || fdEntry.type !== 'file') return 8;
          const data = this.vfs.get(fdEntry.path) || new Uint8Array(0);
          let newOffset = 0n;
          if (whence === 0) newOffset = offset_bigint;
          else if (whence === 1) newOffset = BigInt(fdEntry.offset) + offset_bigint;
          else if (whence === 2) newOffset = BigInt(data.length) + offset_bigint;
          else return 28;
          if (newOffset < 0n) return 28;
          fdEntry.offset = Number(newOffset);
          this.view.setBigUint64(newoffset_ptr, newOffset, true);
          return 0;
        },

        fd_tell: (fd, offset_ptr) => {
          const fdEntry = this.fds.get(fd);
          if (!fdEntry || fdEntry.type !== 'file') return 8;
          this.view.setBigUint64(offset_ptr, BigInt(fdEntry.offset), true);
          return 0;
        },

        fd_close: (fd) => {
          if (fd < 3) return 0;
          if (!this.fds.has(fd)) return 8;
          const entry = this.fds.get(fd);
          this.fds.delete(fd);
          if (entry.type === 'file') this.onSync(entry.path);
          return 0;
        },

        fd_sync: (fd) => {
          const entry = this.fds.get(fd);
          if (entry && entry.type === 'file') this.onSync(entry.path);
          return 0;
        },

        fd_datasync: (fd) => {
          const entry = this.fds.get(fd);
          if (entry && entry.type === 'file') this.onSync(entry.path);
          return 0;
        },

        fd_fdstat_get: (fd, fdstat_ptr) => {
          const fdEntry = this.fds.get(fd);
          if (!fdEntry) return 8;
          let filetype = 0;
          if (fdEntry.type === 'stdin' || fdEntry.type === 'stdout' || fdEntry.type === 'stderr') filetype = 2;
          else if (fdEntry.type === 'dir') filetype = 3;
          else if (fdEntry.type === 'file') filetype = 4;
          this.view.setUint8(fdstat_ptr, filetype);
          this.view.setUint16(fdstat_ptr + 2, fdEntry.flags || 0, true);
          this.view.setBigUint64(fdstat_ptr + 8, 0x1fffffffffffn, true);
          this.view.setBigUint64(fdstat_ptr + 16, 0x1fffffffffffn, true);
          return 0;
        },

        fd_fdstat_set_flags: (fd, flags) => {
          const fdEntry = this.fds.get(fd);
          if (!fdEntry) return 8;
          fdEntry.flags = flags;
          return 0;
        },

        fd_filestat_get: (fd, filestat_ptr) => {
          const fdEntry = this.fds.get(fd);
          if (!fdEntry) return 8;
          let filetype = 0, size = 0n;
          if (fdEntry.type === 'stdin' || fdEntry.type === 'stdout' || fdEntry.type === 'stderr') filetype = 2;
          else if (fdEntry.type === 'dir') filetype = 3;
          else if (fdEntry.type === 'file') {
            filetype = 4;
            const data = this.vfs.get(fdEntry.path);
            if (data) size = BigInt(data.length);
          }
          this.fillFilestat(filestat_ptr, filetype, size, 1);
          return 0;
        },

        path_filestat_get: (fd, flags, path_ptr, path_len, filestat_ptr) => {
          const dirFd = this.fds.get(fd);
          if (!dirFd || dirFd.type !== 'dir') return 8;
          const pathBytes = this.u8.subarray(path_ptr, path_ptr + path_len);
          const relPath = dec.decode(pathBytes);
          const fullPath = relPath.startsWith('/')
            ? this.vfs.normalizePath(relPath)
            : this.vfs.normalizePath(dirFd.path + '/' + relPath);
          if (this.vfs.has(fullPath)) {
            const data = this.vfs.get(fullPath);
            this.fillFilestat(filestat_ptr, 4, BigInt(data.length), 2);
            return 0;
          } else if (this.vfs.isDir(fullPath)) {
            this.fillFilestat(filestat_ptr, 3, 0n, 3);
            return 0;
          }
          return 44;
        },

        fd_readdir: (fd, buf_ptr, buf_len, cookie_bigint, bufused_ptr) => {
          const dirFd = this.fds.get(fd);
          if (!dirFd || dirFd.type !== 'dir') return 8;
          const entries = this.vfs.readDir(dirFd.path);
          const cookie = Number(cookie_bigint);
          let bufUsed = 0;
          for (let i = cookie; i < entries.length; i++) {
            const entry = entries[i];
            const nameBytes = enc.encode(entry.name);
            if (bufUsed + 24 > buf_len) break;
            const target = buf_ptr + bufUsed;
            this.view.setBigUint64(target, BigInt(i + 1), true);
            this.view.setBigUint64(target + 8, BigInt(i + 10), true);
            this.view.setUint32(target + 16, nameBytes.length, true);
            this.view.setUint8(target + 20, entry.type === 'dir' ? 3 : 4);
            bufUsed += 24;
            const copyLen = Math.min(nameBytes.length, buf_len - bufUsed);
            if (copyLen > 0) {
              this.u8.set(nameBytes.subarray(0, copyLen), buf_ptr + bufUsed);
              bufUsed += copyLen;
            }
            if (copyLen < nameBytes.length) break;
          }
          this.view.setUint32(bufused_ptr, bufUsed, true);
          return 0;
        },

        path_create_directory: (fd, path_ptr, path_len) => {
          const dirFd = this.fds.get(fd);
          if (!dirFd || dirFd.type !== 'dir') return 8;
          const rel = dec.decode(this.u8.subarray(path_ptr, path_ptr + path_len));
          const full = rel.startsWith('/') ? this.vfs.normalizePath(rel) : this.vfs.normalizePath(dirFd.path + '/' + rel);
          if (this.vfs.has(full) || this.vfs.isDir(full)) return 20;
          this.vfs.createDir(full);
          this.onSync(full);
          return 0;
        },
        path_unlink_file: (fd, path_ptr, path_len) => {
          const dirFd = this.fds.get(fd);
          if (!dirFd || dirFd.type !== 'dir') return 8;
          const rel = dec.decode(this.u8.subarray(path_ptr, path_ptr + path_len));
          const full = rel.startsWith('/') ? this.vfs.normalizePath(rel) : this.vfs.normalizePath(dirFd.path + '/' + rel);
          if (!this.vfs.has(full)) return 44;
          this.vfs.delete(full);
          this.onSync(full);
          return 0;
        },
        path_remove_directory: (fd, path_ptr, path_len) => {
          const dirFd = this.fds.get(fd);
          if (!dirFd || dirFd.type !== 'dir') return 8;
          const rel = dec.decode(this.u8.subarray(path_ptr, path_ptr + path_len));
          const full = rel.startsWith('/') ? this.vfs.normalizePath(rel) : this.vfs.normalizePath(dirFd.path + '/' + rel);
          if (!this.vfs.isDir(full)) return 44;
          this.vfs.deleteDir(full);
          this.onSync(full);
          return 0;
        },
        path_rename: (fd, old_ptr, old_len, new_fd, new_ptr, new_len) => {
          const d1 = this.fds.get(fd), d2 = this.fds.get(new_fd);
          if (!d1 || !d2) return 8;
          const p1 = dec.decode(this.u8.subarray(old_ptr, old_ptr + old_len));
          const p2 = dec.decode(this.u8.subarray(new_ptr, new_ptr + new_len));
          const f1 = p1.startsWith('/') ? this.vfs.normalizePath(p1) : this.vfs.normalizePath(d1.path + '/' + p1);
          const f2 = p2.startsWith('/') ? this.vfs.normalizePath(p2) : this.vfs.normalizePath(d2.path + '/' + p2);
          if (!this.vfs.has(f1)) {
            if (this.vfs.hasDir(f1)) {
              this.vfs.createDir(f2);
              this.vfs.deleteDir(f1);
              const p1p = f1.endsWith('/') ? f1 : f1 + '/';
              const p2p = f2.endsWith('/') ? f2 : f2 + '/';
              for (const [k, v] of Array.from(this.vfs.files.entries())) {
                if (k.startsWith(p1p)) {
                  this.vfs.delete(k);
                  this.vfs.set(p2p + k.slice(p1p.length), v);
                  this.onSync(k);
                  this.onSync(p2p + k.slice(p1p.length));
                }
              }
              for (const d of Array.from(this.vfs.dirs)) {
                if (d.startsWith(p1p)) {
                  this.vfs.dirs.delete(d);
                  this.vfs.dirs.add(p2p + d.slice(p1p.length));
                }
              }
              return 0;
            }
            return 44;
          }
          const data = this.vfs.get(f1);
          this.vfs.delete(f1);
          this.vfs.set(f2, data);
          this.onSync(f1);
          this.onSync(f2);
          return 0;
        },

        clock_time_get: (id, precision, time_ptr) => {
          const nanos = BigInt(Date.now()) * 1000000n;
          this.view.setBigUint64(time_ptr, nanos, true);
          return 0;
        },
        clock_res_get: (id, res_ptr) => {
          this.view.setBigUint64(res_ptr, 1000n, true);
          return 0;
        },
        random_get: (buf_ptr, buf_len) => {
          const buf = this.u8.subarray(buf_ptr, buf_ptr + buf_len);
          crypto.getRandomValues(buf);
          return 0;
        },
        proc_exit: (rval) => {
          throw new WasiExitError(rval);
        },
        sched_yield: () => 0,
        poll_oneoff: (in_ptr, out_ptr, nsub, nevents_ptr) => {
          this.view.setUint32(nevents_ptr, 0, true);
          return 0;
        }
      }
    };
  }
}

function parseCmdline(str) {
  const tokens = ['/main.wasm'];
  if (!str) return tokens;
  let cur = '';
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if ((ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') && !inDouble && !inSingle) {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

function parseEnv(str) {
  const env = {};
  if (!str) return env;
  const lines = str.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || l.startsWith('#')) continue;
    const eq = l.indexOf('=');
    if (eq !== -1) {
      env[l.slice(0, eq).trim()] = l.slice(eq + 1).trim();
    }
  }
  return env;
}

if (typeof self !== 'undefined') {
  self.onmessage = async (e) => {
    const msg = e.data;
    if (msg.type === 'run') {
      const vfs = new VFS();
      for (const [p, d] of msg.vfsEntries) {
        vfs.set(p, d);
      }

      if (!vfs.has('/main.wasm')) {
        self.postMessage({
          type: 'missing_main',
          message: 'Diagnostic: /main.wasm not found in root filesystem.'
        });
        return;
      }

      let argv = ['/main.wasm'];
      if (vfs.has('/etc/cmdline')) {
        const cmdStr = new TextDecoder().decode(vfs.get('/etc/cmdline'));
        argv = parseCmdline(cmdStr);
      }

      let env = {};
      if (vfs.has('/etc/env')) {
        const envStr = new TextDecoder().decode(vfs.get('/etc/env'));
        env = parseEnv(envStr);
      }

      const host = new WasiHost({
        vfs,
        argv,
        env,
        stdinBuffer: msg.stdinBytes || new Uint8Array(0),
        onStdout: (bytes) => {
          self.postMessage({ type: 'stdout', data: bytes });
        },
        onStderr: (bytes) => {
          self.postMessage({ type: 'stderr', data: bytes });
        },
        onSync: (path) => {
          if (!path.startsWith('/tmp/') && path !== '/tmp') {
            self.postMessage({
              type: 'vfs_sync',
              vfsEntries: vfs.entries()
            });
          }
        }
      });

      try {
        const wasmBytes = vfs.get('/main.wasm');
        const mod = await WebAssembly.compile(wasmBytes);
        const instance = await WebAssembly.instantiate(mod, host.getImports());
        host.instance = instance;

        let exitCode = 0;
        try {
          if (instance.exports._start) {
            instance.exports._start();
          } else if (instance.exports.main) {
            exitCode = instance.exports.main();
          } else {
            throw new Error('No _start or main entrypoint found in /main.wasm');
          }
        } catch (err) {
          if (err instanceof WasiExitError) {
            exitCode = err.code;
          } else {
            throw err;
          }
        }

        self.postMessage({
          type: 'exit',
          code: exitCode,
          vfsEntries: vfs.entries()
        });
      } catch (err) {
        self.postMessage({
          type: 'crash',
          error: err.stack || err.message
        });
      }
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { WasiHost, VFS, WasiExitError, parseCmdline, parseEnv };
}
