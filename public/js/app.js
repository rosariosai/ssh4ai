(() => {
  'use strict';

  // ═════════════════════════════════════════════════════════════════════════
  //  STATE & REFS
  // ═════════════════════════════════════════════════════════════════════════

  const sessions       = new Map();
  let activeId         = null;
  let selectedDevId    = null;
  let devices          = [];
  let macros           = [];
  let macroGlobalLock  = localStorage.getItem('webssh_macro_locked') !== 'false'; // default locked: true
  let macroAutoEnter   = localStorage.getItem('webssh_macro_autoenter') !== 'false'; // default auto-enter: true
  let leftVisible      = true;
  let dockVisible      = true;
  let savedDockH       = 180;
  let zenMode          = false;
  let tabCounter       = 0;
  let hostFilterQuery  = '';
  let showPinnedOnly   = localStorage.getItem('webssh_pinned_only') === 'true';
  let dragDevId        = null;   // device id currently being dragged, if any
  let filteredDevIds   = [];     // ids in the order currently rendered (post-filter), for drag reorder math

  const utf8 = new TextDecoder('utf-8');

  // DOM Query Helper
  const $ = (id) => document.getElementById(id);

  // Core DOM Elements
  const leftPanel        = $('left-panel');
  const splitterLeft     = $('splitter-left');
  const rightPanel       = $('right-panel');
  const splitterBot      = $('splitter-bottom');
  const bottomDock       = $('bottom-dock');
  const deviceListEl     = $('device-list');
  const hostCountBadge   = $('host-count');
  const hostFilterInput  = $('host-filter');
  const btnPinFilter     = $('btn-pin-filter');
  const tabsEl           = $('tabs');
  const termAreaEl       = $('terminal-area');
  const welcomeEl        = $('welcome');
  const statusDot        = $('status-dot');
  const statusText       = $('status-text');
  const statusPing       = $('status-ping');
  const macroListEl      = $('macro-list');
  const macroLockToggle  = $('macro-lock-toggle');
  const macroLockIcon    = $('macro-lock-icon');
  const macroLockLabel   = $('macro-lock-label');
  const macroAutoToggle  = $('macro-autoenter-toggle');
  const macroAutoLabel   = $('macro-autoenter-label');
  const dockCollapseBtn  = $('dock-collapse-btn');
  const dockChevron      = $('dock-chevron');
  const sidebarToggleBtn = $('sidebar-toggle-btn');
  const sidebarToggleIcon= $('sidebar-toggle-icon');
  const zenToggleBtn     = $('zen-mode-toggle-btn');
  const zenTermBtn       = $('btn-term-zen');
  const toastsEl         = $('toasts');

  // Modals
  const devModalOverlay   = $('modal-overlay');
  const macroModalOverlay = $('macro-modal-overlay');
  const helpModalOverlay  = $('help-modal-overlay');
  const settingsOverlay   = $('settings-modal-overlay');

  // ═════════════════════════════════════════════════════════════════════════
  //  SETTINGS MANAGEMENT
  // ═════════════════════════════════════════════════════════════════════════

  const SETTINGS_KEY = 'webssh_settings';

  function loadSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }

  function saveSettingsToStorage(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    window._termSettings = s;
  }

  // Initialize Settings in Form
  (function initSettings() {
    const s = loadSettings();
    window._termSettings = s;
    if (s.fontSize   && $('s-font-size'))   $('s-font-size').value   = s.fontSize;
    if (s.termBg     && $('s-term-bg'))     $('s-term-bg').value     = s.termBg;
    if (s.termFg     && $('s-term-fg'))     $('s-term-fg').value     = s.termFg;
    if (s.termCursor && $('s-term-cursor')) $('s-term-cursor').value = s.termCursor;
    if (s.dbType     && $('s-db-type'))     $('s-db-type').value     = s.dbType;
    if (s.dbHost     && $('s-db-host'))     $('s-db-host').value     = s.dbHost;
    if (s.dbPort     && $('s-db-port'))     $('s-db-port').value     = s.dbPort;
    if (s.dbName     && $('s-db-name'))     $('s-db-name').value     = s.dbName;
    if (s.dbUser     && $('s-db-user'))     $('s-db-user').value     = s.dbUser;
    if (s.logDir     && $('s-log-dir'))     $('s-log-dir').value     = s.logDir;
    if ($('s-compact-devices'))              $('s-compact-devices').checked = !!s.compactDevices;
    if (s.dbType === 'mariadb' && $('s-mariadb-fields')) {
      $('s-mariadb-fields').style.display = 'flex';
    }
  })();

  if ($('s-db-type')) {
    $('s-db-type').addEventListener('change', function() {
      if ($('s-mariadb-fields')) {
        $('s-mariadb-fields').style.display = this.value === 'mariadb' ? 'flex' : 'none';
      }
    });
  }

  // Settings Modal Triggers
  if ($('btn-settings')) {
    $('btn-settings').addEventListener('click', () => settingsOverlay.classList.remove('hidden'));
  }
  if ($('settings-modal-close')) {
    $('settings-modal-close').addEventListener('click', () => settingsOverlay.classList.add('hidden'));
  }
  if ($('settings-modal-cancel')) {
    $('settings-modal-cancel').addEventListener('click', () => settingsOverlay.classList.add('hidden'));
  }
  if (settingsOverlay) {
    settingsOverlay.addEventListener('click', (e) => {
      if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden');
    });
  }
  if ($('settings-modal-save')) {
    $('settings-modal-save').addEventListener('click', () => {
      const s = {
        termBg:         $('s-term-bg')         ? $('s-term-bg').value         : '#05090e',
        termFg:         $('s-term-fg')         ? $('s-term-fg').value         : '#10b981',
        termCursor:     $('s-term-cursor')     ? $('s-term-cursor').value     : '#10b981',
        fontSize:       $('s-font-size')       ? $('s-font-size').value       : '13',
        dbType:         $('s-db-type')         ? $('s-db-type').value         : 'mariadb',
        dbHost:         $('s-db-host')         ? $('s-db-host').value         : '',
        dbPort:         $('s-db-port')         ? $('s-db-port').value         : '3306',
        dbName:         $('s-db-name')         ? $('s-db-name').value         : '',
        dbUser:         $('s-db-user')         ? $('s-db-user').value         : '',
        logDir:         $('s-log-dir')         ? $('s-log-dir').value.trim()  : '',
        compactDevices: $('s-compact-devices') ? $('s-compact-devices').checked: false,
      };
      saveSettingsToStorage(s);
      settingsOverlay.classList.add('hidden');
      renderDeviceList();
      toast('Settings saved — new terminals will use updated theme', 'success');
    });
  }

  // Help Modal Triggers
  if ($('btn-help')) {
    $('btn-help').addEventListener('click', () => helpModalOverlay.classList.remove('hidden'));
  }
  if ($('help-modal-close')) {
    $('help-modal-close').addEventListener('click', () => helpModalOverlay.classList.add('hidden'));
  }
  if ($('help-modal-ok')) {
    $('help-modal-ok').addEventListener('click', () => helpModalOverlay.classList.add('hidden'));
  }
  if (helpModalOverlay) {
    helpModalOverlay.addEventListener('click', (e) => {
      if (e.target === helpModalOverlay) helpModalOverlay.classList.add('hidden');
    });
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  PANEL & ZEN CONTROLS
  // ═════════════════════════════════════════════════════════════════════════

  function toggleSidebar() {
    leftVisible = !leftVisible;
    if (leftPanel) leftPanel.classList.toggle('hidden', !leftVisible);
    if (splitterLeft) splitterLeft.classList.toggle('hidden', !leftVisible);
    if (sidebarToggleBtn) sidebarToggleBtn.classList.toggle('active', leftVisible);
    if (sidebarToggleIcon) {
      sidebarToggleIcon.textContent = leftVisible ? 'left_panel_close' : 'dock_to_left';
    }
    refitActive();
  }

  if (sidebarToggleBtn) sidebarToggleBtn.addEventListener('click', toggleSidebar);

  function toggleDock(minimize) {
    if (minimize !== undefined) {
      dockVisible = !minimize;
    } else {
      dockVisible = !dockVisible;
    }
    if (bottomDock) {
      if (!dockVisible) {
        savedDockH = bottomDock.offsetHeight > 40 ? bottomDock.offsetHeight : savedDockH;
        bottomDock.classList.add('dock-minimized');
        if (dockChevron) dockChevron.textContent = 'expand_less';
        if ($('btn-dock-minimize')) $('btn-dock-minimize').querySelector('span:last-child').textContent = 'Show Panel (Ctrl+J)';
      } else {
        bottomDock.classList.remove('dock-minimized');
        bottomDock.style.height = savedDockH + 'px';
        if (dockChevron) dockChevron.textContent = 'expand_more';
        if ($('btn-dock-minimize')) $('btn-dock-minimize').querySelector('span:last-child').textContent = 'Hide Panel (Ctrl+J)';
      }
    }
    refitActive();
  }

  if (dockCollapseBtn) dockCollapseBtn.addEventListener('click', () => toggleDock());
  if ($('btn-dock-minimize')) $('btn-dock-minimize').addEventListener('click', () => toggleDock());

  function toggleZenMode() {
    zenMode = !zenMode;
    document.body.classList.toggle('zen-active', zenMode);
    if (zenToggleBtn) {
      zenToggleBtn.classList.toggle('active', zenMode);
      zenToggleBtn.querySelector('span:last-child').textContent = zenMode ? 'Exit Zen (Esc)' : 'Zen [F11]';
    }
    refitActive();
    toast(zenMode ? 'Zen Mode active — maximum terminal focus' : 'Exited Zen Mode', 'info');
  }

  if (zenToggleBtn) zenToggleBtn.addEventListener('click', toggleZenMode);
  if (zenTermBtn) zenTermBtn.addEventListener('click', toggleZenMode);

  // ═════════════════════════════════════════════════════════════════════════
  //  SECONDARY DOCK TABS (Macros, Scratchpad)
  // ═════════════════════════════════════════════════════════════════════════

  function activateDockTab(tabKey) {
    // If dock is minimized, restore it
    if (!dockVisible) toggleDock(false);

    const tabs = ['macros', 'scratch'];
    tabs.forEach((k) => {
      const btnHeader = $('dock-tab-' + k);
      const btnDock   = $('dock-btn-' + k);
      const pane      = $('pane-' + k);
      const isMatch   = k === tabKey;

      if (btnHeader) btnHeader.classList.toggle('active', isMatch);
      if (btnDock)   btnDock.classList.toggle('active', isMatch);
      if (pane)      pane.classList.toggle('active', isMatch);
    });

    refitActive();
  }

  ['macros', 'scratch'].forEach((k) => {
    const b1 = $('dock-tab-' + k);
    const b2 = $('dock-btn-' + k);
    if (b1) b1.addEventListener('click', () => activateDockTab(k));
    if (b2) b2.addEventListener('click', () => activateDockTab(k));
  });

  // ═════════════════════════════════════════════════════════════════════════
  //  DEVICE / HOST MANAGER (CRUD)
  // ═════════════════════════════════════════════════════════════════════════

  async function loadDevices() {
    try {
      const res = await fetch('/api/devices');
      devices = await res.json();
      renderDeviceList();
    } catch (e) {
      toast('Cannot load devices: ' + e.message, 'error');
    }
  }

  function renderDeviceList() {
    if (!deviceListEl) return;
    deviceListEl.innerHTML = '';

    const settings = window._termSettings || loadSettings();
    const compact = !!settings.compactDevices;
    const filter = hostFilterQuery.toLowerCase().trim();

    const filtered = devices.filter((dev) => {
      if (showPinnedOnly && !dev.pinned) return false;
      if (!filter) return true;
      const name = (dev.device_name || dev.name || '').toLowerCase();
      const ip = (dev.ip_address || dev.host || '').toLowerCase();
      const user = (dev.username || '').toLowerCase();
      return name.includes(filter) || ip.includes(filter) || user.includes(filter);
    });

    filteredDevIds = filtered.map((d) => d.id);

    if (hostCountBadge) {
      hostCountBadge.textContent = showPinnedOnly
        ? `${filtered.length} PINNED`
        : `${devices.length} TOTAL`;
    }

    if (btnPinFilter) {
      btnPinFilter.classList.toggle('active', showPinnedOnly);
    }

    if (filtered.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.style.cssText = 'padding:14px;text-align:center;color:var(--text-dim);font-family:var(--font-mono);font-size:11px;';
      emptyMsg.textContent = devices.length === 0
        ? 'No hosts saved yet'
        : (showPinnedOnly ? 'No pinned hosts — click the star on a host to pin it' : 'No matching hosts found');
      deviceListEl.appendChild(emptyMsg);
      return;
    }

    filtered.forEach((dev) => {
      const connected = isConnected(dev.id);
      const el = document.createElement('div');
      el.className = 'device-item' + (dev.id === selectedDevId ? ' selected' : '');
      el.dataset.id = dev.id;

      const dn = dev.device_name || dev.name || 'Unnamed Host';
      const dh = dev.ip_address || dev.host || '';
      const port = dev.port || 22;
      const user = dev.username || 'root';
      const pinned = !!dev.pinned;

      const statusBadgeClass = connected ? 'badge-active' : 'badge-idle';
      const statusBadgeText  = connected ? 'ACTIVE' : 'READY';

      const addrDisplay = compact ? '' : `<span>${esc(user)}@${esc(dh)}:${port}</span>`;

      el.innerHTML = `
        <div class="device-card-row-top">
          <span class="dev-drag-handle" title="Drag to reorder">
            <span class="material-symbols-outlined" style="font-size:14px;">drag_indicator</span>
          </span>
          <button class="dev-icon-btn btn-pin-icon${pinned ? ' pinned' : ''}" title="${pinned ? 'Unpin host' : 'Pin host'}" data-action="pin">
            <span class="material-symbols-outlined" style="font-size:14px;">${pinned ? 'star' : 'star_outline'}</span>
          </button>
          <div class="device-card-name-wrap">
            <span class="status-led ${connected ? 'online' : ''}"></span>
            <span class="device-card-name">${esc(dn)}</span>${dev.auth_type && dev.auth_type !== 'password' ? '<span class="material-symbols-outlined dev-key-icon" style="font-size:13px;" title="Key authentication">key</span>' : ''}
          </div>
          <span class="device-card-badge ${statusBadgeClass}">${statusBadgeText}</span>
        </div>
        <div class="device-card-row-bottom">
          <div class="device-card-addr">${addrDisplay}</div>
          <div class="device-card-actions">
            <button class="dev-icon-btn btn-connect-icon" title="Connect Terminal" data-action="connect">
              <span class="material-symbols-outlined" style="font-size:14px;">terminal</span>
            </button>
            <button class="dev-icon-btn" title="Edit Host" data-action="edit">
              <span class="material-symbols-outlined" style="font-size:14px;">edit</span>
            </button>
            <button class="dev-icon-btn btn-del-icon" title="Delete Host" data-action="delete">
              <span class="material-symbols-outlined" style="font-size:14px;">delete</span>
            </button>
          </div>
        </div>
      `;

      // Selection & Connect Triggers
      el.addEventListener('click', (e) => {
        const actionBtn = e.target.closest('[data-action]');
        if (actionBtn) {
          e.stopPropagation();
          const action = actionBtn.dataset.action;
          if (action === 'connect') openTab(dev);
          if (action === 'edit') openDevModal(dev);
          if (action === 'delete') deleteDevice(dev.id);
          if (action === 'pin') togglePin(dev);
          return;
        }
        selectedDevId = dev.id;
        renderDeviceList();
      });

      el.addEventListener('dblclick', () => {
        openTab(dev);
      });

      // Drag-and-drop reorder — only draggable while the pointer is down on
      // the handle, so normal clicks on the row/buttons never accidentally
      // start a drag.
      const handle = el.querySelector('.dev-drag-handle');
      if (handle) {
        handle.addEventListener('mousedown', () => { el.draggable = true; });
      }
      el.addEventListener('dragend', () => {
        el.draggable = false;
        el.classList.remove('dragging');
        deviceListEl.querySelectorAll('.device-item.drag-over').forEach((n) => n.classList.remove('drag-over'));
        dragDevId = null;
      });
      el.addEventListener('dragstart', (e) => {
        dragDevId = dev.id;
        el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(dev.id)); } catch (_) {}
      });
      el.addEventListener('dragover', (e) => {
        if (dragDevId === null || dragDevId === dev.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('drag-over');
      });
      el.addEventListener('dragleave', () => {
        el.classList.remove('drag-over');
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('drag-over');
        if (dragDevId === null || dragDevId === dev.id) return;
        reorderDevices(dragDevId, dev.id);
      });

      deviceListEl.appendChild(el);
    });

    // Update active tunnels telemetry in sidebar
    if ($('telemetry-active-count')) {
      $('telemetry-active-count').textContent = sessions.size;
    }
  }

  // Reorder the visible (filtered) list by moving draggedId to sit just
  // before targetId, then re-splice that new order back into the full
  // `devices` array — devices outside the current filter keep their
  // relative position untouched. Persists the resulting full order.
  function reorderDevices(draggedId, targetId) {
    const fromIdx = filteredDevIds.indexOf(draggedId);
    const toIdx   = filteredDevIds.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;

    const newFilteredOrder = filteredDevIds.slice();
    newFilteredOrder.splice(fromIdx, 1);
    newFilteredOrder.splice(toIdx, 0, draggedId);

    const byId = new Map(devices.map((d) => [d.id, d]));
    const filteredSet = new Set(filteredDevIds);
    let ptr = 0;
    const newDevices = devices.map((d) => {
      if (!filteredSet.has(d.id)) return d;
      const nextId = newFilteredOrder[ptr++];
      return byId.get(nextId);
    });

    devices = newDevices;
    renderDeviceList();

    fetch('/api/devices/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: devices.map((d) => d.id) }),
    }).catch((e) => toast('Could not save new order: ' + e.message, 'error'));
  }

  async function togglePin(dev) {
    const next = !dev.pinned;
    dev.pinned = next ? 1 : 0; // optimistic update
    renderDeviceList();
    try {
      await fetch('/api/devices/' + dev.id + '/pin', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: next }),
      });
    } catch (e) {
      dev.pinned = next ? 0 : 1; // revert on failure
      renderDeviceList();
      toast('Could not update pin: ' + e.message, 'error');
    }
  }

  if (hostFilterInput) {
    hostFilterInput.addEventListener('input', function() {
      hostFilterQuery = this.value;
      renderDeviceList();
    });
  }

  if (btnPinFilter) {
    btnPinFilter.addEventListener('click', () => {
      showPinnedOnly = !showPinnedOnly;
      localStorage.setItem('webssh_pinned_only', String(showPinnedOnly));
      renderDeviceList();
    });
  }

  function isConnected(devId) {
    for (const [, s] of sessions) {
      if (s.devId === devId && s.ws && s.ws.readyState === 1) return true;
    }
    return false;
  }

  function openDevModal(dev) {
    if (!devModalOverlay) return;
    $('modal-title').textContent = dev ? 'Edit Host' : 'Add Host';
    $('m-id').value   = dev ? dev.id : '';
    $('m-name').value = dev ? (dev.device_name || dev.name || '') : '';
    $('m-ip').value   = dev ? (dev.ip_address || dev.host || '') : '';
    $('m-port').value = dev ? dev.port : 22;
    $('m-user').value = dev ? dev.username : '';
    $('m-pass').value = '';
    $('m-pass').type = 'password';
    if ($('m-pass-toggle-icon')) $('m-pass-toggle-icon').textContent = 'visibility';
    keyUiInit(dev);
  devModalOverlay.classList.remove('hidden');
  $('m-name').focus();
  }

  // ═════════════════════════════════════════════════════════════════════════
// SSH KEY AUTHENTICATION (Add/Edit Host dialog)
// The server never sends a saved private key back: only has_key / public_key.
// ═════════════════════════════════════════════════════════════════════════

let keyHas = false; // the host being edited already has a stored private key

function keyUiApply() {
const mode = $('m-auth') ? $('m-auth').value : 'password';
if ($('m-key-section')) $('m-key-section').style.display = mode === 'password' ? 'none' : '';
if ($('m-pass-field')) $('m-pass-field').style.display = mode === 'key' ? 'none' : '';
if ($('m-pass-label')) $('m-pass-label').textContent = mode === 'key_password' ? 'Fallback SSH Password' : 'SSH Password';
}

function keyUiState() {
if ($('m-key-saved')) $('m-key-saved').style.display = keyHas ? '' : 'none';
if ($('m-key-input-wrap')) $('m-key-input-wrap').style.display = keyHas ? 'none' : '';
if ($('m-pub-wrap')) $('m-pub-wrap').style.display = ($('m-pub') && $('m-pub').value) ? '' : 'none';
}

function keyUiInit(dev) {
if (!$('m-auth')) return;
$('m-auth').value = (dev && dev.auth_type) || 'password';
keyHas = !!(dev && dev.has_key);
$('m-key').value = '';
$('m-keypass').value = '';
$('m-pub').value = (dev && dev.public_key) || '';
keyUiApply();
keyUiState();
}

if ($('m-auth')) $('m-auth').addEventListener('change', keyUiApply);

if ($('m-key-replace')) {
$('m-key-replace').addEventListener('click', () => {
keyHas = false;
keyUiState();
if ($('m-key')) $('m-key').focus();
});
}

if ($('m-key-load') && $('m-key-file')) {
$('m-key-load').addEventListener('click', () => $('m-key-file').click());
$('m-key-file').addEventListener('change', function() {
const f = this.files && this.files[0];
this.value = '';
if (!f) return;
if (f.size > 100000) return toast('That file is too large to be a private key', 'error');
const r = new FileReader();
r.onload = () => { $('m-key').value = String(r.result || ''); };
r.onerror = () => toast('Could not read the file', 'error');
r.readAsText(f);
});
}

if ($('m-key-generate')) {
$('m-key-generate').addEventListener('click', async () => {
if (keyHas && !confirm('Replace the stored private key with a newly generated one? The old key will be lost.')) return;
let id = $('m-id').value;
try {
if (!id) {
// New host: save it first (without a key) so the server can attach the generated key to it.
const name = $('m-name').value.trim(), ip = $('m-ip').value.trim(), user = $('m-user').value.trim();
if (!name || !ip || !user) return toast('Fill in Host Name, IP Address and Username first', 'error');
const rc = await fetch('/api/devices', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ device_name: name, ip_address: ip, username: user, port: +$('m-port').value || 22,
password: $('m-pass').value, auth_type: 'key' }),
});
const jc = await rc.json().catch(() => ({}));
if (!rc.ok) throw new Error(jc.error || 'Could not save host');
id = String(jc.id);
$('m-id').value = id;
$('modal-title').textContent = 'Edit Host';
}
const r = await fetch('/api/devices/' + id + '/generate-key', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ replace: true }),
});
const j = await r.json().catch(() => ({}));
if (!r.ok) throw new Error(j.error || 'Key generation failed');
if ($('m-auth').value === 'password') $('m-auth').value = 'key';
keyHas = true;
$('m-key').value = '';
$('m-pub').value = j.public_key;
keyUiApply();
keyUiState();
loadDevices();
toast('Key pair generated - add the public key to the target host', 'success');
} catch (e) {
toast('Key generation failed: ' + e.message, 'error');
}
});
}

if ($('m-pub-copy')) {
$('m-pub-copy').addEventListener('click', () => copyToClipboard($('m-pub').value, 'Public key copied'));
}

async function deleteDevice(id) {
    if (!id) return;
    if (!confirm('Delete this host entry?')) return;
    try {
      await fetch('/api/devices/' + id, { method: 'DELETE' });
      if (selectedDevId === id) selectedDevId = null;
      loadDevices();
      toast('Host deleted', 'info');
    } catch (e) {
      toast('Failed to delete host: ' + e.message, 'error');
    }
  }

  if ($('btn-add-device')) {
    $('btn-add-device').addEventListener('click', () => openDevModal());
  }
  if ($('btn-edit-device')) {
    $('btn-edit-device').addEventListener('click', () => {
      const dev = devices.find((d) => d.id === selectedDevId);
      if (!dev) return toast('Select a host first', 'info');
      openDevModal(dev);
    });
  }
  if ($('btn-del-device')) {
    $('btn-del-device').addEventListener('click', () => {
      if (!selectedDevId) return toast('Select a host first', 'info');
      deleteDevice(selectedDevId);
    });
  }

  if ($('modal-close')) $('modal-close').addEventListener('click', () => devModalOverlay.classList.add('hidden'));
  if ($('modal-cancel')) $('modal-cancel').addEventListener('click', () => devModalOverlay.classList.add('hidden'));
  if (devModalOverlay) {
    devModalOverlay.addEventListener('click', (e) => {
      if (e.target === devModalOverlay) devModalOverlay.classList.add('hidden');
    });
  }

  // Show/hide password toggle (eye icon) in the Add/Edit Host modal
  if ($('m-pass-toggle')) {
    $('m-pass-toggle').addEventListener('click', () => {
      const input = $('m-pass');
      const icon  = $('m-pass-toggle-icon');
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      icon.textContent = showing ? 'visibility' : 'visibility_off';
    });
  }

  if ($('modal-save')) {
    $('modal-save').addEventListener('click', async () => {
      const id = $('m-id').value;
      const body = {
        device_name: $('m-name').value.trim(),
        name:        $('m-name').value.trim(),
        ip_address:  $('m-ip').value.trim(),
        host:        $('m-ip').value.trim(),
        port:        +$('m-port').value || 22,
        username:    $('m-user').value.trim(),
        password: $('m-pass').value,
      auth_type: $('m-auth') ? $('m-auth').value : 'password',
      private_key: $('m-key') ? $('m-key').value : '',
      key_passphrase: $('m-keypass') ? $('m-keypass').value : '',
    };

      if (!body.device_name || !body.ip_address || !body.username) {
        return toast('Host Name, IP Address, and Username are required', 'error');
      }
      if (!id && body.auth_type !== 'key' && !body.password) {
        return toast('Password is required for new hosts', 'error');
      }

      const method = id ? 'PUT' : 'POST';
      const url    = id ? '/api/devices/' + id : '/api/devices';

      try {
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'Request failed');
        }
        devModalOverlay.classList.add('hidden');
        if ($('m-key')) $('m-key').value = '';
        if ($('m-keypass')) $('m-keypass').value = '';
        loadDevices();
        toast(`Host ${id ? 'updated' : 'added'} successfully`, 'success');
      } catch (e) {
        toast('Error saving host: ' + e.message, 'error');
      }
    });
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  QUICK COMMANDS (MACROS)
  // ═════════════════════════════════════════════════════════════════════════

  async function loadMacros() {
    try {
      const res = await fetch('/api/macros');
      const raw = await res.json();
      macros = raw.map((m, i) => { m.slot = i + 1; return m; });
      while (macros.length < 5) {
        macros.push({ id: null, slot: macros.length + 1, name: 'Macro ' + (macros.length + 1), command: '' });
      }
      buildMacros();
    } catch (e) {
      macros = [1, 2, 3, 4, 5].map((i) => ({ id: null, slot: i, name: 'Macro ' + i, command: '' }));
      buildMacros();
    }
  }

  function updateMacroTogglesUI() {
    if (macroLockToggle) {
      macroLockToggle.classList.toggle('unlocked', !macroGlobalLock);
      if (macroLockIcon) macroLockIcon.textContent = macroGlobalLock ? 'lock' : 'lock_open';
      if (macroLockLabel) macroLockLabel.textContent = macroGlobalLock ? 'LOCKED' : 'UNLOCKED';
    }
    if ($('macros-mode-text')) {
      $('macros-mode-text').textContent = macroGlobalLock ? 'Click to Execute to Active Terminal' : 'Click to Edit Command Details';
      $('macros-mode-text').style.color = macroGlobalLock ? 'var(--primary)' : 'var(--tertiary)';
    }
    if (macroAutoToggle) {
      macroAutoToggle.classList.toggle('off', !macroAutoEnter);
      if (macroAutoLabel) macroAutoLabel.textContent = macroAutoEnter ? 'AUTO-ENTER: ON [⏎]' : 'AUTO-ENTER: OFF';
    }
  }

  if (macroLockToggle) {
    macroLockToggle.addEventListener('click', () => {
      macroGlobalLock = !macroGlobalLock;
      localStorage.setItem('webssh_macro_locked', macroGlobalLock ? 'true' : 'false');
      updateMacroTogglesUI();
      buildMacros();
    });
  }

  if (macroAutoToggle) {
    macroAutoToggle.addEventListener('click', () => {
      macroAutoEnter = !macroAutoEnter;
      localStorage.setItem('webssh_macro_autoenter', macroAutoEnter ? 'true' : 'false');
      updateMacroTogglesUI();
    });
  }

  function buildMacros() {
    if (!macroListEl) return;
    macroListEl.innerHTML = '';
    updateMacroTogglesUI();

    const crFlags = JSON.parse(localStorage.getItem('webssh_macro_cr') || '{}');

    for (let i = 1; i <= 5; i++) {
      const m = macros.find((x) => x.slot === i) || { slot: i, name: 'Macro ' + i, command: '' };
      if (crFlags[i] !== undefined) m.cr = crFlags[i];
      const crOn = m.cr !== false;

      const card = document.createElement('div');
      card.className = `macro-card ${macroGlobalLock ? 'locked-mode' : ''}`;
      card.dataset.slot = i;

      card.innerHTML = `
        <div class="macro-card-top">
          <span class="macro-card-label">[M${i}] ${esc(m.name)}</span>
          <span class="material-symbols-outlined macro-send-icon">${macroGlobalLock ? 'send' : 'edit'}</span>
        </div>
        <div class="macro-card-cmd-preview" title="${esc(m.command)}">${esc(m.command || '(empty command)')}</div>
        <div class="macro-card-bottom">
          <span class="macro-pill-hint">${macroGlobalLock ? 'Click to send' : 'Click to configure'}</span>
          <span style="font-family:var(--font-mono);font-size:9px;color:${crOn ? 'var(--primary)' : 'var(--text-dim)'};">${crOn ? '⏎ CR' : 'NO CR'}</span>
        </div>
      `;

      card.addEventListener('click', (e) => {
        if (macroGlobalLock) {
          // Locked: Execute immediately
          if (m && m.command && activeId) {
            sendToTerminal(m.command, crOn && macroAutoEnter);
            toast(`Executed [M${i}]`, 'info');
          } else if (!activeId) {
            toast('Open an active terminal session first', 'info');
          } else {
            toast(`[M${i}] has no command assigned`, 'info');
          }
        } else {
          // Unlocked: Open Edit Modal
          openMacroModal(m);
        }
      });

      macroListEl.appendChild(card);
    }
  }

  function openMacroModal(m) {
    if (!macroModalOverlay) return;
    if ($('mm-id'))      $('mm-id').value      = m.id || '';
    if ($('mm-slot'))    $('mm-slot').value    = m.slot || '';
    if ($('mm-name'))    $('mm-name').value    = m.name || '';
    if ($('mm-command')) $('mm-command').value = m.command || '';

    const crFlags = JSON.parse(localStorage.getItem('webssh_macro_cr') || '{}');
    const crVal = crFlags[m.slot] !== undefined ? crFlags[m.slot] : (m.cr !== false);
    if ($('mm-cr')) $('mm-cr').checked = crVal;

    macroModalOverlay.classList.remove('hidden');
    if ($('mm-name')) $('mm-name').focus();
  }

  if ($('macro-modal-close')) $('macro-modal-close').addEventListener('click', () => macroModalOverlay.classList.add('hidden'));
  if ($('macro-modal-cancel')) $('macro-modal-cancel').addEventListener('click', () => macroModalOverlay.classList.add('hidden'));
  if (macroModalOverlay) {
    macroModalOverlay.addEventListener('click', (e) => {
      if (e.target === macroModalOverlay) macroModalOverlay.classList.add('hidden');
    });
  }

  if ($('macro-modal-save')) {
    $('macro-modal-save').addEventListener('click', async () => {
      const slot = +($('mm-slot') ? $('mm-slot').value : 0);
      if (!slot) return toast('No macro slot selected', 'error');

      const m = macros.find((x) => x.slot === slot);
      if (!m) return toast('Macro entry not found', 'error');

      m.name = $('mm-name').value.trim() || `Macro ${slot}`;
      m.command = $('mm-command').value.trim();
      m.cr = $('mm-cr') ? $('mm-cr').checked : true;

      const crFlags = JSON.parse(localStorage.getItem('webssh_macro_cr') || '{}');
      crFlags[slot] = m.cr;
      localStorage.setItem('webssh_macro_cr', JSON.stringify(crFlags));

      if (m.id) {
        try {
          await fetch('/api/macros/' + m.id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: m.name, command: m.command }),
          });
        } catch (e) {}
      }

      macroModalOverlay.classList.add('hidden');
      buildMacros();
      toast(`Macro [M${slot}] saved`, 'success');
    });
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  SCRATCHPAD BUCKETS (LAYOUT MODES 5, 3, 1)
  // ═════════════════════════════════════════════════════════════════════════

  const bucketsEl = $('buckets');

  function buildBuckets() {
    if (!bucketsEl) return;
    bucketsEl.innerHTML = '';

    for (let i = 1; i <= 5; i++) {
      const val = localStorage.getItem('webssh_bucket_' + i) || '';
      const item = document.createElement('div');
      item.className = 'bucket-item';
      item.dataset.bucket = i;

      item.innerHTML = `
        <div class="bucket-header">
          <span class="bucket-num">#${i}</span>
          <div class="bucket-btns">
            <button class="btn-bk-copy" data-bucket="${i}">Copy</button>
            <button class="btn-bk-paste" data-bucket="${i}">Paste</button>
          </div>
        </div>
        <textarea class="bucket-textarea custom-scroll" data-bucket="${i}" placeholder="Bucket ${i} scratchpad...">${esc(val)}</textarea>
      `;

      bucketsEl.appendChild(item);
    }

    // Input Sync to localStorage
    bucketsEl.querySelectorAll('.bucket-textarea').forEach((ta) => {
      ta.addEventListener('input', function() {
        localStorage.setItem('webssh_bucket_' + this.dataset.bucket, this.value);
      });
    });

    // Copy per bucket
    bucketsEl.querySelectorAll('.btn-bk-copy').forEach((btn) => {
      btn.addEventListener('click', function() {
        const ta = bucketsEl.querySelector('.bucket-textarea[data-bucket="' + this.dataset.bucket + '"]');
        if (ta) copyToClipboard(ta.value, `Bucket #${this.dataset.bucket} copied`);
      });
    });

    // Paste per bucket
    bucketsEl.querySelectorAll('.btn-bk-paste').forEach((btn) => {
      btn.addEventListener('click', async function() {
        const ta = bucketsEl.querySelector('.bucket-textarea[data-bucket="' + this.dataset.bucket + '"]');
        if (!ta) return;
        try {
          ta.value = await navigator.clipboard.readText();
          localStorage.setItem('webssh_bucket_' + this.dataset.bucket, ta.value);
          toast(`Pasted to Bucket #${this.dataset.bucket}`, 'info');
        } catch (e) {
          toast('Clipboard read blocked by browser', 'error');
        }
      });
    });

    // Copy All
    if ($('btn-copy-all')) {
      $('btn-copy-all').addEventListener('click', () => {
        const all = [1, 2, 3, 4, 5]
          .map((i) => localStorage.getItem('webssh_bucket_' + i) || '')
          .filter((t) => t.trim())
          .join('\n\n---\n\n');
        copyToClipboard(all, 'All buckets combined & copied');
      });
    }

    // Clear All
    if ($('btn-clear-all')) {
      $('btn-clear-all').addEventListener('click', () => {
        if (!confirm('Clear contents of all scratchpad buckets?')) return;
        bucketsEl.querySelectorAll('.bucket-textarea').forEach((ta) => {
          ta.value = '';
          localStorage.setItem('webssh_bucket_' + ta.dataset.bucket, '');
        });
        const mta = $('merged-bucket-textarea');
        if (mta) {
          mta.value = '';
          localStorage.setItem('webssh_bucket_1', '');
        }
        toast('All buckets cleared', 'info');
      });
    }

    // Single Merged View Handlers
    const mergedTa = $('merged-bucket-textarea');
    if (mergedTa) {
      mergedTa.addEventListener('input', function() {
        localStorage.setItem('webssh_bucket_1', this.value);
      });
    }
    if ($('merged-copy')) {
      $('merged-copy').addEventListener('click', () => {
        if (mergedTa) copyToClipboard(mergedTa.value, 'Merged bucket copied');
      });
    }
    if ($('merged-clear')) {
      $('merged-clear').addEventListener('click', () => {
        if (mergedTa) mergedTa.value = '';
        localStorage.setItem('webssh_bucket_1', '');
      });
    }
  }

  function applyBucketLayout(layout) {
    if (!bucketsEl) return;
    const mergedWrap = $('merged-bucket-wrap');

    // Button states
    ['1', '3', '5'].forEach((x) => {
      const b = $('bl-' + x);
      if (b) b.classList.toggle('active', x === layout);
    });

    // Ensure we are on scratchpad tab
    activateDockTab('scratch');

    bucketsEl.className = 'layout-' + layout;
    localStorage.setItem('webssh_bucket_layout', layout);

    if (layout === '1') {
      bucketsEl.style.display = 'none';
      if (mergedWrap) {
        mergedWrap.classList.add('active-layout');
        const combined = [1, 2, 3, 4, 5]
          .map((i) => localStorage.getItem('webssh_bucket_' + i) || '')
          .filter((t) => t.trim())
          .join('\n\n---\n\n');
        if ($('merged-bucket-textarea')) $('merged-bucket-textarea').value = combined;
      }
    } else {
      bucketsEl.style.display = '';
      if (mergedWrap) mergedWrap.classList.remove('active-layout');
    }
  }

  ['1', '3', '5'].forEach((l) => {
    const b = $('bl-' + l);
    if (b) b.addEventListener('click', () => applyBucketLayout(l));
  });

  window._applyBucketLayout = applyBucketLayout;

  // ═════════════════════════════════════════════════════════════════════════
  //  TERMINAL MANAGER (xterm.js + WebSocket 2-Step Protocol)
  // ═════════════════════════════════════════════════════════════════════════

  function openTab(dev) {
    const id = ++tabCounter;
    const ts = window._termSettings || loadSettings();
    const devName = dev.device_name || dev.name || 'Server';
    const devHost = dev.ip_address || dev.host || 'localhost';

    // Create Tab Pill in Tabstrip
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.dataset.id = id;
    tab.innerHTML = `
      <span class="status-led online" style="width:6px;height:6px;"></span>
      <span class="tab-label">${esc(devName)}</span>
      <button class="tab-close" data-id="${id}" title="Close Session">&times;</button>
    `;
    tab.addEventListener('click', (e) => {
      if (!e.target.classList.contains('tab-close')) activateTab(id);
    });
    tab.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(id);
    });
    if (tabsEl) tabsEl.appendChild(tab);

    // Create Terminal Pane Container
    const pane = document.createElement('div');
    pane.className = 'term-pane';
    pane.dataset.id = id;
    if (termAreaEl) termAreaEl.appendChild(pane);

    // Instantiate xterm.js Terminal
    const term = new Terminal({
      cursorBlink:       true,
      fontSize:          parseInt(ts.fontSize, 10) || 13,
      fontFamily:        ts.fontFamily || '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
      allowTransparency: true,
      theme: {
        background:          ts.termBg     || '#05090e',
        foreground:          ts.termFg     || '#10b981',
        cursor:              ts.termCursor || '#10b981',
        selectionBackground: 'rgba(56, 189, 248, 0.3)',
        black:   '#05090e', red:     '#f87171', green: '#10b981', yellow: '#fbbf24',
        blue:    '#38bdf8', magenta: '#c084fc', cyan:  '#2dd4bf', white:  '#e2e8f0',
        brightBlack: '#475569', brightRed:     '#fca5a5', brightGreen: '#34d399',
        brightYellow:'#fde047', brightBlue:    '#7dd3fc', brightMagenta:'#e9d5ff',
        brightCyan:  '#5eead4', brightWhite:   '#ffffff',
      },
      scrollback: 5000,
    });

    const fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(pane);
    fitAddon.fit();

    const sessionObj = {
      id,
      devId: dev.id,
      label: devName,
      host: devHost,
      term,
      ws: null,
      fitAddon,
      pane,
      tab,
      buffer: [],
      lineCount: 0,
    };
    sessions.set(id, sessionObj);

    activateTab(id);
    if (welcomeEl) welcomeEl.style.display = 'none';

    // Step 1: POST /api/connect/:deviceId
    fetch('/api/connect/' + dev.id, { method: 'POST' })
      .then((r) => r.text())
      .then((t) => {
        try {
          return JSON.parse(t);
        } catch (e) {
          throw new Error(t.substring(0, 120));
        }
      })
      .then((sessionData) => {
        if (sessionData && sessionData.error) throw new Error(sessionData.error);
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}/ws`);
        sessionObj.ws = ws;

        let pingInterval = null;

        ws.addEventListener('open', () => {
          // Step 2: attach to session over WebSocket
          ws.send(JSON.stringify({
            type: 'attach',
            sessionId: sessionData.sessionId,
            cols: term.cols,
            rows: term.rows,
          }));
          pingInterval = setInterval(() => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'keepalive' }));
          }, 20000);
        });

        ws.addEventListener('message', (evt) => {
          const data = evt.data;
          // Binary SSH output encoded as 'O' + base64
          if (typeof data === 'string' && data[0] === 'O') {
            const bin = atob(data.slice(1));
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const text = utf8.decode(bytes);
            sessionObj.buffer.push(text);

            // Update line counter estimate
            sessionObj.lineCount += (text.match(/\n/g) || []).length;
            if (activeId === id) updateTerminalTelemetry(sessionObj);

            term.write(bytes);
            return;
          }

          // JSON Control Messages
          try {
            const msg = JSON.parse(data);
            if (msg.type === 'status' && msg.data === 'connected') {
              setStatus(true, devName);
              renderDeviceList();
            }
            if (msg.type === 'status' && msg.data === 'disconnected') {
              term.writeln('\r\n\x1b[33m[Session disconnected]\x1b[0m');
              setStatus(false);
              renderDeviceList();
            }
            if (msg.type === 'error') {
              term.writeln(`\r\n\x1b[31m[SSH Error: ${msg.data || msg.message || 'Unknown'}]\x1b[0m`);
            }
          } catch (e) {}
        });

        ws.addEventListener('close', () => {
          clearInterval(pingInterval);
          setStatus(false);
          renderDeviceList();
        });

        ws.addEventListener('error', () => {
          toast('WebSocket connection error', 'error');
        });
      })
      .catch((e) => {
        toast('Connection failed: ' + e.message, 'error');
        term.writeln(`\r\n\x1b[31mConnection failed: ${e.message}\x1b[0m`);
      });

    // Terminal Input & Resize Handlers
    term.onData((data) => {
      const s = sessions.get(id);
      if (s && s.ws && s.ws.readyState === 1) {
        s.ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    term.onResize((sz) => {
      const s = sessions.get(id);
      if (s && s.ws && s.ws.readyState === 1) {
        s.ws.send(JSON.stringify({ type: 'resize', cols: sz.cols, rows: sz.rows }));
      }
      if (activeId === id) updateTerminalTelemetry(s);
    });

    // Copy on selection in terminal
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (!sel || sel.length === 0) return;
      try {
        const ta = document.createElement('textarea');
        ta.value = sel;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, 9999);
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (e) {
        navigator.clipboard.writeText(sel).catch(() => {});
      }
    });

    // Unified paste handling for Ctrl+V / Cmd+V, Shift+Insert, and
    // Ctrl+Shift+V.
    //
    // xterm.js is a real terminal emulator: it treats Ctrl+V as a literal
    // control character (^V) and sends it straight to the shell — it does
    // NOT trigger the browser's native 'paste' event for that combo, so a
    // 'paste' event listener alone never fires for plain Ctrl+V. The fix is
    // to intercept the KEYDOWN itself, in the capture phase (so this runs
    // before xterm's own key handling on the textarea), stop it from
    // reaching xterm, and pull the text via the async Clipboard API.
    async function pasteFromClipboard() {
      try {
        // The very first paste on this site prompts Chrome's native
        // clipboard permission bubble. If it's missed/ignored the promise
        // can hang indefinitely rather than reject, so race it against a
        // timeout and surface a clear message instead of failing silently.
        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 4000)
        );
        const txt = await Promise.race([navigator.clipboard.readText(), timeout]);
        if (!txt) return;
        const s = sessions.get(id);
        if (s && s.ws && s.ws.readyState === 1) {
          s.ws.send(JSON.stringify({ type: 'input', data: txt }));
        }
      } catch (err) {
        if (err && err.message === 'timeout') {
          toast('Clipboard permission needed — click "Allow" on the browser prompt near the address bar, then try pasting again', 'error');
        } else {
          toast('Clipboard access blocked — allow clipboard permission for this site in your browser settings, or use right-click', 'error');
        }
      }
    }

    pane.addEventListener('keydown', (e) => {
      const isCtrlV = (e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'v' || e.key === 'V');
      const isShiftInsert = e.shiftKey && e.key === 'Insert';
      const isCtrlShiftV = (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'v' || e.key === 'V');
      if (isCtrlV || isShiftInsert || isCtrlShiftV) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        pasteFromClipboard();
      }
    }, true);

    // Right-Click Paste (same async Clipboard API — needs the
    // clipboard-read permission, which some browsers only grant after an
    // explicit prompt)
    pane.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      pasteFromClipboard();
    });

    renderDeviceList();
  }

  function activateTab(id) {
    activeId = id;
    sessions.forEach((s, sid) => {
      s.tab.classList.toggle('active', sid === id);
      s.pane.classList.toggle('active', sid === id);
    });

    const s = sessions.get(id);
    if (s) {
      setStatus(true, s.label);
      setTimeout(() => {
        s.fitAddon.fit();
        s.term.focus();
        updateTerminalTelemetry(s);
      }, 35);
    }
  }

  function closeTab(id) {
    const s = sessions.get(id);
    if (!s) return;
    if (s.ws && s.ws.readyState <= 1) {
      try { s.ws.close(); } catch (e) {}
    }
    s.tab.remove();
    s.pane.remove();
    sessions.delete(id);

    if (activeId === id) {
      activeId = null;
      const remaining = [...sessions.keys()];
      if (remaining.length) {
        activateTab(remaining[remaining.length - 1]);
      } else {
        if (welcomeEl) welcomeEl.style.display = '';
        setStatus(false);
        resetTerminalTelemetry();
      }
    }
    renderDeviceList();
  }

  function refitActive() {
    if (activeId) {
      const s = sessions.get(activeId);
      if (s) setTimeout(() => s.fitAddon.fit(), 60);
    }
  }

  function sendToTerminal(cmd, addCR) {
    if (!activeId) {
      toast('No active terminal session', 'info');
      return;
    }
    const s = sessions.get(activeId);
    if (!s || !s.ws || s.ws.readyState !== 1) {
      toast('Session not connected', 'error');
      return;
    }
    const data = addCR === false ? cmd : cmd + '\n';
    s.ws.send(JSON.stringify({ type: 'input', data }));
    if (s.term) s.term.focus();
  }

  function setStatus(online, label) {
    if (statusDot) {
      statusDot.className = 'status-led ' + (online ? 'online' : 'offline');
    }
    if (statusText) {
      statusText.textContent = online ? 'Connected to ' + label : 'Not connected';
    }
  }

  function updateTerminalTelemetry(s) {
    if (!s) return;
    if ($('term-strip-status')) {
      $('term-strip-status').innerHTML = `<span class="status-led online" style="display:inline-block;margin-right:4px;"></span> CONNECTED (${esc(s.label)})`;
    }
    if ($('term-strip-lines')) {
      $('term-strip-lines').innerHTML = `LINES: <strong>${s.lineCount.toLocaleString()}</strong>`;
    }
    if ($('term-strip-geo')) {
      $('term-strip-geo').innerHTML = `GEOMETRY: <strong>${s.term.cols}x${s.term.rows} cols</strong>`;
    }
  }

  function resetTerminalTelemetry() {
    if ($('term-strip-status')) {
      $('term-strip-status').innerHTML = `<span class="status-led offline" style="display:inline-block;margin-right:4px;"></span> NOT CONNECTED`;
    }
    if ($('term-strip-lines')) $('term-strip-lines').innerHTML = 'LINES: <strong>0</strong>';
    if ($('term-strip-geo'))   $('term-strip-geo').innerHTML   = 'GEOMETRY: <strong>-</strong>';
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  TOOLBAR UTILITIES (Clear, Copy Log, Save Log, New Tab, Disconnect)
  // ═════════════════════════════════════════════════════════════════════════

  function clearActiveTerminal() {
    if (!activeId) return;
    const s = sessions.get(activeId);
    if (s) {
      s.term.clear();
      s.buffer = [];
      s.lineCount = 0;
      updateTerminalTelemetry(s);
      toast('Terminal buffer cleared', 'info');
    }
  }

  if ($('btn-clear-viewport')) $('btn-clear-viewport').addEventListener('click', clearActiveTerminal);

  function copyActiveLog() {
    if (!activeId) return;
    const s = sessions.get(activeId);
    if (!s) return;
    const raw = (s.buffer || []).join('');
    const clean = raw.replace(/\x1b\[[0-9;]*[mGKHFABCDJh]/g, '').replace(/\x1b[()][AB012]/g, '');
    copyToClipboard(clean, 'Clean session log copied');
  }

  if ($('btn-copy-term-log')) $('btn-copy-term-log').addEventListener('click', copyActiveLog);

  // Copy the session log, then clear the buffer, in one click.
  // Clear only runs once the copy has actually succeeded, so the log is never lost.
  function copyAndClearActive() {
    if (!activeId) return;
    const s = sessions.get(activeId);
    if (!s) return;
    const raw = (s.buffer || []).join('');
    const clean = raw.replace(/\x1b\[[0-9;]*[mGKHFABCDJh]/g, '').replace(/\x1b[()][AB012]/g, '');
    const done = () => {
      toast('Log copied & buffer cleared', 'success');
      s.term.clear();
      s.buffer = [];
      s.lineCount = 0;
      updateTerminalTelemetry(s);
    };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = clean;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) done(); else toast('Copy failed - buffer NOT cleared', 'error');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(clean).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  if ($('btn-copy-clear-term')) $('btn-copy-clear-term').addEventListener('click', copyAndClearActive);

  function saveActiveLog() {
    if (!activeId) return;
    const s = sessions.get(activeId);
    if (!s) return;
    const raw = (s.buffer || []).join('');
    const clean = raw.replace(/\x1b\[[0-9;]*[mGKHFABCDJh]/g, '').replace(/\x1b[()][AB012]/g, '');
    if (!clean.trim()) return toast('Buffer is empty', 'info');

    const label = (s.label || 'terminal').replace(/[^a-zA-Z0-9_-]/g, '_');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fn = `ssh-log_${label}_${ts}.txt`;

    const blob = new Blob([clean], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fn;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('Downloaded ' + fn, 'success');
  }

  if ($('btn-save-term-log')) $('btn-save-term-log').addEventListener('click', saveActiveLog);

  function openSelectedOrActiveDevice() {
    let dev = devices.find((d) => d.id === selectedDevId);
    if (!dev && activeId) {
      const activeS = sessions.get(activeId);
      if (activeS && activeS.devId) {
        dev = devices.find((d) => d.id === activeS.devId);
      }
    }
    if (!dev && devices.length > 0) dev = devices[0];
    if (dev) openTab(dev);
    else toast('Select a host to connect', 'info');
  }

  if ($('btn-new-term')) $('btn-new-term').addEventListener('click', openSelectedOrActiveDevice);
  if ($('btn-new-tab')) $('btn-new-tab').addEventListener('click', openSelectedOrActiveDevice);

  if ($('btn-disconnect')) {
    $('btn-disconnect').addEventListener('click', () => {
      if (activeId) closeTab(activeId);
    });
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  SPLITTERS & RESIZE HANDLERS
  // ═════════════════════════════════════════════════════════════════════════

  // Left vertical splitter
  if (splitterLeft && leftPanel) {
    let dragging = false, startX, startW;
    splitterLeft.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startW = leftPanel.offsetWidth;
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.max(180, Math.min(480, startW + e.clientX - startX));
      leftPanel.style.width = w + 'px';
      refitActive();
    });
    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        document.body.style.cursor = '';
      }
    });
  }

  // Bottom horizontal splitter
  if (splitterBot && bottomDock) {
    let dragging = false, startY, startH;
    splitterBot.addEventListener('mousedown', (e) => {
      dragging = true;
      startY = e.clientY;
      startH = bottomDock.offsetHeight;
      document.body.style.cursor = 'row-resize';
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const h = Math.max(90, Math.min(450, startH - (e.clientY - startY)));
      bottomDock.style.height = h + 'px';
      savedDockH = h;
      refitActive();
    });
    document.addEventListener('mouseup', () => {
      if (dragging) {
        dragging = false;
        document.body.style.cursor = '';
      }
    });
  }

  // Window resize
  window.addEventListener('resize', refitActive);

  // Global Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    // Ctrl+Tab: Switch tab
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      const ids = [...sessions.keys()];
      if (ids.length > 1) {
        const idx = ids.indexOf(activeId);
        activateTab(ids[(idx + 1) % ids.length]);
      }
    }
    // Ctrl+Shift+W: Close active tab
    if (e.ctrlKey && e.shiftKey && e.key === 'W') {
      e.preventDefault();
      if (activeId) closeTab(activeId);
    }
    // Ctrl+B: Toggle Sidebar
    if (e.ctrlKey && e.key === 'b') {
      e.preventDefault();
      toggleSidebar();
    }
    // Ctrl+J: Toggle Bottom Dock
    if (e.ctrlKey && e.key === 'j') {
      e.preventDefault();
      toggleDock();
    }
    // F11: Toggle Zen Mode
    if (e.key === 'F11') {
      e.preventDefault();
      toggleZenMode();
    }
    // Escape: Exit Zen mode if active
    if (e.key === 'Escape' && zenMode) {
      toggleZenMode();
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  //  HELPERS
  // ═════════════════════════════════════════════════════════════════════════

  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function copyToClipboard(text, msg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        toast(msg || 'Copied to clipboard', 'success');
      }).catch(() => fallbackCopy(text, msg));
    } else {
      fallbackCopy(text, msg);
    }
  }

  function fallbackCopy(text, msg) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast(msg || 'Copied to clipboard', 'success');
  }

  function toast(msg, type = 'info') {
    if (!toastsEl) return;
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    toastsEl.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      el.style.transition = 'all 0.2s ease';
      setTimeout(() => el.remove(), 200);
    }, 3200);
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  WEB LINKS (4 URL launcher buttons — own lock, icon = uploaded/pasted image)
  // ═════════════════════════════════════════════════════════════════════════

  const LINK_SLOTS = 4;
  let links = [];
  let linksLocked = localStorage.getItem('webssh_links_locked') !== 'false'; // default locked
  let linkIconDraft = null;   // data-URL currently shown in the modal (null = no icon)

  const linksListEl     = $('links-list');
  const linksLockToggle = $('links-lock-toggle');
  const linksLockIcon   = $('links-lock-icon');
  const linksLockLabel  = $('links-lock-label');
  const linkModalOverlay = $('link-modal-overlay');

  async function loadLinks() {
    try {
      const res = await fetch('/api/links');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const raw = await res.json();
      links = raw.map((l, i) => { l.slot = i + 1; return l; });
    } catch (e) {
      links = [];
    }
    while (links.length < LINK_SLOTS) {
      links.push({ id: null, slot: links.length + 1, name: '', url: '', icon: null });
    }
    buildLinks();
  }

  function updateLinksLockUI() {
    if (!linksLockToggle) return;
    linksLockToggle.classList.toggle('unlocked', !linksLocked);
    if (linksLockIcon)  linksLockIcon.textContent  = linksLocked ? 'lock' : 'lock_open';
    if (linksLockLabel) linksLockLabel.textContent = linksLocked ? 'LOCKED' : 'UNLOCKED';
  }

  if (linksLockToggle) {
    linksLockToggle.addEventListener('click', () => {
      linksLocked = !linksLocked;
      localStorage.setItem('webssh_links_locked', linksLocked ? 'true' : 'false');
      buildLinks();
    });
  }

  function isSafeHttpUrl(u) {
    return /^https?:\/\/[^\s]+$/i.test(u || '');
  }

  function buildLinks() {
    if (!linksListEl) return;
    linksListEl.innerHTML = '';
    updateLinksLockUI();

    for (let i = 1; i <= LINK_SLOTS; i++) {
      const l = links.find((x) => x.slot === i);
      const hasUrl = !!(l && l.url);
      const label  = l && l.name ? l.name : (hasUrl ? l.url : 'Add URL');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link-btn ' + (linksLocked ? 'locked-mode' : 'unlocked-mode') + (hasUrl ? '' : ' empty');
      btn.title = hasUrl ? l.url : 'Empty — unlock to set a URL';

      const iconWrap = document.createElement('span');
      iconWrap.className = 'link-btn-icon';
      if (l && l.icon && /^data:image\//i.test(l.icon)) {
        const img = document.createElement('img');
        img.src = l.icon;
        img.alt = '';
        iconWrap.appendChild(img);
      } else {
        iconWrap.innerHTML = '<span class="material-symbols-outlined">' + (hasUrl ? 'public' : 'add_link') + '</span>';
      }

      const nameEl = document.createElement('span');
      nameEl.className = 'link-btn-name';
      nameEl.textContent = label;

      const actEl = document.createElement('span');
      actEl.className = 'material-symbols-outlined link-btn-action';
      actEl.textContent = linksLocked ? 'open_in_new' : 'edit';

      btn.appendChild(iconWrap);
      btn.appendChild(nameEl);
      btn.appendChild(actEl);

      btn.addEventListener('click', () => {
        if (linksLocked) {
          if (!hasUrl) return toast('Link ' + i + ' has no URL — unlock to set one', 'info');
          if (!isSafeHttpUrl(l.url)) return toast('Link ' + i + ' has an invalid URL', 'error');
          window.open(l.url, '_blank', 'noopener');
        } else {
          openLinkModal(l);
        }
      });

      linksListEl.appendChild(btn);
    }
  }

  // ── Modal ──────────────────────────────────────────────────────────────
  function renderLinkIconPreview() {
    const box = $('lm-icon-preview');
    if (!box) return;
    box.innerHTML = '';
    if (linkIconDraft) {
      const img = document.createElement('img');
      img.src = linkIconDraft;
      img.alt = '';
      box.appendChild(img);
    } else {
      box.innerHTML = '<span class="material-symbols-outlined">add_photo_alternate</span>';
    }
  }

  function openLinkModal(l) {
    if (!linkModalOverlay) return;
    $('lm-slot').value = l.slot;
    $('lm-name').value = l.name || '';
    $('lm-url').value  = l.url  || '';
    linkIconDraft = l.icon || null;
    renderLinkIconPreview();
    linkModalOverlay.classList.remove('hidden');
    $('lm-name').focus();
  }

  function closeLinkModal() {
    if (linkModalOverlay) linkModalOverlay.classList.add('hidden');
  }

  // Shrink any image blob to max 48x48 PNG so the DB row stays tiny.
  function imageBlobToIcon(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read image'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Not a valid image'));
        img.onload = () => {
          const MAX = 48;
          const scale = Math.min(1, MAX / Math.max(img.width || MAX, img.height || MAX));
          const w = Math.max(1, Math.round((img.width  || MAX) * scale));
          const h = Math.max(1, Math.round((img.height || MAX) * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/png'));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(blob);
    });
  }

  async function setLinkIconFromBlob(blob) {
    try {
      linkIconDraft = await imageBlobToIcon(blob);
      renderLinkIconPreview();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  if ($('link-modal-close'))  $('link-modal-close').addEventListener('click', closeLinkModal);
  if ($('link-modal-cancel')) $('link-modal-cancel').addEventListener('click', closeLinkModal);
  if (linkModalOverlay) {
    linkModalOverlay.addEventListener('click', (e) => { if (e.target === linkModalOverlay) closeLinkModal(); });

    // Ctrl+V anywhere inside the open modal: paste an image from the clipboard
    document.addEventListener('paste', (e) => {
      if (linkModalOverlay.classList.contains('hidden')) return;
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          e.preventDefault();
          setLinkIconFromBlob(it.getAsFile());
          return;
        }
      }
    });
  }

  if ($('lm-icon-upload')) $('lm-icon-upload').addEventListener('click', () => $('lm-icon-file').click());
  if ($('lm-icon-file')) {
    $('lm-icon-file').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) setLinkIconFromBlob(f);
      e.target.value = '';
    });
  }
  if ($('lm-icon-clear')) {
    $('lm-icon-clear').addEventListener('click', () => { linkIconDraft = null; renderLinkIconPreview(); });
  }

  if ($('link-modal-save')) {
    $('link-modal-save').addEventListener('click', async () => {
      const slot = +$('lm-slot').value;
      const l = links.find((x) => x.slot === slot);
      if (!l) return toast('Link slot not found', 'error');

      const name = $('lm-name').value.trim();
      let url = $('lm-url').value.trim();
      if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;   // "host.tld" -> https://host.tld
      if (url && !isSafeHttpUrl(url)) return toast('URL must start with http:// or https://', 'error');

      if (!l.id) return toast('Link not stored in the database yet — reload the page', 'error');

      try {
        const res = await fetch('/api/links/' + l.id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, url, icon: linkIconDraft }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return toast(err.error || 'Save failed', 'error');
        }
      } catch (e) {
        return toast('Save failed: ' + e.message, 'error');
      }

      l.name = name; l.url = url; l.icon = linkIconDraft;
      closeLinkModal();
      buildLinks();
      toast('Link ' + slot + ' saved', 'success');
    });
  }

  // ═════════════════════════════════════════════════════════════════════════
  //  INITIALIZATION
  // ═════════════════════════════════════════════════════════════════════════

  buildBuckets();
  loadDevices();
  loadMacros();
  loadLinks();

  document.addEventListener('DOMContentLoaded', () => {
    let savedLayout = localStorage.getItem('webssh_bucket_layout') || '5';
    if (!['1', '3', '5'].includes(savedLayout)) savedLayout = '5';
    applyBucketLayout(savedLayout);
  });

})();
