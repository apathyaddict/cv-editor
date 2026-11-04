/**
 * Tests for catching text that fails to draw when a PDF is rendered to images.
 * Everything here runs real PDFs through the real renderer and API.
 */

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const { PDFDocument, StandardFonts, degrees, rgb } = require("pdf-lib");
const { app, server } = require("../index");
const {
  PDF_LOAD_OPTIONS,
  convertPDFToImages,
} = require("../src/services/pdfToImage");
const { findPagesWithLostText } = require("../src/services/renderedTextCheck");

const WHITE = rgb(1, 1, 1);
const NAVY = rgb(0, 0, 0.5);

const drawLines = (page, font, color = rgb(0, 0, 0), count = 10) => {
  for (let line = 0; line < count; line++) {
    page.drawText(`Experience line ${line}`, {
      x: 50,
      y: 700 - line * 20,
      size: 12,
      font,
      color,
    });
  }
};

const buildPdf = async (...pageDrawers) => {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  pageDrawers.forEach((drawPage) => drawPage(pdfDoc.addPage([612, 792]), font));
  return Buffer.from(await pdfDoc.save());
};

const textCheckOf = async (drawPage) => {
  const [image] = await convertPDFToImages(await buildPdf(drawPage));
  return image.textCheck;
};

const pageResult = (totalItems, visibleItems, pageNumber = 1) => ({
  pageNumber,
  textCheck: { totalItems, visibleItems },
});

// Another test file may already hold the port, leaving this server not listening.
afterAll((done) => {
  server.close(() => done());
});

describe("standard fonts", () => {
  test("bundled font files exist where the renderer looks for them", () => {
    const fontFile = path.join(
      PDF_LOAD_OPTIONS.standardFontDataUrl,
      "FoxitFixed.pfb",
    );

    expect(PDF_LOAD_OPTIONS.standardFontDataUrl.endsWith("/")).toBe(true);
    expect(fs.existsSync(fontFile)).toBe(true);
  });

  test("Helvetica loads from the bundled fonts, not from the machine", async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdfBuffer = await buildPdf((page, font) => drawLines(page, font));
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer),
      ...PDF_LOAD_OPTIONS,
    });
    const pdfDocument = await loadingTask.promise;
    const page = await pdfDocument.getPage(1);
    await page.getOperatorList();
    const { items } = await page.getTextContent();

    const font = page.commonObjs.get(items[0].fontName);
    await loadingTask.destroy();

    expect(font.missingFile).toBeFalsy();
  });
});

describe("rendered text check", () => {
  test("counts every line of normal text as visible", async () => {
    const check = await textCheckOf((page, font) => drawLines(page, font));

    expect(check).toEqual({ totalItems: 10, visibleItems: 10 });
  });

  test("counts white text on a white page as not visible", async () => {
    const check = await textCheckOf((page, font) =>
      drawLines(page, font, WHITE),
    );

    expect(check).toEqual({ totalItems: 10, visibleItems: 0 });
  });

  test("counts white text on a dark background as visible", async () => {
    const check = await textCheckOf((page, font) => {
      page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: NAVY });
      drawLines(page, font, WHITE);
    });

    expect(check).toEqual({ totalItems: 10, visibleItems: 10 });
  });

  test("counts text covered by a solid shape as not visible", async () => {
    const check = await textCheckOf((page, font) => {
      drawLines(page, font);
      page.drawRectangle({ x: 0, y: 0, width: 612, height: 792, color: NAVY });
    });

    expect(check).toEqual({ totalItems: 10, visibleItems: 0 });
  });

  test("still finds text on a rotated page", async () => {
    const check = await textCheckOf((page, font) => {
      drawLines(page, font);
      page.setRotation(degrees(90));
    });

    expect(check).toEqual({ totalItems: 10, visibleItems: 10 });
  });

  test("ignores blank text and text outside the page", async () => {
    const check = await textCheckOf((page, font) => {
      page.drawText("     ", { x: 50, y: 700, size: 12, font });
      page.drawText("Off the page", { x: 2000, y: 700, size: 12, font });
    });

    expect(check).toEqual({ totalItems: 0, visibleItems: 0 });
  });

  test("leaves emails and phone numbers out of the count", async () => {
    const check = await textCheckOf((page, font) => {
      page.drawText("Jane Doe", { x: 50, y: 700, size: 12, font });
      page.drawText("jane@example.com", { x: 50, y: 680, size: 12, font });
      page.drawText("(416) 555-0100", { x: 50, y: 660, size: 12, font });
    });

    expect(check).toEqual({ totalItems: 1, visibleItems: 1 });
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

  test("flags a page just under half visible", () => {
    expect(findPagesWithLostText([pageResult(11, 5)])).toHaveLength(1);
  });

  test("passes pages with too little text to judge", () => {
    expect(findPagesWithLostText([pageResult(4, 0)])).toEqual([]);
  });

  test("judges pages with exactly the minimum amount of text", () => {
    expect(findPagesWithLostText([pageResult(5, 0)])).toHaveLength(1);
  });

  test("passes scanned pages with no text layer", () => {
    expect(findPagesWithLostText([pageResult(0, 0)])).toEqual([]);
  });
});

describe("POST /api/editor/redact text check", () => {
  const drawEmail = (page, font, color) =>
    page.drawText("jane@example.com", { x: 50, y: 740, size: 12, font, color });

  test("returns 422 instead of a PDF when the text does not appear", async () => {
    const pdfBuffer = await buildPdf((page, font) => {
      drawEmail(page, font, WHITE);
      drawLines(page, font, WHITE);
    });

    const response = await request(app)
      .post("/api/editor/redact")
      .attach("file", pdfBuffer, "cv.pdf")
      .expect(422)
      .expect("Content-Type", /json/);

    expect(response.body).toMatchObject({
      error: "Scrubbed PDF Lost Its Text",
      code: "RENDER_TEXT_LOST",
      pages: [{ pageNumber: 1, totalItems: 10, visibleItems: 0 }],
    });
    // locum's scrub-cv route reads this field when the request fails.
    expect(response.body.message).toEqual(expect.any(String));
    expect(response.body.processingTime).toEqual(expect.any(Number));
  });

  test("reports only the affected page of a multi-page PDF", async () => {
    const pdfBuffer = await buildPdf(
      (page, font) => {
        drawEmail(page, font);
        drawLines(page, font);
      },
      (page, font) => drawLines(page, font, WHITE),
    );

    const response = await request(app)
      .post("/api/editor/redact")
      .attach("file", pdfBuffer, "cv.pdf")
      .expect(422);

    expect(response.body.pages).toEqual([
      { pageNumber: 2, totalItems: 10, visibleItems: 0 },
    ]);
  });

  test("scrubs a references page full of contact details", async () => {
    const pdfBuffer = await buildPdf((page, font) => {
      page.drawText("References", { x: 50, y: 740, size: 14, font });
      [0, 1, 2].forEach((person) => {
        [
          `Dr Referee ${person}`,
          `referee${person}@example.com`,
          `(416) 555-010${person}`,
          `(905) 555-020${person}`,
        ].forEach((text, line) => {
          page.drawText(text, {
            x: 50,
            y: 700 - person * 100 - line * 20,
            size: 11,
            font,
          });
        });
      });
    });

    const response = await request(app)
      .post("/api/editor/redact")
      .attach("file", pdfBuffer, "cv.pdf")
      .expect(200)
      .expect("Content-Type", "application/pdf");

    expect(JSON.parse(response.headers["x-redaction-stats"])).toMatchObject({
      emails: 3,
      phones: 6,
    });
  });
});
