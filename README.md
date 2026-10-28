# urlfs

urlfs is a client-side WebAssembly (WASI Preview 1) application runner and virtual filesystem where machine state is stored entirely in the browser URL hash.

When an application executes or files are modified, the filesystem is serialized into a compact binary format, compressed with raw DEFLATE, base64url-encoded, and synchronized to the URL hash. Loading or sharing the URL restores the exact machine state without any backend dependencies.

The application is completely self-contained in a single file with no external dependencies or server requirements. You can test the application by opening [`index.html`](index.html) in any modern browser, or via the [online preview](https://htmlpreview.github.io/?https://github.com/gaurangsinha/urlfs/blob/main/index.html).

## Architecture

- **WASI Preview 1 Host**: Implements standard WASI syscalls (`fd_read`, `fd_write`, `fd_seek`, `path_open`, `environ_get`, `args_get`, etc.) inside a dedicated Web Worker.
- **Virtual Filesystem (VFS)**: In-memory filesystem supporting hierarchical directories and binary/text files. Ephemeral paths under `/tmp/` are excluded from URL serialization.
- **Wire Format**: Serializes files with a 3-byte magic header (`0x55 0x46 0x01`), ULEB128-encoded lengths and paths, and compresses the stream using raw DEFLATE (`deflate-raw`).
- **In-Memory WASM Assembler**: Directly emits WebAssembly binary bytecode in JavaScript to construct working modules without an external compiler toolchain.

## Built-in Demos

1. **Stateful URL Counter**: Increments a persistent counter in `/count.txt` using step parameters defined in `/etc/cmdline`.
2. **CLI Stream Processor**: Reads input from `/input.txt`, applies command-line transformations from `/etc/cmdline`, and writes results to `/output.txt`.
3. **Scratch vs. Persistent Log**: Demonstrates persistent logging to `/log.txt` alongside ephemeral storage in `/tmp/scratch.bin`.
4. **BusyBox Linux Simulation**: Implements 30 POSIX-like utilities (`cat`, `cp`, `mv`, `grep`, `head`, `tail`, `stat`, `df`, `free`, `ps`, `wc`, `mkdir`, `rm`, `touch`, `uname`, `whoami`, `sh`) synthesized directly in WebAssembly bytecode.

## Development

### Building

The frontend source files in `src/` bundle into a single self-contained `index.html`:

```bash
node src/build.js
```

### Running Locally

Serve the project root with any static web server:

```bash
python3 -m http.server 8000
```

Then navigate to `http://localhost:8000`.

### Testing

The test suites validate the wire format, WASI runtime execution, and browser integration:

```bash
# Test wire format ULEB128 encoding and DEFLATE roundtrips
node test_wire_format.js

# Test all WASM demos and BusyBox applets against the WASI host in Node
node test_all_demos.js

# Run end-to-end browser automation in headless Chrome
node test_in_chrome.js
```

## License

MIT
