// ─── CAMERA + OCR MODULE ──────────────────────────────────────────────────────
// Uses device camera to capture serial number photos
// OCR via Tesseract.js (loaded from CDN)

let tesseractWorker = null;

async function initOCR() {
  if (tesseractWorker) return;
  try {
    tesseractWorker = await Tesseract.createWorker('eng');
    await tesseractWorker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- ',
    });
    console.log('[OCR] Tesseract ready');
  } catch (e) {
    console.warn('[OCR] Tesseract failed to load:', e);
  }
}

// Called when user taps the camera icon next to a serial field
async function captureSerial(fieldId, photoFieldId) {
  // Create a hidden file input that triggers camera
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.capture = 'environment'; // rear camera
  input.style.display = 'none';
  document.body.appendChild(input);

  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Show the photo preview
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const base64 = ev.target.result;

      // Store photo reference
      if (photoFieldId) {
        state.formData[photoFieldId] = base64;
        // Show thumbnail
        const thumb = document.getElementById(`thumb-${fieldId}`);
        if (thumb) {
          thumb.src = base64;
          thumb.style.display = 'block';
        }
      }

      // Run OCR
      const inp = document.getElementById(fieldId);
      if (inp) {
        inp.placeholder = 'Reading…';
        inp.disabled = true;
      }

      showToast('Reading serial number…', 'ok');

      try {
        if (!tesseractWorker) await initOCR();
        if (tesseractWorker) {
          const { data } = await tesseractWorker.recognize(base64);
          let text = data.text.trim().toUpperCase().replace(/\s+/g, ' ');
          // Clean up common OCR mistakes
          text = text.replace(/O/g, '0').replace(/l/g, '1').replace(/\n/g, ' ').trim();
          if (inp) {
            inp.value = text;
            inp.disabled = false;
            inp.placeholder = 'Confirm or correct';
            // Save to state
            state.formData[fieldId.replace('inp-', '').replace(/-/g, '_')] = text;
          }
          showToast('Serial read — please confirm ✓', 'ok');
        }
      } catch (err) {
        console.warn('[OCR] Failed:', err);
        if (inp) {
          inp.disabled = false;
          inp.placeholder = 'OCR failed — type manually';
        }
        showToast('Could not read — please type manually', 'warn');
      }
    };
    reader.readAsDataURL(file);
    document.body.removeChild(input);
  };

  input.click();
}
