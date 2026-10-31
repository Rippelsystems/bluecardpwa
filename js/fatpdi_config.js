// ─── FAT / PDI CHECKLIST CONFIGURATIONS ────────────────────────────────────
// Item lists taken verbatim (column order) from the real paper acceptance
// sheets supplied:
//   RES-QC-20  RLL 37/38  FAT   RES-QC-21  RLL 37/38  PDI
//   RES-QC-08  XRGL40     FAT   RES-QC-14  XRGL40     PDI
//   RES-QC-16  GRN40 Sighting System — Acceptance List (used for both
//              the GRN40 FAT stage and the GRN40 PDI stage, entered
//              independently by separate staff into separate tables)
//              31/10/2026 (v1.25): the GRN40 FAT stage is the full RES-QC-16
//              FINAL ACCEPTANCE by QC — 8 actions PASS/FAIL, Remarks, Notes,
//              ACCEPT YES/NO, Country, Acceptance Specification 105-AC-SZ,
//              inspected by / date (acceptance: true below). Its units come
//              from the GRN40 SERIAL REGISTER (weapon_serials), not from
//              build cards; results go to weapon_fat_results as before
//              (extra columns: grn40_acceptance_31Oct.sql).
//
// FAT and PDI are two entirely separate stages/tables (weapon_fat_results /
// weapon_pdi_results) — this file only supplies the *item list + doc_code*
// for each, it does not merge the stages.

const FATPDI_TYPES = {

  RLL: {
    label: 'RLL 37/38',
    keyedBy: 'launcher_serial',      // follows the Blue Card launcher_serial
    FAT: {
      docCode: 'RES-QC-20',
      items: [
        { id:'f01', label:'General Finish & Cosmetics' },
        { id:'f02', label:'Functioning' },
        { id:'f03', label:'Butt Stock' },
        { id:'f04', label:'Safety Catch & Trigger Mechanism' },
        { id:'f05', label:'Index Pin' },
        { id:'f06', label:'Manual Release' },
        { id:'f07', label:'Cylinder Torque' },
        { id:'f08', label:'Headspace' },
        { id:'f09', label:'Minimum Bore' },
        { id:'f10', label:'Maximum Bore' },
        { id:'f11', label:'Firing Pin Protrusion' },
        { id:'f12', label:'Simulator Test (Pressure TBC)' },
      ]
    },
    PDI: {
      docCode: 'RES-QC-21',
      items: [
        { id:'p01', label:'General Finish & Cosmetics' },
        { id:'p02', label:'Functioning' },
        { id:'p03', label:'Butt Stock' },
        { id:'p04', label:'Safety Catch & Trigger Mechanism' },
        { id:'p05', label:'Index Pin' },
        { id:'p06', label:'Manual Release' },
        { id:'p07', label:'Cylinder Torque' },
        { id:'p08', label:'Headspace' },
        { id:'p09', label:'Minimum Bore' },
        { id:'p10', label:'Maximum Bore' },
        { id:'p11', label:'Firing Pin Protrusion' },
      ]
    }
  },

  XRGL40: {
    label: 'XRGL40',
    keyedBy: 'launcher_serial',      // follows the Blue Card launcher_serial (weapon serial)
    extraSerial: 'sight_serial',     // shown alongside, inherited from Blue Card identity screen
    FAT: {
      docCode: 'RES-QC-08',
      items: [
        { id:'f01', label:'General Finish & Cosmetics' },
        { id:'f02', label:'Functioning' },
        { id:'f03', label:'Butt Stock' },
        { id:'f04', label:'Sight Elevation' },
        { id:'f05', label:'Safety Catch & Trigger Mechanism' },
        { id:'f06', label:'Index Pin' },
        { id:'f07', label:'Manual Release' },
        { id:'f08', label:'Cylinder Torque' },
        { id:'f09', label:'Headspace' },
        { id:'f10', label:'Minimum Bore' },
        { id:'f11', label:'Maximum Bore' },
        { id:'f12', label:'Firing Pin Protrusion' },
      ]
    },
    PDI: {
      docCode: 'RES-QC-14',
      items: [
        { id:'p01', label:'General Finish & Cosmetics' },
        { id:'p02', label:'Functioning' },
        { id:'p03', label:'Butt Stock' },
        { id:'p04', label:'Sight Elevation' },
        { id:'p05', label:'Safety Catch & Trigger Mechanism' },
        { id:'p06', label:'Index Pin' },
        { id:'p07', label:'Manual Release' },
        { id:'p08', label:'Cylinder Torque' },
        { id:'p09', label:'Headspace' },
        { id:'p10', label:'Minimum Bore' },
        { id:'p11', label:'Maximum Bore' },
        { id:'p12', label:'Firing Pin Protrusion' },
      ]
    }
  },

  GRN40: {
    label: 'GRN40',
    keyedBy: 'sight_serial',         // GRN40 has no launcher of its own —
                                      // identified by its own sight_serial,
                                      // which is paired to an XRGL40 launcher
                                      // (see weapon_sight_pairings)
    // 31/10/2026 (v1.25): the GRN40 FAT tab IS the RES-QC-16 Final Acceptance
    // by QC — actions in the form's order, plus the form's Country, ACCEPT
    // YES/NO and Notes fields (acceptance: true). Units are listed from the
    // serial register (weapon_serials), not from Blue Card build cards.
    FAT: {
      docCode: 'RES-QC-16',
      title: 'Final Acceptance Checklist',
      acceptance: true,
      acceptanceSpec: '105-AC-SZ',
      items: [
        { id:'f01', label:'General Finish' },
        { id:'f02', label:'Switch On' },
        { id:'f03', label:'Enable Night Vision' },
        { id:'f04', label:'Automatic Adjustment to Light Conditions' },
        { id:'f05', label:'Switch Off' },
        { id:'f06', label:'Elevation Test — Secure Location in Ranges' },
        { id:'f07', label:'Sight Zero Adjustable — Up and Down' },
        { id:'f08', label:'Sight Zero Adjustable — Left and Right' },
      ]
    },
    PDI: {
      docCode: 'RES-QC-16',
      items: [
        { id:'p01', label:'General Finish' },
        { id:'p02', label:'Switch On' },
        { id:'p03', label:'Switch Off' },
        { id:'p04', label:'Enable Night Vision' },
        { id:'p05', label:'Automatic Adjustment to Light Conditions' },
        { id:'p06', label:'Elevation Test — Secure Location in Ranges' },
        { id:'p07', label:'Sight Zero Adjustable Up and Down' },
        { id:'p08', label:'Sight Zero Adjustable Left and Right' },
      ]
    },
  }
};

window.FATPDI_TYPES = FATPDI_TYPES;
