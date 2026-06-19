// HU Label Microservice
// One job: take an HU number, return a PDF label with HU number + barcode
// Mirrors the layout of Label A: "HU LABEL" header, barcode, "HU: <number>" below

const express = require('express');
const bwipjs = require('bwip-js');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const app = express();
app.use(express.json());

// In-memory store for generated PDFs (good enough for POC; swap for real storage later)
const generatedLabels = new Map();

// ---- Core function: builds the PDF for a given HU number ----
async function buildHuLabelPdf(huNumber) {
  // 1. Generate barcode as PNG buffer (Code 128, same style as most HU labels)
  const barcodePng = await bwipjs.toBuffer({
    bcid: 'code128',       // barcode type
    text: huNumber,        // value to encode
    scale: 3,               // resolution
    height: 18,              // bar height in mm
    includetext: false,    // we'll print the HU number ourselves, styled
  });

  // 2. Create a new PDF document
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([320, 200]); // small label-sized page (points)
  const font = await pdfDoc.embedFont(StandardFonts.Courier);
  const fontBold = await pdfDoc.embedFont(StandardFonts.CourierBold);

  // 3. Outer border (matches the bordered look of Label A)
  page.drawRectangle({
    x: 5, y: 5, width: 310, height: 190,
    borderColor: rgb(0, 0, 0), borderWidth: 1.5,
  });

  // 4. Header text "HU LABEL"
  page.drawText('HU LABEL', {
    x: 15, y: 165, size: 12, font: fontBold, color: rgb(0, 0, 0),
  });

  // 5. Embed barcode image
  const barcodeImage = await pdfDoc.embedPng(barcodePng);
  const barcodeDims = barcodeImage.scale(0.45);
  page.drawImage(barcodeImage, {
    x: 15, y: 80, width: barcodeDims.width, height: barcodeDims.height,
  });

  // 6. HU number text, styled like "HU:  9000000756"
  page.drawText(`HU:   ${huNumber}`, {
    x: 15, y: 50, size: 16, font, color: rgb(0, 0, 0),
  });

  return await pdfDoc.save(); // returns Uint8Array
}

// ---- API endpoint: POST /generate-hu-label ----
// Body: { "huNumber": "9000000756" }
// Returns: { "pdfUrl": "http://.../label/<id>.pdf" }
app.post('/generate-hu-label', async (req, res) => {
  try {
    const { huNumber } = req.body;

    if (!huNumber || typeof huNumber !== 'string') {
      return res.status(400).json({ error: 'huNumber is required and must be a string' });
    }

    const pdfBytes = await buildHuLabelPdf(huNumber);

    // Store in memory with a simple id (swap for real storage in production)
    const id = `${huNumber}-${Date.now()}`;
    generatedLabels.set(id, Buffer.from(pdfBytes));

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
      success: true,
      huNumber,
      pdfUrl: `${baseUrl}/label/${id}.pdf`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate label', details: err.message });
  }
});

// ---- Serve the generated PDF for preview/download ----
app.get('/label/:id.pdf', (req, res) => {
  const { id } = req.params;
  const pdfBuffer = generatedLabels.get(id);

  if (!pdfBuffer) {
    return res.status(404).send('Label not found or expired');
  }

  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'inline; filename="hu-label.pdf"');
  res.send(pdfBuffer);
});

// ---- Health check (useful once deployed, to confirm the service is alive) ----
app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HU Label service running on port ${PORT}`));

module.exports = app;
