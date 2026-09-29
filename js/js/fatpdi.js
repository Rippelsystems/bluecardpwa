// ─── FAT / PDI MODULE ───────────────────────────────────────────────────────
// Grid-view digital equivalent of the paper FAT / PDI acceptance sheets.
// Fully separate from the Blue Card build screens and from each other:
//   - FAT results  -> weapon_fat_results
//   - PDI results  -> weapon_pdi_results
// A unit only appears here once its Blue Card build is COMPLETE, and the
// serial/trolley/position are read from that build — never re-typed.

const fatpdi = {
  stage: null,      // 'FAT' | 'PDI'
  cardType: null,   // 'RLL' | 'XRGL40' | 'GRN40'
  units: [],        // eligible units for this stage+cardType
  results: {},      // results[unitSerial][itemId] = 'PASS'|'FAIL'|null
  remarks: {},      // remarks[unitSerial] = text
  docCode: null
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
  const typeCfg = FATPDI_TYPES[cardType];
  const stageCfg = typeCfg[stage];
  fatpdi.docCode = stageCfg.docCode;
  fatpdi.results = {};
  fatpdi.remarks = {};

  document.getElementById('fatpdi-stage-badge').textContent = stage;
  document.getElementById('fatpdi-title').textContent = `${stage} — ${typeCfg.label}`;
  document.getElementById('fatpdi-op').textContent = state.operator || '—';

  show('screen-fatpdi');
  _loadFatPdiUnits();
}

// ── Load eligible units (Blue Card build must be COMPLETE) ─────────────────
async function _loadFatPdiUnits() {
  const grid = document.getElementById('fatpdi-grid');
  const emptyMsg = document.getElementById('fatpdi-empty-msg');
  const footer = document.getElementById('fatpdi-doc-footer');
  grid.innerHTML = '';
  emptyMsg.style.display = 'none';
  footer.textContent = 'Loading…';

  try {
    let units = [];

    if (fatpdi.cardType === 'GRN40') {
      // GRN40's own Blue Card build IS the sight unit — eligibility is its
      // own weapon_builds row, keyed by sight_serial.
      const { data } = await supabaseClient.from('weapon_builds')
        .select('id,sight_serial,trolley_number,trolley_position,client_country,contract_name')
        .eq('card_type', 'GRN40').eq('status', 'COMPLETE')
        .not('sight_serial', 'is', null)
        .order('trolley_number').order('trolley_position');
      units = (data || []).map(r => ({
        unitSerial: r.sight_serial,
        launcherSerial: null,
        sightSerial: r.sight_serial,
        trolleyNumber: r.trolley_number,
        trolleyPosition: r.trolley_position
      }));
    } else {
      const { data } = await supabaseClient.from('weapon_builds')
        .select('id,launcher_serial,sight_serial,trolley_number,trolley_position,client_country,contract_name')
        .eq('card_type', fatpdi.cardType).eq('status', 'COMPLETE')
        .not('launcher_serial', 'is', null)
        .order('trolley_number').order('trolley_position');
      units = (data || []).map(r => ({
        unitSerial: r.launcher_serial,
        launcherSerial: r.launcher_serial,
        sightSerial: r.sight_serial || null,
        trolleyNumber: r.trolley_number,
        trolleyPosition: r.trolley_position
      }));
    }

    fatpdi.units = units;

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

    if (units.length === 0) {
      emptyMsg.style.display = 'block';
      emptyMsg.textContent = `No ${fatpdi.cardType} units with a completed Blue Card build are available yet.`;
      return;
    }

    // Pull any existing results so re-opening the screen shows saved state
    const unitSerials = units.map(u => u.unitSerial);
    const { data: existing } = await supabaseClient.from(_fatpdiTable())
      .select('unit_serial,item_id,result,remarks')
      .eq('card_type', fatpdi.cardType).in('unit_serial', unitSerials);

    (existing || []).forEach(row => {
      if (!fatpdi.results[row.unit_serial]) fatpdi.results[row.unit_serial] = {};
      fatpdi.results[row.unit_serial][row.item_id] = row.result;
      if (row.remarks) fatpdi.remarks[row.unit_serial] = row.remarks;
    });

    _renderFatPdiGrid();
  } catch (e) {
    console.error('[FAT/PDI] load error', e);
    footer.textContent = '';
    emptyMsg.style.display = 'block';
    emptyMsg.textContent = 'Could not load units — check connection and try again.';
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
    html += `<td style="position:sticky;left:0;background:var(--bg,#0a1628);font-family:var(--font-mono,monospace);font-weight:700;">${us}${u.sightSerial && u.launcherSerial ? `<br><span style="font-size:10px;color:var(--text-dim,#8fa3c0);">Sight ${u.sightSerial}</span>` : ''}</td>`;
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
