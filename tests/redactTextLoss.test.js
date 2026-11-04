/**
 * Tests the /redact response when rendering loses a PDF's text
 */

jest.mock("../src/services/pdfToImage", () => ({
  ...jest.requireActual("../src/services/pdfToImage"),
  convertPDFToImages: jest.fn(),
}));

const request = require("supertest");
const { PDFDocument, StandardFonts } = require("pdf-lib");
const { app } = require("../index");
const { convertPDFToImages } = require("../src/services/pdfToImage");

const createPdfWithEmail = async () => {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([612, 792]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  page.drawText("jane@example.com", { x: 50, y: 700, size: 12, font });
  return Buffer.from(await pdfDoc.save());
};

describe("POST /api/editor/redact when text is lost", () => {
  test("returns a 422 error instead of a blank PDF", async () => {
    convertPDFToImages.mockResolvedValue([
      { pageNumber: 1, textCheck: { totalItems: 56, visibleItems: 3 } },
    ]);

    const response = await request(app)
      .post("/api/editor/redact")
      .attach("file", await createPdfWithEmail(), "cv.pdf")
      .expect(422)
      .expect("Content-Type", /json/);

    expect(response.body.code).toBe("RENDER_TEXT_LOST");
    expect(response.body.pages).toEqual([
      { pageNumber: 1, totalItems: 56, visibleItems: 3 },
    ]);
  });
});
