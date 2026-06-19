// HU Label Microservice — v2: template-driven engine
// Instead of hardcoding each label's layout in code, each label is described
// as a JSON "template" (see /labels). This file contains one generic engine
// that reads a template + data, and draws whatever the template describes.
// Adding a new label type = adding a new JSON file, not changing this code.

const express = require('express');
const bwipjs = require('bwip-js');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const generatedLabels = new Map();

// ---- Load all label templates from /labels at startup ----
const labelsDir = path.join(__dirname, 'labels');
const templates = {};
fs.readdirSync(labelsDir).forEach((file) => {
  if (file.endsWith('.json')) {
    const template = JSON.parse(fs.readFileSync(path.join(labelsDir, file), 'utf8'));
    templates[template.labelType] = template;
  }
});
console.log('Loaded label templates:', Object.keys(templates));

// ---- Helper: fill {field} placeholders in a string with real data ----
function fillTemplate(str, data) {
  return str.replace(/\{(\w+)\}/g, (_, key) => (data[key] !== undefined ? data[key] : ''));
}

// ---- Helper: build a GS1-128 Application Identifier string ----
// e.g. ai "02" + field value "15012345678907" -> "0215012345678907"
// Fixed-length AIs (01,02,17,37 etc. have known lengths) are concatenated directly;
// bwip-js's gs1-128 mode handles the FNC1 separators for variable-length fields.
function buildGs1String(aiFields, data) {
  return aiFields
    .map(({ ai, field }) => `(${ai})${data[field] !== undefined ? data[field] : ''}`)
    .join('');
}

// ---- Core function: renders a PDF from a template + data ----
async function renderLabel(labelType, data) {
  const template = templates[labelType];
  if (!template) {
    throw new Error(`Unknown labelType "${labelType}". Available: ${Object.keys(templates).join(', ')}`);
  }

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([template.pageWidth, template.pageHeight]);
  const font = await pdfDoc.embedFont(StandardFonts.Courier);
  const fontBold = await pdfDoc.embedFont(StandardFonts.CourierBold);

  for (const el of template.elements) {
    switch (el.type) {
      case 'border': {
        page.drawRectangle({
          x: 5, y: 5,
          width: template.pageWidth - 10,
          height: template.pageHeight - 10,
          borderColor: rgb(0, 0, 0), borderWidth: 1.5,
        });
        break;
      }

      case 'text': {
        const text = el.template ? fillTemplate(el.template, data) : el.value;
        page.drawText(text, {
          x: el.x, y: el.y,
          size: el.size || 11,
          font: el.bold ? fontBold : font,
          color: rgb(0, 0, 0),
        });
        break;
      }

      case 'barcode': {
        // Simple single-value barcode (Label A style)
        const value = data[el.field];
        const png = await bwipjs.toBuffer({ bcid: 'code128', text: String(value), scale: 3, height: 18, includetext: false });
        const img = await pdfDoc.embedPng(png);
        const dims = img.scale(el.scale || 0.45);
        page.drawImage(img, { x: el.x, y: el.y, width: dims.width, height: dims.height });
        break;
      }

      case 'gs1_barcode': {
        // Multi-field GS1-128 barcode (Label B style)
        const gs1Text = buildGs1String(el.aiFields, data);
        const png = await bwipjs.toBuffer({ bcid: 'gs1-128', text: gs1Text, scale: 3, height: 18, includetext: false });
        const img = await pdfDoc.embedPng(png);
        const dims = img.scale(el.scale || 0.45);
        page.drawImage(img, { x: el.x, y: el.y, width: dims.width, height: dims.height });

        // Human Readable Interpretation (HRI): the AI-prefixed values printed
        // below the barcode, e.g. "(02)15012345678907(17)131225(37)0110"
        // GS1 convention: parentheses around the AI, fixed-length AI values
        // run straight into the next AI with no separator.
        const hriText = el.aiFields
          .map(({ ai, field }) => `(${ai})${data[field] !== undefined ? data[field] : ''}`)
          .join('');
        page.drawText(hriText, {
          x: el.x,
          y: el.y - 12, // just below the barcode image
          size: el.hriSize || 8,
          font,
          color: rgb(0, 0, 0),
        });
        break;
      }

      default:
        console.warn(`Unknown element type "${el.type}" — skipped`);
    }
  }

  return await pdfDoc.save();
}

// ---- API endpoint ----
// Body: { "labelType": "A" or "B", ...data fields needed by that template }
app.post('/generate-hu-label', async (req, res) => {
  try {
    const { labelType, ...data } = req.body;

    if (!labelType) {
      return res.status(400).json({ error: 'labelType is required (e.g. "A" or "B")' });
    }

    const pdfBytes = await renderLabel(labelType, data);

    const id = `${labelType}-${data.huNumber || data.sscc || 'label'}-${Date.now()}`;
    generatedLabels.set(id, Buffer.from(pdfBytes));

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ success: true, labelType, pdfUrl: `${baseUrl}/label/${id}.pdf` });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

app.get('/label/:id.pdf', (req, res) => {
  const pdfBuffer = generatedLabels.get(req.params.id);
  if (!pdfBuffer) return res.status(404).send('Label not found or expired');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'inline; filename="hu-label.pdf"');
  res.send(pdfBuffer);
});

app.get('/health', (req, res) => res.json({ status: 'ok', labelTypes: Object.keys(templates) }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HU Label service (v2) running on port ${PORT}`));

module.exports = app;
