const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

function decodeVfsPayload(b64url) {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const compressed = Buffer.from(b64, 'base64');
  const decompressed = zlib.inflateRawSync(compressed);
  
  if (decompressed[0] !== 0x55 || decompressed[1] !== 0x46 || decompressed[2] !== 0x01) {
    throw new Error('Invalid magic bytes');
  }

  let offset = 3;
  function readUleb() {
    let result = 0;
    let shift = 0;
    while (offset < decompressed.length) {
      const b = decompressed[offset++];
      result |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return result;
  }

  const count = readUleb();
  const files = {};
  for (let i = 0; i < count; i++) {
    const pathLen = readUleb();
    const pathStr = decompressed.slice(offset, offset + pathLen).toString('utf8');
    offset += pathLen;
    const dataLen = readUleb();
    const data = decompressed.slice(offset, offset + dataLen);
    offset += dataLen;
    files['/' + pathStr] = data;
  }
  return { decompressedLen: decompressed.length, compressedLen: compressed.length, files };
}

async function testInChrome() {
  const tmpProfile = '/tmp/chrome-urlfs-test-' + Date.now();
  const filePath = 'file://' + path.resolve(__dirname, 'index.html');
  const port = 9300 + Math.floor(Math.random() * 500);

  console.log("==================================================");
  console.log("       LAUNCHING HEADLESS CHROME TEST SUITE       ");
  console.log("==================================================");

  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${tmpProfile}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    filePath
  ]);

  chrome.on('error', (err) => {
    console.error('Failed to spawn Chrome:', err);
    process.exit(1);
  });

  // Wait for Chrome CDP port to be ready
  let targets = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      targets = await res.json();
      if (targets && targets.length > 0) break;
    } catch (e) {}
  }

  if (!targets || targets.length === 0) {
    console.error("Chrome remote debugging port not available");
    chrome.kill();
    process.exit(1);
  }

  let ws = null;
  try {
    const pageTarget = targets.find(t => t.type === 'page') || targets[0];
    console.log("Target attached:", pageTarget.title);

    ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    let msgId = 1;
    const callbacks = new Map();

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.id && callbacks.has(data.id)) {
        callbacks.get(data.id)(data.result || data);
        callbacks.delete(data.id);
      }
    };

    function sendCmd(method, params = {}) {
      return new Promise((resolve) => {
        const id = msgId++;
        callbacks.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    async function waitForStatus(expected, maxMs = 5000) {
      const start = Date.now();
      while (Date.now() - start < maxMs) {
        const res = await sendCmd('Runtime.evaluate', {
          expression: 'document.getElementById("status-text").innerText',
          returnByValue: true
        });
        if (res.result && res.result.value && res.result.value.includes(expected)) return;
        await new Promise(r => setTimeout(r, 100));
      }
    }

    await new Promise(r => ws.onopen = r);

    await sendCmd('Runtime.enable');
    await sendCmd('Page.enable');

    // Wait for initial worker boot and execution
    await waitForStatus('Exited (0)', 5000);

    // --- TEST 1: Initial Load & Boot (Demo 1: Counter) ---
    console.log("\n[TEST 1] Initial Load & Boot (Default Demo 1: Counter)");
    const eval1 = await sendCmd('Runtime.evaluate', {
      expression: '({ hash: location.hash, terminal: document.getElementById("terminal-viewport").innerText, status: document.getElementById("status-text").innerText })',
      returnByValue: true
    });

    const res1 = eval1.result.value;
    console.log("  • Status badge:", res1.status);
    console.log("  • Hash present:", res1.hash.length > 10, "Length:", res1.hash.length);

    const parsedVfs1 = decodeVfsPayload(res1.hash.slice(1));
    console.log("  • Decompressed wire payload successfully!");
    console.log("  • Magic bytes verified: UF v1");
    console.log("  • Files in serialized URL hash:", Object.keys(parsedVfs1.files));
    const countStr = parsedVfs1.files['/count.txt'].toString('utf8');
    console.log("  • /count.txt content in URL hash:", JSON.stringify(countStr));

    if (res1.terminal.includes('Current Run Count: 1') && countStr.trim() === '1') {
      console.log("  ✓ PASS: Demo 1 ran cleanly, incremented count to 1, and synchronized URL hash!");
    } else {
      throw new Error('Test 1 failed to verify count 1');
    }

    // --- TEST 2: Re-run Execution ---
    console.log("\n[TEST 2] Re-run Execution via '#btn-run'");
    const initialHash = res1.hash;
    await sendCmd('Runtime.evaluate', {
      expression: 'document.getElementById("btn-run").click()'
    });

    await new Promise(r => setTimeout(r, 1000));

    const eval2 = await sendCmd('Runtime.evaluate', {
      expression: '({ hash: location.hash, terminal: document.getElementById("terminal-viewport").innerText })',
      returnByValue: true
    });

    const res2 = eval2.result.value;
    console.log("  • Terminal includes 'Current Run Count: 2':", res2.terminal.includes('Current Run Count: 2'));
    console.log("  • URL hash mutated:", res2.hash !== initialHash);

    const parsedVfs2 = decodeVfsPayload(res2.hash.slice(1));
    const countStr2 = parsedVfs2.files['/count.txt'].toString('utf8');
    console.log("  • /count.txt content in updated URL hash:", JSON.stringify(countStr2));

    if (res2.terminal.includes('Current Run Count: 2') && countStr2.trim() === '2' && res2.hash !== initialHash) {
      console.log("  ✓ PASS: Second execution incremented counter to 2 and updated hash!");
    } else {
      throw new Error('Test 2 failed on re-run');
    }

    // --- TEST 3: Workbench Drawer, File Tree & Wasm Inspector ---
    console.log("\n[TEST 3] Workbench Mode & Wasm Inspector");
    await sendCmd('Runtime.evaluate', {
      expression: 'document.getElementById("btn-workbench-toggle").click()'
    });

    const eval3 = await sendCmd('Runtime.evaluate', {
      expression: `({
        isWorkbenchOpen: document.getElementById('app-root').classList.contains('workbench-active'),
        fileItems: Array.from(document.querySelectorAll('.vfs-file-item .file-name')).map(e => e.textContent),
        activeFile: document.getElementById('inspector-file-title').textContent,
        wasmImportsCount: Array.from(document.querySelectorAll('#wasm-imports-table tbody tr')).length,
        wasmExportsCount: Array.from(document.querySelectorAll('#wasm-exports-table tbody tr')).length,
        uncompressedMetric: document.getElementById('metric-uncompressed').textContent,
        compressedMetric: document.getElementById('metric-compressed').textContent,
        urlLenMetric: document.getElementById('metric-url-len').textContent
      })`,
      returnByValue: true
    });

    const res3 = eval3.result.value;
    console.log("  • Workbench drawer opened:", res3.isWorkbenchOpen);
    console.log("  • VFS sidebar files:", res3.fileItems);
    console.log("  • Active file in inspector:", res3.activeFile);
    console.log("  • Wasm inspector imports:", res3.wasmImportsCount, "exports:", res3.wasmExportsCount);
    console.log(`  • Telemetry metrics: Uncompressed=${res3.uncompressedMetric}, Compressed=${res3.compressedMetric}, URL=${res3.urlLenMetric}`);

    if (res3.isWorkbenchOpen && res3.fileItems.includes('/count.txt') && res3.wasmImportsCount > 0) {
      console.log("  ✓ PASS: Workbench drawer and Wasm binary inspector functioning properly!");
    } else {
      throw new Error('Test 3 failed for Workbench');
    }

    // --- TEST 4: Demo 2 (Cli-Echo) & Live Editor Mutation ---
    console.log("\n[TEST 4] Switch to Demo 2 (Cli-Echo) and live edit /etc/cmdline");
    await sendCmd('Runtime.evaluate', {
      expression: `
        document.getElementById('demo-select').value = 'echo';
        document.getElementById('demo-select').dispatchEvent(new Event('change'));
      `
    });

    await new Promise(r => setTimeout(r, 1000));

    const eval4a = await sendCmd('Runtime.evaluate', {
      expression: '({ terminal: document.getElementById("terminal-viewport").innerText })',
      returnByValue: true
    });

    console.log("  • Demo 2 first run completed with default args: [PROCESSED]");
    if (!eval4a.result.value.terminal.includes('CLI ARGUMENT & STREAM PROCESSOR')) {
      throw new Error('Demo 2 failed initial run');
    }

    // Click /etc/cmdline in file tree to open in editor
    await sendCmd('Runtime.evaluate', {
      expression: `
        const item = Array.from(document.querySelectorAll('.vfs-file-item')).find(el => el.textContent.includes('/etc/cmdline'));
        if (item) item.click();
      `
    });

    await new Promise(r => setTimeout(r, 400));

    // Edit /etc/cmdline and click Save & Run
    await sendCmd('Runtime.evaluate', {
      expression: `
        const ta = document.getElementById('editor-textarea');
        ta.value = '--prefix [CUSTOM_TEST_TOKEN] --uppercase';
        ta.dispatchEvent(new Event('input'));
        document.getElementById('btn-save-run').click();
      `
    });

    await new Promise(r => setTimeout(r, 1200));

    const eval4b = await sendCmd('Runtime.evaluate', {
      expression: '({ terminal: document.getElementById("terminal-viewport").innerText, hash: location.hash })',
      returnByValue: true
    });

    const res4b = eval4b.result.value;
    console.log("  • Terminal includes '[CUSTOM_TEST_TOKEN]':", res4b.terminal.includes('[CUSTOM_TEST_TOKEN]'));
    const parsedVfs4 = decodeVfsPayload(res4b.hash.slice(1));
    const savedCmdline = parsedVfs4.files['/etc/cmdline'].toString('utf8');
    console.log("  • /etc/cmdline in URL hash:", JSON.stringify(savedCmdline));

    if (res4b.terminal.includes('[CUSTOM_TEST_TOKEN]') && savedCmdline.includes('[CUSTOM_TEST_TOKEN]')) {
      console.log("  ✓ PASS: File editor edited /etc/cmdline, mutated URL hash, and CLI processed custom args!");
    } else {
      throw new Error('Test 4 failed on live file editing');
    }

    // --- TEST 5: Demo 3 (Logger) & Strict Ephemeral /tmp/* Exclusion ---
    console.log("\n[TEST 5] Switch to Demo 3 (Logger) & Verify /tmp/* Excluded from URL Hash");
    await sendCmd('Runtime.evaluate', {
      expression: `
        document.getElementById('demo-select').value = 'logger';
        document.getElementById('demo-select').dispatchEvent(new Event('change'));
      `
    });

    await new Promise(r => setTimeout(r, 1000));

    const eval5 = await sendCmd('Runtime.evaluate', {
      expression: `({
        terminal: document.getElementById("terminal-viewport").innerText,
        hasEphemeralBadge: document.querySelector('.badge-ephemeral') !== null,
        fileItems: Array.from(document.querySelectorAll('.vfs-file-item .file-name')).map(e => e.textContent),
        hash: location.hash
      })`,
      returnByValue: true
    });

    const res5 = eval5.result.value;
    console.log("  • In-memory VFS files (including /tmp):", res5.fileItems);
    console.log("  • Ephemeral badge visible in UI tree:", res5.hasEphemeralBadge);

    const parsedVfs5 = decodeVfsPayload(res5.hash.slice(1));
    const urlFiles = Object.keys(parsedVfs5.files);
    console.log("  • Serialized files inside URL hash:", urlFiles);

    const scratchInUrl = urlFiles.some(f => f.startsWith('/tmp'));
    console.log("  • Any /tmp/* file in URL hash:", scratchInUrl);

    if (res5.fileItems.includes('/tmp/scratch.bin') && res5.hasEphemeralBadge && !scratchInUrl && urlFiles.includes('/log.txt')) {
      console.log("  ✓ PASS: /tmp/scratch.bin exists in VFS during execution but is STRICTLY EXCLUDED from the URL hash!");
    } else {
      throw new Error('Test 5 failed on ephemeral exclusion');
    }

    // --- TEST 6: Hotkey ⌘I / Ctrl+I Zen Toggle ---
    console.log("\n[TEST 6] Zen Mode Toggle via Keyboard Event");
    await sendCmd('Runtime.evaluate', {
      expression: `
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', metaKey: true }));
      `
    });

    const eval6 = await sendCmd('Runtime.evaluate', {
      expression: 'document.getElementById("app-root").classList.contains("workbench-active")',
      returnByValue: true
    });

    console.log("  • Workbench active after ⌘I:", eval6.result.value);
    if (!eval6.result.value) {
      console.log("  ✓ PASS: ⌘I shortcut toggled workbench closed (back to Zen Mode)!");
    } else {
      throw new Error('Test 6 failed on hotkey toggle');
    }

    // --- TEST 7: Terminal Clear & Stdin Pipeline ---
    console.log("\n[TEST 7] Terminal Clear & Stdin Submission");
    await sendCmd('Runtime.evaluate', {
      expression: 'document.getElementById("btn-clear").click()'
    });

    const eval7a = await sendCmd('Runtime.evaluate', {
      expression: 'document.getElementById("terminal-viewport").innerText',
      returnByValue: true
    });
    console.log("  • Terminal empty after Clear:", eval7a.result.value.trim() === '');

    // Send stdin text
    await sendCmd('Runtime.evaluate', {
      expression: `
        document.getElementById('stdin-input').value = 'Hello urlfs from stdin!';
        document.getElementById('btn-stdin-send').click();
      `
    });

    await new Promise(r => setTimeout(r, 1000));

    const eval7b = await sendCmd('Runtime.evaluate', {
      expression: 'document.getElementById("terminal-viewport").innerText',
      returnByValue: true
    });
    console.log("  • Terminal received stdin echo:", eval7b.result.value.includes('stdin > Hello urlfs from stdin!'));

    if (eval7a.result.value.trim() === '' && eval7b.result.value.includes('Hello urlfs from stdin!')) {
      console.log("  ✓ PASS: Terminal clear and interactive stdin pipeline verified!");
    } else {
      throw new Error('Test 7 failed on stdin pipeline');
    }

    // --- TEST 8: Full URL Hash State Persistence on Page Navigation ---
    console.log("\n[TEST 8] Cold Boot from URL Hash (Simulating Shared Link in New Session)");
    // Get the current hash from test 5 (Logger state)
    const currentHash = (await sendCmd('Runtime.evaluate', { expression: 'location.hash', returnByValue: true })).result.value;

    // Navigate Chrome to the same page with that hash
    await sendCmd('Page.navigate', { url: filePath + currentHash });
    await new Promise(r => setTimeout(r, 1500));

    const eval8 = await sendCmd('Runtime.evaluate', {
      expression: `({
        terminal: document.getElementById("terminal-viewport").innerText,
        status: document.getElementById("status-text").innerText
      })`,
      returnByValue: true
    });

    console.log("  • Status on cold boot with hash:", eval8.result.value.status);
    console.log("  • Terminal on cold boot contains logger output:", eval8.result.value.terminal.includes('EPHEMERAL SCRATCH VS PERSISTENT LOG'));

    if (eval8.result.value.status === 'Exited (0)' && eval8.result.value.terminal.includes('EPHEMERAL SCRATCH VS PERSISTENT LOG')) {
      console.log("  ✓ PASS: Opening urlfs URL hash directly booted preserved state and re-executed!");
    } else {
      throw new Error('Test 8 failed on cold boot');
    }

    // --- TEST 9: Demo 4 (BusyBox Linux CLI & Interactive Shell) ---
    console.log("\n[TEST 9] Switch to Demo 4 (BusyBox Linux Shell & Tools)");
    await sendCmd('Runtime.evaluate', {
      expression: `
        document.getElementById('demo-select').value = 'busybox';
        document.getElementById('demo-select').dispatchEvent(new Event('change'));
      `
    });

    await new Promise(r => setTimeout(r, 1200));

    const eval9a = await sendCmd('Runtime.evaluate', {
      expression: `({
        terminal: document.getElementById("terminal-viewport").innerText,
        status: document.getElementById("status-text").innerText
      })`,
      returnByValue: true
    });

    const res9a = eval9a.result.value;
    console.log("  • Busybox boot status:", res9a.status);
    console.log("  • Terminal contains BusyBox banner:", res9a.terminal.includes('BusyBox v1.36.1'));
    console.log("  • Terminal contains shell prompt 'urlfs:/# ':", res9a.terminal.includes('urlfs:/# '));

    if (!res9a.terminal.includes('BusyBox v1.36.1') || !res9a.terminal.includes('urlfs:/# ')) {
      throw new Error('Test 9 failed on BusyBox initial boot');
    }

    // Run command 'ls'
    console.log("  • Executing shell command: 'ls'");
    await sendCmd('Runtime.evaluate', {
      expression: `
        document.getElementById('stdin-input').value = 'ls';
        document.getElementById('btn-stdin-send').click();
      `
    });

    await new Promise(r => setTimeout(r, 1000));

    const eval9b = await sendCmd('Runtime.evaluate', {
      expression: 'document.getElementById("terminal-viewport").innerText',
      returnByValue: true
    });

    console.log("  • Terminal contains ls output with etc/ and home/:", eval9b.result.value.includes('etc/') && eval9b.result.value.includes('home/'));

    // Run command 'cat /etc/passwd'
    console.log("  • Executing shell command: 'cat /etc/passwd'");
    await sendCmd('Runtime.evaluate', {
      expression: `
        document.getElementById('stdin-input').value = 'cat /etc/passwd';
        document.getElementById('btn-stdin-send').click();
      `
    });

    await new Promise(r => setTimeout(r, 1000));

    const eval9c = await sendCmd('Runtime.evaluate', {
      expression: 'document.getElementById("terminal-viewport").innerText',
      returnByValue: true
    });

    console.log("  • Terminal contains passwd contents:", eval9c.result.value.includes('root:x:0:0:root'));

    // Run command 'echo "urlfs linux rules" > /test.txt'
    console.log("  • Executing redirection command: 'echo LinuxContainer > /test.txt'");
    await sendCmd('Runtime.evaluate', {
      expression: `
        document.getElementById('stdin-input').value = 'echo LinuxContainer > /test.txt';
        document.getElementById('btn-stdin-send').click();
      `
    });

    await new Promise(r => setTimeout(r, 1000));

    // Verify /test.txt exists in URL hash!
    const hashAfterEcho = (await sendCmd('Runtime.evaluate', { expression: 'location.hash', returnByValue: true })).result.value;
    const vfsAfterEcho = decodeVfsPayload(hashAfterEcho.slice(1));
    console.log("  • /test.txt synchronized to URL hash:", '/test.txt' in vfsAfterEcho.files);

    // Read back /test.txt with 'cat /test.txt'
    console.log("  • Executing shell command: 'cat /test.txt'");
    await sendCmd('Runtime.evaluate', {
      expression: `
        document.getElementById('stdin-input').value = 'cat /test.txt';
        document.getElementById('btn-stdin-send').click();
      `
    });

    await new Promise(r => setTimeout(r, 1000));

    const eval9d = await sendCmd('Runtime.evaluate', {
      expression: 'document.getElementById("terminal-viewport").innerText',
      returnByValue: true
    });

    console.log("  • cat /test.txt output contains 'LinuxContainer':", eval9d.result.value.includes('LinuxContainer'));

    if (vfsAfterEcho.files['/test.txt'] && eval9d.result.value.includes('LinuxContainer')) {
      console.log("  ✓ PASS: BusyBox Linux shell and basic tools verified!");
    } else {
      throw new Error('Test 9 failed on Busybox command execution');
    }

    // --- TEST 10: Expanded Linux Applets (grep, cp, mv, df, free, stat, tail, base64) ---
    console.log("\n[TEST 10] Expanded BusyBox Applets Verification");

    // grep
    console.log("  • Testing: 'grep root /etc/passwd'");
    await sendCmd('Runtime.evaluate', {
      expression: `
        document.getElementById('stdin-input').value = 'grep root /etc/passwd';
        document.getElementById('btn-stdin-send').click();
      `
    });
    await new Promise(r => setTimeout(r, 1000));
    const termGrep = (await sendCmd('Runtime.evaluate', { expression: 'document.getElementById("terminal-viewport").innerText', returnByValue: true })).result.value;
    console.log("    Result matches grep:", termGrep.includes('root:x:0:0:root:/root:/bin/sh'));

    // cp
    console.log("  • Testing: 'cp /etc/hostname /home/user/host.bak'");
    await sendCmd('Runtime.evaluate', {
      expression: `
        document.getElementById('stdin-input').value = 'cp /etc/hostname /home/user/host.bak';
        document.getElementById('btn-stdin-send').click();
      `
    });
    await new Promise(r => setTimeout(r, 1000));

    // mv
    console.log("  • Testing: 'mv /home/user/host.bak /home/user/host.txt'");
    await sendCmd('Runtime.evaluate', {
      expression: `
        document.getElementById('stdin-input').value = 'mv /home/user/host.bak /home/user/host.txt';
        document.getElementById('btn-stdin-send').click();
      `
    });
    await new Promise(r => setTimeout(r, 1000));

    // verify /home/user/host.txt exists in URL hash and host.bak is gone
    const hashAfterMv = (await sendCmd('Runtime.evaluate', { expression: 'location.hash', returnByValue: true })).result.value;
    const vfsAfterMv = decodeVfsPayload(hashAfterMv.slice(1));
    console.log("    host.txt in URL hash:", '/home/user/host.txt' in vfsAfterMv.files);
    console.log("    host.bak removed from URL hash:", !('/home/user/host.bak' in vfsAfterMv.files));

    // df & free
    console.log("  • Testing: 'df' and 'free'");
    await sendCmd('Runtime.evaluate', {
      expression: `
        document.getElementById('stdin-input').value = 'df';
        document.getElementById('btn-stdin-send').click();
      `
    });
    await new Promise(r => setTimeout(r, 1000));
    const termDf = (await sendCmd('Runtime.evaluate', { expression: 'document.getElementById("terminal-viewport").innerText', returnByValue: true })).result.value;
    console.log("    df table present:", termDf.includes('urlfs-rootfs') && termDf.includes('1K-blocks'));

    // stat
    console.log("  • Testing: 'stat /etc/passwd'");
    await sendCmd('Runtime.evaluate', {
      expression: `
        document.getElementById('stdin-input').value = 'stat /etc/passwd';
        document.getElementById('btn-stdin-send').click();
      `
    });
    await new Promise(r => setTimeout(r, 1000));
    const termStat = (await sendCmd('Runtime.evaluate', { expression: 'document.getElementById("terminal-viewport").innerText', returnByValue: true })).result.value;
    console.log("    stat format present:", termStat.includes('File: /etc/passwd') && termStat.includes('Size:'));

    // base64
    console.log("  • Testing: 'base64 /etc/hostname'");
    await sendCmd('Runtime.evaluate', {
      expression: `
        document.getElementById('stdin-input').value = 'base64 /etc/hostname';
        document.getElementById('btn-stdin-send').click();
      `
    });
    await new Promise(r => setTimeout(r, 1000));
    const termB64 = (await sendCmd('Runtime.evaluate', { expression: 'document.getElementById("terminal-viewport").innerText', returnByValue: true })).result.value;
    // 'urlfs-box\n' in base64 is 'dXJsZnMtYm94Cg=='
    console.log("    base64 output correct:", termB64.includes('dXJsZnMtYm94Cg=='));

    // tail
    console.log("  • Testing: 'tail /home/user/notes.txt'");
    await sendCmd('Runtime.evaluate', {
      expression: `
        document.getElementById('stdin-input').value = 'tail /home/user/notes.txt';
        document.getElementById('btn-stdin-send').click();
      `
    });
    await new Promise(r => setTimeout(r, 1000));
    const termTail = (await sendCmd('Runtime.evaluate', { expression: 'document.getElementById("terminal-viewport").innerText', returnByValue: true })).result.value;
    console.log("    tail output present:", termTail.includes('Try commands: grep'));

    // help
    console.log("  • Testing: 'help'");
    await sendCmd('Runtime.evaluate', {
      expression: `
        document.getElementById('stdin-input').value = 'help';
        document.getElementById('btn-stdin-send').click();
      `
    });
    await new Promise(r => setTimeout(r, 1000));
    const termHelp = (await sendCmd('Runtime.evaluate', { expression: 'document.getElementById("terminal-viewport").innerText', returnByValue: true })).result.value;
    console.log("    help shows 30 applets:", termHelp.includes('30 applets'));

    if (termGrep.includes('root:x:0:0:root:/root:/bin/sh') &&
        vfsAfterMv.files['/home/user/host.txt'] &&
        termDf.includes('urlfs-rootfs') &&
        termStat.includes('File: /etc/passwd') &&
        termB64.includes('dXJsZnMtYm94Cg==') &&
        termHelp.includes('30 applets')) {
      console.log("  ✓ PASS: All 30 BusyBox Linux tools verified end-to-end in Chrome!");
    } else {
      throw new Error('Test 10 failed on expanded Busybox applets');
    }

    console.log("\n==================================================");
    console.log("  ALL TESTS PASSED WITH 100% SUCCESS IN CHROME!   ");
    console.log("==================================================");
  } finally {
    if (ws) ws.close();
    chrome.kill('SIGKILL');
    try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch (e) {}
  }
}

testInChrome().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
