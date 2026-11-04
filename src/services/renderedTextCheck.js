/**
 * Rendered Text Check
 * Compares a page's text layer with its rendered image to catch text that failed to draw
 */

const { containsPII } = require("../utils/patterns");

const INK_THRESHOLD = 32;
const MIN_TEXT_ITEMS = 5;
// Set low because CVs can legitimately contain invisible text, such as white keyword stuffing.
const MIN_VISIBLE_RATIO = 0.5;

/**
 * Check whether a region of the canvas contains more than one color
 * @param {Object} context - Canvas 2D context
 * @param {Object} box - Region to inspect, in canvas pixels
 * @returns {boolean} True if something is drawn in the region
 */
function regionHasInk(context, { x, y, width, height }) {
  const { data } = context.getImageData(x, y, width, height);

  for (let i = 4; i < data.length; i += 4) {
    if (
      Math.abs(data[i] - data[0]) > INK_THRESHOLD ||
      Math.abs(data[i + 1] - data[1]) > INK_THRESHOLD ||
      Math.abs(data[i + 2] - data[2]) > INK_THRESHOLD
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Convert a PDF text item to its bounding box in canvas pixels
 * @param {Object} item - PDF.js text item
 * @param {Object} viewport - PDF.js page viewport
 * @returns {Object} Bounding box, clipped to the canvas
 */
function getItemBox(item, viewport) {
  const [originX, originY] = [item.transform[4], item.transform[5]];
  const [x1, y1] = viewport.convertToViewportPoint(originX, originY);
  const [x2, y2] = viewport.convertToViewportPoint(
    originX + item.width,
    originY + item.height,
  );

  const left = Math.max(0, Math.floor(Math.min(x1, x2)));
  const top = Math.max(0, Math.floor(Math.min(y1, y2)));
  const right = Math.min(viewport.width, Math.ceil(Math.max(x1, x2)));
  const bottom = Math.min(viewport.height, Math.ceil(Math.max(y1, y2)));

  return {
    x: left,
    y: top,
    width: Math.floor(right - left),
    height: Math.floor(bottom - top),
  };
}

/**
 * Count how many of a page's text items actually appear in its rendered image
 * @param {Object} context - Canvas 2D context the page was rendered to
 * @param {Array} textItems - Items from PDF.js page.getTextContent()
 * @param {Object} viewport - Viewport the page was rendered with
 * @returns {{totalItems: number, visibleItems: number}} Text item counts
 */
function countVisibleTextItems(context, textItems, viewport) {
  const boxes = textItems
    // Text containing PII sits under a redaction box, so it is hidden on purpose.
    .filter((item) => item.str && item.str.trim() && !containsPII(item.str.trim()))
    .map((item) => getItemBox(item, viewport))
    .filter((box) => box.width > 0 && box.height > 0);

  return {
    totalItems: boxes.length,
    visibleItems: boxes.filter((box) => regionHasInk(context, box)).length,
  };
}

/**
 * Find rendered pages where most of the text is missing from the image
 * @param {Array} images - Images from convertPDFToImages
 * @returns {Array} Affected pages with their text item counts
 */
function findPagesWithLostText(images) {
  return images
    .filter(({ textCheck: { totalItems, visibleItems } }) => (
      totalItems >= MIN_TEXT_ITEMS &&
      visibleItems / totalItems < MIN_VISIBLE_RATIO
    ))
    .map(({ pageNumber, textCheck }) => ({ pageNumber, ...textCheck }));
}

module.exports = {
  countVisibleTextItems,
  findPagesWithLostText,
};
