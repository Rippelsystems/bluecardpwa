// ─── FAT / PDI MODULE ───────────────────────────────────────────────────────
// Grid-view digital equivalent of the paper FAT / PDI acceptance sheets.
// Fully separate from the Blue Card build screens and from each other:
//   - FAT results  -> weapon_fat_results
//   - PDI results  -> weapon_pdi_results
// A unit appears here as soon as it has a Blue Card build (v1.22 — the
// sign-off gate was removed 23/10/2026; an open FAIL still holds it back),
// and the serial/trolley/position are read from that build — never re-typed.

const FATPDI_PAGE_SIZE = 50;

const fatpdi = {
  stage: null,      // 'FAT' | 'PDI'
  cardType: null,   // 'RLL' | 'XRGL40' | 'GRN40'
  units: [],        // eligible units currently LOADED (paged, not the whole contract)
  results: {},      // results[unitSerial][itemId] = 'PASS'|'FAIL'|null
  remarks: {},      // remarks[unitSerial] = text
  accept: {},       // acceptance stage only (GRN40 FAT = RES-QC-16): accept[unitSerial] = 'YES'|'NO'   (31/10/2026)
  notes: {},        // acceptance stage only: notes[unitSerial] = text
  saved: {},        // acceptance stage only: saved[unitSerial] = {accepted, by, at} from the database
  touched: {},      // acceptance stage only: touched[unitSerial] = true once the operator changed anything on that row
  docCode: null,
  adminPreview: false,  // true = Admin bypassed the COMPLETE gate to review layout;
                        // preview data is never saved to the real QC tables
  offset: 0,            // paging — a contract can have 1000+ guns, so we never
  totalCount: 0,         // load them all at once, only FATPDI_PAGE_SIZE per page
  filterContract: '',
  filterSearch: ''
};

// 23/10/2026 (v1.22): a Supabase call that never answers (dead Wi-Fi,
// request dropped) used to leave the FAT/PDI screen on "Loading…" for ever.
// Every read on this screen now gives up after `ms` and reports WHY.
function _withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} took longer than ${ms / 1000}s — check Wi-Fi and tap Retry`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function _fatpdiTable() {
  return fatpdi.stage === 'FAT' ? 'weapon_fat_results' : 'weapon_pdi_results';
}
// 31/10/2026: a stage flagged `acceptance: true` in fatpdi_config.js (the GRN40
// FAT = RES-QC-16 Final Acceptance) carries the paper form's extra fields —
// Country, ACCEPT YES/NO, Notes — and lists its units from the SERIAL
// REGISTER instead of from Blue Card build cards. Same stage, same table.
function _stageCfg() { return (FATPDI_TYPES[fatpdi.cardType] || {})[fatpdi.stage] || null; }
function _isAcc() { const c = _stageCfg(); return !!(c && c.acceptance); }

// ── Open from the bottom bar (v1.22) — for the card type the operator is
//    logged in with. Before, FAT and PDI were two blocks at the foot of the
//    Home screen, each with its own card-type picker.
function openFatPdiTab(stage) {
  if (!state.operator) { showToast('Log in first', 'error'); return; }
  if (!state.cardType) { showToast('No card type — log in again and pick one', 'error'); return; }
  if (!(FATPDI_TYPES[state.cardType] || {})[stage]) {
    showToast(`${stage} is not set up for ${state.cardType}`, 'error'); return;
  }
  // Already on this stage — just go back to it, keep what is loaded
  if (fatpdi.stage === stage && fatpdi.cardType === state.cardType &&
      document.getElementById('screen-fatpdi').classList.contains('active')) return;
  // Leaving the Checks tab saves it, same as showSection() does
  const chk = document.getElementById('screen-checks');
  if (chk && chk.classList.contains('active') && state.buildId) {
    supabaseClient.from('weapon_builds').update({checks: state.checks}).eq('id', state.buildId).then(() => {});
  }
  openFatPdi(stage, state.cardType);
}

function openFatPdi(stage, cardType) {
  if (!cardType) {
    const sel = document.getElementById(stage === 'FAT' ? 'inp-fat-type' : 'inp-pdi-type');
    cardType = sel ? sel.value : state.cardType;
  }
  if (!cardType) { showToast('Select a card type first', 'error'); return; }

  fatpdi.stage = stage;
  fatpdi.cardType = cardType;
  fatpdi.adminPreview = false;
  fatpdi.offset = 0;
  fatpdi.totalCount = 0;
  fatpdi.filterContract = '';
  fatpdi.filterSearch = '';
  const typeCfg = FATPDI_TYPES[cardType];
  const stageCfg = typeCfg[stage];
  fatpdi.docCode = stageCfg.docCode;
  fatpdi.results = {};
  fatpdi.remarks = {};
  fatpdi.accept = {};
  fatpdi.notes = {};
  fatpdi.saved = {};
  fatpdi.touched = {};
  fatpdi.units = [];

  // 31/10/2026: an acceptance stage is named for what it is — the GRN40
  // "Final Acceptance Checklist" — not "FAT", so it is not confused with the
  // GRN40 build card.
  document.getElementById('fatpdi-stage-badge').textContent = stageCfg.acceptance ? 'ACCEPT' : stage;
  document.getElementById('fatpdi-title').textContent =
    stageCfg.acceptance ? `${stageCfg.title || 'Final Acceptance Checklist'} — ${typeCfg.label}` : `${stage} — ${typeCfg.label}`;
  const unitsHeading = document.getElementById('fatpdi-units-heading');
  if (unitsHeading) unitsHeading.textContent = stageCfg.acceptance ? 'Sights for Final Acceptance' : 'Units Ready for Inspection';
  document.getElementById('fatpdi-op').textContent = state.operator || '—';
  const searchInp = document.getElementById('fatpdi-filter-search');
  if (searchInp) searchInp.value = '';
  _updateAdminPreviewUI();
  _loadFatPdiContracts();

  show('screen-fatpdi');
  _loadFatPdiUnits(true);
}

// ── Contract filter dropdown — narrows a large contract down before ────────
// listing units, same idea as the Home screen's Find by Trolley filters.
async function _loadFatPdiContracts() {
  const sel = document.getElementById('fatpdi-filter-contract');
  if (!sel) return;
  sel.innerHTML = '<option value="">All Contracts</option>';
  try {
    // 31/10/2026: Final Acceptance lists the SERIAL REGISTER's contracts
    const { data } = _isAcc()
      ? await _withTimeout(supabaseClient.from('weapon_serials')
          .select('project').eq('card_type', fatpdi.cardType)
          .not('project', 'is', null), 15000, 'Contract list')
      : await _withTimeout(supabaseClient.from('weapon_builds')
          .select('contract_name').eq('card_type', fatpdi.cardType)
          .not('contract_name', 'is', null), 15000, 'Contract list');
    const names = [...new Set((data || []).map(r => _isAcc() ? r.project : r.contract_name))].sort();
    names.forEach(n => { sel.innerHTML += `<option value="${n}">${n}</option>`; });
  } catch (e) {
    console.warn('[FAT/PDI] Could not load contracts', e);
  }
}

// Load More / Retry button: with nothing loaded yet, a retry restarts the
// page from the top (reset); otherwise it appends the next page.
function _fatpdiLoadMore() { _loadFatPdiUnits(fatpdi.units.length === 0); }

function _fatpdiApplyFilter() {
  fatpdi.filterContract = document.getElementById('fatpdi-filter-contract').value;
  fatpdi.filterSearch = document.getElementById('fatpdi-filter-search').value.trim().toUpperCase();
  fatpdi.offset = 0;
  fatpdi.units = [];
  _loadFatPdiUnits(true);
}

// ── Admin Preview — review mode: also lists units whose build card has an
//    open FAIL, and never writes a result (the COMPLETE gate it used to
//    bypass was removed in v1.22). Uses the same PIN-gate pattern as Supervisor
//    Override (PIN kept in app_settings, never hardcoded in the page).
//    Preview data is NEVER written to weapon_fat_results/weapon_pdi_results.
async function requestAdminPreview() {
  if (fatpdi.adminPreview) {
    // Toggle off
    fatpdi.adminPreview = false;
    _updateAdminPreviewUI();
    _loadFatPdiUnits();
    return;
  }

  let adminPin = 'ADMIN123'; // fallback — matches Rippel Matrix's default admin PIN
  try {
    const { data } = await supabaseClient.from('app_settings')
      .select('value').eq('key', 'pwa_admin_pin').limit(1);
    if (data && data.length > 0) adminPin = data[0].value;
  } catch (e) {
    console.warn('[FAT/PDI] Could not fetch admin PIN, using fallback');
  }

  const entered = prompt('ADMIN PREVIEW\n\nEnter Admin PIN to review the FAT/PDI checklist, including units held back by an open FAIL:\n(Nothing entered here is saved as a real QC record.)');
  if (!entered) return;

  if (entered.trim() !== adminPin) {
    showToast('❌ Wrong Admin PIN', 'error');
    return;
  }

  fatpdi.adminPreview = true;
  showToast('🔓 Admin Preview ON — showing all units, nothing will be saved', 'warn');
  _updateAdminPreviewUI();
  _loadFatPdiUnits();
}

function _updateAdminPreviewUI() {
  const banner = document.getElementById('fatpdi-preview-banner');
  const btn = document.getElementById('btn-fatpdi-admin-preview');
  const saveBtn = document.getElementById('btn-fatpdi-save');
  if (banner) banner.style.display = fatpdi.adminPreview ? 'block' : 'none';
  if (btn) btn.textContent = fatpdi.adminPreview ? '🔓 Admin Preview: ON (tap to exit)' : '🔒 Admin Preview';
  if (saveBtn) saveBtn.textContent = fatpdi.adminPreview ? '💾 Save (disabled in Preview)' : '💾 Save All';
}

// ── Load eligible units, one page at a time ─────────────────────────────────
// A contract can hold 1000+ guns, so this never fetches "all" units — it
// pages FATPDI_PAGE_SIZE at a time (Supabase .range()) and reports a real
// count, with a Contract filter and serial search to narrow it down first.
// reset=true (first open, or filter changed) replaces the grid; reset=false
// ("Load More") appends the next page onto what's already showing.
async function _loadFatPdiUnits(reset) {
  const grid = document.getElementById('fatpdi-grid');
  const emptyMsg = document.getElementById('fatpdi-empty-msg');
  const footer = document.getElementById('fatpdi-doc-footer');
  const countLabel = document.getElementById('fatpdi-count-label');
  const loadMoreBtn = document.getElementById('btn-fatpdi-loadmore');
  emptyMsg.style.display = 'none';
  if (reset) { fatpdi.offset = 0; fatpdi.units = []; grid.innerHTML = ''; }
  footer.textContent = 'Loading…';
  if (loadMoreBtn) { loadMoreBtn.disabled = true; loadMoreBtn.textContent = 'Loading…'; }

  try {
    if (_isAcc()) { await _loadAcceptanceUnits(reset, { grid, emptyMsg, footer, countLabel, loadMoreBtn }); return; }
    const serialCol = fatpdi.cardType === 'GRN40' ? 'sight_serial' : 'launcher_serial';
    // 23/10/2026 (v1.22): no more count='exact' — that made PostgREST run a
    // second counting query over the table on every page; the page itself
    // tells us whether there is more (a full page = probably more).
    let q = supabaseClient.from('weapon_builds')
      .select('id,launcher_serial,sight_serial,trolley_number,trolley_position,client_country,contract_name,status,checks')
      .eq('card_type', fatpdi.cardType)
      .not(serialCol, 'is', null);
    // 23/10/2026 (v1.22): the "build card must be signed off (COMPLETE)
    // first" gate is removed at the floor's request — a unit is listed as
    // soon as it has a build card. Units still in build are tagged in the
    // grid. The FAIL rule stays: an open FAIL on the build card holds the
    // unit back (shown under Admin Preview only).
    if (fatpdi.filterContract) q = q.eq('contract_name', fatpdi.filterContract);
    if (fatpdi.filterSearch) q = q.ilike(serialCol, `%${fatpdi.filterSearch}%`);
    q = q.order('trolley_number').order('trolley_position')
         .range(fatpdi.offset, fatpdi.offset + FATPDI_PAGE_SIZE - 1);

    const { data, error } = await _withTimeout(q, 20000, 'Loading units');
    if (error) throw error;
    const pageFull = (data || []).length >= FATPDI_PAGE_SIZE;

    // 21/10/2026: a unit whose build card still carries a FAIL / NO-GO is NOT
    // offered for FAT or PDI (strict rule — it must be reworked and passed
    // first). v1.21 blocks sign-off with a FAIL, so this only ever applies to
    // cards completed before that rule; Admin Preview still lists them, tagged.
    const hasFail = r => Object.values(r.checks || {}).some(v => v && ['FAIL','NO-GO'].includes(v.result));
    const skippedFails = (data || []).filter(r => hasFail(r) && !fatpdi.adminPreview).length;
    const pageUnits = (data || []).filter(r => fatpdi.adminPreview || !hasFail(r)).map(r => ({
      openFails: Object.values(r.checks || {}).filter(v => v && ['FAIL','NO-GO'].includes(v.result)).length,
      unitSerial: fatpdi.cardType === 'GRN40' ? r.sight_serial : r.launcher_serial,
      launcherSerial: fatpdi.cardType === 'GRN40' ? null : r.launcher_serial,
      sightSerial: r.sight_serial || null,
      status: r.status,
      trolleyNumber: r.trolley_number,
      trolleyPosition: r.trolley_position
    }));

    fatpdi.units = fatpdi.units.concat(pageUnits);
    fatpdi.offset += (data || []).length;
    if (skippedFails) showToast(`⚠ ${skippedFails} unit(s) held back — build card has an open FAIL`, 'warn');

    // Doc control footer — pulled live from Document Revision Control.
    // Not awaited: the grid must never wait for the footer.
    footer.textContent = fatpdi.docCode;
    _withTimeout(supabaseClient.from('document_revisions')
        .select('doc_code,revision,revision_date').eq('doc_code', fatpdi.docCode).limit(1),
      10000, 'Document revision')
      .then(({ data: doc }) => {
        if (doc && doc.length) {
          const d = doc[0];
          footer.textContent = `${d.doc_code} · Rev ${d.revision} · ${(d.revision_date||'').slice(0,10)}`;
        } else {
          footer.textContent = `${fatpdi.docCode} (not yet registered in Document Revision Control)`;
        }
      })
      .catch(() => { footer.textContent = fatpdi.docCode; });

    if (fatpdi.units.length === 0) {
      emptyMsg.style.display = 'block';
      emptyMsg.textContent = fatpdi.adminPreview
        ? `No ${fatpdi.cardType} Blue Card builds match this filter.`
        : `No ${fatpdi.cardType} units with a Blue Card build match this filter yet (units with an open FAIL are held back).`;
      if (countLabel) countLabel.textContent = '';
      if (loadMoreBtn) loadMoreBtn.style.display = 'none';
      return;
    }

    // Pull any existing results for just this page's units, so re-opening
    // or paging in more shows saved state without re-fetching everything.
    const pageSerials = pageUnits.map(u => u.unitSerial);
    if (pageSerials.length) {
      const { data: existing, error: exErr } = await _withTimeout(
        supabaseClient.from(_fatpdiTable())
          .select('unit_serial,item_id,result,remarks')
          .eq('card_type', fatpdi.cardType).in('unit_serial', pageSerials),
        20000, 'Loading saved results');
      if (exErr) throw exErr;
      (existing || []).forEach(row => {
        if (!fatpdi.results[row.unit_serial]) fatpdi.results[row.unit_serial] = {};
        fatpdi.results[row.unit_serial][row.item_id] = row.result;
        if (row.remarks) fatpdi.remarks[row.unit_serial] = row.remarks;
      });
    }

    _renderFatPdiGrid();

    if (countLabel) countLabel.textContent = `Showing ${fatpdi.units.length}${pageFull ? ' — more available' : ''}`;
    if (loadMoreBtn) {
      loadMoreBtn.style.display = pageFull ? 'block' : 'none';
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = `Load ${FATPDI_PAGE_SIZE} More`;
    }
  } catch (e) {
    console.error('[FAT/PDI] load error', e);
    footer.textContent = '';
    emptyMsg.style.display = 'block';
    // Say what actually went wrong — "Loading…" with no reason helps nobody
    emptyMsg.textContent = `⚠ Could not load units — ${(e && e.message) || e}. Tap Retry.`;
    if (loadMoreBtn) { loadMoreBtn.style.display = 'block'; loadMoreBtn.disabled = false; loadMoreBtn.textContent = 'Retry'; }
  }
}

// ── 31/10/2026: GRN40 FINAL ACCEPTANCE (the GRN40 FAT tab, RES-QC-16) ────
// Units from the SERIAL REGISTER: GRN40 sights never get a Blue Card build
// card, so the rows are the sights allocated in weapon_serials for this card
// type (the same register the Blue Card checks a serial against). Only a
// registered sight can be accepted (database trigger), and weapon_fat_results
// holds ONE result per sight per action (existing unique key) — the same
// duplicate rule the launcher / sight serials already follow.
async function _loadAcceptanceUnits(reset, el) {
  const { emptyMsg, footer, countLabel, loadMoreBtn } = el;
  let q = supabaseClient.from('weapon_serials')
    .select('serial_number,project,customer,status,trolley_number,trolley_position')
    .eq('card_type', fatpdi.cardType);
  if (fatpdi.filterContract) q = q.eq('project', fatpdi.filterContract);
  if (fatpdi.filterSearch) q = q.ilike('serial_number', `%${fatpdi.filterSearch}%`);
  q = q.order('serial_number').range(fatpdi.offset, fatpdi.offset + FATPDI_PAGE_SIZE - 1);

  const { data, error } = await _withTimeout(q, 20000, 'Loading sights from the serial register');
  if (error) throw error;
  const pageFull = (data || []).length >= FATPDI_PAGE_SIZE;
  const pageUnits = (data || []).map(r => ({
    openFails: 0,
    unitSerial: r.serial_number,
    launcherSerial: null,
    sightSerial: r.serial_number,
    status: (r.status || 'UNBUILT').toUpperCase(),     // build status from the register
    project: r.project || null,
    country: r.customer || null,
    trolleyNumber: r.trolley_number,
    trolleyPosition: r.trolley_position
  }));
  fatpdi.units = fatpdi.units.concat(pageUnits);
  fatpdi.offset += (data || []).length;

  const cfg = _stageCfg();
  footer.textContent = `${fatpdi.docCode} · Acceptance spec ${cfg.acceptanceSpec || ''}`;
  _withTimeout(supabaseClient.from('document_revisions')
      .select('doc_code,revision,revision_date').eq('doc_code', fatpdi.docCode).limit(1),
    10000, 'Document revision')
    .then(({ data: doc }) => {
      const d = doc && doc.length ? doc[0] : null;
      footer.textContent = (d ? `${d.doc_code} · Rev ${d.revision} · ${(d.revision_date||'').slice(0,10)}`
                              : `${fatpdi.docCode} (not yet registered in Document Revision Control)`)
                         + ` · Acceptance spec ${cfg.acceptanceSpec || ''}`;
    })
    .catch(() => {});

  if (fatpdi.units.length === 0) {
    emptyMsg.style.display = 'block';
    emptyMsg.textContent = `No ${fatpdi.cardType} sights in the serial register match this filter. `
      + `A sight must be loaded in the serial register (Rippel Matrix) before it can be accepted.`;
    if (countLabel) countLabel.textContent = '';
    if (loadMoreBtn) loadMoreBtn.style.display = 'none';
    return;
  }

  const pageSerials = pageUnits.map(u => u.unitSerial);
  const { data: existing, error: exErr } = await _withTimeout(
    supabaseClient.from(_fatpdiTable())
      .select('unit_serial,item_id,result,remarks,accepted,notes,country,inspected_by,inspected_at')
      .eq('card_type', fatpdi.cardType).in('unit_serial', pageSerials),
    20000, 'Loading saved acceptance');
  if (exErr) throw exErr;
  (existing || []).forEach(row => {
    const us = row.unit_serial;
    if (!fatpdi.results[us]) fatpdi.results[us] = {};
    if (row.item_id) fatpdi.results[us][row.item_id] = row.result;
    if (row.remarks) fatpdi.remarks[us] = row.remarks;
    if (row.notes) fatpdi.notes[us] = row.notes;
    if (row.accepted === true || row.accepted === false) {
      fatpdi.accept[us] = row.accepted ? 'YES' : 'NO';
      fatpdi.saved[us] = { accepted: row.accepted, by: row.inspected_by, at: row.inspected_at };
    }
    const u = fatpdi.units.find(x => x.unitSerial === us);
    if (u && row.country && !u.country) u.country = row.country;
  });

  _renderFatPdiGrid();
  if (countLabel) countLabel.textContent = `Showing ${fatpdi.units.length}${pageFull ? ' — more available' : ''} · ${Object.keys(fatpdi.saved).length} already decided on this page`;
  if (loadMoreBtn) {
    loadMoreBtn.style.display = pageFull ? 'block' : 'none';
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = `Load ${FATPDI_PAGE_SIZE} More`;
  }
}

function _setAccept(btn) {
  const unit = btn.dataset.unit, val = btn.dataset.val;
  fatpdi.accept[unit] = val;
  fatpdi.touched[unit] = true;
  btn.parentElement.querySelectorAll('.fatpdi-toggle').forEach(b => {
    b.classList.toggle('is-pass', b.dataset.val === 'YES' && val === 'YES');
    b.classList.toggle('is-fail', b.dataset.val === 'NO'  && val === 'NO');
  });
}
function _setFatPdiNotes(inp) { fatpdi.notes[inp.dataset.notesUnit] = inp.value; fatpdi.touched[inp.dataset.notesUnit] = true; }

// ── Render the grid: rows = units, columns = checklist items ───────────────
function _renderFatPdiGrid() {
  const items = FATPDI_TYPES[fatpdi.cardType][fatpdi.stage].items;
  const table = document.getElementById('fatpdi-grid');

  let html = '<thead><tr>';
  html += `<th style="position:sticky;left:0;background:var(--surface,#111f38);z-index:2;min-width:110px;">Serial</th>`;
  html += `<th style="min-width:80px;">Trolley/Pos</th>`;
  if (_isAcc()) html += `<th style="min-width:90px;">Country</th>`;
  items.forEach(it => { html += `<th style="min-width:120px;font-size:11px;">${it.label}</th>`; });
  html += `<th style="min-width:160px;">Remarks</th>`;
  if (_isAcc()) html += `<th style="min-width:110px;">Accept</th><th style="min-width:180px;">Notes</th>`;
  html += `</tr></thead><tbody>`;

  fatpdi.units.forEach(u => {
    const us = u.unitSerial;
    if (!fatpdi.results[us]) fatpdi.results[us] = {};
    html += `<tr>`;
    const savedAcc = _isAcc() ? fatpdi.saved[us] : null;
    const statusTag = (u.status !== 'COMPLETE'
      ? `<br><span style="font-size:9px;color:#e08f1a;">build ${u.status||'IN PROGRESS'}${fatpdi.adminPreview ? ' (preview)' : ''}</span>` : '')
      + (u.openFails ? `<br><span style="font-size:9px;color:#e03c3c;font-weight:700;">⚠ ${u.openFails} FAIL on build card</span>` : '')
      + (savedAcc ? `<br><span style="font-size:9px;font-weight:700;color:${savedAcc.accepted ? '#1a9e5c' : '#e03c3c'};">${savedAcc.accepted ? '✓ ACCEPTED' : '✗ NOT ACCEPTED'} · OP ${savedAcc.by || '?'} ${(savedAcc.at || '').slice(0,10)}</span>` : '');
    html += `<td style="position:sticky;left:0;background:var(--bg,#0a1628);font-family:var(--font-mono,monospace);font-weight:700;">${us}${u.sightSerial && u.launcherSerial ? `<br><span style="font-size:10px;color:var(--text-dim,#8fa3c0);">Sight ${u.sightSerial}</span>` : ''}${statusTag}</td>`;
    html += `<td style="font-size:12px;">${u.trolleyNumber||'—'} / ${u.trolleyPosition||'—'}</td>`;
    if (_isAcc()) html += `<td style="font-size:12px;">${u.country || '—'}</td>`;
    items.forEach(it => {
      const cur = fatpdi.results[us][it.id] || null;
      html += `<td style="text-align:center;">
        <button type="button" class="fatpdi-toggle ${cur==='PASS'?'is-pass':''}" data-unit="${us}" data-item="${it.id}" data-val="PASS" onclick="_setFatPdiResult(this)">P</button>
        <button type="button" class="fatpdi-toggle ${cur==='FAIL'?'is-fail':''}" data-unit="${us}" data-item="${it.id}" data-val="FAIL" onclick="_setFatPdiResult(this)">F</button>
      </td>`;
    });
    html += `<td><input type="text" data-remarks-unit="${us}" value="${(fatpdi.remarks[us]||'').replace(/"/g,'&quot;')}" style="width:100%;font-size:12px;" onchange="_setFatPdiRemarks(this)"></td>`;
    if (_isAcc()) {
      const acc = fatpdi.accept[us] || null;
      html += `<td style="text-align:center;white-space:nowrap;">
        <button type="button" class="fatpdi-toggle ${acc==='YES'?'is-pass':''}" style="width:44px;" data-unit="${us}" data-val="YES" onclick="_setAccept(this)">YES</button>
        <button type="button" class="fatpdi-toggle ${acc==='NO'?'is-fail':''}" style="width:44px;" data-unit="${us}" data-val="NO" onclick="_setAccept(this)">NO</button>
      </td>`;
      html += `<td><input type="text" data-notes-unit="${us}" value="${(fatpdi.notes[us]||'').replace(/"/g,'&quot;')}" placeholder="Notes" style="width:100%;font-size:12px;" onchange="_setFatPdiNotes(this)"></td>`;
    }
    html += `</tr>`;
  });
  html += '</tbody>';
  table.innerHTML = html;
}

function _setFatPdiResult(btn) {
  const unit = btn.dataset.unit, item = btn.dataset.item, val = btn.dataset.val;
  if (!fatpdi.results[unit]) fatpdi.results[unit] = {};
  fatpdi.results[unit][item] = val;
  fatpdi.touched[unit] = true;
  // Refresh just this row's two buttons
  const cell = btn.parentElement;
  cell.querySelectorAll('.fatpdi-toggle').forEach(b => {
    b.classList.toggle('is-pass', b.dataset.val==='PASS' && val==='PASS');
    b.classList.toggle('is-fail', b.dataset.val==='FAIL' && val==='FAIL');
  });
}

function _setFatPdiRemarks(inp) {
  fatpdi.remarks[inp.dataset.remarksUnit] = inp.value;
  fatpdi.touched[inp.dataset.remarksUnit] = true;
}

// ── Save all entered results for this stage+cardType ───────────────────────
async function saveFatPdi() {
  if (fatpdi.adminPreview) {
    showToast('🔓 Admin Preview mode — nothing is saved. Exit preview to record real results.', 'warn');
    return;
  }
  const rows = [];
  const cfg = _stageCfg();
  // 31/10/2026 — Final Acceptance rules (the paper form's ACCEPT YES / NO):
  //   YES needs every action marked PASS; NO needs a reason in Remarks or
  //   Notes. Checked before anything is written, per sight.
  if (_isAcc()) {
    for (const u of fatpdi.units) {
      const us = u.unitSerial, acc = fatpdi.accept[us];
      if (!acc) continue;
      const res = fatpdi.results[us] || {};
      if (acc === 'YES') {
        const notPassed = cfg.items.filter(it => res[it.id] !== 'PASS').map(it => it.label);
        if (notPassed.length) {
          showToast(`🚫 ${us}: ACCEPT YES needs every action PASS — ${notPassed.slice(0,2).join(', ')}${notPassed.length>2?' + more':''}`, 'error');
          return;
        }
      } else if (!(fatpdi.remarks[us] || fatpdi.notes[us] || '').trim()) {
        showToast(`🚫 ${us}: ACCEPT NO needs a reason in Remarks or Notes`, 'error');
        return;
      }
    }
  }
  fatpdi.units.forEach(u => {
    const us = u.unitSerial;
    // Acceptance stage: only the sights the operator actually changed are
    // written, so an already-accepted sight keeps its inspector and date.
    if (_isAcc() && !fatpdi.touched[us]) return;
    const itemResults = fatpdi.results[us] || {};
    const items = FATPDI_TYPES[fatpdi.cardType][fatpdi.stage].items;
    const accExtra = _isAcc() ? {
      accepted: fatpdi.accept[us] === 'YES' ? true : fatpdi.accept[us] === 'NO' ? false : null,
      notes: fatpdi.notes[us] || null,
      country: u.country || null,
      project: u.project || null,
      acceptance_spec: cfg.acceptanceSpec || null
    } : {};
    items.forEach(it => {
      const result = itemResults[it.id];
      if (!result) return; // skip untouched items — allows partial saves
      rows.push({
        ...accExtra,
        unit_serial: us,
        launcher_serial: u.launcherSerial,
        sight_serial: u.sightSerial,
        trolley_number: u.trolleyNumber,
        trolley_position: u.trolleyPosition,
        card_type: fatpdi.cardType,
        item_id: it.id,
        item_label: it.label,
        result: result,
        remarks: fatpdi.remarks[us] || null,
        inspected_by: state.operator,
        inspected_at: new Date().toISOString(),
        doc_code: fatpdi.docCode,
        updated_at: new Date().toISOString()
      });
    });
  });

  if (rows.length === 0) { showToast('Nothing entered yet', 'warn'); return; }

  const btn = document.getElementById('btn-fatpdi-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    const { error } = await supabaseClient.from(_fatpdiTable())
      .upsert(rows, { onConflict: 'unit_serial,card_type,item_id' });
    if (error) throw error;
    showToast(`✅ ${_isAcc() ? 'Acceptance' : fatpdi.stage} results saved (${rows.length} entries)`, 'ok');
    if (_isAcc()) {
      // show the decision stamps without a full reload
      fatpdi.units.forEach(u => {
        const a = fatpdi.accept[u.unitSerial];
        if (a && fatpdi.touched[u.unitSerial]) fatpdi.saved[u.unitSerial] = { accepted: a === 'YES', by: state.operator, at: new Date().toISOString() };
      });
      fatpdi.touched = {};
      _renderFatPdiGrid();
    }
  } catch (e) {
    console.error('[FAT/PDI] save error', e);
    showToast('❌ Save failed — ' + (e.message||e), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Save All'; }
  }
}
