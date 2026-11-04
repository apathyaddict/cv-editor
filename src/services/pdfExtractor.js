/**
 * PDF Text Extraction Service
 * Uses PDF.js (through unpdf) to extract text and coordinates from PDF documents
 *
 * IMPORTANT: This service extracts PII (Personally Identifiable Information)
 * from PDFs including emails and phone numbers with their approximate coordinates.
 *
 * COORDINATE ACCURACY NOTES:
 * - PDF coordinates are transformed from PDF space to standard coordinates
 * - The current implementation uses simplified transform matrices (translation only)
 * - Scale, rotation, and skew are NOT currently factored in
 * - When multiple PII items exist in a single text block, the entire block's
 *   bounding box is used for each item (imprecise but functional)
 * - For production use with complex PDFs, consider implementing full matrix transforms
 */

// Use unpdf for serverless-compatible PDF parsing
let pdfjsLib;
const { containsPII, findEmails, findPhones } = require("../utils/patterns");

/**
 * Initialize PDF.js through unpdf using dynamic import
 * Uses lazy loading pattern - only imports once on first call
 *
 * @returns {Promise<Object>} The pdfjs-dist module resolved by unpdf
 */
async function initPdfjs() {
  if (!pdfjsLib) {
    try {
      const { definePDFJSModule, getResolvedPDFJS } = await import("unpdf");
      // Rendering uses pdfjs-dist, and two pdf.js versions in one process fail with a worker version mismatch.
      definePDFJSModule(() => import("pdfjs-dist/legacy/build/pdf.mjs"));
      pdfjsLib = await getResolvedPDFJS();
    } catch (error) {
      // If dynamic import fails (e.g., in Jest), throw a clear error
      throw new Error(`Failed to load unpdf: ${error.message}`);
    }
  }
  return pdfjsLib;
}

/**
 * Extract text items with coordinates from a PDF buffer
 *
 * This function:
 * 1. Loads and parses the PDF document
 * 2. Iterates through all pages
 * 3. Extracts text content with positional information
 * 4. Identifies PII (emails, phone numbers) within the text
 * 5. Returns PII items with their approximate screen coordinates
 *
 * @param {Buffer} pdfBuffer - The PDF file as a buffer
 * @returns {Promise<Array>} Array of pages with text items containing PII
 *
 * @example
 * const piiItems = await extractPIICoordinates(pdfBuffer);
 * // Returns: [{ pageNumber: 1, items: [{ text: 'email@example.com', x: 100, y: 200, ... }], ... }]
 *
 * @throws {Error} If PDF is corrupted, encrypted, or cannot be parsed
 */
async function extractPIICoordinates(pdfBuffer) {
  try {
    // Initialize unpdf library (returns PDF.js module)
    const pdfjs = await initPdfjs();

    // Load the PDF document using PDF.js getDocument method
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer),
      useSystemFonts: true, // Use system fonts for better text extraction
      disableFontFace: false, // Allow embedded fonts
    });

    const pdfDocument = await loadingTask.promise;
    const numPages = pdfDocument.numPages;
    const piiItems = [];

    // Process each page
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDocument.getPage(pageNum);
      const textContent = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1.0 });

      const pageHeight = viewport.height;
      const pageItems = [];

      // Check each text item for PII
      textContent.items.forEach((item) => {
        const text = item.str.trim();

        if (!text || text.length === 0) return;

        // Check if text contains PII
        if (containsPII(text)) {
          // Transform coordinates from PDF space to standard coordinates
          // PDF Transform Matrix: [scaleX, skewX, skewY, scaleY, translateX, translateY]
          //
          // SIMPLIFICATION: We're only using translateX and translateY
          // For most standard PDFs this is sufficient, but complex transformations
          // (rotation, skew, non-uniform scale) are not accounted for
          const transform = item.transform;
          const x = transform[4]; // translateX
          const y = pageHeight - transform[5]; // translateY, flipped to standard coords
          const width = item.width;
          const height = item.height;

          // Find all emails in this text
          const emails = findEmails(text);
          emails.forEach((email) => {
            // LIMITATION: Using the full text item bounds for the email
            // If the text contains "Contact: email@example.com", the bounding box
            // will include "Contact: " even though we only want to redact the email
            // A more sophisticated approach would calculate character-level positions
            pageItems.push({
              text: email,
              x: x,
              y: y - height, // Adjust Y to top-left corner
              width: width,
              height: height,
              type: "email",
            });
          });

          // Find all phones in this text
          const phones = findPhones(text);
          phones.forEach((phone) => {
            pageItems.push({
              text: phone,
              x: x,
              y: y - height,
              width: width,
              height: height,
              type: "phone",
            });
          });
        }
      });

      if (pageItems.length > 0) {
        piiItems.push({
          pageNumber: pageNum,
          items: pageItems,
          pageHeight: pageHeight,
          pageWidth: viewport.width,
        });
      }
    }

    return piiItems;
  } catch (error) {
    // Preserve the original error for debugging
    console.error("Error extracting PII coordinates:", error);

    // Provide more specific error messages based on error type
    if (error.name === "PasswordException") {
      throw new Error("PDF is password protected and cannot be processed");
    } else if (error.message && error.message.includes("Invalid PDF")) {
      throw new Error("Invalid or corrupted PDF file");
    } else if (error.message && error.message.includes("encrypted")) {
      throw new Error("PDF is encrypted and cannot be processed");
    } else if (
      error.message &&
      error.message.includes("Failed to load unpdf")
    ) {
      // Re-throw unpdf loading errors
      throw error;
    } else {
      // Include original error message for debugging
      throw new Error(`Failed to extract text from PDF: ${error.message}`);
    }
  }
}

/**
 * Extract all text content from PDF for debugging purposes
 *
 * This is a simpler extraction that concatenates all text from all pages.
 * Useful for debugging text extraction issues or analyzing PDF content.
 *
 * @param {Buffer} pdfBuffer - The PDF file as a buffer
 * @returns {Promise<string>} All text content with page separators
 *
 * @example
 * const allText = await extractAllText(pdfBuffer);
 * console.log(allText);
 * // --- Page 1 ---
 * // Hello World
 * // --- Page 2 ---
 * // More text...
 *
 * @throws {Error} If PDF cannot be parsed
 */
async function extractAllText(pdfBuffer) {
  try {
    // Initialize unpdf (returns PDF.js module)
    const pdfjs = await initPdfjs();

    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer),
    });

    const pdfDocument = await loadingTask.promise;
    const numPages = pdfDocument.numPages;
    let allText = "";

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDocument.getPage(pageNum);
      const textContent = await page.getTextContent();

      const pageText = textContent.items.map((item) => item.str).join(" ");

      allText += `\n--- Page ${pageNum} ---\n${pageText}\n`;
    }

    return allText;
  } catch (error) {
    console.error("Error extracting all text:", error);
    throw new Error(`Failed to extract text from PDF: ${error.message}`);
  }
}

module.exports = {
  extractPIICoordinates,
  extractAllText,
  // Export for testing purposes
  _initPdfjs: initPdfjs,
};
