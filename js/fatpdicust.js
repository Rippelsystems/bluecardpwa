// ═══════════════════════════════════════════════════════════════════════════
//  fatpdicust.js — CUSTOMER ACCEPTANCE ENGINE          v1.0  ·  25/11/2026
//
//  ⚠  THIS IS NOT THE OPERATIONAL FILE. The floor's own FAT and PDI run on
//     js/fatpdi.js and that file is NOT touched by any of this. This is a
//     COPY, taken from fatpdi.js on 25/11/2026, used only by
//     acceptance.html — the green CLIENT ACCEPTANCE RECORD page.
//
//  WHY A COPY AND NOT A SHARED FILE:
//     Total isolation from the working system. The customer's tablet never
//     loads app.js and never loads fatpdi.js, so there is no path — none —
//     from the client's page into the floor's own records.
//
//  ⚠  THE PRICE OF THAT, AND IT MUST NOT BE FORGOTTEN:
//     A FIX MADE TO fatpdi.js DOES NOT REACH THIS FILE. If a fault is found
//     in the FAT/PDI engine, it has to be applied HERE AS WELL. Check both
//     files whenever either is changed.
//
//  WHAT IS *NOT* COPIED, DELIBERATELY:
//     js/fatpdi_config.js — the CHECKLIST ITSELF — is SHARED, not copied.
//     That is what guarantees the client tests the identical list we PDI
//     with. Copy that file and the two lists drift apart the first time
//     anyone edits a check, which is the one failure that would be
//     indefensible in front of a customer.
//
//  WHAT THIS FILE DOES DIFFERENTLY FROM fatpdi.js:
//     1. Writes to weapon_customer_results, never to weapon_pdi_results.
//     2. The sign-off unlocks when every item is MARKED — pass OR fail —
//        not when everything passes. A gun signed off with known fails is
//        acknowledged by both sides and the fails go into the signature.
//     3. Sign-off calls bc_ca_unit_signoff. It does NOT set
//        weapon_builds.status, qa_operator or completed_at. The floor's QC
//        record stays exactly as the QC man left it.
//     4. A gun can be REOPENED, an item changed with a reason, and signed
//        again — every step written to customer_acceptance_log.
// ═══════════════════════════════════════════════════════════════════════════
//
// ─── FAT / PDI MODULE (as copied) ───────────────────────────────────────────
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
  _touchAt: 0,          // v1.35: last "still working on it" stamp sent
  _readyShown: null     // v1.44: unit the "ready for final approval" pop-up was shown for
};
const FP_BUSY_MINUTES = 30;
const FP_STRICT_ALL_ITEMS = true;   // v1.39: every FAT / PDI item required (no old-list exception)

// ════════════════════════════════════════════════════════════════════════
// v1.39 (16/11/2026) — THE FAT / PDI GATE IS BACK (RLL + XRGL40, STRICT)
// FAT lists a gun only when every assembly check is COMPLETED or GO
// (database view bc_fat_ready). PDI lists a gun only when, on top of that,
// every FAT item is PASS (view bc_pdi_ready). A gun that does not qualify is
// not listed, even if work was already saved on it — it must be fixed first.
// Admin Preview (PIN) still lists every gun, tagged with why it is held back.
// GRN40 is not gated (left as it is).
// ════════════════════════════════════════════════════════════════════════
function _fpGated() { return fatpdi.cardType === 'RLL' || fatpdi.cardType === 'XRGL40'; }
function _fpGateSource() {
  if (fatpdi.adminPreview || !_fpGated()) return 'weapon_builds';
  return fatpdi.stage === 'PDI' ? 'bc_pdi_ready' : 'bc_fat_ready';
}
// assembly checks COMPLETED (PASS) / GO out of the card's total
function _fpChecksOk(ct, checks) {
  const defs = ((typeof CARD_TYPES !== 'undefined' && CARD_TYPES[ct]) || {}).checks || [];
  const ok = defs.filter(c => ['PASS', 'GO'].includes(String(((checks || {})[c.id] || {}).result || '').toUpperCase())).length;
  return { ok, total: defs.length };
}   // v1.35: an open gun nobody touched for 30 min no longer shows as in progress

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
  // v1.39 (16/11/2026) STRICT: every item on the list must be PASS — the
  // old-list exception below is switched off (Gerhard: guns done before
  // 12 Nov need the Cylinder Alignment tick to go through to PDI). Kept, not
  // deleted, so it can be switched back on by removing the next line.
  if (FP_STRICT_ALL_ITEMS) return items;
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

// 25/11/2026 — CUSTOMER COPY: one table, always. Not a branch, not a
// setting, not something a later edit can accidentally point back at the
// floor's own records. If this file is loaded, the customer's marks go to
// the customer's table and nowhere else.
function _fatpdiTable() {
  return 'weapon_customer_results';
}

// ── the visit this tablet is working under ─────────────────────────────────
// Filled in by acceptance.html when the visit is opened. Nothing in here
// saves without it — a mark with no visit behind it belongs to nobody.
const CA = {
  visitId:     null,
  contract:    null,
  cardType:    'XRGL40',
  customerCompany: null,
  customerRep: null,     // asked again at every signature, never assumed
  batchSize:   null,
  state:       {},       // unit_serial -> last answer from bc_ca_unit_state
  // 26/11/2026 — two pages: 'choose' (the whole batch, tick to select) and
  // 'selected' (only the units the customer picked, where the testing is done)
  view:        'choose',
  selCount:    0,        // units selected on this visit, whatever the filters show
  sel:         [],       // the selected page's rows, as last read from the database
  signature:   null,     // last answer from bc_ca_visit_signature
  sigPrompted: false     // the signature pad has already been offered for this state
};
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
    // 25/11/2026 CUSTOMER COPY: the original flushed the Checks tab back to
    // weapon_builds here. There is no Checks tab on the acceptance page and
    // this file must never write to weapon_builds, so it is removed rather
    // than left sitting dormant where a later edit could wake it up.
    /* removed: weapon_builds.update({ checks }) — see header */
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
  fatpdi._readyShown = null; _fpCloseReadyPopup();   // v1.44
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
    _loadFatPdiUnits(true);   // v1.39: start the list again (was appending)
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

  const entered = prompt('ADMIN PREVIEW\n\nEnter Admin PIN to review the FAT/PDI checklist, including guns held back (checks not all COMPLETED, FAT not all PASS):\n(Nothing entered here is saved as a real QC record.)');
  if (!entered) return;

  if (entered.trim() !== adminPin) {
    showToast('❌ Wrong Admin PIN', 'error');
    return;
  }

  fatpdi.adminPreview = true;
  showToast('🔓 Admin Preview ON — showing all units, nothing will be saved', 'warn');
  _updateAdminPreviewUI();
  _loadFatPdiUnits(true);     // v1.39: start the list again (was appending)
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
// ═══════════════════════════════════════════════════════════════════════════
//  THE GUNS THE CLIENT CAN DRAW FROM — 25/11/2026
//
//  bc_ca_units_available returns every gun on the contract that has finished
//  OUR PDI and been signed off (weapon_builds.status = 'COMPLETE') — the
//  batch as it actually stands — and flags the ones already drawn into this
//  visit so the same gun is not tested twice by mistake.
//
//  The search box filters here, on what came back, rather than going to the
//  database on every keystroke. The batch is a few hundred guns at most and
//  the client is standing at the tablet — a list that answers instantly is
//  worth more than one that is paged.
// ═══════════════════════════════════════════════════════════════════════════
async function _caLoadUnits(reset, els) {
  const { grid, emptyMsg, footer, countLabel, loadMoreBtn } = els;
  if (!CA.visitId) {
    emptyMsg.style.display = 'block';
    emptyMsg.textContent = 'No acceptance visit is open. Start one before drawing guns.';
    footer.textContent = fatpdi.docCode || '';
    if (loadMoreBtn) loadMoreBtn.style.display = 'none';
    return;
  }

  const { data, error } = await _withTimeout(
    supabaseClient.rpc('bc_ca_units_available', {
      p_contract:  CA.contract || null,
      p_card_type: CA.cardType || fatpdi.cardType,
      p_visit_id:  CA.visitId
    }), 20000, 'Loading the batch');
  if (error) throw error;

  let rows = data || [];
  CA.selCount = rows.filter(r => r.already_drawn).length;   // 26/11/2026: the whole visit, not just what the filters show
  const q = String(fatpdi.filterSearch || '').trim().toUpperCase();
  if (q) rows = rows.filter(r => String(r.unit_serial || '').toUpperCase().indexOf(q) >= 0);
  if (fatpdi.filterTrolley)
    rows = rows.filter(r => String(r.trolley_number) === String(fatpdi.filterTrolley));
  if (fatpdi.filterPos)
    rows = rows.filter(r => String(r.trolley_position) === String(fatpdi.filterPos));

  fatpdi.units = rows.map(r => ({
    unitSerial:      r.unit_serial,
    launcherSerial:  r.launcher_serial || null,
    sightSerial:     r.sight_serial || null,
    status:          r.already_drawn ? 'DRAWN' : 'READY',
    caDrawn:         !!r.already_drawn,
    trolleyNumber:   r.trolley_number,
    trolleyPosition: r.trolley_position,
    contract:        r.contract || null,
    openFails:       0
  }));
  fatpdi.offset = fatpdi.units.length;

  footer.textContent = (fatpdi.docCode || '') + ' · CLIENT ACCEPTANCE';

  if (!fatpdi.units.length) {
    emptyMsg.style.display = 'block';
    emptyMsg.textContent = q
      ? 'No gun on this contract matches "' + q + '".'
      : 'No guns on ' + (CA.contract || 'this contract')
        + ' have finished PDI yet, so there is nothing to draw from.';
    if (countLabel) countLabel.textContent = '';
    if (loadMoreBtn) loadMoreBtn.style.display = 'none';
    _renderFatPdiGrid();
    return;
  }

  // whatever the client has already marked on the guns they have drawn
  const drawn = fatpdi.units.filter(u => u.caDrawn).map(u => u.unitSerial);
  if (drawn.length) {
    const { data: existing, error: exErr } = await _withTimeout(
      supabaseClient.from(_fatpdiTable())
        .select('unit_serial,item_id,result,remarks,inspected_by,inspected_at')
        .eq('card_type', fatpdi.cardType).in('unit_serial', drawn),
      20000, 'Loading what the client has marked');
    if (exErr) throw exErr;
    (existing || []).forEach(_fpTakeRow);
  }

  _renderFatPdiGrid();
  if (countLabel)
    countLabel.textContent = `${fatpdi.units.length} gun(s) on ${CA.contract || 'this contract'}`
      + ` · ${drawn.length} drawn into this visit`;
  if (loadMoreBtn) loadMoreBtn.style.display = 'none';   // the whole batch is here
}

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
    // ── 25/11/2026 CUSTOMER COPY ────────────────────────────────────────
    // The guns come from the VISIT, not from the FAT/PDI gate views. The
    // client is shown the batch that has finished our PDI and is ready to
    // ship, and marks which of them they are drawing. Same pattern the
    // GRN40 Final Acceptance stage already uses one line below.
    await _caLoadUnits(reset, { grid, emptyMsg, footer, countLabel, loadMoreBtn });
    return;
    /* eslint-disable no-unreachable */
    if (_isAcc()) { await _loadAcceptanceUnits(reset, { grid, emptyMsg, footer, countLabel, loadMoreBtn }); return; }
    const serialCol = fatpdi.cardType === 'GRN40' ? 'sight_serial' : 'launcher_serial';
    // 23/10/2026 (v1.22): no more count='exact' — that made PostgREST run a
    // second counting query over the table on every page; the page itself
    // tells us whether there is more (a full page = probably more).
    // v1.39: FAT / PDI read the gate views; Admin Preview + GRN40 read weapon_builds
    let q = supabaseClient.from(_fpGateSource())
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
      chk: _fpChecksOk(fatpdi.cardType, r.checks),     // v1.39: for the Admin Preview "held back" tag
      unitSerial: fatpdi.cardType === 'GRN40' ? r.sight_serial : r.launcher_serial,
      launcherSerial: fatpdi.cardType === 'GRN40' ? null : r.launcher_serial,
      sightSerial: r.sight_serial || null,
      status: r.status,
      trolleyNumber: r.trolley_number,
      trolleyPosition: r.trolley_position
    }));

    fatpdi.units = fatpdi.units.concat(pageUnits);
    fatpdi.offset += (data || []).length;
    if (skippedFails) showToast(`⚠ ${skippedFails} unit(s) held back — build card has a check NOT COMPLETED / NO-GO`, 'warn');

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
        : !_fpGated()
        ? `No ${fatpdi.cardType} units with a Blue Card build match this filter yet (units with a check NOT COMPLETED are held back).`
        : fatpdi.stage === 'PDI'
        ? `No ${fatpdi.cardType} guns ready for PDI match this filter. A gun comes onto PDI when every assembly check is COMPLETED / GO and every FAT item is PASS.`
        : `No ${fatpdi.cardType} guns ready for FAT match this filter. A gun comes onto FAT when every assembly check on its build card is COMPLETED / GO.`;
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
      // v1.39: Admin Preview on PDI — how many FAT items each gun has PASS
      if (fatpdi.adminPreview && _fpGated() && fatpdi.stage === 'PDI') {
        try {
          const { data: fr } = await _withTimeout(
            supabaseClient.from('weapon_fat_results').select('unit_serial,item_id,result')
              .eq('card_type', fatpdi.cardType).in('unit_serial', pageSerials),
            20000, 'Reading FAT results');
          const pass = {};
          (fr || []).forEach(r => { if (String(r.result || '').toUpperCase() === 'PASS')
            (pass[r.unit_serial] = pass[r.unit_serial] || new Set()).add(r.item_id); });
          const nFat = ((FATPDI_TYPES[fatpdi.cardType] || {}).FAT || {}).items || [];
          pageUnits.forEach(u => { u.fatPass = nFat.filter(it => (pass[u.unitSerial] || new Set()).has(it.id)).length;
                                   u.fatTotal = nFat.length; });
        } catch (e) { console.warn('[FAT/PDI] preview FAT read', e); }
      }
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
      + (u.openFails ? `<br><span style="font-size:9px;color:#e03c3c;font-weight:700;">⚠ ${u.openFails} NOT COMPLETED / NO-GO on build card</span>` : '')
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
// v1.39: Admin Preview only — why a gun is not on this tab for the floor
function _fpHeldTag(u) {
  if (!fatpdi.adminPreview || !_fpGated() || _isAcc()) return '';
  const why = [];
  if (u.chk && u.chk.ok < u.chk.total) why.push(`checks ${u.chk.ok}/${u.chk.total}`);
  if (fatpdi.stage === 'PDI' && u.fatTotal != null && u.fatPass < u.fatTotal) why.push(`FAT PASS ${u.fatPass}/${u.fatTotal}`);
  return why.length ? `<br><span style="font-size:9px;color:#e03c3c;font-weight:700;">⛔ not on ${fatpdi.stage} yet — ${_fpEsc(why.join(' · '))}</span>` : '';
}
function _fpShowList() {
  const lv = document.getElementById('fatpdi-list-view'), uv = document.getElementById('fatpdi-unit-view');
  const sv = document.getElementById('ca-selected-view');
  const onSel = !!(sv && CA.view === 'selected');      // 26/11/2026: back goes to the page he came from
  if (lv) lv.style.display = onSel ? 'none' : '';
  if (sv) sv.style.display = onSel ? '' : 'none';
  if (uv) { uv.style.display = 'none'; uv.innerHTML = ''; }
}

// ═══════════════════════════════════════════════════════════════════════════
//  DRAWING A GUN INTO THE SAMPLE — 25/11/2026
//
//  The client picks the guns. Ticking one calls bc_ca_unit_add, which checks
//  the gun really has finished our PDI before it goes on the list, and keeps
//  the visit's sample_size in step. Until a gun is ticked it cannot be
//  opened — otherwise a man could test a gun nobody drew and it would belong
//  to no visit and no certificate.
//
//  There is no untick on this list. 27/11/2026 (Gerhard): a unit that was
//  selected but NEVER TESTED can be taken off on the Selected units page
//  (caRemoveSelected -> bc_ca_unit_remove), so "test only 8 of the 10" does
//  not hold the signature back. A unit with any mark or a sign-off stays:
//  it is part of the record of what the client tested. Every removal is
//  written to the acceptance log.
// ═══════════════════════════════════════════════════════════════════════════
async function _caDraw(cb, us) {
  if (!CA.visitId) { showToast('No acceptance visit is open', 'error'); return; }
  cb.disabled = true;
  try {
    const { data, error } = await supabaseClient.rpc('bc_ca_unit_add', {
      p_visit_id: CA.visitId, p_unit_serial: us
    });
    if (error) throw error;
    if (data && data.ok === false) {
      cb.checked = false;
      showToast('❌ ' + (data.error || 'Not drawn'), 'error');
      return;
    }
    const u = fatpdi.units.find(x => x.unitSerial === us);
    if (u && !u.caDrawn) CA.selCount = (CA.selCount || 0) + 1;
    if (u) { u.caDrawn = true; u.status = 'DRAWN'; }
    CA.sigPrompted = false;
    showToast('✓ ' + us + ' selected', 'ok');
    _renderFatPdiList();
  } catch (e) {
    cb.checked = false;
    showToast('❌ Could not draw it — ' + ((e && e.message) || e), 'error');
  } finally {
    cb.disabled = false;
  }
}

function _caOpenDrawn(us) {
  const u = fatpdi.units.find(x => x.unitSerial === us);
  if (!u || !u.caDrawn) {
    showToast('Tick it first — the client has to draw the gun before it is tested', 'warn');
    return;
  }
  openFatPdiUnit(us);
}

function _renderFatPdiList() {
  const table = document.getElementById('fatpdi-grid');
  const drawnCount = fatpdi.units.filter(u => u.caDrawn).length;
  let html = '<thead><tr>'
    + '<th style="width:1%;white-space:nowrap;">Draw</th>'
    + '<th style="min-width:120px;">Serial</th>'
    + '<th style="min-width:80px;">Trolley/Pos</th>'
    + `<th style="min-width:110px;">${fatpdi.stage} progress</th>`
    + '<th style="width:1%;"></th>'
    + '</tr></thead><tbody>';
  fatpdi.units.forEach(u => {
    const us = u.unitSerial, p = _fpProgress(us);
    const tag = (u.status !== 'COMPLETE'
        ? `<br><span style="font-size:9px;color:#e08f1a;">build ${_fpEsc(u.status||'IN PROGRESS')}${fatpdi.adminPreview ? ' (preview)' : ''}</span>` : '')
      + (u.openFails ? `<br><span style="font-size:9px;color:#e03c3c;font-weight:700;">⚠ ${u.openFails} NOT COMPLETED / NO-GO on build card</span>` : '')
      + _fpHeldTag(u);
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
    // the tick that draws it into the sample. Ticked ones stay ticked and
    // cannot be unticked — see the note above _caDraw.
    const drawCell = u.caDrawn
      ? `<td style="text-align:center;" onclick="event.stopPropagation()">`
        + `<span style="font-size:18px;color:#1a9e5c;" title="Drawn for the client">✔</span></td>`
      : `<td style="text-align:center;" onclick="event.stopPropagation()">`
        + `<input type="checkbox" style="width:26px;height:26px;" `
        + `title="Draw this gun for the client" `
        + `onclick="_caDraw(this,'${_fpEsc(us)}')"></td>`;
    html += `<tr class="fp-list-row" data-unit="${_fpEsc(us)}" onclick="_caOpenDrawn(this.dataset.unit)">`
      + drawCell
      + `<td style="font-family:var(--font-mono,monospace);font-weight:700;">${_fpEsc(us)}${u.sightSerial && u.launcherSerial ? `<br><span style="font-size:10px;color:var(--text-dim,#8fa3c0);">Sight ${_fpEsc(u.sightSerial)}</span>` : ''}${tag}</td>`
      + `<td style="font-size:12px;">${u.trolleyNumber||'—'} / ${u.trolleyPosition||'—'}</td>`
      + `<td>${prog}${whoTag}${busyTag}${signedTag}</td>`
      + `<td>${u.caDrawn ? '<button type="button" class="fp-open">Open ›</button>'
                         : '<span style="font-size:11px;color:var(--text-dim,#8fa3c0);">tick to draw</span>'}</td>`
      + '</tr>';
  });
  html += '</tbody>';
  table.innerHTML = html;
  const cl = document.getElementById('fatpdi-count-label');
  if (cl && CA.visitId) {
    cl.textContent = `${fatpdi.units.length} gun(s) on ${CA.contract || 'this contract'}`
                   + ` · ${drawnCount} drawn for the client`;
  }
  // the list has nothing to save — saving happens per unit
  const saveAll = document.getElementById('btn-fatpdi-save');
  if (saveAll) saveAll.style.display = 'none';
  _caSelButtons();
}

// ═══════════════════════════════════════════════════════════════════════════
//  THE SELECTED UNITS PAGE, AND THE CUSTOMER'S SIGNATURE — 26/11/2026
//
//  Gerhard: the units are chosen from the trolley/position list as before;
//  then a button takes them to a second page that lists ONLY the units the
//  customer selected, so they are all together. The testing is done from
//  there, on a cell phone, so each row is just the serial, where it stands,
//  and Open. When every selected unit has had its final approval sign-off,
//  the representative signs ONCE on the screen, and that signature is kept
//  with the acceptance record (customer_acceptance_signatures) and shown on
//  the certificate in Matrix.
// ═══════════════════════════════════════════════════════════════════════════
function _caSelButtons() {
  document.querySelectorAll('.ca-to-selected').forEach(b => {
    const k = CA.selCount || 0;
    b.textContent = k ? `Selected units (${k})  ›` : 'Selected units  ›';
  });
}

function caShowChoose() {
  CA.view = 'choose';
  _fpShowList();
  _loadFatPdiUnits(true);          // the filters decide what this page lists
  window.scrollTo(0, 0);
}

function caShowSelected() {
  if (!CA.visitId) { showToast('No acceptance visit is open', 'error'); return; }
  CA.view = 'selected';
  _fpShowList();
  window.scrollTo(0, 0);
  caLoadSelected(false);
}

// Reads the selection fresh from the database every time: which units, where
// each one stands, what has been marked, and whether the visit is signed.
async function caLoadSelected(mayPrompt) {
  const list = document.getElementById('ca-sel-list'), msg = document.getElementById('ca-sel-msg');
  if (!list || !CA.visitId) return;
  if (!CA.sel.length) list.innerHTML = '<div class="ca-sel-note">Loading the selected units…</div>';
  if (msg) msg.textContent = '';
  try {
    const visit = CA.visitId;
    const [av, vs, sg] = await Promise.all([
      _withTimeout(supabaseClient.rpc('bc_ca_units_available', {
        p_contract: CA.contract || null, p_card_type: CA.cardType || fatpdi.cardType, p_visit_id: visit
      }), 20000, 'Loading the selected units'),
      _withTimeout(supabaseClient.rpc('bc_ca_visit_status', { p_visit_id: visit }), 20000, 'Loading the visit'),
      _withTimeout(supabaseClient.rpc('bc_ca_visit_signature', { p_visit_id: visit, p_with_image: false }),
                   20000, 'Loading the signature')
    ]);
    if (av.error) throw av.error;
    if (vs.error) throw vs.error;
    if (visit !== CA.visitId) return;
    const drawn = (av.data || []).filter(r => r.already_drawn);
    const stand = {};
    ((vs.data && vs.data.units) || []).forEach(u => { stand[u.unit_serial] = u; });

    // the engine opens a unit out of fatpdi.units, so every selected unit has
    // to be in there even when the choose page's filters had left it out
    drawn.forEach(r => {
      let u = fatpdi.units.find(x => x.unitSerial === r.unit_serial);
      if (!u) {
        u = { unitSerial: r.unit_serial, openFails: 0 };
        fatpdi.units.push(u);
      }
      u.launcherSerial = r.launcher_serial || null; u.sightSerial = r.sight_serial || null;
      u.trolleyNumber = r.trolley_number; u.trolleyPosition = r.trolley_position;
      u.contract = r.contract || null; u.caDrawn = true;
      const st = stand[r.unit_serial];
      u.status = (st && st.status === 'SIGNED') ? 'SIGNED' : 'DRAWN';
    });
    CA.selCount = drawn.length;

    const serials = drawn.map(r => r.unit_serial);
    if (serials.length) {
      const { data: marks, error: mErr } = await _withTimeout(
        supabaseClient.from(_fatpdiTable())
          .select('unit_serial,item_id,result,remarks,inspected_by,inspected_at')
          .eq('card_type', fatpdi.cardType).in('unit_serial', serials),
        20000, 'Loading what has been marked');
      if (mErr) throw mErr;
      (marks || []).forEach(_fpTakeRow);
    }

    CA.sel = drawn.map(r => {
      const st = stand[r.unit_serial] || {};
      return { us: r.unit_serial, status: st.status || 'IN PROGRESS', result: st.result || null,
               round: st.round || 1, openFails: Number(st.open_fails || 0) };
    });
    // the signature function is new on 26/11 — without it the page still works
    CA.signature = (sg && !sg.error && sg.data) ? sg.data : { signed: false, current: false, missing: !!(sg && sg.error) };
    _caRenderSelected();
    _caSelButtons();
    if (mayPrompt && _caAllDone() && !(CA.signature && CA.signature.current)
        && !CA.signature.missing && !CA.sigPrompted) {
      CA.sigPrompted = true;
      caSignatureOpen();
    }
  } catch (e) {
    list.innerHTML = '';
    if (msg) msg.textContent = '⚠ Could not read the selected units — ' + ((e && e.message) || e)
                             + '. Check the signal and tap Refresh.';
  }
}

function _caAllDone() {
  return CA.sel.length > 0 && CA.sel.every(x => x.status === 'SIGNED');
}

function _caWhen(ts) {
  try {
    const d = new Date(ts); if (isNaN(d)) return '';
    const p = v => String(v).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch (e) { return ''; }
}

function _caRenderSelected() {
  const list = document.getElementById('ca-sel-list'), sign = document.getElementById('ca-sel-sign');
  const head = document.getElementById('ca-sel-count');
  if (!list) return;
  const done = CA.sel.filter(x => x.status === 'SIGNED').length;
  if (head) head.textContent = CA.sel.length
    ? `${CA.sel.length} selected · ${done} done` : '';
  if (!CA.sel.length) {
    list.innerHTML = '<div class="ca-sel-note">No units selected yet. Tap “Add units” and tick the ones the customer picks.</div>';
  } else {
    list.innerHTML = CA.sel.map(x => {
      const p = _fpProgress(x.us);
      let cls = 'todo', txt = 'Not started';
      if (x.status === 'SIGNED') {
        cls = x.result === 'FAIL' ? 'fault' : 'done';
        txt = x.result === 'FAIL' ? `✓ Done · ${x.openFails || p.fails || 1} fault(s) noted` : '✓ Done · passed';
      } else if (p.done) {
        cls = 'busy';
        txt = p.done >= p.total ? `All ${p.total} marked · needs its sign-off` : `${p.done} of ${p.total} marked`;
      }
      // 27/11/2026: only a unit nothing has been marked on can be taken off
      const rm = (cls === 'todo')
        ? `<button type="button" class="ca-sel-remove" data-unit="${_fpEsc(x.us)}"
             onclick="event.stopPropagation();caRemoveSelected(this.dataset.unit)">Remove</button>` : '';
      return `<div class="ca-sel-row ${cls}" data-unit="${_fpEsc(x.us)}" onclick="_caOpenSelected(this.dataset.unit)">
          <div class="ca-sel-main"><div class="ca-sel-serial">${_fpEsc(x.us)}</div>
            <div class="ca-sel-state">${txt}</div></div>
          ${rm}<button type="button" class="ca-sel-open">Open ›</button>
        </div>`;
    }).join('');
  }
  if (!sign) return;
  const sg = CA.signature || {};
  const rep = _fpEsc(CA.customerRep || 'the representative');
  if (sg.missing) {
    sign.innerHTML = '<div class="ca-sel-note">The signature step is not set up on the database yet (customer_acceptance_signature_26Nov.sql).</div>';
  } else if (!CA.sel.length) {
    sign.innerHTML = '';
  } else if (sg.current) {
    sign.innerHTML = `<div class="ca-sig-done">✓ Signed by ${_fpEsc(sg.signed_name || '')}<br>
        <span>${_fpEsc(_caWhen(sg.signed_at))} · ${sg.units_count} unit(s)</span></div>
      <button type="button" class="ca-sig-again" onclick="caSignatureOpen()">Sign again</button>`;
  } else if (_caAllDone()) {
    sign.innerHTML = `<div class="ca-sel-note">Every selected unit is done.${sg.signed ? ' A unit was signed off after the last signature, so it has to be signed again.' : ''}</div>
      <button type="button" class="ca-sig-go" onclick="caSignatureOpen()">🖊 ${rep} signs now</button>`;
  } else {
    sign.innerHTML = `<div class="ca-sel-note">${rep} signs once, here, when every selected unit is done
        (${CA.sel.length - done} still to do).</div>
      <button type="button" class="ca-sig-go" disabled>🖊 Signature</button>`;
  }
}

// 27/11/2026 — take a selected unit that was never tested off the visit.
// The database decides (bc_ca_unit_remove): it refuses a unit with any mark
// or a sign-off, and logs every removal. If the units that are left are all
// done, the signature box comes up straight away.
async function caRemoveSelected(us) {
  if (!CA.visitId || !us) return;
  if (!confirm(us + '\n\nTake this unit off the selection?\n\n'
      + 'Only for a unit the customer decided NOT to test. '
      + 'It is recorded that it was selected and taken off untested.')) return;
  try {
    const { data, error } = await _withTimeout(supabaseClient.rpc('bc_ca_unit_remove', {
      p_visit_id: CA.visitId, p_unit_serial: us, p_by: String(state.operator || '')
    }), 20000, 'Removing the unit');
    if (error) throw error;
    if (data && data.ok === false) {
      showToast('❌ ' + (data.error || 'Not removed'), 'error');
      caLoadSelected(false);
      return;
    }
    const u = fatpdi.units.find(x => x.unitSerial === us);
    if (u) { u.caDrawn = false; u.status = 'READY'; }
    CA.sel = CA.sel.filter(x => x.us !== us);
    CA.selCount = CA.sel.length;
    CA.sigPrompted = false;
    showToast('✓ ' + us + ' taken off the selection', 'ok');
    _caRenderSelected();
    _caSelButtons();
    caLoadSelected(true);
  } catch (e) {
    showToast('❌ Could not remove it — ' + ((e && e.message) || e), 'error');
  }
}

function _caOpenSelected(us) {
  const u = fatpdi.units.find(x => x.unitSerial === us);
  if (!u) { showToast('Tap Refresh — that unit was not read', 'warn'); return; }
  openFatPdiUnit(us);
}

// ── the signature pad ──────────────────────────────────────────────────────
function caSignatureClose() {
  const e = document.getElementById('ca-sig-pop');
  if (e && e.remove) e.remove();
}

function caSignatureOpen() {
  if (!CA.visitId) return;
  if (!_caAllDone()) { showToast('Every selected unit has to be done first', 'warn'); return; }
  caSignatureClose();
  const pass = CA.sel.filter(x => x.result !== 'FAIL').length, fail = CA.sel.length - pass;
  const ov = document.createElement('div');
  ov.id = 'ca-sig-pop';
  ov.className = 'ca-sig-wrap';
  ov.innerHTML =
    `<div class="ca-sig-box">
       <div class="ca-sig-head">CUSTOMER ACCEPTANCE — SIGNATURE</div>
       <div class="ca-sig-txt"><b>${_fpEsc(CA.customerRep || '')}</b> signs for ${CA.sel.length} unit(s) on
         ${_fpEsc(CA.contract || '')}: ${pass} passed${fail ? `, <b class="f">${fail} with faults noted</b>` : ''}.</div>
       <div class="ca-sig-units">${CA.sel.map(x => `<span class="${x.result === 'FAIL' ? 'f' : ''}">${_fpEsc(x.us)}</span>`).join('')}</div>
       <div class="ca-sig-lbl">Sign in the box with a finger</div>
       <canvas id="ca-sig-canvas" class="ca-sig-canvas"></canvas>
       <div id="ca-sig-err" class="ca-sig-err"></div>
       <div class="ca-sig-btns">
         <button type="button" id="ca-sig-clear" class="ca-sig-clear">Clear</button>
         <button type="button" id="ca-sig-save" class="ca-sig-save">✓ Save signature</button>
       </div>
       <button type="button" id="ca-sig-later" class="ca-sig-later">Not now</button>
     </div>`;
  document.body.appendChild(ov);

  const cv = document.getElementById('ca-sig-canvas');
  const rc = cv.getBoundingClientRect();
  const scale = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.max(200, Math.round(rc.width * scale));
  cv.height = Math.max(100, Math.round(rc.height * scale));
  const g = cv.getContext('2d');
  const ink = { len: 0, down: false, x: 0, y: 0 };
  const wipe = () => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, cv.width, cv.height); ink.len = 0; };
  wipe();
  g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#10203a'; g.lineWidth = 2.4 * scale;
  const at = ev => {
    const r = cv.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * cv.width / r.width, y: (ev.clientY - r.top) * cv.height / r.height };
  };
  cv.addEventListener('pointerdown', ev => {
    ev.preventDefault();
    const p = at(ev); ink.down = true; ink.x = p.x; ink.y = p.y;
    const er = document.getElementById('ca-sig-err'); if (er) er.textContent = '';
    try { cv.setPointerCapture(ev.pointerId); } catch (e) {}
    g.beginPath(); g.arc(p.x, p.y, g.lineWidth / 2, 0, Math.PI * 2); g.fillStyle = '#10203a'; g.fill();
  });
  cv.addEventListener('pointermove', ev => {
    if (!ink.down) return;
    ev.preventDefault();
    const p = at(ev);
    g.beginPath(); g.moveTo(ink.x, ink.y); g.lineTo(p.x, p.y); g.stroke();
    ink.len += Math.hypot(p.x - ink.x, p.y - ink.y) / scale;
    ink.x = p.x; ink.y = p.y;
  });
  const up = () => { ink.down = false; };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up); cv.addEventListener('pointerleave', up);

  const err = document.getElementById('ca-sig-err');
  document.getElementById('ca-sig-clear').onclick = () => { wipe(); err.textContent = ''; };
  document.getElementById('ca-sig-later').onclick = caSignatureClose;
  const save = document.getElementById('ca-sig-save');
  save.onclick = async () => {
    err.textContent = '';
    if (ink.len < 60) { err.textContent = 'There is no signature in the box yet.'; return; }
    save.disabled = true; save.textContent = 'Saving…';
    try {
      const { data, error } = await _withTimeout(supabaseClient.rpc('bc_ca_visit_sign', {
        p_visit_id: CA.visitId, p_signed_name: CA.customerRep || '',
        p_signature: cv.toDataURL('image/png'), p_by: String(state.operator || '')
      }), 30000, 'Saving the signature');
      if (error) throw error;
      if (!data || data.ok === false) { err.textContent = (data && data.error) || 'Not saved.'; return; }
      caSignatureClose();
      showToast('✅ Signature saved with the acceptance record', 'ok');
      CA.view = 'selected'; _fpShowList();
      caLoadSelected(false);
    } catch (e) {
      err.textContent = 'Not saved — ' + ((e && e.message) || e) + '. The signature is still in the box; try Save again.';
    } finally {
      if (save.isConnected) { save.disabled = false; save.textContent = '✓ Save signature'; }
    }
  };
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
  fatpdi._readyShown = null;   // v1.44: say it again for the gun being opened
  _fpCloseReadyPopup();
  _renderFatPdiUnit();
  const lv = document.getElementById('fatpdi-list-view'), uv = document.getElementById('fatpdi-unit-view');
  const sv = document.getElementById('ca-selected-view');
  if (lv) lv.style.display = 'none';
  if (sv) sv.style.display = 'none';
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
      <div class="fp-meta">${fatpdi.cardType === 'GRN40' ? 'Sight' : `Trolley ${u.trolleyNumber||'—'} · Pos ${u.trolleyPosition||'—'}`}${u.sightSerial && u.launcherSerial ? ` · Sight ${_fpEsc(u.sightSerial)}` : ''}${u.status !== 'COMPLETE' ? ` · build ${_fpEsc(u.status||'IN PROGRESS')}` : ''}${fatpdi.adminPreview ? ' · ADMIN PREVIEW (not saved)' : ''}</div>
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
      <button class="btn btn-secondary" id="btn-fp-back" onclick="closeFatPdiUnit()">${_fpBackLabel()}</button>
    </div>`;
  // v1.31: the final sign-off lives on the PDI page only
  if (fatpdi.stage === 'PDI') html += `<div class="fp-final" id="fp-final"><h3>🖊 FINAL APPROVAL SIGN-OFF</h3>
      <div id="fp-final-list" style="font-size:12px;color:var(--text-dim,#8fa3c0);">Checking the card…</div>
      <button class="btn fp-signoff" id="btn-fp-signoff" disabled onclick="signOffFromPdi()">${_fpSignOffLabel(us)}</button>
      <button type="button" class="fp-backlink" id="btn-fp-back2" onclick="closeFatPdiUnit()">← Back to the list</button>
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
        ['firing_mech_no','Firing mech no'],['hfm_serial_no','HFM serial']],
        // v1.47 (23/11/2026): HRC prod no and HFM prod no came off the XRGL40
        // card, so they are no longer asked for at the Final Approval Sign-Off.
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

// v1.44 (21/11/2026): the floor was missing the green button, so it says what
// it is and carries the serial — "🖊 FINAL APPROVAL SIGN-OFF · RLL 260207".
function _fpSignOffLabel(us) { return `🖊 FINAL APPROVAL SIGN-OFF · ${_fpEsc(us || '')}`; }

function _fpRenderFinal(list, signed) {
  const el = document.getElementById('fp-final-list'), btn = document.getElementById('btn-fp-signoff');
  if (!el || !btn) return;
  if (signed) {
    el.innerHTML = `<div class="fp-req"><span class="ok">✓</span><span><b>Signed off</b> — OP ${_fpEsc(signed.by || '?')} · ${_fpEsc(String(signed.at || '').slice(0,16).replace('T',' '))}</span></div>`;
    btn.disabled = true; btn.textContent = '✓ Signed off';
    btn.classList.remove('fp-blink');
    _fpCloseReadyPopup();
    return;
  }
  el.innerHTML = list.map(r => `<div class="fp-req"><span class="${r.ok ? 'ok' : 'no'}">${r.ok ? '✓' : '✗'}</span>
      <span>${_fpEsc(r.label)}${!r.ok && r.why ? `<br><span class="why">${_fpEsc(r.why)}</span>` : ''}</span></div>`).join('');
  const all = !!(list.length && list.every(r => r.ok));
  const live = all && !fatpdi.adminPreview;
  btn.disabled = !live;
  btn.title = fatpdi.adminPreview ? 'Admin Preview — nothing is saved' : (all ? '' : 'Everything above must be ✓ first');
  // v1.44: blink while it is live, and say so once — a gun is NOT finished
  // until this is pressed (RLL 260207, 20/11/2026: all three stages done,
  // never signed off, because Save took the operator back to the list).
  btn.classList.toggle('fp-blink', live);
  const us = fatpdi.focus;
  if (live && us && fatpdi._readyShown !== us) {
    fatpdi._readyShown = us;
    _fpReadyPopup(us);
  }
  if (!live) _fpCloseReadyPopup();
}

// ── v1.44: "ready for final approval" pop-up ────────────────────────────────
function _fpCloseReadyPopup() {
  const e = document.getElementById('fp-ready-pop');
  if (e && e.remove) e.remove();
}

function _fpReadyPopup(us) {
  _fpCloseReadyPopup();
  const ov = document.createElement('div');
  ov.id = 'fp-ready-pop';
  ov.className = 'fp-pop-wrap';
  ov.innerHTML =
    `<div class="fp-pop">
       <div class="fp-pop-head">✅ READY FOR FINAL APPROVAL</div>
       <div class="fp-pop-serial">${_fpEsc(us)}</div>
       <div class="fp-pop-txt">Every item on the acceptance checklist is marked.<br>
         This unit is <b>not finished</b> until the Final Approval Sign-Off is pressed.</div>
       <button type="button" class="fp-pop-go" id="fp-pop-go">🖊 Go to Final Approval Sign-Off</button>
       <button type="button" class="fp-pop-later" id="fp-pop-later">Not now</button>
     </div>`;
  document.body.appendChild(ov);
  const later = document.getElementById('fp-pop-later');
  const go    = document.getElementById('fp-pop-go');
  if (later) later.onclick = _fpCloseReadyPopup;
  if (go) go.onclick = () => {
    _fpCloseReadyPopup();
    const fin = document.getElementById('fp-final');
    if (fin && fin.scrollIntoView) fin.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const b = document.getElementById('btn-fp-signoff');
    if (b && !b.disabled && b.focus) { try { b.focus({ preventScroll: true }); } catch (e) { b.focus(); } }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  THE GATE — 25/11/2026, and this is where the two systems differ most.
//
//  A TRAP THE ORIGINAL WOULD HAVE WALKED INTO: the version in fatpdi.js
//  treats a gun whose weapon_builds.status is 'COMPLETE' as already signed
//  off and disables the button. EVERY gun the customer tests is COMPLETE —
//  that is precisely how it qualified to be drawn. Left as it was, the
//  sign-off button would never have unlocked for a single gun.
//
//  So this version ignores weapon_builds entirely and asks the customer
//  tables where the gun stands: how many items are marked, how many failed,
//  and whether it has been signed in THIS visit. The button unlocks when
//  every item is marked — pass or fail.
// ═══════════════════════════════════════════════════════════════════════════
function _fpReadyToSign(us) {
  if (fatpdi.adminPreview) return false;
  const st = (CA.state || {})[us];
  if (!st) return false;
  if (String(st.status || '') === 'SIGNED') return false;
  return !!st.can_sign;
}

async function _fpRefreshFinal(reload) {
  const us = fatpdi.focus; if (!us) return;
  const el = document.getElementById('fp-final-list');
  const btn = document.getElementById('btn-fp-signoff');
  if (!CA.visitId) {
    if (el) el.textContent = '⚠ No acceptance visit is open.';
    if (btn) btn.disabled = true;
    return;
  }
  try {
    const items = _fpItems();
    CA.state = CA.state || {};
    // 26/11/2026: a tap only needs the panel redrawn from what is on screen —
    // the database is asked when the unit is opened or saved (reload), not on
    // every tap. One call per tap was pointless and slow on a phone signal.
    let st = (!reload && CA.state[us] && CA.state[us].status) ? CA.state[us] : null;
    if (!st) {
      const { data, error } = await supabaseClient.rpc('bc_ca_unit_state', {
        p_visit_id: CA.visitId, p_unit_serial: us, p_expected_items: items.length
      });
      if (error) throw error;
      if (fatpdi.focus !== us) return;
      st = data || {};
      CA.state[us] = st;
    }

    // already signed in this visit — show it and leave the button alone
    if (st && String(st.status || '') === 'SIGNED') {
      const sg = (st.round > 1 ? `round ${st.round} · ` : '') + (st.result || '');
      if (el) el.innerHTML =
        `<div class="fp-req"><span class="ok">✓</span><span><b>This unit is done</b>` +
        ` — ${_fpEsc(sg)}</span></div>` +
        (Number(st.open_fails || 0) > 0
          ? `<div class="fp-req"><span class="no">!</span><span>${st.open_fails}` +
            ` fault(s) acknowledged on the signature — reopen the gun once they are put right</span></div>`
          : '');
      if (btn) { btn.disabled = true; btn.textContent = '✓ Unit done'; }
      if (btn) btn.classList.remove('fp-blink');
      _fpCloseReadyPopup();
      return;
    }

    // 25/11/2026 — count what is ON THE SCREEN, not what is saved.
    // _fpSet only writes to fatpdi.results; nothing reaches the database
    // until Save is pressed. Counting st.marked meant the panel sat at
    // "11 item(s) still to mark" with all 11 already marked, and the
    // sign-off button never went live. The saved marks are read back into
    // fatpdi.results when the unit is opened (see _caOpenDrawn), so this is
    // the complete picture, and it is what the internal PDI has always done.
    // signOffFromPdi still saves first and re-checks against the database
    // before it signs anything, so nothing can be signed off unsaved.
    const res    = fatpdi.results[us] || {};
    const marked = items.filter(it => res[it.id] === 'PASS' || res[it.id] === 'FAIL').length;
    const fails  = items.filter(it => res[it.id] === 'FAIL').length;
    const list = [
      { label: `Every item marked — ${marked} of ${items.length}`,
        ok: marked >= items.length,
        why: marked < items.length
             ? `${items.length - marked} item(s) still to mark, pass or fail`
             : '' }
    ];
    if (fails > 0) {
      // NOT a blocker. It is a warning that goes onto the signature.
      list.push({ label: `${fails} item(s) FAILED — they will be acknowledged on the signature`,
                  ok: true, why: '' });
    }
    _fpRenderFinal(list);
  } catch (e) {
    if (el) el.textContent = '⚠ Could not check the gun — ' + ((e && e.message) || e);
    if (btn) btn.disabled = true;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  CUSTOMER SIGN-OFF  —  25/11/2026
//
//  The original in fatpdi.js set weapon_builds.status = 'COMPLETE' and wrote
//  qa_operator and completed_at, then set weapon_serials.status. That is the
//  floor's own record of who passed the gun and when. If the customer's test
//  ran down that road it would re-stamp your QC man's work with the date of
//  their visit and whoever was holding the tablet.
//
//  THIS VERSION WRITES NOTHING TO weapon_builds OR weapon_serials. There is
//  no line of code in this file that can. It calls bc_ca_unit_signoff and
//  that function touches the customer tables only.
//
//  AND THE GATE IS DIFFERENT. Ours unlocks when everything PASSES. This one
//  unlocks when every item has been MARKED — pass or fail — because the
//  client signs for what they found, faults included. The fails are read
//  back from the database, shown to both of them, and acknowledged by name
//  before the signature is taken.
// ═══════════════════════════════════════════════════════════════════════════
async function signOffFromPdi() {
  const us = fatpdi.focus; if (!us) return;
  if (fatpdi.adminPreview) { showToast('🔓 Admin Preview — nothing is saved', 'warn'); return; }
  const op = String(state.operator || '').trim();
  if (!op) { showToast('Log in first — the sign-off is recorded against your operator number', 'error'); return; }
  if (!CA.visitId) { showToast('No acceptance visit is open', 'error'); return; }
  const btn = document.getElementById('btn-fp-signoff');
  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }

    // anything marked on screen and not yet saved goes down first
    if (_fpChanged()) {
      const saved = await saveFatPdi(us);
      if (!saved) return;
      fatpdi.focusSnap = { results: { ...(fatpdi.results[us] || {}) }, remarks: fatpdi.remarks[us] || '' };
    }

    // ask the database where the gun stands — never the screen's memory
    const items = _fpItems();
    const { data: st, error: stErr } = await supabaseClient.rpc('bc_ca_unit_state', {
      p_visit_id: CA.visitId, p_unit_serial: us, p_expected_items: items.length
    });
    if (stErr) throw stErr;
    if (!st) { showToast('Could not read where this gun stands', 'error'); return; }

    if (!st.can_sign) {
      showToast(`🚫 ${st.marked} of ${items.length} marked — every item has to be `
                + 'marked, pass or fail, before it can be signed', 'error');
      return;
    }

    const fails = Number(st.fails || 0);
    const failList = (st.fail_list || [])
      .map(f => `   • ${f.item_label || f.item_id}${f.remarks ? ' — ' + f.remarks : ''}`)
      .join('\n');

    // 26/11/2026: the representative is named ONCE, when the visit starts, and
    // signs ONCE on the screen when every selected unit is done. So this step
    // no longer asks for the name on every unit.
    const who = String(CA.customerRep || '').trim();
    if (!who) { showToast('Not signed — no representative is named on this visit', 'error'); return; }

    let acknowledged = false;
    if (fails > 0) {
      acknowledged = confirm(
        '⚠  SIGNING WITH ' + fails + ' FAILED ITEM(S)\n\n' + us + '\n\n' + failList +
        '\n\nBy going on, both ' + who + ' and OP ' + op + ' acknowledge these ' +
        'faults. They are recorded against this gun and go on the paper that ' +
        'is signed.\n\nThe gun can be reopened once they are put right, and ' +
        'signed again.\n\nAcknowledge and sign?');
      if (!acknowledged) { showToast('Not signed', 'warn'); return; }
    } else {
      if (!confirm('CLIENT ACCEPTANCE — UNIT DONE\n\n' + us +
                   '\n\nEvery item passed.\n\nFinish this unit for ' + who +
                   ', witnessed by OP ' + op + '?\n\n(' + who + ' signs once, when all ' +
                   'the selected units are done.)')) {
        showToast('Not signed', 'warn'); return;
      }
    }

    const { data: res, error } = await supabaseClient.rpc('bc_ca_unit_signoff', {
      p_visit_id: CA.visitId, p_unit_serial: us, p_our_rep: op,
      p_customer_rep: who, p_acknowledged: acknowledged, p_notes: null
    });
    if (error) throw error;
    if (res && res.ok === false) { showToast('❌ ' + (res.error || 'Not signed'), 'error'); return; }

    const u = fatpdi.units.find(x => x.unitSerial === us);
    if (u) { u.status = 'SIGNED'; u.caResult = (res && res.result) || null; }
    showToast(fails > 0
      ? `✅ ${us} done — ${fails} fault(s) recorded`
      : `✅ ${us} done — all passed`, 'ok');
    CA.sigPrompted = false;          // a unit just finished: offer the signature if it was the last
    CA.view = 'selected';            // and go to the page where they are all together
    closeFatPdiUnit(true);
  } catch (e) {
    console.error('[Client sign-off] error', e);
    showToast('❌ Sign-off failed — ' + ((e && e.message) || e), 'error');
  } finally {
    if (btn && btn.isConnected && btn.textContent === 'Checking…') btn.textContent = _fpSignOffLabel(us);
  }
}

function _fpUpdateCount() {
  const el = document.getElementById('fp-unit-count');
  if (!el || !fatpdi.focus) return;
  const p = _fpProgress(fatpdi.focus);
  el.textContent = `${p.done} of ${p.total} marked${p.fails ? ` · ${p.fails} FAIL` : ''}`;
  _fpUpdateBack();
}

// v1.44 (21/11/2026): the way back out of a unit. The warning only belongs
// there while something is NOT saved — after a Save "(don't save)" read as if
// it would throw the work away.
function _fpBackLabel() {
  return _fpChanged() ? "← Back to list (don't save)" : '← Back to list';
}
function _fpUpdateBack() {
  const b = document.getElementById('btn-fp-back');
  if (b) b.textContent = _fpBackLabel();
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
  // 26/11/2026: this waited on fatpdi._final, which the customer copy never
  // sets — so the sign-off panel did not follow the taps at all, and stayed
  // on "0 of N" until Save was pressed and the unit opened again.
  if (fatpdi.stage === 'PDI') _fpRefreshFinal(false);
}
function _fpRemarks(ta) {
  if (!fatpdi.focus) return;
  fatpdi.remarks[fatpdi.focus] = ta.value;
  fatpdi.touched[fatpdi.focus] = true;
  _fpTouch(fatpdi.focus);   // v1.35
  _fpUpdateBack();          // v1.44
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
  fatpdi._readyShown = null; _fpCloseReadyPopup();   // v1.44
  _fpShowList();
  _renderFatPdiList();
  if (CA.view === 'selected') {
    // 26/11/2026: back on the selected page — read it again, and if that was
    // the last unit, the signature pad comes up by itself
    _caRenderSelected();
    caLoadSelected(true);
  } else if (us) {
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
  if (!ok) return;
  // v1.43 (20/11/2026): GRN40 PDI — stay on the sight after Save, so the
  // Final Approval Sign-Off below can be done straight away.
  // v1.44 (21/11/2026): the same for RLL / XRGL40, but only when the gun is
  // now ready to be signed off — a part-done gun still goes back to the list
  // as before. Save used to close the page on a finished gun, which is how
  // RLL 260207 ended up through FAT and PDI with no sign-off.
  if (fatpdi.stage === 'PDI' && fatpdi.focus === us) {
    // 26/11/2026: judged from what is marked, not from the database's answer
    // from BEFORE this save — that was always "not ready", so Save threw the
    // man back to the list with the unit one tap from finished.
    const pr = _fpProgress(us);
    const ready = pr.total > 0 && pr.done >= pr.total
      && !(CA.state && CA.state[us] && CA.state[us].status === 'SIGNED');
    _renderFatPdiUnit();   // shows what is saved and re-checks the sign-off list
    if (ready || fatpdi.cardType === 'GRN40') {
      const fin = document.getElementById('fp-final');
      if (fin && fin.scrollIntoView) fin.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
  }
  closeFatPdiUnit(true);
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
// v1.40 (18/11/2026): the database hands back at most 1000 rows per read.
// 100 guns × 11 PDI / 13 FAT items = 1100 / 1300 rows — the rest were cut
// off, so once more than ~90 guns were loaded a refresh (every minute, Back,
// Save) wiped the results of the guns past row 1000. 50 guns per read =
// at most 650 rows.
const FP_READ_CHUNK = 50;
async function _fpReadFresh(serials, forOpen) {
  if (_isAcc() || !serials.length) return;
  for (let i = 0; i < serials.length; i += FP_READ_CHUNK) {
    const part = serials.slice(i, i + FP_READ_CHUNK);
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
// 25/11/2026 — EVERY result row has to say which VISIT and which ROUND it
// belongs to. Both row builders below were copied from fatpdi.js, where no
// such thing exists, and these two columns were never added — so every row
// went into weapon_customer_results with visit_id NULL, and nothing could be
// tied back to a visit (Matrix Card Results found nothing at all).
function _caRound(us) {
  const st = (CA.state && CA.state[us]) || null;
  return Number((st && st.round) || 1) || 1;
}
function _caStampRow(r, us) {
  r.visit_id = CA.visitId || null;
  r.round    = _caRound(us);
  return r;
}

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
      return _caStampRow(r, us);
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
      rows.push(_caStampRow({
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
      }, us));
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
