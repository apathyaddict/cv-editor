/**
 * Tests for catching text that fails to draw when a PDF is rendered to images
 */

const { createCanvas } = require("@napi-rs/canvas");
const { PDFDocument, StandardFonts } = require("pdf-lib");
const { convertPDFToImages } = require("../src/services/pdfToImage");
const {
  countVisibleTextItems,
  findPagesWithLostText,
} = require("../src/services/renderedTextCheck");

const viewport = {
  width: 200,
  height: 200,
  convertToViewportPoint: (x, y) => [x, 200 - y],
};

const textItem = (x, y, str = "text") => ({
  str,
  width: 40,
  height: 10,
  transform: [10, 0, 0, 10, x, y],
});

const createWhiteContext = () => {
  const context = createCanvas(200, 200).getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, 200, 200);
  return context;
};

const pageResult = (totalItems, visibleItems) => ({
  pageNumber: 1,
  textCheck: { totalItems, visibleItems },
});

describe("countVisibleTextItems", () => {
  test("counts only items with something drawn in their area", () => {
    const context = createWhiteContext();
    context.fillStyle = "black";
    context.fillRect(15, 45, 10, 5);

    const result = countVisibleTextItems(
      context,
      [textItem(10, 150), textItem(10, 50)],
      viewport,
    );

    expect(result).toEqual({ totalItems: 2, visibleItems: 1 });
  });

  test("treats a solid colored background as not visible", () => {
    const context = createWhiteContext();
    context.fillStyle = "navy";
    context.fillRect(0, 0, 200, 200);

    const result = countVisibleTextItems(context, [textItem(10, 50)], viewport);

    expect(result).toEqual({ totalItems: 1, visibleItems: 0 });
  });

  test("detects light text on a dark background", () => {
    const context = createWhiteContext();
    context.fillStyle = "navy";
    context.fillRect(0, 0, 200, 200);
    context.fillStyle = "white";
    context.fillRect(15, 145, 10, 5);

    const result = countVisibleTextItems(context, [textItem(10, 50)], viewport);

    expect(result).toEqual({ totalItems: 1, visibleItems: 1 });
  });

  test("ignores blank items and items outside the page", () => {
    const result = countVisibleTextItems(
      createWhiteContext(),
      [textItem(10, 50, "   "), textItem(500, 500)],
      viewport,
    );

    expect(result).toEqual({ totalItems: 0, visibleItems: 0 });
  });
});

describe("findPagesWithLostText", () => {
  test("flags a page where most of the text is missing", () => {
    expect(findPagesWithLostText([pageResult(56, 3)])).toEqual([
      { pageNumber: 1, totalItems: 56, visibleItems: 3 },
    ]);
  });

  test("passes a page where half the text is visible", () => {
    expect(findPagesWithLostText([pageResult(10, 5)])).toEqual([]);
  });

  test("passes pages with too little text to judge", () => {
    expect(findPagesWithLostText([pageResult(4, 0)])).toEqual([]);
  });

  test("passes scanned pages with no text layer", () => {
    expect(findPagesWithLostText([pageResult(0, 0)])).toEqual([]);
  });

  test("reports only the affected page in a multi-page document", () => {
    const images = [pageResult(20, 20), { ...pageResult(20, 1), pageNumber: 2 }];

    expect(findPagesWithLostText(images)).toEqual([
      { pageNumber: 2, totalItems: 20, visibleItems: 1 },
    ]);
  });
});

describe("convertPDFToImages on a server with no installed fonts", () => {
  const contextPrototype = Object.getPrototypeOf(
    createCanvas(1, 1).getContext("2d"),
  );
  const { fillText, strokeText } = contextPrototype;

  beforeEach(() => {
    contextPrototype.fillText = () => {};
    contextPrototype.strokeText = () => {};
  });

  afterEach(() => {
    contextPrototype.fillText = fillText;
    contextPrototype.strokeText = strokeText;
  });

  test("still draws text in non-embedded fonts", async () => {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([612, 792]);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    for (let line = 0; line < 10; line++) {
      page.drawText(`Experience line ${line}`, {
        x: 50,
        y: 700 - line * 20,
        size: 12,
        font,
      });
    }

    const images = await convertPDFToImages(Buffer.from(await pdfDoc.save()));

    expect(images[0].textCheck).toEqual({ totalItems: 10, visibleItems: 10 });
    expect(findPagesWithLostText(images)).toEqual([]);
  });
});
