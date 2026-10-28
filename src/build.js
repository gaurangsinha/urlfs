const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const workerCode = fs.readFileSync(path.join(__dirname, 'worker.js'), 'utf8');
const appCode = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>urlfs — URL-Encoded WASI Filesystem & Application Runner</title>
  <style>
${css}
  </style>
</head>
<body>
  <div id="app-root">
    <header id="app-header">
      <div class="header-left">
        <div class="logo">
          <span class="logo-icon">⚡</span>
          <span class="logo-text">urlfs</span>
        </div>
        <div class="entrypoint-badge" id="entrypoint-badge" title="WASI Preview 1 Entrypoint">
          <span class="ep-cmd">/main.wasm</span>
          <span class="ep-args" id="ep-args"></span>
        </div>
        <div class="status-badge status-ready" id="status-badge">
          <span class="status-dot"></span>
          <span class="status-text" id="status-text">Ready</span>
        </div>
      </div>

      <div class="header-center">
        <div class="demo-select-wrapper">
          <span class="select-label">Demo:</span>
          <select id="demo-select" title="Switch Filesystem Demo">
            <option value="counter">1. Stateful URL Counter</option>
            <option value="echo">2. CLI Stream Processor</option>
            <option value="logger">3. Scratch vs Persistent Log</option>
            <option value="busybox">4. BusyBox Linux Shell & Tools</option>
            <option value="custom" disabled>Custom URL Filesystem</option>
          </select>
        </div>
      </div>

      <div class="header-right">
        <button id="btn-run" class="btn btn-primary" title="Execute /main.wasm (⌘↵ / Ctrl+Enter)">
          <svg class="btn-icon" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <span>Run</span>
          <kbd>⌘↵</kbd>
        </button>
        <button id="btn-stop" class="btn btn-danger" disabled title="Terminate running Web Worker">
          <svg class="btn-icon" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12"/></svg>
          <span>Stop</span>
        </button>
        <button id="btn-clear" class="btn" title="Clear Terminal Output">
          <svg class="btn-icon" viewBox="0 0 24 24"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          <span>Clear</span>
        </button>
        <button id="btn-share" class="btn" title="Copy shareable URL to clipboard">
          <svg class="btn-icon" viewBox="0 0 24 24"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
          <span>Copy URL</span>
        </button>
        <button id="btn-workbench-toggle" class="btn btn-workbench" title="Toggle Workbench (⌘I / Ctrl+I)">
          <svg class="btn-icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
          <span>Workbench</span>
          <kbd>⌘I</kbd>
        </button>
      </div>
    </header>

    <div id="main-container">
      <div id="terminal-pane">
        <div id="terminal-viewport"></div>
        <div id="stdin-bar">
          <span class="stdin-prompt">stdin &gt;</span>
          <input type="text" id="stdin-input" placeholder="Type standard input and press Enter to run..." autocomplete="off" spellcheck="false" />
          <button id="btn-stdin-send" class="btn btn-small" title="Send Stdin & Run">Send ↵</button>
        </div>
      </div>

      <div id="layout-splitter"></div>

      <div id="workbench-pane">
        <div class="workbench-body">
          <div class="vfs-sidebar">
            <div class="sidebar-header">
              <span>Root Filesystem (/)</span>
              <div class="sidebar-actions">
                <button id="btn-new-file" class="btn btn-small" title="Create New File in VFS">+ File</button>
                <button id="btn-upload-file" class="btn btn-small" title="Upload File to VFS">Upload</button>
                <input type="file" id="file-upload-input" multiple style="display: none;" />
              </div>
            </div>
            <ul class="vfs-file-list" id="vfs-file-list"></ul>
            <div class="sidebar-footer">
              <button id="btn-delete-file" class="btn btn-small btn-danger" title="Delete Selected File">Delete</button>
              <button id="btn-rename-file" class="btn btn-small" title="Rename Selected File">Rename</button>
              <button id="btn-download-file" class="btn btn-small" title="Download File">Download</button>
            </div>
          </div>

          <div class="inspector-main">
            <div class="inspector-header">
              <div class="file-meta">
                <span class="file-title" id="inspector-file-title">/count.txt</span>
                <span class="file-type-pill" id="inspector-file-type">Text</span>
                <div class="save-indicator">
                  <span class="save-dot" id="save-dot"></span>
                  <span id="save-status">Saved</span>
                </div>
              </div>
              <div class="inspector-actions">
                <button id="btn-save" class="btn btn-small" title="Save file to VFS (⌘S)">Save <kbd>⌘S</kbd></button>
                <button id="btn-save-run" class="btn btn-small btn-primary" title="Save & Run (⌘↵)">Save & Run</button>
                <button id="btn-revert" class="btn btn-small" title="Revert Changes">Revert</button>
              </div>
            </div>

            <div class="inspector-content">
              <div id="editor-view">
                <div id="editor-gutter">1</div>
                <textarea id="editor-textarea" spellcheck="false"></textarea>
              </div>

              <div id="wasm-view" style="display: none;">
                <div class="wasm-tabs">
                  <button class="tab-btn active" id="tab-wasm-overview">Overview & Sections</button>
                  <button class="tab-btn" id="tab-wasm-hex">Hex & ASCII Dump</button>
                </div>
                <div id="wasm-overview-content">
                  <div class="wasm-card">
                    <div class="wasm-card-title">WASI Preview 1 Imports (<span id="wasm-import-count">0</span>)</div>
                    <table class="wasm-table" id="wasm-imports-table">
                      <thead>
                        <tr><th>Module</th><th>Field</th><th>Kind</th><th>Sig/Type</th></tr>
                      </thead>
                      <tbody></tbody>
                    </table>
                  </div>

                  <div class="wasm-card">
                    <div class="wasm-card-title">Exports (<span id="wasm-export-count">0</span>)</div>
                    <table class="wasm-table" id="wasm-exports-table">
                      <thead>
                        <tr><th>Name</th><th>Kind</th><th>Index</th></tr>
                      </thead>
                      <tbody></tbody>
                    </table>
                  </div>

                  <div class="wasm-card">
                    <div class="wasm-card-title">Memory & Sections</div>
                    <div id="wasm-memory-details" style="font-size: 11px; margin-bottom: 8px; color: var(--text-muted);"></div>
                    <table class="wasm-table" id="wasm-sections-table">
                      <thead>
                        <tr><th>ID</th><th>Section Name</th><th>Size</th></tr>
                      </thead>
                      <tbody></tbody>
                    </table>
                  </div>
                </div>
              </div>

              <div id="hex-view" style="display: none;">
                <div class="hex-toolbar">
                  <div id="hex-page-info">Offset 0x0000 - 0x01FF (Page 1 of 1)</div>
                  <div style="display: flex; gap: 6px;">
                    <button class="btn btn-small" id="btn-hex-prev">Prev</button>
                    <button class="btn btn-small" id="btn-hex-next">Next</button>
                  </div>
                </div>
                <div class="hex-scroll-container" id="hex-dump-content"></div>
              </div>
            </div>
          </div>
        </div>

        <div id="telemetry-bar">
          <div class="telemetry-header">
            <div class="telemetry-metrics">
              <div class="metric-item">
                <span class="metric-label">VFS Uncompressed:</span>
                <span class="metric-val" id="metric-uncompressed">0 B</span>
              </div>
              <div class="metric-item">
                <span class="metric-label">Deflate-Raw:</span>
                <span class="metric-val" id="metric-compressed">0 B</span>
              </div>
              <div class="metric-item">
                <span class="metric-label">URL Chars:</span>
                <span class="metric-val" id="metric-url-len">0 / 65,536</span>
              </div>
            </div>
            <div class="telemetry-status-pill" id="telemetry-pill">Safe for SMS (&lt; 2KB)</div>
          </div>
          <div class="telemetry-progress-container" title="URL Length Budget">
            <div class="thresh-line" style="left: 3.05%;" title="2KB Limit (SMS/Messengers)"></div>
            <div class="thresh-line" style="left: 12.2%;" title="8KB Limit (Discord/Slack/Email)"></div>
            <div class="telemetry-progress-bar" id="telemetry-bar-fill" style="width: 2%;"></div>
          </div>
        </div>
      </div>
    </div>

    <div id="drop-overlay">
      <div class="drop-icon">📦</div>
      <div class="drop-text">Drop Files to Mount into urlfs VFS</div>
      <div class="drop-subtext">Drop .wasm binaries or data files to immediately inspect or execute</div>
    </div>

    <div id="toast-container"></div>
  </div>

  <textarea id="worker-code" style="display: none;" hidden>
${workerCode}
  </textarea>

  <script>
(function() {
  if (window.__URLFS_APP_INITIALIZED__) return;
  window.__URLFS_APP_INITIALIZED__ = true;
${appCode}
})();
  </script>
</body>
</html>`;

const outPath = path.join(__dirname, '..', 'index.html');
fs.writeFileSync(outPath, html);
console.log('Successfully generated index.html at', outPath, 'size:', fs.statSync(outPath).size, 'bytes');
