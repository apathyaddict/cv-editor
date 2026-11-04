/**
 * PDF to Image Conversion Service
 * Converts PDF pages to PNG images using pdfjs-dist and @napi-rs/canvas
 * This implementation is compatible with Vercel and other serverless environments
 */

const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');
const { countVisibleTextItems } = require('./renderedTextCheck');

// Servers have no installed fonts, so non-embedded fonts like Helvetica draw as nothing without these.
const STANDARD_FONT_DATA_URL = path.join(
  path.dirname(require.resolve('pdfjs-dist/package.json')),
  'standard_fonts/',
);

const PDF_LOAD_OPTIONS = {
  useSystemFonts: false,
  standardFontDataUrl: STANDARD_FONT_DATA_URL,
  useWorkerFetch: false, // Disable worker in Node.js
  isEvalSupported: false, // Disable eval for security
  disableWorker: true, // Disable worker for Node.js environment
};

// Lazy-loaded pdfjs-dist module (loaded once on first use)
let pdfjsLib = null;

/**
 * Get or initialize pdfjs-dist module
 * @returns {Promise<Object>} pdfjs-dist module
 */
async function getPdfJsLib() {
  if (!pdfjsLib) {
    // Dynamic import for ES module
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsLib;
}

/**
 * Convert PDF buffer to PNG images (one per page)
 * @param {Buffer} pdfBuffer - PDF buffer to convert
 * @param {Object} options - Conversion options
 * @param {number} options.scale - Scale factor for rendering (default: 2.0 for high quality)
 * @returns {Promise<Array>} Array of base64-encoded PNG images
 */
async function convertPDFToImages(pdfBuffer, options = {}) {
  const { scale = 2.0 } = options;

  try {
    console.log(`Converting PDF to PNG images at ${scale}x scale`);

    // Get pdfjs-dist module
    const pdfjs = await getPdfJsLib();

    // Load PDF document
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer),
      ...PDF_LOAD_OPTIONS,
    });

    const pdfDocument = await loadingTask.promise;
    const numPages = pdfDocument.numPages;
    const images = [];

    console.log(`PDF loaded: ${numPages} page(s)`);

    // Process each page
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDocument.getPage(pageNum);

      // Get viewport at the desired scale
      const viewport = page.getViewport({ scale });
      const width = Math.floor(viewport.width);
      const height = Math.floor(viewport.height);

      // Create canvas
      const canvas = createCanvas(width, height);
      const context = canvas.getContext('2d');

      // Render PDF page to canvas
      const renderContext = {
        canvasContext: context,
        viewport: viewport,
      };

      await page.render(renderContext).promise;

      const textContent = await page.getTextContent();
      const textCheck = countVisibleTextItems(context, textContent.items, viewport);

      // Convert canvas to PNG buffer
      const imageBuffer = await canvas.encode('png');
      const base64Image = imageBuffer.toString('base64');

      images.push({
        pageNumber: pageNum,
        width: width,
        height: height,
        data: base64Image,
        mimeType: 'image/png',
        size: imageBuffer.length,
        textCheck
      });

      console.log(`Page ${pageNum}/${numPages} converted - ${imageBuffer.length} bytes`);

      // Clean up
      page.cleanup();
    }

    // Clean up document
    await loadingTask.destroy();

    return images;
  } catch (error) {
    console.error('Error converting PDF to images:', error);
    throw new Error('Failed to convert PDF to images: ' + error.message);
  }
}

/**
 * Get total size of all images
 * @param {Array} images - Array of image objects
 * @returns {number} Total size in bytes
 */
function getTotalImageSize(images) {
  return images.reduce((total, img) => total + img.size, 0);
}

module.exports = {
  PDF_LOAD_OPTIONS,
  convertPDFToImages,
  getTotalImageSize
};
