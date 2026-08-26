// ─── ENHANCED CAMERA MODULE v1.3 ──────────────────────────────────────────────
// Safer version — OpenCV optional, Tesseract with timeout, never hangs
try {

let tesseractWorker = null;
let openCVReady = false;
let openCVLoading = false;

// ── Serial format corrections per card type ───────────────────────────────────
const DOT_MATRIX_FIXES = [
  // Common dot-matrix OCR confusions in numeric positions
  [/(?<=[A-Z]{2,3}\s*)\O/g, '0'],  // O→0 after letter prefix
  [/\b0(?=[A-Z])/g, 'O'],           // 0→O before letters (e.g. 0SA → OSA)
];

// ── Load OpenCV with timeout ───────────────────────────────────────────────────
function tryLoadOpenCV() {
  if (openCVReady || openCVLoading) return;
  openCVLoading = true;
  const script = document.createElement('script');
  script.src = 'https://docs.opencv.org/4.8.0/opencv.js';
  script.async = true;
  // Timeout — if OpenCV doesn't load in 8 seconds, give up gracefully
  const timeout = setTimeout(() => {
    console.warn('[Camera] OpenCV load timeout — using basic mode');
    openCVLoading = false;
  }, 8000);
  script.onload = () => {
    const check = setInterval(() => {
      if (typeof cv !== 'undefined' && cv.Mat) {
        clearInterval(check);
        clearTimeout(timeout);
        openCVReady = true;
        openCVLoading = false;
        console.log('[Camera] OpenCV ready');
      }
    }, 200);
  };
  script.onerror = () => {
    clearTimeout(timeout);
    openCVLoading = false;
    console.warn('[Camera] OpenCV failed to load');
  };
  document.head.appendChild(script);
}

// ── Tesseract init ────────────────────────────────────────────────────────────
async function initOCR() {
  if (tesseractWorker) return;
  try {
    tesseractWorker = await Tesseract.createWorker('eng');
    await tesseractWorker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- ',
      tessedit_pageseg_mode: '7',
    });
    console.log('[Camera] Tesseract ready');
    // Start loading OpenCV in background after Tesseract is ready
    tryLoadOpenCV();
  } catch(e) {
    console.error('[Camera] Tesseract init failed:', e);
  }
}

// ── Main capture function ─────────────────────────────────────────────────────
async function captureSerial(fieldId, photoKey, useOCR) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment';
  input.style.display = 'none';
  document.body.appendChild(input);

  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) { document.body.removeChild(input); return; }

    const reader = new FileReader();
    reader.onload = async (ev) => {
      const base64 = ev.target.result;

      // Store photo
      if (typeof state !== 'undefined' && state.formData) {
        state.formData[photoKey] = base64;
      }

      // Show thumbnail immediately
      const thumb = document.getElementById(`thumb-${fieldId}`);
      if (thumb) { thumb.src = base64; thumb.style.display = 'block'; }

      const inp = document.getElementById(fieldId);
      const statusEl = document.getElementById('ocr-status');

      // ── PHOTO ONLY mode — no OCR for dot-matrix serials ─────────────────
      if (!useOCR) {
        if (statusEl) statusEl.textContent = '✅ Photo stored — type serial number above';
        if (typeof showToast === 'function') showToast('Photo saved ✓', 'ok');
        if (inp) { inp.disabled = false; inp.placeholder = 'Type serial number'; inp.focus(); }
        return;
      }

      if (inp) { inp.disabled = true; inp.placeholder = 'Reading…'; }
      if (statusEl) statusEl.textContent = '🔍 Reading laser serial…';
      if (typeof showToast === 'function') showToast('Reading serial…', 'ok');

      try {
        // Ensure Tesseract is ready
        if (!tesseractWorker) await initOCR();
        if (!tesseractWorker) throw new Error('OCR not available');

        // Try OpenCV preprocessing if available, with strict timeout
        let imageToProcess = base64;
        if (openCVReady) {
          if (statusEl) statusEl.textContent = '🔍 Enhancing image for dot matrix…';
          try {
            const enhanced = await Promise.race([
              preprocessDotMatrix(base64),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))
            ]);
            imageToProcess = enhanced;
            console.log('[Camera] OpenCV preprocessing done');
          } catch(cvErr) {
            console.warn('[Camera] OpenCV preprocessing failed/timeout, using original');
            imageToProcess = base64;
          }
        }

        // Run OCR with timeout
        if (statusEl) statusEl.textContent = '🔍 OCR running…';
        const ocrResult = await Promise.race([
          tesseractWorker.recognize(imageToProcess),
          new Promise((_, reject) => setTimeout(() => reject(new Error('OCR timeout')), 15000))
        ]);

        const { data } = ocrResult;
        let text = (data.text || '').trim().toUpperCase()
          .replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
        const confidence = Math.round(data.confidence || 0);

        // Apply dot-matrix corrections
        text = applyCorrections(text, fieldId);

        // Update field
        if (inp) {
          inp.value = text;
          inp.disabled = false;
          inp.placeholder = 'Confirm or correct';
          inp.style.borderBottomColor =
            confidence >= 85 ? 'var(--pass, #1a9e5c)' :
            confidence >= 65 ? 'var(--warn, #e08f1a)' :
                               'var(--fail, #d93025)';
        }

        // Confidence feedback
        const confEmoji = confidence >= 85 ? '✅' : confidence >= 65 ? '⚠' : '❌';
        const confMsg = `${confEmoji} ${text} — ${confidence}% confidence`;
        if (statusEl) statusEl.textContent = confMsg;
        if (typeof showToast === 'function') {
          showToast(confMsg, confidence >= 85 ? 'ok' : confidence >= 65 ? 'warn' : 'error');
        }

        // Auto-show retake button if low confidence
        if (confidence < 65) showRetakeButton(fieldId, photoKey);

        // Trigger launcher serial confirm
        if (fieldId === 'inp-launcher-serial' && typeof resetSerialConfirm === 'function') {
          resetSerialConfirm();
        }

      } catch(err) {
        console.error('[Camera] OCR error:', err);
        if (inp) { inp.disabled = false; inp.placeholder = 'Type manually'; }
        if (statusEl) statusEl.textContent = '⚠ Could not read — please type manually';
        if (typeof showToast === 'function') showToast('OCR failed — type manually', 'warn');
      }
    };
    reader.readAsDataURL(file);
    document.body.removeChild(input);
  };

  input.click();
}

// ── OpenCV preprocessing ──────────────────────────────────────────────────────
function preprocessDotMatrix(base64) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.width * 2;  // upscale 2x
          canvas.height = img.height * 2;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          const src = cv.imread(canvas);
          const gray = new cv.Mat();
          const blackhat = new cv.Mat();
          const thresh = new cv.Mat();
          const dilated = new cv.Mat();

          // Greyscale
          cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

          // Black-hat to pull out dot-matrix dots from metal
          const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));
          cv.morphologyEx(gray, blackhat, cv.MORPH_BLACKHAT, kernel);

          // Threshold
          cv.threshold(blackhat, thresh, 20, 255, cv.THRESH_BINARY);

          // Dilate to connect dots into characters
          const dkern = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(4, 4));
          cv.dilate(thresh, dilated, dkern);

          const outCanvas = document.createElement('canvas');
          outCanvas.width = dilated.cols;
          outCanvas.height = dilated.rows;
          cv.imshow(outCanvas, dilated);

          src.delete(); gray.delete(); blackhat.delete();
          thresh.delete(); dilated.delete(); kernel.delete(); dkern.delete();

          resolve(outCanvas.toDataURL('image/png'));
        } catch(e) {
          console.warn('[Camera] OpenCV inner error:', e);
          resolve(base64);
        }
      };
      img.onerror = () => resolve(base64);
      img.src = base64;
    } catch(e) {
      resolve(base64);
    }
  });
}

// ── Dot-matrix correction heuristics ─────────────────────────────────────────
function applyCorrections(text, fieldId) {
  const cardType = (typeof state !== 'undefined' && state.cardType) ? state.cardType : 'RLL';

  // Remove junk characters
  let clean = text.replace(/[^A-Z0-9\s\-]/g, '').replace(/\s+/g, ' ').trim();

  if (cardType === 'RLL' || fieldId === 'inp-launcher-serial') {
    // RLL NNNNN format — after 'RLL' everything should be digits
    if (clean.startsWith('RL')) {
      // Fix prefix first
      clean = 'RLL' + clean.slice(3);
      // Fix digits after prefix — common: O→0, I→1, S→5, B→8
      const prefix = 'RLL';
      const rest = clean.slice(3).replace(/O/g,'0').replace(/I/g,'1')
                        .replace(/S/g,'5').replace(/B/g,'8').replace(/G/g,'6');
      clean = prefix + rest;
    }
  }

  if (cardType === 'XRGL40') {
    // X26 3007 RSA — letter+2digits SPACE 4digits SPACE 2-3letters
    const parts = clean.split(/\s+/);
    if (parts[0] && parts[0].length >= 3) {
      // digits part: fix O→0
      parts[0] = parts[0][0] + parts[0].slice(1)
        .replace(/O/g,'0').replace(/I/g,'1').replace(/S/g,'5');
    }
    if (parts[1]) {
      // 4-digit section: all numeric
      parts[1] = parts[1].replace(/O/g,'0').replace(/I/g,'1')
                         .replace(/S/g,'5').replace(/B/g,'8')
                         .replace(/G/g,'6').replace(/Z/g,'2');
    }
    clean = parts.join(' ');
  }

  return clean;
}

// ── Retake button ─────────────────────────────────────────────────────────────
function showRetakeButton(fieldId, photoKey) {
  const existing = document.getElementById(`retake-${fieldId}`);
  if (existing) existing.remove();
  const inp = document.getElementById(fieldId);
  if (!inp || !inp.parentNode) return;
  const btn = document.createElement('button');
  btn.id = `retake-${fieldId}`;
  btn.className = 'cam-btn';
  btn.style.cssText = 'margin-top:4px;width:auto;padding:4px 10px;font-size:11px;background:#fdf2f2;border-color:#d93025;color:#d93025;';
  btn.textContent = '📷 Retake Photo';
  btn.onclick = () => { btn.remove(); captureSerial(fieldId, photoKey); };
  inp.parentNode.insertBefore(btn, inp.nextSibling);
}

// Override app.js functions — captureSerial now accepts useOCR flag
window.initOCR = initOCR;
window.captureSerial = captureSerial;
console.log('[Camera Enhanced v1.3] Loaded');

} catch(loadErr) {
  console.warn('[Camera Enhanced] Load failed, using basic camera:', loadErr);
}
