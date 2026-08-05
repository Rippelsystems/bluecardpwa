// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  operator: null,
  cardType: 'RLL',
  currentSection: 'login',
  formData: {},
  serialVerified: false,
  checks: {},
  savedToDb: false,
  dbRecordId: null
};

// ─── RLL CHECK LIST ───────────────────────────────────────────────────────────
// Placeholder checks — replace with actual check items from reviewed PDF
const RLL_CHECKS = [
  { id: 'c01', label: 'Frame inspection — no cracks or deformation' },
  { id: 'c02', label: 'Barrel installation correct and torqued' },
  { id: 'c03', label: 'Bolt carrier group fitted and cycles freely' },
  { id: 'c04', label: 'Trigger group installed — pull weight within spec' },
  { id: 'c05', label: 'Pistol grip fitted and fastened' },
  { id: 'c06', label: 'Stock / buffer assembly installed' },
  { id: 'c07', label: 'Magazine catch operates correctly' },
  { id: 'c08', label: 'Safety selector — all positions confirmed' },
  { id: 'c09', label: 'Dust cover fitted and spring-loaded correctly' },
  { id: 'c10', label: 'Handguard secured — no movement' },
  { id: 'c11', label: 'Gas system installed and aligned' },
  { id: 'c12', label: 'Muzzle device fitted and torqued' },
  { id: 'c13', label: 'All external surfaces — finish inspection' },
  { id: 'c14', label: 'Serial number engraving — legible and correct' },
  { id: 'c15', label: 'Function test — dry cycle confirmed' },
  { id: 'c16', label: 'Lubrication applied per spec' },
  { id: 'c17', label: 'Final visual — no loose components or tooling left' }
];

// ─── SECTIONS CONFIG ──────────────────────────────────────────────────────────
const SECTIONS = [
  { id: 'identity',  label: 'Identity',  icon: '📋', screen: 'screen-identity'  },
  { id: 'serial',    label: 'Serial',    icon: '🔢', screen: 'screen-serial'    },
  { id: 'checks',    label: 'Checks',    icon: '✅', screen: 'screen-checks'    },
  { id: 'signoff',   label: 'Sign-off',  icon: '🖊', screen: 'screen-signoff'   },
];

// ─── BOOT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initSupabase();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(console.error);
  }
  show('screen-login');
});

// ─── ROUTING ──────────────────────────────────────────────────────────────────
function show(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(screenId);
  if (el) { el.classList.add('active'); window.scrollTo(0, 0); }
  state.currentSection = screenId;
  updateNav(screenId);
}

function updateNav(screenId) {
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.screen === screenId);
  });
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
function handleLogin() {
  const opNum = document.getElementById('inp-operator').value.trim();
  if (!opNum) { showToast('Enter your operator number', 'error'); return; }
  state.operator = opNum;
  state.formData.operator_number = opNum;
  state.formData.card_type = 'RLL';
  state.formData.session_start = new Date().toISOString();
  showToast(`Session started — Operator ${opNum}`, 'ok');
  setTimeout(() => showSection('identity'), 500);
}

// ─── SECTION NAV (from tab bar or direct call) ────────────────────────────────
function showSection(sectionId) {
  const sec = SECTIONS.find(s => s.id === sectionId);
  if (!sec) return;
  // Refresh dynamic content before showing
  if (sectionId === 'identity')  refreshIdentity();
  if (sectionId === 'checks')    refreshChecks();
  if (sectionId === 'signoff')   refreshSignoff();
  show(sec.screen);
}

// ─── IDENTITY / HEADER ────────────────────────────────────────────────────────
function refreshIdentity() {
  document.getElementById('hdr-assy-no-display').textContent = state.operator;
  document.getElementById('hdr-date').textContent = formatDate(new Date());
  // Restore any previously saved values
  const fields = ['inp-serial','inp-lot','inp-batch','inp-contract','inp-customer',
                  'inp-model','inp-calibre','inp-barrel-len','inp-stock-type',
                  'inp-grip-type','inp-trigger-type','inp-colour','inp-spec-ref'];
  fields.forEach(f => {
    const key = f.replace('inp-','').replace(/-/g,'_');
    const el = document.getElementById(f);
    if (el && state.formData[key]) el.value = state.formData[key];
  });
}

function saveIdentity() {
  const fields = ['inp-serial','inp-lot','inp-batch','inp-contract','inp-customer',
                  'inp-model','inp-calibre','inp-barrel-len','inp-stock-type',
                  'inp-grip-type','inp-trigger-type','inp-colour','inp-spec-ref'];
  let anyFilled = false;
  fields.forEach(f => {
    const el = document.getElementById(f);
    if (el && el.value.trim()) {
      el.classList.remove('error');
      state.formData[f.replace('inp-','').replace(/-/g,'_')] = el.value.trim();
      anyFilled = true;
    }
  });
  if (anyFilled) showToast('Identity fields saved', 'ok');
  else showToast('Nothing to save yet', 'warn');
}

// ─── SERIAL VERIFICATION ──────────────────────────────────────────────────────
async function handleSerialConfirm() {
  const e1 = document.getElementById('inp-serial-1').value.trim().toUpperCase();
  const e2 = document.getElementById('inp-serial-2').value.trim().toUpperCase();

  if (!e1 || !e2) { showToast('Enter serial in both fields', 'error'); return; }
  if (e1 !== e2)  { showToast('Entries do not match — check and re-enter', 'error'); return; }

  const btn = document.getElementById('btn-serial-confirm');
  btn.textContent = 'Checking…';
  btn.disabled = true;

  const isDupe = await checkDuplicateSerial(e1);
  btn.textContent = 'Confirm Serial';
  btn.disabled = false;

  if (isDupe) {
    showToast(`DUPLICATE — ${e1} already in system`, 'error');
    return;
  }

  state.formData.serial_number = e1;
  state.serialVerified = true;
  document.getElementById('serial-status').textContent = `✓ Verified: ${e1}`;
  document.getElementById('serial-status').className = 'serial-verified ok';
  showToast('Serial verified ✓', 'ok');
}

// ─── INSPECTION CHECKS ────────────────────────────────────────────────────────
function refreshChecks() {
  const container = document.getElementById('checks-list');
  // Only rebuild DOM if empty — preserve existing selections
  if (container.children.length === RLL_CHECKS.length) {
    // Just re-apply visual state from state.checks
    RLL_CHECKS.forEach(chk => applyCheckVisual(chk.id));
    updateChecksProgress();
    return;
  }
  container.innerHTML = '';
  RLL_CHECKS.forEach(chk => {
    const row = document.createElement('div');
    row.className = 'check-row';
    row.id = `chk-row-${chk.id}`;
    row.innerHTML = `
      <span class="check-label">${chk.label}</span>
      <div class="check-btns">
        <button class="chk-btn pass" onclick="setCheck('${chk.id}','PASS')">PASS</button>
        <button class="chk-btn fail" onclick="setCheck('${chk.id}','FAIL')">FAIL</button>
        <button class="chk-btn na"   onclick="setCheck('${chk.id}','N/A')">N/A</button>
      </div>`;
    container.appendChild(row);
    if (state.checks[chk.id]) applyCheckVisual(chk.id);
  });
  updateChecksProgress();
}

function setCheck(id, result) {
  state.checks[id] = result;
  applyCheckVisual(id);
  updateChecksProgress();
  updateNavBadges();
}

function applyCheckVisual(id) {
  const result = state.checks[id];
  if (!result) return;
  const row = document.getElementById(`chk-row-${id}`);
  if (!row) return;
  row.setAttribute('data-result', result);
  row.querySelectorAll('.chk-btn').forEach(b => b.classList.remove('selected'));
  const cls = result === 'PASS' ? 'pass' : result === 'FAIL' ? 'fail' : 'na';
  const btn = row.querySelector(`.chk-btn.${cls}`);
  if (btn) btn.classList.add('selected');
}

function updateChecksProgress() {
  const done   = Object.keys(state.checks).length;
  const total  = RLL_CHECKS.length;
  const fails  = Object.values(state.checks).filter(v => v === 'FAIL').length;
  const el     = document.getElementById('checks-progress');
  if (el) el.textContent = `${done} / ${total} marked${fails > 0 ? ` · ${fails} FAIL` : ''}`;
}

function saveChecks() {
  const done  = Object.keys(state.checks).length;
  const total = RLL_CHECKS.length;
  showToast(`Checks saved — ${done}/${total} marked`, 'ok');
}

// ─── QA SIGN-OFF ──────────────────────────────────────────────────────────────
function refreshSignoff() {
  document.getElementById('so-summary-serial').textContent   = state.formData.serial_number || '—';
  document.getElementById('so-summary-operator').textContent = state.operator || '—';
  document.getElementById('so-summary-date').textContent     = formatDate(new Date());
  const done   = Object.keys(state.checks).length;
  const total  = RLL_CHECKS.length;
  const fails  = Object.values(state.checks).filter(v => v === 'FAIL').length;
  document.getElementById('so-checks-done').textContent  = `${done} / ${total}`;
  document.getElementById('so-fail-count').textContent   = fails;
  document.getElementById('so-fail-count').className     = `badge ${fails > 0 ? 'fail' : 'pass'}`;
  // Restore previous QA input if any
  if (state.formData.qa_operator) {
    document.getElementById('inp-qa-operator').value = state.formData.qa_operator;
  }
  if (state.formData.qa_note) {
    document.getElementById('inp-qa-note').value = state.formData.qa_note;
  }
}

async function handleSubmit() {
  const qaOperator = document.getElementById('inp-qa-operator').value.trim();
  const qaNote     = document.getElementById('inp-qa-note').value.trim();
  if (!qaOperator) { showToast('QA operator number required', 'error'); return; }

  // Warn if incomplete but don't block — operator may be doing partial save
  const done  = Object.keys(state.checks).length;
  const total = RLL_CHECKS.length;
  if (done < total) {
    showToast(`Note: ${total - done} checks not yet marked`, 'warn');
  }

  state.formData.qa_operator = qaOperator;
  state.formData.qa_note     = qaNote || null;

  const btn = document.getElementById('btn-submit');
  btn.textContent = 'Saving…';
  btn.disabled = true;

  const buildRecord = {
    ...state.formData,
    completed_at: new Date().toISOString(),
    checks: state.checks,
    checks_complete: done === total
  };

  const { result, error } = await saveRecord('weapon_builds', buildRecord);

  btn.textContent = 'Submit & Save Build Card';
  btn.disabled = false;

  if (error) {
    console.error(error);
    showToast('Save failed — check connection', 'error');
    return;
  }

  state.savedToDb = true;
  showToast('Build card saved ✓', 'ok');
  setTimeout(() => show('screen-complete'), 800);
  document.getElementById('done-serial').textContent = state.formData.serial_number || '—';
}

// ─── COMPLETE ─────────────────────────────────────────────────────────────────
function startNewCard() {
  state.formData     = { operator_number: state.operator, card_type: 'RLL', session_start: new Date().toISOString() };
  state.checks       = {};
  state.serialVerified = false;
  state.savedToDb    = false;
  // Clear form inputs
  ['inp-serial','inp-lot','inp-batch','inp-contract','inp-customer','inp-model',
   'inp-calibre','inp-barrel-len','inp-stock-type','inp-grip-type','inp-trigger-type',
   'inp-colour','inp-spec-ref','inp-serial-1','inp-serial-2','inp-qa-operator','inp-qa-note']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('serial-status').textContent = 'Not yet verified';
  document.getElementById('serial-status').className = 'serial-verified';
  document.getElementById('checks-list').innerHTML = '';
  updateNavBadges();
  showSection('identity');
}

function endSession() {
  state.operator = null;
  startNewCard();
  show('screen-login');
}

// ─── NAV BADGES ───────────────────────────────────────────────────────────────
function updateNavBadges() {
  const checksTotal = RLL_CHECKS.length;
  const checksDone  = Object.keys(state.checks).length;
  const el = document.getElementById('nav-badge-checks');
  if (el) {
    el.textContent = checksDone > 0 ? `${checksDone}/${checksTotal}` : '';
    el.style.display = checksDone > 0 ? 'inline' : 'none';
  }
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function formatDate(d) {
  return d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
}

let toastTimer;
function showToast(msg, type = 'ok') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type} visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('visible'), 3200);
}
