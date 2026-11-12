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
  filterSearch: '',
  filterTrolley: '',    // v1.33: trolley number drop-down ('' = all trolleys)
  filterPos: '',        // v1.33: trolley position drop-down ('' = all positions)
  focus: null,          // v1.30: unit serial open in the single-unit view (FAT / PDI), null = list
  focusSnap: null,      // v1.30: its results/remarks when opened — Back without saving restores them
  resAt: {},            // v1.32: resAt[unitSerial][itemId] = inspected_at of the saved result
  addedCutoff: null,    // v1.32: first time an added item (Cylinder Alignment) was saved for this card type
  by: {},               // v1.35: by[unitSerial][itemId] = operator who saved that result
  busy: {},             // v1.35: busy[unitSerial] = [{op, since}] — who has the gun open right now
  _opening: false,      // v1.35: a unit is being opened (one tap = one open)
  _touchAt: 0           // v1.35: last "still working on it" stamp sent
};
const FP_BUSY_MINUTES = 30;   // v1.35: an open gun nobody touched for 30 min no longer shows as in progress

// ════════════════════════════════════════════════════════════════════════
// v1.32 (12/11/2026) — ITEMS ADDED TO A LIST LATER (added: true in config)
// FAT "Cylinder Alignment" was added on 12 Nov 2026. Gerhard: "going forward
// is fine, what is done is done" — a gun whose FAT was already complete on
// the old list stays complete. The moment the new item came into use is
// read from the database: the first time it was saved for this card type
// (nothing saved yet = not in use yet). A unit is "done on the old list" when
// every other item is saved and all of those were saved before that moment.
// Such a unit does not need the added item (it can still be marked);
// every other unit needs it like any other item.
// ════════════════════════════════════════════════════════════════════════
function _fpAddedIds(ct, stage) {
  return ((((FATPDI_TYPES[ct] || {})[stage] || {}).items) || []).filter(it => it.added).map(it => it.id);
}
async function _fpLoadAddedCutoff(ct, stage) {
  const ids = _fpAddedIds(ct, stage);
  if (!ids.length) return null;
  const { data, error } = await _withTimeout(
    supabaseClient.from(stage === 'FAT' ? 'weapon_fat_results' : 'weapon_pdi_results')
      .select('inspected_at').eq('card_type', ct).in('item_id', ids)
      .not('inspected_at', 'is', null).order('inspected_at', { ascending: true }).limit(1),
    15000, 'Reading the checklist history');
  if (error) throw error;
  return (data && data.length) ? data[0].inspected_at : null;     // null = added item never used yet
}
// items this unit must have: res = {itemId: result}, at = {itemId: inspected_at}
function _fpRequiredItems(ct, stage, res, at, cutoff) {
  const items = (((FATPDI_TYPES[ct] || {})[stage] || {}).items) || [];
  if (!items.some(it => it.added)) return items;
  const older = items.filter(it => !it.added);
  const cut = cutoff ? Date.parse(cutoff) : Infinity;
  const doneOnOldList = older.length > 0 && older.every(it => {
    if (!(res || {})[it.id]) return false;
    const t = Date.parse(((at || {})[it.id]) || '');
    return isNaN(t) || t < cut;          // a result with no time is an old one
  });
  return doneOnOldList ? older : items;
}

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
    // v1.35: only what this tablet changed is sent (app.js _flushChecks)
    if (typeof _flushChecks === 'function') _flushChecks();
    else supabaseClient.from('weapon_builds').update({ checks: state.checks }).eq('id', state.buildId).then(() => {});
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
  fatpdi.filterTrolley = '';
  fatpdi.filterPos = '';
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
  fatpdi.resAt = {};
  fatpdi.addedCutoff = null;
  // v1.35: a gun still open from before is released
  if (fatpdi.focus && fatpdi._focusStage) _fpRelease(fatpdi.focus, fatpdi._focusStage, fatpdi._focusType);
  fatpdi.by = {};
  fatpdi.busy = {};

  // 31/10/2026: an acceptance stage is named for what it is — the GRN40
  // "Final Acceptance Checklist" — not "FAT", so it is not confused with the
  // GRN40 build card.
  document.getElementById('fatpdi-stage-badge').textContent = stageCfg.acceptance ? 'ACCEPT' : stage;
  // v1.30: the screen carries the stage, so FAT and PDI each get their own colours
  const scr = document.getElementById('screen-fatpdi');
  if (scr) scr.dataset.fpStage = stageCfg.acceptance ? 'ACC' : stage;
  fatpdi.focus = null; fatpdi.focusSnap = null;
  _fpShowList();
  document.getElementById('fatpdi-title').textContent =
    stageCfg.acceptance ? `${stageCfg.title || 'Final Acceptance Checklist'} — ${typeCfg.label}` : `${stage} — ${typeCfg.label}`;
  const unitsHeading = document.getElementById('fatpdi-units-heading');
  if (unitsHeading) unitsHeading.textContent = stageCfg.acceptance ? 'Sights for Final Acceptance' : 'Units Ready for Inspection';
  document.getElementById('fatpdi-op').textContent = state.operator || '—';
  const searchInp = document.getElementById('fatpdi-filter-search');
  if (searchInp) searchInp.value = '';
  _fatpdiFillTrolleys();
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

// v1.33 (12/11/2026): Trolley No + Trolley Position drop-downs — the same
// Trolley 1–20 / Pos 1–56 lists as the build card (populateTrolley), so the
// floor picks the gun in front of them
function _fatpdiFillTrolleys() {
  const sel = document.getElementById('fatpdi-filter-trolley');
  if (sel) {
    let html = '<option value="">All Trolleys</option>';
    for (let i = 1; i <= 20; i++) html += `<option value="${i}">Trolley ${i}</option>`;
    sel.innerHTML = html; sel.value = '';
  }
  const pos = document.getElementById('fatpdi-filter-pos');
  if (pos) {
    let html = '<option value="">All Positions</option>';
    for (let i = 1; i <= 56; i++) html += `<option value="${i}">Pos ${i}</option>`;
    pos.innerHTML = html; pos.value = '';
  }
}

function _fatpdiApplyFilter() {
  fatpdi.focus = null; fatpdi.focusSnap = null; _fpShowList();
  fatpdi.filterContract = document.getElementById('fatpdi-filter-contract').value;
  const tSel = document.getElementById('fatpdi-filter-trolley');
  fatpdi.filterTrolley = tSel ? tSel.value : '';
  const pSel = document.getElementById('fatpdi-filter-pos');
  fatpdi.filterPos = pSel ? pSel.value : '';
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
    if (fatpdi.filterTrolley) q = q.eq('trolley_number', parseInt(fatpdi.filterTrolley, 10));
    if (fatpdi.filterPos) q = q.eq('trolley_position', parseInt(fatpdi.filterPos, 10));
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
          .select('unit_serial,item_id,result,remarks,inspected_by,inspected_at')
          .eq('card_type', fatpdi.cardType).in('unit_serial', pageSerials),
        20000, 'Loading saved results');
      if (exErr) throw exErr;
      (existing || []).forEach(_fpTakeRow);
      await _fpLoadBusy(pageSerials);   // v1.35: who has a gun open right now
      // v1.32: when did the added item(s) come into use (once per opening)
      if (reset && _fpAddedIds(fatpdi.cardType, fatpdi.stage).length) {
        try { fatpdi.addedCutoff = await _fpLoadAddedCutoff(fatpdi.cardType, fatpdi.stage); }
        catch (e) { console.warn('[FAT/PDI] added-item cutoff', e); fatpdi.addedCutoff = null; }
      }
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
  if (fatpdi.filterTrolley) q = q.eq('trolley_number', parseInt(fatpdi.filterTrolley, 10));
  if (fatpdi.filterPos) q = q.eq('trolley_position', parseInt(fatpdi.filterPos, 10));
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
  const rf = document.getElementById('btn-fatpdi-refresh');   // v1.35: FAT / PDI list only
  if (rf) rf.style.display = _isAcc() ? 'none' : '';
  if (!_isAcc()) { _renderFatPdiList(); return; }   // v1.30: FAT / PDI = pick a unit, then one at a time
  const saveAll = document.getElementById('btn-fatpdi-save');
  if (saveAll) saveAll.style.display = '';            // the acceptance grid keeps its Save All
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

// ════════════════════════════════════════════════════════════════════════
// v1.30 (11/11/2026) — FAT and PDI: ONE UNIT AT A TIME
// The list shows each unit with its progress; tapping it opens that gun on
// its own, its items as vertical PASS / FAIL cards like the Checks page but
// in the stage's own colours (FAT blue, PDI violet — set in index.html).
// Save writes that one unit and goes straight back to the list.
// The GRN40 Final Acceptance Checklist keeps its own grid (unchanged).
// ════════════════════════════════════════════════════════════════════════
function _fpEsc(t) { return String(t == null ? '' : t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _fpItems() { return FATPDI_TYPES[fatpdi.cardType][fatpdi.stage].items; }
function _fpProgress(us) {
  const res = fatpdi.results[us] || {};
  // v1.32: a gun done on the old list does not need the added item
  const items = _fpRequiredItems(fatpdi.cardType, fatpdi.stage, res, fatpdi.resAt[us], fatpdi.addedCutoff);
  const done = items.filter(it => res[it.id]).length;
  const fails = _fpItems().filter(it => res[it.id] === 'FAIL').length;
  return { done, total: items.length, fails };
}
function _fpShowList() {
  const lv = document.getElementById('fatpdi-list-view'), uv = document.getElementById('fatpdi-unit-view');
  if (lv) lv.style.display = '';
  if (uv) { uv.style.display = 'none'; uv.innerHTML = ''; }
}

function _renderFatPdiList() {
  const table = document.getElementById('fatpdi-grid');
  let html = '<thead><tr>'
    + '<th style="min-width:120px;">Serial</th>'
    + '<th style="min-width:80px;">Trolley/Pos</th>'
    + `<th style="min-width:110px;">${fatpdi.stage} progress</th>`
    + '<th style="width:1%;"></th>'
    + '</tr></thead><tbody>';
  fatpdi.units.forEach(u => {
    const us = u.unitSerial, p = _fpProgress(us);
    const tag = (u.status !== 'COMPLETE'
        ? `<br><span style="font-size:9px;color:#e08f1a;">build ${_fpEsc(u.status||'IN PROGRESS')}${fatpdi.adminPreview ? ' (preview)' : ''}</span>` : '')
      + (u.openFails ? `<br><span style="font-size:9px;color:#e03c3c;font-weight:700;">⚠ ${u.openFails} FAIL on build card</span>` : '');
    const prog = p.done === 0 ? '<span class="fp-prog" style="color:var(--text-dim,#8fa3c0);">Not started</span>'
      : p.fails ? `<span class="fp-prog" style="color:#d93025;">${p.done}/${p.total} · ${p.fails} FAIL</span>`
      : p.done === p.total ? '<span class="fp-prog" style="color:#1a9e5c;">✓ Completed — all PASS</span>'
      : `<span class="fp-prog" style="color:#e08f1a;">${p.done}/${p.total}</span>`;
    // v1.35: who did it, and who has it open right now
    const who = _fpWho(us);
    const whoTag = (p.done && who) ? `<br><span class="fp-who">by ${_fpEsc(who)}</span>` : '';
    const busy = fatpdi.busy[us] || [];
    const busyTag = busy.length
      ? `<br><span class="fp-busy">🔒 In progress: ${busy.map(b => String(b.op) === String(state.operator) ? 'you' : 'OP ' + _fpEsc(b.op)).join(', ')}</span>` : '';
    const signedTag = (fatpdi.stage === 'PDI' && u.status === 'COMPLETE')
      ? '<br><span class="fp-prog" style="color:#1a9e5c;font-size:10px;">🖊 SIGNED OFF</span>' : '';
    html += `<tr class="fp-list-row" data-unit="${_fpEsc(us)}" onclick="openFatPdiUnit(this.dataset.unit)">`
      + `<td style="font-family:var(--font-mono,monospace);font-weight:700;">${_fpEsc(us)}${u.sightSerial && u.launcherSerial ? `<br><span style="font-size:10px;color:var(--text-dim,#8fa3c0);">Sight ${_fpEsc(u.sightSerial)}</span>` : ''}${tag}</td>`
      + `<td style="font-size:12px;">${u.trolleyNumber||'—'} / ${u.trolleyPosition||'—'}</td>`
      + `<td>${prog}${whoTag}${busyTag}${signedTag}</td>`
      + `<td><button type="button" class="fp-open">Open ›</button></td>`
      + '</tr>';
  });
  html += '</tbody>';
  table.innerHTML = html;
  // the list has nothing to save — saving happens per unit
  const saveAll = document.getElementById('btn-fatpdi-save');
  if (saveAll) saveAll.style.display = 'none';
}

async function openFatPdiUnit(us) {
  const u = fatpdi.units.find(x => x.unitSerial === us);
  if (!u || fatpdi._opening) return;
  // v1.35: never open a gun on what this tablet remembers — read it now, so
  // results saved on another tablet show (and nobody redoes / overwrites them)
  if (!_isAcc()) {
    fatpdi._opening = true;
    try {
      try { await _fpReadFresh([us], true); }
      catch (e) { showToast(`⚠ Could not read the latest for ${us} — check Wi-Fi. Showing what was loaded before.`, 'warn'); }
      const others = (fatpdi.busy[us] || []).filter(b => String(b.op) !== String(state.operator));
      if (others.length && !fatpdi.adminPreview) {
        const who = others.map(b => `OP ${b.op} (since ${_fpTime(b.since)})`).join(', ');
        if (!confirm(`🔒 ${us} is open on another tablet: ${who}.\n\n` +
                     `More than one person may work on a gun — each save keeps the items the other person saved.\n\n` +
                     `Open it and work on it too?`)) {
          _renderFatPdiList();
          return;
        }
      }
      if (!fatpdi.adminPreview) _fpClaim(us);
    } finally { fatpdi._opening = false; }
  }
  fatpdi.focus = us;
  fatpdi._focusStage = fatpdi.stage; fatpdi._focusType = fatpdi.cardType;
  fatpdi.focusSnap = { results: { ...(fatpdi.results[us] || {}) }, remarks: fatpdi.remarks[us] || '' };
  _renderFatPdiUnit();
  const lv = document.getElementById('fatpdi-list-view'), uv = document.getElementById('fatpdi-unit-view');
  if (lv) lv.style.display = 'none';
  if (uv) uv.style.display = '';
  window.scrollTo(0, 0);
}

function _renderFatPdiUnit() {
  const us = fatpdi.focus, uv = document.getElementById('fatpdi-unit-view');
  const u = fatpdi.units.find(x => x.unitSerial === us);
  if (!uv || !u) return;
  const items = _fpItems(), res = fatpdi.results[us] || {};
  // v1.32: an added item this gun does not need (done on the old list) says so
  const reqIds = new Set(_fpRequiredItems(fatpdi.cardType, fatpdi.stage, res, fatpdi.resAt[us], fatpdi.addedCutoff).map(it => it.id));
  const stageName = fatpdi.stage === 'FAT' ? 'FAT · FACTORY ACCEPTANCE TEST' : 'PDI · PRE-DELIVERY INSPECTION';
  let html = `<div class="fp-band">
      <div class="fp-stage">${stageName} · ${_fpEsc(fatpdi.docCode || '')}</div>
      <div class="fp-serial">${_fpEsc(us)}</div>
      <div class="fp-meta">Trolley ${u.trolleyNumber||'—'} · Pos ${u.trolleyPosition||'—'}${u.sightSerial && u.launcherSerial ? ` · Sight ${_fpEsc(u.sightSerial)}` : ''}${u.status !== 'COMPLETE' ? ` · build ${_fpEsc(u.status||'IN PROGRESS')}` : ''}${fatpdi.adminPreview ? ' · ADMIN PREVIEW (not saved)' : ''}</div>
      ${_fpBandStatus(us)}
    </div>
    <div id="fp-unit-count" style="font-size:12px;color:var(--text-dim,#8fa3c0);margin:0 0 8px 2px;"></div>`;
  items.forEach((it, i) => {
    const cur = res[it.id] || '';
    html += `<div class="fp-row" data-item="${_fpEsc(it.id)}" data-result="${cur}">
        <span class="fp-label"><span class="fp-no">${String(i + 1).padStart(2, '0')}</span>${_fpEsc(it.label)}${it.added && !reqIds.has(it.id) ? '<br><span style="font-size:10px;font-weight:400;opacity:0.75;">not needed on this gun — FAT done before this item was added</span>' : ''}${_fpSavedLine(us, it.id)}</span>
        <div class="fp-btns">
          <button type="button" class="fp-btn pass ${cur==='PASS'?'selected':''}" data-item="${_fpEsc(it.id)}" data-val="PASS" onclick="_fpSet(this)">PASS</button>
          <button type="button" class="fp-btn fail ${cur==='FAIL'?'selected':''}" data-item="${_fpEsc(it.id)}" data-val="FAIL" onclick="_fpSet(this)">FAIL</button>
        </div>
      </div>`;
  });
  html += `<div class="field-group" style="margin-top:6px;">
      <label>Remarks</label>
      <textarea id="fp-remarks" class="fp-remarks" oninput="_fpRemarks(this)">${_fpEsc(fatpdi.remarks[us] || '')}</textarea>
    </div>
    <div class="fp-actions">
      <button class="btn btn-primary fp-save" id="btn-fp-save-unit" onclick="saveFatPdiUnit()">💾 Save ${_fpEsc(us)}</button>
      <button class="btn btn-secondary" onclick="closeFatPdiUnit()">← Back to list (don't save)</button>
    </div>`;
  // v1.31: the final sign-off lives on the PDI page only
  if (fatpdi.stage === 'PDI') html += `<div class="fp-final" id="fp-final"><h3>🖊 FINAL SIGN-OFF</h3>
      <div id="fp-final-list" style="font-size:12px;color:var(--text-dim,#8fa3c0);">Checking the card…</div>
      <button class="btn fp-signoff" id="btn-fp-signoff" disabled onclick="signOffFromPdi()">🖊 Sign Off ${_fpEsc(us)}</button>
    </div>`;
  uv.innerHTML = html;
  _fpUpdateCount();
  if (fatpdi.stage === 'PDI') _fpRefreshFinal(true);
}

// ════════════════════════════════════════════════════════════════════════
// v1.31 (11/11/2026) — FINAL SIGN-OFF ON THE PDI PAGE
// The gun is only ready for shipping when PDI is done, so the sign-off that
// marks the build card COMPLETE moved here (it was a button on Checks that
// the floor never pressed). The button stays locked until EVERYTHING is in:
//   1. every identity field of the card filled in
//   2. every assembly check recorded (measurement values filled), no FAIL
//   3. every FAT item PASS (saved)
//   4. every PDI item PASS (on screen; saved as part of signing off)
// Pressing it re-reads all of that from the database first, then marks the
// card COMPLETE with the PDI operator and time, and the serial COMPLETE.
// ════════════════════════════════════════════════════════════════════════
const _FP_REQUIRED_FIELDS = {
  RLL: [['contract_name','Contract'],['client_country','Country'],['year_of_manufacture','Year'],
        ['trolley_number','Trolley'],['trolley_position','Position'],['launcher_serial','Launcher serial'],
        ['barrel_no','Barrel no'],['barrel_production_no','Barrel prod no'],['cylinder_no','Cylinder no'],
        ['cylinder_production_no','Cylinder prod no'],['hrc_serial_no','HRC serial'],
        ['firing_mech_no','Firing mech no'],['hfm_serial_no','HFM serial']],
  XRGL40: [['contract_name','Contract'],['client_country','Country'],['year_of_manufacture','Year'],
        ['trolley_number','Trolley'],['trolley_position','Position'],['launcher_serial','Launcher serial'],
        ['sight_serial','Sight serial'],['barrel_no','Barrel no'],['barrel_production_no','Barrel prod no'],
        ['cylinder_no','Cylinder no'],['cylinder_production_no','Cylinder prod no'],['hrc_serial_no','HRC serial'],
        ['hrc_prod_no','HRC prod no'],['firing_mech_no','Firing mech no'],['hfm_serial_no','HFM serial'],
        ['hfm_prod_no','HFM prod no']],
  GRN40: [['contract_name','Contract'],['client_country','Country'],['year_of_manufacture','Year'],
        ['sight_serial','Sight serial']],
};

async function _fpLoadForSignoff(us) {
  const col = fatpdi.cardType === 'GRN40' ? 'sight_serial' : 'launcher_serial';
  const [b, f] = await Promise.all([
    _withTimeout(supabaseClient.from('weapon_builds').select('*')
      .eq('card_type', fatpdi.cardType).eq(col, us).limit(1), 15000, 'Reading the build card'),
    _withTimeout(supabaseClient.from('weapon_fat_results').select('item_id,result,inspected_at')
      .eq('card_type', fatpdi.cardType).eq('unit_serial', us), 15000, 'Reading FAT results')
  ]);
  if (b.error) throw b.error;
  if (f.error) throw f.error;
  const fatCutoff = await _fpLoadAddedCutoff(fatpdi.cardType, 'FAT');   // v1.32
  return { build: (b.data || [])[0] || null, fat: f.data || [], fatCutoff };
}

// -> [{label, ok, why}]
function _fpFinalChecks(build, fatRows, pdiResults, fatCutoff) {
  const ct = fatpdi.cardType, out = [];
  // 1. identity
  const missing = (_FP_REQUIRED_FIELDS[ct] || []).filter(([k]) => build == null ||
                   build[k] === null || build[k] === undefined || String(build[k]).trim() === '').map(([, l]) => l);
  out.push({ label: 'Identity — all fields filled in', ok: !!build && missing.length === 0,
             why: !build ? 'no build card found' : missing.length ? 'missing: ' + missing.join(', ') : '' });
  // 2. assembly checks
  const cfg = (typeof CARD_TYPES !== 'undefined' && CARD_TYPES[ct]) || {};
  const defs = cfg.checks || cfg.stages || [];
  const checks = (build && build.checks) || {};
  const notDone = [], noValue = [], failed = [];
  defs.forEach(c => {
    const d = checks[c.id] || {};
    if (!d.result) notDone.push(c.label);
    else if (['FAIL', 'NO-GO'].includes(d.result)) failed.push(c.label);
    else if (c.type === 'measurement' && !d.value) noValue.push(c.label);
  });
  out.push({ label: `Assembly checks — ${defs.length - notDone.length}/${defs.length} recorded`,
             ok: !!build && defs.length > 0 && !notDone.length && !noValue.length && !failed.length,
             why: [failed.length ? `${failed.length} FAIL: ${failed.slice(0,2).join(', ')}${failed.length>2?' …':''}` : '',
                   notDone.length ? `${notDone.length} not recorded: ${notDone.slice(0,2).join(', ')}${notDone.length>2?' …':''}` : '',
                   noValue.length ? `value missing: ${noValue.slice(0,2).join(', ')}${noValue.length>2?' …':''}` : '']
                  .filter(Boolean).join(' · ') });
  // 3. FAT
  const fatRes = {}, fatAt = {};
  (fatRows || []).forEach(r => { fatRes[r.item_id] = r.result; fatAt[r.item_id] = r.inspected_at || null; });
  // v1.32: a gun done on the old FAT list does not need the added item
  const fatItems = _fpRequiredItems(ct, 'FAT', fatRes, fatAt, fatCutoff);
  const fatPass = fatItems.filter(it => fatRes[it.id] === 'PASS').length;
  const fatFail = fatItems.filter(it => fatRes[it.id] === 'FAIL').length;
  out.push({ label: `FAT — ${fatPass}/${fatItems.length} PASS`, ok: fatItems.length > 0 && fatPass === fatItems.length,
             why: fatFail ? `${fatFail} FAIL on FAT` : fatPass < fatItems.length ? `${fatItems.length - fatPass} FAT item(s) not done` : '' });
  // 4. PDI (what is on screen now)
  const pdiItems = _fpItems();
  const pdiPass = pdiItems.filter(it => (pdiResults || {})[it.id] === 'PASS').length;
  const pdiFail = pdiItems.filter(it => (pdiResults || {})[it.id] === 'FAIL').length;
  out.push({ label: `PDI — ${pdiPass}/${pdiItems.length} PASS`, ok: pdiPass === pdiItems.length,
             why: pdiFail ? `${pdiFail} FAIL on PDI` : pdiPass < pdiItems.length ? `${pdiItems.length - pdiPass} PDI item(s) still to mark` : '' });
  return out;
}

function _fpRenderFinal(list, signed) {
  const el = document.getElementById('fp-final-list'), btn = document.getElementById('btn-fp-signoff');
  if (!el || !btn) return;
  if (signed) {
    el.innerHTML = `<div class="fp-req"><span class="ok">✓</span><span><b>Signed off</b> — OP ${_fpEsc(signed.by || '?')} · ${_fpEsc(String(signed.at || '').slice(0,16).replace('T',' '))}</span></div>`;
    btn.disabled = true; btn.textContent = '✓ Signed off';
    return;
  }
  el.innerHTML = list.map(r => `<div class="fp-req"><span class="${r.ok ? 'ok' : 'no'}">${r.ok ? '✓' : '✗'}</span>
      <span>${_fpEsc(r.label)}${!r.ok && r.why ? `<br><span class="why">${_fpEsc(r.why)}</span>` : ''}</span></div>`).join('');
  const all = list.length && list.every(r => r.ok);
  btn.disabled = !all || fatpdi.adminPreview;
  btn.title = fatpdi.adminPreview ? 'Admin Preview — nothing is saved' : (all ? '' : 'Everything above must be ✓ first');
}

async function _fpRefreshFinal(reload) {
  const us = fatpdi.focus; if (!us || fatpdi.stage !== 'PDI') return;
  try {
    if (reload || !fatpdi._final || fatpdi._final.us !== us) {
      const d = await _fpLoadForSignoff(us);
      fatpdi._final = { us, build: d.build, fat: d.fat, fatCutoff: d.fatCutoff };
    }
    if (fatpdi.focus !== us) return;
    const b = fatpdi._final.build;
    if (b && String(b.status || '').toUpperCase() === 'COMPLETE' && b.completed_at) {
      _fpRenderFinal(null, { by: b.qa_operator, at: b.completed_at }); return;
    }
    _fpRenderFinal(_fpFinalChecks(b, fatpdi._final.fat, fatpdi.results[us], fatpdi._final.fatCutoff));
  } catch (e) {
    const el = document.getElementById('fp-final-list'), btn = document.getElementById('btn-fp-signoff');
    if (el) el.textContent = '⚠ Could not check the card — ' + ((e && e.message) || e);
    if (btn) btn.disabled = true;
  }
}

async function signOffFromPdi() {
  const us = fatpdi.focus; if (!us) return;
  if (fatpdi.adminPreview) { showToast('🔓 Admin Preview — nothing is saved', 'warn'); return; }
  const op = String(state.operator || '').trim();
  if (!op) { showToast('Log in first — the sign-off is recorded against your operator number', 'error'); return; }
  const btn = document.getElementById('btn-fp-signoff');
  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    // fresh from the database — never sign off on what the screen remembers
    const d = await _fpLoadForSignoff(us);
    fatpdi._final = { us, build: d.build, fat: d.fat, fatCutoff: d.fatCutoff };
    const list = _fpFinalChecks(d.build, d.fat, fatpdi.results[us], d.fatCutoff);
    if (!list.every(r => r.ok)) {
      _fpRenderFinal(list);
      showToast('🚫 Not everything is complete — see the list', 'error');
      return;
    }
    if (!confirm(`FINAL SIGN-OFF\n\n${us}\nIdentity, assembly checks, FAT and PDI are all complete.\n\nSign off as OP ${op} — ready for shipping?`)) {
      _fpRenderFinal(list); return;
    }
    // PDI marks on screen not saved yet → save them first
    if (_fpChanged()) {
      const saved = await saveFatPdi(us);
      if (!saved) { _fpRenderFinal(list); return; }
      fatpdi.focusSnap = { results: { ...(fatpdi.results[us] || {}) }, remarks: fatpdi.remarks[us] || '' };
    }
    const now = new Date().toISOString();
    const { error } = await supabaseClient.from('weapon_builds').update({
      status: 'COMPLETE', qa_operator: op, completed_at: now, checks_complete: true, updated_at: now
    }).eq('id', d.build.id);
    if (error) throw error;
    await supabaseClient.from('weapon_serials').update({ status: 'COMPLETE' }).eq('serial_number', us);
    try {
      await supabaseClient.from('weapon_build_sessions').insert({
        launcher_serial: us, operator_number: op, action: 'PDI_SIGNOFF',
        fields_updated: JSON.stringify({ signed_off_by: op, signed_off_at: now, stage: 'PDI', card_type: fatpdi.cardType })
      });
    } catch (e) { console.warn('[Sign-off] log failed', e); }
    const u = fatpdi.units.find(x => x.unitSerial === us); if (u) u.status = 'COMPLETE';
    showToast(`✅ ${us} signed off — ready for shipping`, 'ok');
    closeFatPdiUnit(true);
  } catch (e) {
    console.error('[Sign-off] error', e);
    showToast('❌ Sign-off failed — ' + ((e && e.message) || e), 'error');
    _fpRefreshFinal(false);
  } finally {
    if (btn && btn.isConnected && btn.textContent === 'Checking…') btn.textContent = `🖊 Sign Off ${us}`;
  }
}

function _fpUpdateCount() {
  const el = document.getElementById('fp-unit-count');
  if (!el || !fatpdi.focus) return;
  const p = _fpProgress(fatpdi.focus);
  el.textContent = `${p.done} of ${p.total} marked${p.fails ? ` · ${p.fails} FAIL` : ''}`;
}

function _fpSet(btn) {
  const us = fatpdi.focus; if (!us) return;
  const item = btn.dataset.item, val = btn.dataset.val;
  if (!fatpdi.results[us]) fatpdi.results[us] = {};
  fatpdi.results[us][item] = val;
  fatpdi.touched[us] = true;
  _fpTouch(us);   // v1.35: still working on it
  const row = btn.closest('.fp-row');
  if (row) {
    row.dataset.result = val;
    row.querySelectorAll('.fp-btn').forEach(b => b.classList.toggle('selected', b.dataset.val === val));
  }
  _fpUpdateCount();
  if (fatpdi.stage === 'PDI' && fatpdi._final && fatpdi._final.us === us) _fpRefreshFinal(false);
}
function _fpRemarks(ta) {
  if (!fatpdi.focus) return;
  fatpdi.remarks[fatpdi.focus] = ta.value;
  fatpdi.touched[fatpdi.focus] = true;
  _fpTouch(fatpdi.focus);   // v1.35
}

function _fpChanged() {
  const us = fatpdi.focus, snap = fatpdi.focusSnap;
  if (!us || !snap) return false;
  const now = fatpdi.results[us] || {};
  const keys = new Set([...Object.keys(now), ...Object.keys(snap.results)]);
  for (const k of keys) if ((now[k] || '') !== (snap.results[k] || '')) return true;
  return (fatpdi.remarks[us] || '') !== (snap.remarks || '');
}

function closeFatPdiUnit(skipAsk) {
  const us = fatpdi.focus;
  if (us && !skipAsk && _fpChanged()) {
    if (!confirm(`${us}: what you marked has NOT been saved.\n\nGo back to the list and discard it?`)) return;
    // put back what the unit had when it was opened
    fatpdi.results[us] = { ...fatpdi.focusSnap.results };
    if (fatpdi.focusSnap.remarks) fatpdi.remarks[us] = fatpdi.focusSnap.remarks; else delete fatpdi.remarks[us];
  }
  const st = fatpdi._focusStage, ct = fatpdi._focusType;
  fatpdi.focus = null; fatpdi.focusSnap = null; fatpdi._focusStage = null; fatpdi._focusType = null;
  _fpShowList();
  _renderFatPdiList();
  if (us) {
    const row = [...document.querySelectorAll('#fatpdi-grid tr[data-unit]')].find(r => r.dataset.unit === us);
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
  }
  // v1.35: let the others see it is free, and show what they did meanwhile
  if (us && st && !_isAcc()) {
    _fpRelease(us, st, ct).then(() => _fpRefreshList());
  }
}

async function saveFatPdiUnit() {
  const us = fatpdi.focus; if (!us) return;
  const p = _fpProgress(us);
  if (p.done === 0) { showToast('Nothing marked yet on ' + us, 'warn'); return; }
  if (p.done < p.total &&
      !confirm(`${us}: only ${p.done} of ${p.total} items are marked.\n\nSave what is marked now and finish the rest later?`)) return;
  const ok = await saveFatPdi(us);
  if (ok) closeFatPdiUnit(true);
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

// ════════════════════════════════════════════════════════════════════════
// v1.35 (12/11/2026) — SEVERAL PEOPLE ON ONE GUN (floor feedback)
// Two people on FAT finished a gun; the second did not see it was complete
// and his save overwrote the first. Also: a save re-wrote EVERY item on the
// gun, so items done by someone else got this operator's name and time.
// Now:
//   • a gun is read fresh from the database when it is opened, and every
//     saved item shows who did it and when;
//   • the list shows 🔒 In progress: OP …  (who has the gun open, from
//     fatpdi_activity — cleared on Save / Back, or after 30 min untouched),
//     ✓ Completed, and who did the work. Someone else can still open it
//     (asked first) — more than one person may work on a gun;
//   • Save writes only the items changed on this tablet. Just before saving
//     it reads the gun again; an item someone else saved differently in the
//     meantime is shown and nothing is overwritten unless the operator says so;
//   • the list refreshes on Back / Save, on ↻ Refresh, and every minute.
// GRN40 Final Acceptance keeps its own grid (unchanged).
// ════════════════════════════════════════════════════════════════════════
function _fpTime(iso) {
  const d = new Date(iso || '');
  if (isNaN(d)) return '?';
  return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short' }) + ' '
       + d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function _fpTakeRow(row) {
  const us = row.unit_serial;
  if (!fatpdi.results[us]) fatpdi.results[us] = {};
  fatpdi.results[us][row.item_id] = row.result;
  if (!fatpdi.resAt[us]) fatpdi.resAt[us] = {};
  fatpdi.resAt[us][row.item_id] = row.inspected_at || null;
  if (!fatpdi.by[us]) fatpdi.by[us] = {};
  fatpdi.by[us][row.item_id] = row.inspected_by || null;
  if (row.remarks) fatpdi.remarks[us] = row.remarks;
}
// operators who saved items on this gun, e.g. "OP 022, OP 030"
function _fpWho(us) {
  const ops = [...new Set(Object.values(fatpdi.by[us] || {}).filter(Boolean).map(String))];
  return ops.map(o => 'OP ' + o).join(', ');
}
function _fpSavedLine(us, itemId) {
  const snap = (fatpdi.focusSnap && fatpdi.focusSnap.results) || {};
  const res = snap[itemId];
  if (!res) return '';
  const by = (fatpdi.by[us] || {})[itemId], at = (fatpdi.resAt[us] || {})[itemId];
  return `<br><span class="fp-saved">saved ${_fpEsc(res)} · ${by ? 'OP ' + _fpEsc(by) : 'OP ?'}${at ? ' · ' + _fpEsc(_fpTime(at)) : ''}</span>`;
}
function _fpBandStatus(us) {
  const out = [];
  const p = _fpProgress(us), snap = (fatpdi.focusSnap && fatpdi.focusSnap.results) || {};
  const savedDone = _fpRequiredItems(fatpdi.cardType, fatpdi.stage, snap, fatpdi.resAt[us], fatpdi.addedCutoff)
                      .filter(it => snap[it.id] === 'PASS').length;
  if (p.total && savedDone === p.total) out.push('✓ Completed — all PASS');
  const who = _fpWho(us); if (who) out.push('Done by ' + who);
  const others = (fatpdi.busy[us] || []).filter(b => String(b.op) !== String(state.operator));
  if (others.length) out.push('🔒 Also open on: ' + others.map(b => 'OP ' + b.op).join(', '));
  return out.length ? `<div class="fp-meta" style="font-weight:700;">${_fpEsc(out.join(' · '))}</div>` : '';
}

// results + who-is-busy for these guns, straight from the database.
// forOpen = reading the gun that is being opened (anything else skips the
// gun open on screen, so a refresh never touches unsaved marks).
async function _fpReadFresh(serials, forOpen) {
  if (_isAcc() || !serials.length) return;
  for (let i = 0; i < serials.length; i += 100) {
    const part = serials.slice(i, i + 100);
    const { data, error } = await _withTimeout(
      supabaseClient.from(_fatpdiTable())
        .select('unit_serial,item_id,result,remarks,inspected_by,inspected_at')
        .eq('card_type', fatpdi.cardType).in('unit_serial', part),
      20000, 'Reading the latest results');
    if (error) throw error;
    const keep = forOpen ? null : fatpdi.focus;
    part.forEach(us => {
      if (us === keep) return;
      delete fatpdi.results[us]; delete fatpdi.resAt[us]; delete fatpdi.by[us]; delete fatpdi.remarks[us];
    });
    (data || []).forEach(r => { if (r.unit_serial !== keep) _fpTakeRow(r); });
  }
  await _fpLoadBusy(serials);
}
async function _fpLoadBusy(serials) {
  if (_isAcc() || !serials.length) return;
  const since = new Date(Date.now() - FP_BUSY_MINUTES * 60000).toISOString();
  try {
    for (let i = 0; i < serials.length; i += 100) {
      const part = serials.slice(i, i + 100);
      const { data, error } = await _withTimeout(
        supabaseClient.from('fatpdi_activity')
          .select('unit_serial,operator_number,started_at,last_seen')
          .eq('stage', fatpdi.stage).eq('card_type', fatpdi.cardType)
          .in('unit_serial', part).gte('last_seen', since),
        10000, 'Reading who is busy');
      if (error) throw error;
      part.forEach(us => { delete fatpdi.busy[us]; });
      (data || []).forEach(r => {
        (fatpdi.busy[r.unit_serial] = fatpdi.busy[r.unit_serial] || []).push({ op: r.operator_number, since: r.started_at });
      });
    }
  } catch (e) { console.warn('[FAT/PDI] in-progress list not read', e); }   // never stops the page
}
function _fpClaimRow(us, stage, ct) {
  return { stage: stage || fatpdi.stage, card_type: ct || fatpdi.cardType, unit_serial: us,
           operator_number: String(state.operator || '?'), last_seen: new Date().toISOString() };
}
function _fpClaim(us) {
  fatpdi._touchAt = Date.now();
  // best effort — the in-progress tag must never stop anybody working
  return (async () => {
    try {
      const r = await supabaseClient.from('fatpdi_activity')
        .upsert(_fpClaimRow(us), { onConflict: 'stage,card_type,unit_serial,operator_number' });
      if (r && r.error) console.warn('[FAT/PDI] claim', r.error);
    } catch (e) { console.warn('[FAT/PDI] claim', e); }
  })();
}
// still working on it — at most once a minute
function _fpTouch(us) {
  if (!us || fatpdi.adminPreview || _isAcc()) return;
  if (Date.now() - (fatpdi._touchAt || 0) < 60000) return;
  _fpClaim(us);
}
function _fpRelease(us, stage, ct) {
  if (!us) return Promise.resolve();
  return (async () => {
    try {
      const r = await supabaseClient.from('fatpdi_activity').delete()
        .eq('stage', stage || fatpdi.stage).eq('card_type', ct || fatpdi.cardType)
        .eq('unit_serial', us).eq('operator_number', String(state.operator || '?'));
      if (r && r.error) console.warn('[FAT/PDI] release', r.error);
    } catch (e) { console.warn('[FAT/PDI] release', e); }
  })();
}
// the list, read again (Back / Save / ↻ Refresh / every minute)
async function _fpRefreshList(btn) {
  if (_isAcc() || fatpdi.focus || !fatpdi.units.length) return;
  const txt = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
  try {
    await _fpReadFresh(fatpdi.units.map(u => u.unitSerial), false);
    if (!fatpdi.focus) _renderFatPdiList();
  } catch (e) {
    if (btn) showToast('⚠ Could not refresh — ' + ((e && e.message) || e), 'warn');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = txt; }
  }
}
setInterval(() => {
  const scr = typeof document !== 'undefined' && document.getElementById('screen-fatpdi');
  if (scr && scr.classList.contains('active') && !fatpdi.focus && !fatpdi._opening && fatpdi.stage) _fpRefreshList();
}, 60000);

// Save ONE gun: only the items changed on this tablet; read the gun first
// and stop if someone else saved a different result on one of them.
async function _fpSaveUnitSafe(us) {
  const u = fatpdi.units.find(x => x.unitSerial === us);
  if (!u) return false;
  const snap = fatpdi.focusSnap || { results: {}, remarks: '' };
  const mine = fatpdi.results[us] || (fatpdi.results[us] = {});
  const items = _fpItems();
  let changed = items.filter(it => mine[it.id] && mine[it.id] !== (snap.results[it.id] || ''));
  const remarksChanged = (fatpdi.remarks[us] || '') !== (snap.remarks || '');
  if (!changed.length && !remarksChanged) { showToast(`Nothing changed on ${us}`, 'warn'); return false; }

  const btn = document.getElementById('btn-fp-save-unit');
  const btnText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    // 1. the gun as it is in the database right now
    const { data: fresh, error: fErr } = await _withTimeout(
      supabaseClient.from(_fatpdiTable()).select('item_id,result,remarks,inspected_by,inspected_at')
        .eq('card_type', fatpdi.cardType).eq('unit_serial', us),
      15000, 'Reading the latest before saving');
    if (fErr) throw fErr;
    const db = {}; (fresh || []).forEach(r => { db[r.item_id] = r; });

    // 2. saved differently by someone else since this gun was opened?
    const conflicts = changed.filter(it => {
      const dbRes = db[it.id] ? db[it.id].result : '';
      return dbRes !== (snap.results[it.id] || '') && dbRes !== mine[it.id];
    });
    if (conflicts.length) {
      const lines = conflicts.map(it => {
        const d = db[it.id];
        return `• ${it.label}: OP ${d.inspected_by || '?'} saved ${d.result} (${_fpTime(d.inspected_at)}) — you marked ${mine[it.id]}`;
      }).join('\n');
      if (!confirm(`⚠ ${us} was changed on another tablet while you had it open:\n\n${lines}\n\n` +
                   `OK = save YOUR result over theirs\nCancel = keep THEIR result (your other marks stay on screen)`)) {
        conflicts.forEach(it => { mine[it.id] = db[it.id].result; });
        _fpAdoptDb(us, fresh || []);
        _renderFatPdiUnit();
        showToast('Their result kept — check the gun and save again', 'warn');
        return false;
      }
    }
    // an item someone else already saved with the same result needs no save
    changed = changed.filter(it => !(db[it.id] && db[it.id].result === mine[it.id] && conflicts.indexOf(it) < 0));

    if (!changed.length && remarksChanged && !(fresh || []).length) {
      showToast('Mark at least one item before saving remarks', 'warn'); return false;
    }
    // 3. write only those items
    const now = new Date().toISOString();
    const rows = changed.map(it => {
      const r = {
        unit_serial: us, launcher_serial: u.launcherSerial, sight_serial: u.sightSerial,
        trolley_number: u.trolleyNumber, trolley_position: u.trolleyPosition,
        card_type: fatpdi.cardType, item_id: it.id, item_label: it.label, result: mine[it.id],
        inspected_by: state.operator, inspected_at: now, doc_code: fatpdi.docCode, updated_at: now
      };
      if (remarksChanged) r.remarks = fatpdi.remarks[us] || null;
      return r;
    });
    if (rows.length) {
      const { error } = await supabaseClient.from(_fatpdiTable())
        .upsert(rows, { onConflict: 'unit_serial,card_type,item_id' });
      if (error) throw error;
    }
    if (remarksChanged) {
      const { error: rErr } = await supabaseClient.from(_fatpdiTable())
        .update({ remarks: fatpdi.remarks[us] || null, updated_at: now })
        .eq('card_type', fatpdi.cardType).eq('unit_serial', us);
      if (rErr) throw rErr;
    }
    // 4. the screen follows what is now saved
    const myRemarks = fatpdi.remarks[us] || '';
    const added = _fpAddedIds(fatpdi.cardType, fatpdi.stage);
    (fresh || []).forEach(r => { if (!changed.some(it => it.id === r.item_id)) _fpTakeRow({ ...r, unit_serial: us }); });
    rows.forEach(r => {
      _fpTakeRow({ ...r, remarks: r.remarks || fatpdi.remarks[us] });
      if (added.includes(r.item_id) && !fatpdi.addedCutoff) fatpdi.addedCutoff = r.inspected_at;
    });
    if (remarksChanged) { if (myRemarks) fatpdi.remarks[us] = myRemarks; else delete fatpdi.remarks[us]; }
    fatpdi.focusSnap = { results: { ...(fatpdi.results[us] || {}) }, remarks: fatpdi.remarks[us] || '' };
    showToast(`✅ ${us} — ${fatpdi.stage} saved (${rows.length} items${remarksChanged ? ' + remarks' : ''})`, 'ok');
    return true;
  } catch (e) {
    console.error('[FAT/PDI] save error', e);
    showToast('❌ Save failed — ' + ((e && e.message) || e), 'error');
    return false;
  } finally {
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = btnText; }
  }
}
// take the database's results as the saved state; marks not saved yet stay
function _fpAdoptDb(us, fresh) {
  const snap = (fatpdi.focusSnap && fatpdi.focusSnap.results) || {};
  const mine = fatpdi.results[us] || {};
  const unsaved = {};
  Object.keys(mine).forEach(id => { if (mine[id] && mine[id] !== (snap[id] || '')) unsaved[id] = mine[id]; });
  delete fatpdi.results[us]; delete fatpdi.resAt[us]; delete fatpdi.by[us];
  fresh.forEach(r => _fpTakeRow({ ...r, unit_serial: us }));
  const dbRes = { ...(fatpdi.results[us] || {}) };
  Object.keys(unsaved).forEach(id => { if (unsaved[id] === dbRes[id]) delete unsaved[id]; });
  fatpdi.results[us] = { ...dbRes, ...unsaved };
  fatpdi.focusSnap = { results: dbRes, remarks: fatpdi.focusSnap ? fatpdi.focusSnap.remarks : '' };
}

// ── Save all entered results for this stage+cardType ───────────────────────
async function saveFatPdi(onlyUnit) {
  // v1.30: onlyUnit = save just that unit (the single-unit view); returns true when saved
  if (fatpdi.adminPreview) {
    showToast('🔓 Admin Preview mode — nothing is saved. Exit preview to record real results.', 'warn');
    return false;
  }
  // v1.35: one gun (FAT / PDI) — only what was changed here, checked first
  if (onlyUnit && !_isAcc()) return _fpSaveUnitSafe(onlyUnit);
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
    if (onlyUnit && us !== onlyUnit) return;
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

  if (rows.length === 0) { showToast('Nothing entered yet', 'warn'); return false; }

  const btn = document.getElementById(onlyUnit ? 'btn-fp-save-unit' : 'btn-fatpdi-save');
  const btnText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  let saved = false;

  try {
    const { error } = await supabaseClient.from(_fatpdiTable())
      .upsert(rows, { onConflict: 'unit_serial,card_type,item_id' });
    if (error) throw error;
    saved = true;
    // v1.32: keep the saved times on screen in step (they decide whether a
    // gun was done on the old list), and note the first use of an added item
    const added = _fpAddedIds(fatpdi.cardType, fatpdi.stage);
    rows.forEach(r => {
      if (!fatpdi.resAt[r.unit_serial]) fatpdi.resAt[r.unit_serial] = {};
      fatpdi.resAt[r.unit_serial][r.item_id] = r.inspected_at;
      if (added.includes(r.item_id) && !fatpdi.addedCutoff) fatpdi.addedCutoff = r.inspected_at;
    });
    showToast(onlyUnit ? `✅ ${onlyUnit} — ${fatpdi.stage} saved (${rows.length} items)`
                       : `✅ ${_isAcc() ? 'Acceptance' : fatpdi.stage} results saved (${rows.length} entries)`, 'ok');
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
    if (btn) { btn.disabled = false; btn.textContent = onlyUnit ? btnText : '💾 Save All'; }
  }
  return saved;
}
