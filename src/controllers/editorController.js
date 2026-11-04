const { extractPIICoordinates } = require("../services/pdfExtractor");
const { redactPDF, getRedactionStats } = require("../services/pdfRedactor");
const { checkPDFEncryption } = require("../middleware/pdfValidator");
const { getUserFriendlyError } = require("../middleware/errorHandler");
const { convertPDFToImages, getTotalImageSize } = require("../services/pdfToImage");
const { imagesToPDF } = require("../services/imagesToPDF");
const { findPagesWithLostText } = require("../services/renderedTextCheck");

/**
 * Get the editor UI page
 */
const getEditorUI = (req, res) => {
  res.sendFile(require("path").join(__dirname, "../../test-client.html"));
};

/**
 * Redact PII from a PDF
 */
const redactPDF_handler = async (req, res) => {
  const startTime = Date.now();

  try {
    if (!req.file) {
      return res.status(400).json({
        error: "No PDF file uploaded",
        message: 'Please upload a PDF file using the "file" field',
      });
    }

    console.log(
      `Processing PDF: ${req.file.originalname} (${req.file.size} bytes)`,
    );

    // Validate PDF
    const encryptionCheck = await checkPDFEncryption(req.file.buffer);
    if (encryptionCheck.isEncrypted) {
      console.log(`PDF is encrypted: ${req.file.originalname}`);
      return res.status(400).json({
        error: "PDF is Password Protected",
        message: encryptionCheck.error,
        technicalDetails:
          "The PDF contains encryption markers that prevent processing",
      });
    }
    if (encryptionCheck.error) {
      console.log(`PDF validation failed: ${encryptionCheck.error}`);
      return res.status(400).json({
        error: "Invalid PDF File",
        message: encryptionCheck.error,
      });
    }

    // Extract PII
    const piiItems = await extractPIICoordinates(req.file.buffer);

    if (piiItems.length === 0) {
      console.log("No PII found in document");
      return res.status(200).json({
        message: "No personal information found in the document",
        redactions: {
          totalRedactions: 0,
          emails: 0,
          phones: 0,
          pagesAffected: 0,
        },
        processingTime: Date.now() - startTime,
      });
    }

    // Get statistics and redact
    const stats = getRedactionStats(piiItems);
    console.log(
      `Found PII: ${stats.totalRedactions} items (${stats.emails} emails, ${stats.phones} phones)`,
    );

    // Redact PDF without encryption (since we'll convert to images)
    const redactedPdfBuffer = await redactPDF(req.file.buffer, piiItems, { skipEncryption: true });

    // Convert redacted PDF to PNG images (one per page)
    console.log('Converting redacted PDF to PNG images...');
    const images = await convertPDFToImages(redactedPdfBuffer, { scale: 2.0 });

    const lostTextPages = findPagesWithLostText(images);
    if (lostTextPages.length > 0) {
      console.error(
        `Rendered text lost: ${req.file.originalname} ${JSON.stringify(lostTextPages)}`,
      );
      return res.status(422).json({
        error: "Scrubbed PDF Lost Its Text",
        code: "RENDER_TEXT_LOST",
        message:
          "Most of the text disappeared while scrubbing this PDF, so no scrubbed file was created. Keep the original and report this file.",
        pages: lostTextPages,
        processingTime: Date.now() - startTime,
      });
    }

    // Convert images back to PDF
    console.log('Converting PNG images back to PDF...');
    const finalPdfBytes = await imagesToPDF(images);

    const processingTime = Date.now() - startTime;

    console.log(`PDF redaction complete: ${images.length} pages, final PDF size ${finalPdfBytes.length} bytes`);

    // Send PDF as binary with proper headers
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${req.file.originalname}"`,
      'Content-Length': finalPdfBytes.length,
      'X-Redaction-Stats': JSON.stringify(stats),
      'X-Processing-Time': processingTime,
    });

    res.send(Buffer.from(finalPdfBytes));
  } catch (error) {
    console.error("Error processing PDF:", error);
    const friendlyError = getUserFriendlyError(error);
    res.status(500).json(friendlyError);
  }
};

/**
 * Analyze PII in a PDF without redacting
 */
const analyzePDF_handler = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "No PDF file uploaded",
      });
    }

    // Validate PDF
    const encryptionCheck = await checkPDFEncryption(req.file.buffer);
    if (encryptionCheck.isEncrypted) {
      console.log(`PDF is encrypted: ${req.file.originalname}`);
      return res.status(400).json({
        error: "PDF is Password Protected",
        message: encryptionCheck.error,
        technicalDetails:
          "The PDF contains encryption markers that prevent processing",
      });
    }
    if (encryptionCheck.error) {
      return res.status(400).json({
        error: "Invalid PDF File",
        message: encryptionCheck.error,
      });
    }

    // Extract and analyze
    const piiItems = await extractPIICoordinates(req.file.buffer);
    const stats = getRedactionStats(piiItems);

    res.json({
      found: piiItems.length > 0,
      statistics: stats,
      details: piiItems.map((page) => ({
        page: page.pageNumber,
        items: page.items.map((item) => ({
          type: item.type,
          text: item.text,
          coordinates: {
            x: Math.round(item.x),
            y: Math.round(item.y),
            width: Math.round(item.width),
            height: Math.round(item.height),
          },
        })),
      })),
    });
  } catch (error) {
    console.error("Error analyzing PDF:", error);
    const friendlyError = getUserFriendlyError(error);
    res.status(500).json(friendlyError);
  }
};

module.exports = {
  getEditorUI,
  redactPDF_handler,
  analyzePDF_handler,
};
