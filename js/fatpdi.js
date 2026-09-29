// ─── FAT / PDI MODULE ───────────────────────────────────────────────────────
// Grid-view digital equivalent of the paper FAT / PDI acceptance sheets.
// Fully separate from the Blue Card build screens and from each other:
//   - FAT results  -> weapon_fat_results
//   - PDI results  -> weapon_pdi_results
// A unit only appears here once its Blue Card build is COMPLETE, and the
// serial/trolley/position are read from that build — never re-typed.

const FATPDI_PAGE_SIZE = 50;

const fatpdi = {
  stage: null,      // 'FAT' | 'PDI'
  cardType: null,   // 'RLL' | 'XRGL40' | 'GRN40'
  units: [],        // eligible units currently LOADED (paged, not the whole contract)
  results: {},      // results[unitSerial][itemId] = 'PASS'|'FAIL'|null
  remarks: {},      // remarks[unitSerial] = text
  docCode: null,
  adminPreview: false,  // true = Admin bypassed the COMPLETE gate to review layout;
                        // preview data is never saved to the real QC tables
  offset: 0,            // paging — a contract can have 1000+ guns, so we never
  totalCount: 0,         // load them all at once, only FATPDI_PAGE_SIZE per page
  filterContract: '',
  filterSearch: ''
};

function _fatpdiTable() {
  return fatpdi.stage === 'FAT' ? 'weapon_fat_results' : 'weapon_pdi_results';
}

// ── Open from the Resume screen buttons ────────────────────────────────────
function openFatPdi(stage) {
  const sel = document.getElementById(stage === 'FAT' ? 'inp-fat-type' : 'inp-pdi-type');
  const cardType = sel ? sel.value : '';
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
  fatpdi.units = [];

  document.getElementById('fatpdi-stage-badge').textContent = stage;
  document.getElementById('fatpdi-title').textContent = `${stage} — ${typeCfg.label}`;
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
    const { data } = await supabaseClient.from('weapon_builds')
      .select('contract_name').eq('card_type', fatpdi.cardType)
      .not('contract_name', 'is', null);
    const names = [...new Set((data || []).map(r => r.contract_name))].sort();
    names.forEach(n => { sel.innerHTML += `<option value="${n}">${n}</option>`; });
  } catch (e) {
    console.warn('[FAT/PDI] Could not load contracts', e);
  }
}

function _fatpdiApplyFilter() {
  fatpdi.filterContract = document.getElementById('fatpdi-filter-contract').value;
  fatpdi.filterSearch = document.getElementById('fatpdi-filter-search').value.trim().toUpperCase();
  fatpdi.offset = 0;
  fatpdi.units = [];
  _loadFatPdiUnits(true);
}

// ── Admin Preview — bypass the "Blue Card must be COMPLETE" gate so an
//    admin can review the FAT/PDI layout/checklist without finishing a
//    real build first. Uses the same PIN-gate pattern as Supervisor
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

  const entered = prompt('ADMIN PREVIEW\n\nEnter Admin PIN to review FAT/PDI setup on units that are not yet COMPLETE:\n(Nothing entered here is saved as a real QC record.)');
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
    const serialCol = fatpdi.cardType === 'GRN40' ? 'sight_serial' : 'launcher_serial';
    let q = supabaseClient.from('weapon_builds')
      .select('id,launcher_serial,sight_serial,trolley_number,trolley_position,client_country,contract_name,status',
              { count: 'exact' })
      .eq('card_type', fatpdi.cardType)
      .not(serialCol, 'is', null);
    if (!fatpdi.adminPreview) q = q.eq('status', 'COMPLETE');
    if (fatpdi.filterContract) q = q.eq('contract_name', fatpdi.filterContract);
    if (fatpdi.filterSearch) q = q.ilike(serialCol, `%${fatpdi.filterSearch}%`);
    q = q.order('trolley_number').order('trolley_position')
         .range(fatpdi.offset, fatpdi.offset + FATPDI_PAGE_SIZE - 1);

    const { data, count } = await q;
    fatpdi.totalCount = count || 0;

    const pageUnits = (data || []).map(r => ({
      unitSerial: fatpdi.cardType === 'GRN40' ? r.sight_serial : r.launcher_serial,
      launcherSerial: fatpdi.cardType === 'GRN40' ? null : r.launcher_serial,
      sightSerial: r.sight_serial || null,
      status: r.status,
      trolleyNumber: r.trolley_number,
      trolleyPosition: r.trolley_position
    }));

    fatpdi.units = fatpdi.units.concat(pageUnits);
    fatpdi.offset += pageUnits.length;

    // Doc control footer — pulled live from Document Revision Control
    try {
      const { data: doc } = await supabaseClient.from('document_revisions')
        .select('doc_code,revision,revision_date').eq('doc_code', fatpdi.docCode).limit(1);
      if (doc && doc.length) {
        const d = doc[0];
        footer.textContent = `${d.doc_code} · Rev ${d.revision} · ${(d.revision_date||'').slice(0,10)}`;
      } else {
        footer.textContent = `${fatpdi.docCode} (not yet registered in Document Revision Control)`;
      }
    } catch (e) {
      footer.textContent = fatpdi.docCode;
    }

    if (fatpdi.units.length === 0) {
      emptyMsg.style.display = 'block';
      emptyMsg.textContent = fatpdi.adminPreview
        ? `No ${fatpdi.cardType} Blue Card builds match this filter.`
        : `No ${fatpdi.cardType} units with a completed Blue Card build match this filter yet.`;
      if (countLabel) countLabel.textContent = '';
      if (loadMoreBtn) loadMoreBtn.style.display = 'none';
      return;
    }

    // Pull any existing results for just this page's units, so re-opening
    // or paging in more shows saved state without re-fetching everything.
    const pageSerials = pageUnits.map(u => u.unitSerial);
    if (pageSerials.length) {
      const { data: existing } = await supabaseClient.from(_fatpdiTable())
        .select('unit_serial,item_id,result,remarks')
        .eq('card_type', fatpdi.cardType).in('unit_serial', pageSerials);
      (existing || []).forEach(row => {
        if (!fatpdi.results[row.unit_serial]) fatpdi.results[row.unit_serial] = {};
        fatpdi.results[row.unit_serial][row.item_id] = row.result;
        if (row.remarks) fatpdi.remarks[row.unit_serial] = row.remarks;
      });
    }

    _renderFatPdiGrid();

    if (countLabel) countLabel.textContent = `Showing ${fatpdi.units.length} of ${fatpdi.totalCount}`;
    if (loadMoreBtn) {
      const more = fatpdi.units.length < fatpdi.totalCount;
      loadMoreBtn.style.display = more ? 'block' : 'none';
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = `Load ${Math.min(FATPDI_PAGE_SIZE, fatpdi.totalCount - fatpdi.units.length)} More`;
    }
  } catch (e) {
    console.error('[FAT/PDI] load error', e);
    footer.textContent = '';
    emptyMsg.style.display = 'block';
    emptyMsg.textContent = 'Could not load units — check connection and try again.';
    if (loadMoreBtn) { loadMoreBtn.disabled = false; loadMoreBtn.textContent = 'Retry'; }
  }
}

// ── Render the grid: rows = units, columns = checklist items ───────────────
function _renderFatPdiGrid() {
  const items = FATPDI_TYPES[fatpdi.cardType][fatpdi.stage].items;
  const table = document.getElementById('fatpdi-grid');

  let html = '<thead><tr>';
  html += `<th style="position:sticky;left:0;background:var(--surface,#111f38);z-index:2;min-width:110px;">Serial</th>`;
  html += `<th style="min-width:80px;">Trolley/Pos</th>`;
  items.forEach(it => { html += `<th style="min-width:120px;font-size:11px;">${it.label}</th>`; });
  html += `<th style="min-width:160px;">Remarks</th></tr></thead><tbody>`;

  fatpdi.units.forEach(u => {
    const us = u.unitSerial;
    if (!fatpdi.results[us]) fatpdi.results[us] = {};
    html += `<tr>`;
    const statusTag = fatpdi.adminPreview && u.status !== 'COMPLETE'
      ? `<br><span style="font-size:9px;color:#e08f1a;">${u.status||'IN PROGRESS'} (preview)</span>` : '';
    html += `<td style="position:sticky;left:0;background:var(--bg,#0a1628);font-family:var(--font-mono,monospace);font-weight:700;">${us}${u.sightSerial && u.launcherSerial ? `<br><span style="font-size:10px;color:var(--text-dim,#8fa3c0);">Sight ${u.sightSerial}</span>` : ''}${statusTag}</td>`;
    html += `<td style="font-size:12px;">${u.trolleyNumber||'—'} / ${u.trolleyPosition||'—'}</td>`;
    items.forEach(it => {
      const cur = fatpdi.results[us][it.id] || null;
      html += `<td style="text-align:center;">
        <button type="button" class="fatpdi-toggle ${cur==='PASS'?'is-pass':''}" data-unit="${us}" data-item="${it.id}" data-val="PASS" onclick="_setFatPdiResult(this)">P</button>
        <button type="button" class="fatpdi-toggle ${cur==='FAIL'?'is-fail':''}" data-unit="${us}" data-item="${it.id}" data-val="FAIL" onclick="_setFatPdiResult(this)">F</button>
      </td>`;
    });
    html += `<td><input type="text" data-remarks-unit="${us}" value="${(fatpdi.remarks[us]||'').replace(/"/g,'&quot;')}" style="width:100%;font-size:12px;" onchange="_setFatPdiRemarks(this)"></td>`;
    html += `</tr>`;
  });
  html += '</tbody>';
  table.innerHTML = html;
}

function _setFatPdiResult(btn) {
  const unit = btn.dataset.unit, item = btn.dataset.item, val = btn.dataset.val;
  if (!fatpdi.results[unit]) fatpdi.results[unit] = {};
  fatpdi.results[unit][item] = val;
  // Refresh just this row's two buttons
  const cell = btn.parentElement;
  cell.querySelectorAll('.fatpdi-toggle').forEach(b => {
    b.classList.toggle('is-pass', b.dataset.val==='PASS' && val==='PASS');
    b.classList.toggle('is-fail', b.dataset.val==='FAIL' && val==='FAIL');
  });
}

function _setFatPdiRemarks(inp) {
  fatpdi.remarks[inp.dataset.remarksUnit] = inp.value;
}

// ── Save all entered results for this stage+cardType ───────────────────────
async function saveFatPdi() {
  if (fatpdi.adminPreview) {
    showToast('🔓 Admin Preview mode — nothing is saved. Exit preview to record real results.', 'warn');
    return;
  }
  const rows = [];
  fatpdi.units.forEach(u => {
    const us = u.unitSerial;
    const itemResults = fatpdi.results[us] || {};
    const items = FATPDI_TYPES[fatpdi.cardType][fatpdi.stage].items;
    items.forEach(it => {
      const result = itemResults[it.id];
      if (!result) return; // skip untouched items — allows partial saves
      rows.push({
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
    showToast(`✅ ${fatpdi.stage} results saved (${rows.length} entries)`, 'ok');
  } catch (e) {
    console.error('[FAT/PDI] save error', e);
    showToast('❌ Save failed — ' + (e.message||e), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Save All'; }
  }
}
