// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  operator: null,
  checks: {},
  formData: {},
  serialVerified: false,
  buildId: null
};

// ─── REAL RLL CHECKS from physical card ───────────────────────────────────────
const RLL_CHECKS = [
  { id:'c01', label:'Cylinder Spacer Size — Front',    type:'measurement', unit:'mm' },
  { id:'c02', label:'Cylinder Spacer Size — Rear',     type:'measurement', unit:'mm' },
  { id:'c03', label:'Spacer Friction Size — Front',    type:'measurement', unit:'mm' },
  { id:'c04', label:'Spacer Friction Size — Rear',     type:'measurement', unit:'mm' },
  { id:'c05', label:'Flash Gap: GO & NO-GO',           type:'go_nogo' },
  { id:'c06', label:'Manual Advance',                  type:'pass_fail' },
  { id:'c07', label:'Cylinder Alignment',              type:'pass_fail' },
  { id:'c08', label:'Cylinder Torque',                 type:'measurement', unit:'Nm' },
  { id:'c09', label:'Trigger Pull',                    type:'measurement', unit:'N' },
  { id:'c10', label:'Firing Pin Protrusion',           type:'measurement', unit:'mm' },
  { id:'c11', label:'Centre Lock Pin-Lock',            type:'pass_fail' },
  { id:'c12', label:'Headspace',                       type:'measurement', unit:'mm' },
  { id:'c13', label:'Front Grip',                      type:'pass_fail' },
  { id:'c14', label:'Rear Stiffness',                  type:'pass_fail' },
  { id:'c15', label:'Barrel: GO & NO-GO',              type:'go_nogo' },
  { id:'c16', label:'Stock Movement',                  type:'pass_fail' },
  { id:'c17', label:'Cylinder Torque-Sim',             type:'measurement', unit:'Nm' },
  { id:'c18', label:'General Finish',                  type:'pass_fail' },
];

// ─── BOOT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initSupabase();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
  show('screen-login');
});

// ─── ROUTING ──────────────────────────────────────────────────────────────────
function show(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(screenId);
  if (el) { el.classList.add('active'); window.scrollTo(0,0); }
  document.querySelectorAll('.nav-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.screen === screenId));
  const nav = document.getElementById('bottom-nav');
  const hideNav = ['screen-login','screen-resume','screen-complete'].includes(screenId);
  if (nav) nav.classList.toggle('hidden', hideNav);
  // Show/hide switch operator button
  const swBtn = document.getElementById('switch-op-btn');
  if (swBtn) swBtn.style.display = hideNav ? 'none' : 'block';
}

function showSection(id) {
  if (id==='identity') refreshIdentity();
  if (id==='checks')   refreshChecks();
  if (id==='signoff')  refreshSignoff();
  const map = { identity:'screen-identity', checks:'screen-checks', signoff:'screen-signoff' };
  if (map[id]) show(map[id]);
}

// ─── SWITCH OPERATOR ──────────────────────────────────────────────────────────
function showSwitchOperator() {
  const newOp = prompt(`Current operator: ${state.operator}\n\nEnter new operator number:`);
  if (!newOp || !newOp.trim()) return;
  const prev = state.operator;
  state.operator = newOp.trim();
  // Update all operator displays
  ['id-op','resume-op'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = state.operator;
  });
  document.getElementById('switch-op-label').textContent = `OP ${state.operator}`;
  showToast(`Switched to Operator ${state.operator}`, 'ok');
  logActivity('OPERATOR_SWITCH', { from: prev, to: state.operator }, null);
}

// ─── LOGIN ─────────────────────────────────────────────────────────────────────
function handleLogin() {
  const op = document.getElementById('inp-operator').value.trim();
  if (!op) { showToast('Enter your operator number','error'); return; }
  state.operator = op;
  document.getElementById('resume-op').textContent = op;
  document.getElementById('switch-op-label').textContent = `OP ${op}`;
  show('screen-resume');
  loadResumeScreen();
}

// ─── RESUME SCREEN ────────────────────────────────────────────────────────────
async function loadResumeScreen() {
  const tSel = document.getElementById('inp-find-trolley');
  const pSel = document.getElementById('inp-find-pos');
  tSel.innerHTML = '<option value="">Trolley…</option>';
  pSel.innerHTML = '<option value="">Pos…</option>';
  for (let i=1;i<=20;i++) tSel.innerHTML += `<option value="${i}">Trolley ${i}</option>`;
  for (let i=1;i<=56;i++) pSel.innerHTML += `<option value="${i}">Pos ${i}</option>`;

  const listEl = document.getElementById('my-cards-list');
  listEl.innerHTML = '<div class="loading-msg">Loading…</div>';
  try {
    const { data } = await supabaseClient
      .from('weapon_builds')
      .select('id,launcher_serial,trolley_number,trolley_position,client_country,created_at,status')
      .eq('operator_number', state.operator)
      .neq('status','COMPLETE')
      .order('created_at',{ascending:false})
      .limit(10);
    if (!data || data.length===0) {
      listEl.innerHTML = '<div class="loading-msg">No incomplete cards — start a new one below</div>';
    } else {
      listEl.innerHTML = data.map(r => `
        <div class="resume-card" onclick="loadBuild('${r.id}')">
          <div style="font-family:var(--font-mono);font-size:14px;font-weight:700;color:var(--accent);">
            ${r.launcher_serial || 'No serial yet'}
          </div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:2px;">
            Trolley ${r.trolley_number||'—'} · Pos ${r.trolley_position||'—'} · ${r.client_country||'—'} · ${formatDate(new Date(r.created_at))}
          </div>
        </div>`).join('');
    }
  } catch(e) {
    listEl.innerHTML = '<div class="loading-msg">Could not load cards</div>';
  }
}

async function findBySerial() {
  const serial = document.getElementById('inp-find-serial').value.trim().toUpperCase();
  if (!serial) { showToast('Enter a serial number','error'); return; }
  const { data } = await supabaseClient.from('weapon_builds')
    .select('id').eq('launcher_serial',serial).neq('status','COMPLETE').limit(1);
  if (data && data.length>0) loadBuild(data[0].id);
  else showToast('No incomplete card found for that serial','warn');
}

async function findByTrolley() {
  const t = document.getElementById('inp-find-trolley').value;
  const p = document.getElementById('inp-find-pos').value;
  if (!t||!p) { showToast('Select trolley and position','error'); return; }
  const { data } = await supabaseClient.from('weapon_builds')
    .select('id').eq('trolley_number',t).eq('trolley_position',p).neq('status','COMPLETE').limit(1);
  if (data && data.length>0) loadBuild(data[0].id);
  else showToast('No incomplete card at that position','warn');
}

async function loadBuild(id) {
  showToast('Loading build card…','ok');
  const { data } = await supabaseClient.from('weapon_builds').select('*').eq('id',id).limit(1);
  if (!data||data.length===0) { showToast('Could not load card','error'); return; }
  const row = data[0];
  state.buildId = row.id;
  state.formData = { ...row };
  state.checks = row.checks || {};
  state.serialVerified = !!row.launcher_serial;
  showToast('Card loaded ✓','ok');
  refreshIdentity();
  show('screen-identity');
  document.getElementById('bottom-nav').classList.remove('hidden');
  populateTrolley(); populateYear(); loadCustomers();
  loadActivityLog(row.launcher_serial);
  initOCR();
}

function startNewCard() {
  state.buildId = null;
  state.formData = { operator_number:state.operator, card_type:'RLL', status:'IN PROGRESS', session_start:new Date().toISOString() };
  state.checks = {};
  state.serialVerified = false;
  clearFormInputs();
  refreshIdentity();
  show('screen-identity');
  document.getElementById('bottom-nav').classList.remove('hidden');
  populateTrolley(); populateYear(); loadCustomers(); initOCR();
}

function goToResume() {
  state.buildId=null; state.formData={}; state.checks={}; state.serialVerified=false;
  clearFormInputs(); show('screen-resume'); loadResumeScreen();
}

function endSession() {
  state.operator=null; state.buildId=null; state.formData={}; state.checks={};
  clearFormInputs(); show('screen-login');
}

function clearFormInputs() {
  document.querySelectorAll('input[type="text"],textarea').forEach(el=>el.value='');
  document.querySelectorAll('.serial-thumb').forEach(t=>{t.style.display='none';t.src='';});
  const lv=document.getElementById('launcher-verified');
  const lw=document.getElementById('launcher-confirm-wrap');
  if (lv) lv.style.display='none';
  if (lw) lw.style.display='none';
  document.getElementById('checks-list').innerHTML='';
  updateNavBadges();
}

// ─── IDENTITY ─────────────────────────────────────────────────────────────────
function refreshIdentity() {
  const opEl=document.getElementById('id-op');
  if (opEl) opEl.textContent=state.operator||'—';
  const map=getIdentityMap();
  Object.entries(map).forEach(([elId,key])=>{
    const el=document.getElementById(elId);
    if (el && state.formData[key]) el.value=state.formData[key];
  });
  if (state.serialVerified && state.formData.launcher_serial) {
    const lv=document.getElementById('launcher-verified');
    const lw=document.getElementById('launcher-confirm-wrap');
    if (lv) lv.style.display='block';
    if (lw) lw.style.display='none';
  }
  const logWrap=document.getElementById('activity-log-wrap');
  if (logWrap) logWrap.style.display=state.buildId?'block':'none';
}

function getIdentityMap() {
  return {
    'inp-trolley-no':'trolley_number','inp-trolley-pos':'trolley_position',
    'inp-year':'year_of_manufacture','inp-customer':'client_country',
    'inp-launcher-serial':'launcher_serial','inp-barrel-no':'barrel_no',
    'inp-barrel-prod-no':'barrel_production_no','inp-cylinder-no':'cylinder_no',
    'inp-hrc-serial':'hrc_serial_no','inp-cylinder-prod-no':'cylinder_production_no',
    'inp-hfm-serial':'hfm_serial_no','inp-firing-mech':'firing_mech_no',
  };
}

function resetSerialConfirm() {
  state.serialVerified=false;
  const lv=document.getElementById('launcher-verified');
  const lw=document.getElementById('launcher-confirm-wrap');
  const val=document.getElementById('inp-launcher-serial').value.trim();
  if (lv) lv.style.display='none';
  if (lw) lw.style.display=val.length>2?'block':'none';
}

async function confirmLauncherSerial() {
  const s1=document.getElementById('inp-launcher-serial').value.trim().toUpperCase();
  const s2=document.getElementById('inp-launcher-confirm').value.trim().toUpperCase();
  if (!s1||!s2) { showToast('Enter serial in both fields','error'); return; }
  if (s1!==s2)  { showToast('Serials do not match','error'); return; }
  if (!state.buildId) {
    const isDupe=await checkDuplicateSerial(s1);
    if (isDupe) { showToast(`DUPLICATE — ${s1} already exists`,'error'); return; }
  }
  state.formData.launcher_serial=s1;
  state.serialVerified=true;
  const lv=document.getElementById('launcher-verified');
  const lw=document.getElementById('launcher-confirm-wrap');
  if (lv) lv.style.display='block';
  if (lw) lw.style.display='none';
  showToast('Launcher serial confirmed ✓','ok');
}

async function saveIdentity() {
  if (!state.serialVerified) { showToast('Please confirm launcher serial first','error'); return; }
  const map=getIdentityMap();
  Object.entries(map).forEach(([elId,key])=>{
    const el=document.getElementById(elId); if (el) state.formData[key]=el.value;
  });
  let result, error;
  if (state.buildId) {
    ({data:result,error}=await supabaseClient.from('weapon_builds')
      .update({...state.formData,updated_at:new Date().toISOString()}).eq('id',state.buildId).select());
  } else {
    ({data:result,error}=await supabaseClient.from('weapon_builds').insert({...state.formData}).select());
    if (!error&&result&&result.length>0) state.buildId=result[0].id;
  }
  if (error) { console.error(error); showToast('Save failed','error'); return; }
  await logActivity('IDENTITY_SAVE',state.formData,null);
  showToast('Identity saved ✓','ok');
  loadActivityLog(state.formData.launcher_serial);
}

// ─── ACTIVITY LOG ─────────────────────────────────────────────────────────────
async function logActivity(action,fields,checks) {
  if (!state.formData.launcher_serial) return;
  try {
    await supabaseClient.from('weapon_build_sessions').insert({
      launcher_serial:state.formData.launcher_serial,
      operator_number:state.operator, action,
      fields_updated:fields?JSON.stringify(fields):null,
      checks_updated:checks?JSON.stringify(checks):null,
    });
  } catch(e) { console.warn('Log failed',e); }
}

async function loadActivityLog(serial) {
  if (!serial) return;
  const logEl=document.getElementById('activity-log'); if (!logEl) return;
  try {
    const {data}=await supabaseClient.from('weapon_build_sessions')
      .select('operator_number,action,created_at').eq('launcher_serial',serial)
      .order('created_at',{ascending:true});
    if (!data||data.length===0) { logEl.innerHTML='<div style="color:var(--text-dim);font-style:italic;font-size:12px;">No activity yet</div>'; return; }
    logEl.innerHTML=data.map(r=>`
      <div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px;">
        <span style="font-family:var(--font-mono);color:var(--accent);font-weight:700;flex-shrink:0;">OP ${r.operator_number}</span>
        <span style="flex:1;">${r.action.replace(/_/g,' ')}</span>
        <span style="color:var(--text-dim);flex-shrink:0;">${formatDate(new Date(r.created_at))}</span>
      </div>`).join('');
  } catch(e) {}
}

// ─── TROLLEY / YEAR / CUSTOMERS ───────────────────────────────────────────────
function populateTrolley() {
  const tSel=document.getElementById('inp-trolley-no');
  if (!tSel||tSel.options.length>1) return;
  tSel.innerHTML='<option value="">— Select —</option>';
  for (let i=1;i<=20;i++) tSel.innerHTML+=`<option value="${i}">Trolley ${i}</option>`;
  const pSel=document.getElementById('inp-trolley-pos');
  pSel.innerHTML='<option value="">— Select —</option>';
  for (let i=1;i<=56;i++) pSel.innerHTML+=`<option value="${i}">Pos ${i}</option>`;
  if (!state.buildId) autoSuggestTrolley();
}

async function autoSuggestTrolley() {
  try {
    const {data}=await supabaseClient.from('weapon_builds')
      .select('trolley_number,trolley_position').not('trolley_number','is',null)
      .order('created_at',{ascending:false}).limit(1);
    let t=1,p=1;
    if (data&&data.length>0&&data[0].trolley_number) {
      t=data[0].trolley_number; p=(data[0].trolley_position||0)+1;
      if (p>56){t++;p=1;} if (t>20) t=20;
    }
    document.getElementById('inp-trolley-no').value=t;
    document.getElementById('inp-trolley-pos').value=p;
    state.formData.trolley_number=String(t);
    state.formData.trolley_position=String(p);
  } catch(e){}
}

function handleTrolleyChange() { document.getElementById('inp-trolley-pos').value=1; }

function populateYear() {
  const sel=document.getElementById('inp-year');
  if (!sel||sel.options.length>1) return;
  sel.innerHTML='<option value="">— Select —</option>';
  const y=new Date().getFullYear();
  for (let i=y;i<=y+2;i++) sel.innerHTML+=`<option value="${i}">${i}</option>`;
  if (!state.formData.year_of_manufacture) sel.value=y;
}

async function loadCustomers() {
  try {
    const {data}=await supabaseClient.from('weapon_serials').select('customer').order('customer');
    const unique=[...new Set((data||[]).map(r=>r.customer).filter(Boolean))];
    const sel=document.getElementById('inp-customer');
    sel.innerHTML='<option value="">— Select —</option>';
    unique.forEach(c=>sel.innerHTML+=`<option value="${c}">${c}</option>`);
    if (state.formData.client_country) sel.value=state.formData.client_country;
  } catch(e){}
}

// ─── CHECKS ───────────────────────────────────────────────────────────────────
function refreshChecks() {
  const container=document.getElementById('checks-list');
  if (container.children.length===RLL_CHECKS.length) {
    RLL_CHECKS.forEach(c=>applyCheckVisual(c.id));
    updateChecksProgress(); return;
  }
  container.innerHTML='';
  RLL_CHECKS.forEach(chk=>{
    const saved=state.checks[chk.id]||{};
    const row=document.createElement('div');
    row.className='check-row'; row.id=`chk-row-${chk.id}`;

    // Build result buttons based on type
    let resultBtns='';
    if (chk.type==='go_nogo') {
      resultBtns=`
        <button class="chk-btn pass" onclick="setCheck('${chk.id}','GO')">GO</button>
        <button class="chk-btn fail" onclick="setCheck('${chk.id}','NO-GO')">NO-GO</button>
        <button class="chk-btn na"   onclick="setCheck('${chk.id}','N/A')">N/A</button>`;
    } else if (chk.type==='measurement') {
      resultBtns=`
        <button class="chk-btn pass" onclick="setCheck('${chk.id}','PASS')">PASS</button>
        <button class="chk-btn fail" onclick="setCheck('${chk.id}','FAIL')">FAIL</button>
        <button class="chk-btn na"   onclick="setCheck('${chk.id}','N/A')">N/A</button>`;
    } else {
      resultBtns=`
        <button class="chk-btn pass" onclick="setCheck('${chk.id}','PASS')">PASS</button>
        <button class="chk-btn fail" onclick="setCheck('${chk.id}','FAIL')">FAIL</button>
        <button class="chk-btn na"   onclick="setCheck('${chk.id}','N/A')">N/A</button>`;
    }

    // Measurement value field
    const measField = chk.type==='measurement' ? `
      <input type="text" class="chk-measure" id="chk-val-${chk.id}"
             placeholder="Value (${chk.unit})" value="${saved.value||''}"
             onchange="setCheckValue('${chk.id}',this.value)"
             style="width:100%;border:none;border-bottom:1px solid var(--border);
                    background:transparent;font-size:12px;padding:3px 2px;
                    margin-top:6px;outline:none;color:var(--text);">` : '';

    row.innerHTML=`
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px;">
        <span class="check-label" style="margin:0;">${chk.label}</span>
        <div class="assy-stamp" id="assy-${chk.id}" onclick="editAssyNo('${chk.id}')"
             title="Tap to change operator"
             style="font-size:10px;font-family:var(--font-mono);color:var(--text-dim);
                    background:var(--bg);border:1px solid var(--border);border-radius:4px;
                    padding:2px 6px;cursor:pointer;flex-shrink:0;white-space:nowrap;">
          OP ${saved.assy_no||state.operator||'—'}
        </div>
      </div>
      ${measField}
      <div class="check-btns" style="margin-top:8px;">${resultBtns}</div>`;
    container.appendChild(row);
    if (saved.result) applyCheckVisual(chk.id);
  });
  updateChecksProgress();
}

function setCheck(id, result) {
  if (!state.checks[id]) state.checks[id]={};
  state.checks[id].result   = result;
  state.checks[id].assy_no  = state.checks[id].assy_no || state.operator;
  state.checks[id].timestamp= new Date().toISOString();
  applyCheckVisual(id);
  updateChecksProgress();
  updateNavBadges();
  // Update assy stamp display
  const stamp=document.getElementById(`assy-${id}`);
  if (stamp) stamp.textContent=`OP ${state.checks[id].assy_no}`;
}

function setCheckValue(id, value) {
  if (!state.checks[id]) state.checks[id]={};
  state.checks[id].value=value;
}

function editAssyNo(id) {
  const current=state.checks[id]?.assy_no||state.operator;
  const newNo=prompt(`Assy No for this check:\nCurrently: ${current}\n\nEnter operator number:`);
  if (!newNo||!newNo.trim()) return;
  if (!state.checks[id]) state.checks[id]={};
  state.checks[id].assy_no=newNo.trim();
  const stamp=document.getElementById(`assy-${id}`);
  if (stamp) stamp.textContent=`OP ${newNo.trim()}`;
  showToast(`Assy No updated to ${newNo.trim()}`,'ok');
}

function applyCheckVisual(id) {
  const chkData=state.checks[id]; if (!chkData||!chkData.result) return;
  const result=chkData.result;
  const row=document.getElementById(`chk-row-${id}`); if (!row) return;
  const isPass=result==='PASS'||result==='GO';
  const isFail=result==='FAIL'||result==='NO-GO';
  row.setAttribute('data-result', isPass?'PASS':isFail?'FAIL':'N/A');
  row.querySelectorAll('.chk-btn').forEach(b=>b.classList.remove('selected'));
  // Find button by text content
  row.querySelectorAll('.chk-btn').forEach(b=>{
    if (b.textContent.trim()===result) b.classList.add('selected');
  });
}

function updateChecksProgress() {
  const done=Object.values(state.checks).filter(v=>v&&v.result).length;
  const total=RLL_CHECKS.length;
  const fails=Object.values(state.checks).filter(v=>v&&(v.result==='FAIL'||v.result==='NO-GO')).length;
  const el=document.getElementById('checks-progress');
  if (el) el.textContent=`${done}/${total}${fails>0?` · ${fails} FAIL`:''}`;
}

async function saveChecks() {
  const done=Object.values(state.checks).filter(v=>v&&v.result).length;
  if (state.buildId) {
    await supabaseClient.from('weapon_builds').update({checks:state.checks}).eq('id',state.buildId);
    await logActivity('CHECKS_SAVE',null,state.checks);
  }
  showToast(`Progress saved — ${done}/${RLL_CHECKS.length} marked`,'ok');
}

function updateNavBadges() {
  const done=Object.values(state.checks).filter(v=>v&&v.result).length;
  const el=document.getElementById('nav-badge-checks');
  if (el){el.textContent=done>0?`${done}/${RLL_CHECKS.length}`:'';el.style.display=done>0?'inline':'none';}
}

// ─── SIGNOFF ──────────────────────────────────────────────────────────────────
function refreshSignoff() {
  document.getElementById('so-serial').textContent  = state.formData.launcher_serial||'—';
  document.getElementById('so-trolley').textContent = `${state.formData.trolley_number||'—'} / Pos ${state.formData.trolley_position||'—'}`;
  document.getElementById('so-client').textContent  = state.formData.client_country||'—';
  const done=Object.values(state.checks).filter(v=>v&&v.result).length;
  const fails=Object.values(state.checks).filter(v=>v&&(v.result==='FAIL'||v.result==='NO-GO')).length;
  document.getElementById('so-checks').textContent=`${done} / ${RLL_CHECKS.length}`;
  const fb=document.getElementById('so-fails');
  fb.textContent=fails; fb.className=`badge ${fails>0?'fail':'pass'}`;
  if (state.formData.qa_operator) document.getElementById('inp-qa-operator').value=state.formData.qa_operator;
  if (state.formData.qa_note)     document.getElementById('inp-qa-note').value=state.formData.qa_note;
}

async function handleSubmit() {
  const qa=document.getElementById('inp-qa-operator').value.trim();
  const fat=document.getElementById('inp-fat-name').value.trim();
  if (!qa)  { showToast('QA operator number required','error'); return; }
  if (!fat) { showToast('FAT name required','error'); return; }
  const btn=document.getElementById('btn-submit');
  btn.textContent='Saving…'; btn.disabled=true;
  const updates={
    qa_operator:qa,
    qa_note:document.getElementById('inp-qa-note').value.trim()||null,
    fat_name:fat,
    fat_date:document.getElementById('inp-fat-date').value||null,
    completed_at:new Date().toISOString(),
    checks:state.checks,
    checks_complete:Object.values(state.checks).filter(v=>v&&v.result).length===RLL_CHECKS.length,
    status:'COMPLETE'
  };
  let error;
  if (state.buildId) {
    ({error}=await supabaseClient.from('weapon_builds').update(updates).eq('id',state.buildId));
  } else {
    ({error}=await supabaseClient.from('weapon_builds').insert({...state.formData,...updates}));
  }
  if (!error && state.formData.launcher_serial) {
    await supabaseClient.from('weapon_serials')
      .update({status:'COMPLETE'}).eq('serial_number',state.formData.launcher_serial);
  }
  await logActivity('QA_SIGNOFF',{qa_operator:qa,fat_name:fat},state.checks);
  btn.textContent='Submit & Save Build Card'; btn.disabled=false;
  if (error){console.error(error);showToast('Save failed','error');return;}
  showToast('Build card saved ✓','ok');
  document.getElementById('done-serial').textContent=state.formData.launcher_serial||'—';
  setTimeout(()=>show('screen-complete'),800);
}

// ─── CAMERA + OCR ─────────────────────────────────────────────────────────────
let tesseractWorker=null;
async function initOCR() {
  try {
    tesseractWorker=await Tesseract.createWorker('eng');
    await tesseractWorker.setParameters({tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- '});
    const el=document.getElementById('ocr-status');
    if (el) el.textContent='📷 Camera ready — tap icon next to any yellow serial field';
  } catch(e) {
    const el=document.getElementById('ocr-status');
    if (el) el.textContent='⚠ OCR not available — type serials manually';
  }
}

async function captureSerial(fieldId,photoKey) {
  const input=document.createElement('input');
  input.type='file'; input.accept='image/*'; input.capture='environment';
  input.style.display='none'; document.body.appendChild(input);
  input.onchange=async(e)=>{
    const file=e.target.files[0];
    if (!file){document.body.removeChild(input);return;}
    const reader=new FileReader();
    reader.onload=async(ev)=>{
      const base64=ev.target.result;
      state.formData[photoKey]=base64;
      const thumb=document.getElementById(`thumb-${fieldId}`);
      if (thumb){thumb.src=base64;thumb.style.display='block';}
      const inp=document.getElementById(fieldId);
      if (inp){inp.placeholder='Reading…';inp.disabled=true;}
      const statusEl=document.getElementById('ocr-status');
      if (statusEl) statusEl.textContent='🔍 Reading serial number…';
      showToast('Reading serial…','ok');
      try {
        if (!tesseractWorker) await initOCR();
        const {data}=await tesseractWorker.recognize(base64);
        let text=data.text.trim().toUpperCase().replace(/\n/g,' ').replace(/\s+/g,' ').trim();
        if (inp){inp.value=text;inp.disabled=false;inp.placeholder='Confirm or correct';}
        if (statusEl) statusEl.textContent='✓ Read — confirm or correct the value above';
        if (fieldId==='inp-launcher-serial') resetSerialConfirm();
        showToast('Done — confirm serial ✓','ok');
      } catch(err) {
        if (inp){inp.disabled=false;inp.placeholder='Type manually';}
        if (statusEl) statusEl.textContent='⚠ Could not read — type manually';
        showToast('OCR failed — type manually','warn');
      }
    };
    reader.readAsDataURL(file);
    document.body.removeChild(input);
  };
  input.click();
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function formatDate(d){return new Date(d).toLocaleDateString('en-ZA',{day:'2-digit',month:'short',year:'numeric'});}
let toastTimer;
function showToast(msg,type='ok'){
  const t=document.getElementById('toast');
  t.textContent=msg; t.className=`toast ${type} visible`;
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.classList.remove('visible'),3200);
}
