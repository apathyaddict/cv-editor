/**
 * Integration Tests for API Endpoints
 * Tests the Express server endpoints
 */

const request = require("supertest");
const { app, server } = require("../index");
const fs = require("fs");
const path = require("path");
const { PDFDocument, StandardFonts } = require("pdf-lib");
const { extractAllText } = require("../src/services/pdfExtractor");

const createPdfWithPII = async () => {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([600, 400]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  page.drawText("Jane Doe", { x: 50, y: 350, size: 14, font });
  page.drawText("jane.doe@example.com", { x: 50, y: 330, size: 12, font });
  page.drawText("(416) 555-0100", { x: 50, y: 310, size: 12, font });
  return Buffer.from(await pdfDoc.save());
};

describe("API Endpoints", () => {
  describe("GET /health", () => {
    test("should return 200 and health status", async () => {
      const response = await request(app)
        .get("/api/health")
        .expect(200)
        .expect("Content-Type", /json/);

      expect(response.body).toHaveProperty("status", "ok");
      expect(response.body).toHaveProperty(
        "service",
        "PDF Privacy Redaction Server",
      );
      expect(response.body).toHaveProperty("version");
    });
  });

  describe("POST /redact", () => {
    test("should return 400 when no file is uploaded", async () => {
      const response = await request(app)
        .post("/api/editor/redact")
        .expect(400);

      expect(response.body).toHaveProperty("error");
      expect(response.body.error).toMatch(/No PDF file uploaded/i);
    });

    test("should return 400 when non-PDF file is uploaded", async () => {
      const response = await request(app)
        .post("/api/editor/redact")
        .field("name", "test")
        .attach("file", Buffer.from("not a pdf"), "test.txt")
        .expect(400);

      expect(response.body).toHaveProperty("error");
    });

    test("should process PDF with PII and return redacted PDF", async () => {
      const response = await request(app)
        .post("/api/editor/redact")
        .attach("file", await createPdfWithPII(), "cv.pdf")
        .expect(200)
        .expect("Content-Type", "application/pdf");

      expect(response.headers).toHaveProperty("x-processing-time");
      expect(JSON.parse(response.headers["x-redaction-stats"])).toEqual({
        totalRedactions: 2,
        emails: 1,
        phones: 1,
        pagesAffected: 1,
      });

      expect(response.body).toBeInstanceOf(Buffer);
      expect(response.body.subarray(0, 5).toString()).toBe("%PDF-");

      const outputText = await extractAllText(response.body);
      expect(outputText).not.toContain("jane.doe@example.com");
      expect(outputText).not.toContain("555-0100");
    });

    test("should handle PDF with no PII gracefully", async () => {
      // Create a simple PDF with no PII
      const { PDFDocument, StandardFonts } = require("pdf-lib");
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([600, 400]);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

      page.drawText("This is a test document with no personal information.", {
        x: 50,
        y: 350,
        size: 12,
        font: font,
      });

      const pdfBytes = await pdfDoc.save();

      const response = await request(app)
        .post("/api/editor/redact")
        .attach("file", Buffer.from(pdfBytes), "test.pdf")
        .expect(200);

      expect(response.body).toHaveProperty("message");
      expect(response.body.message).toMatch(/No personal information found/i);
      expect(response.body.redactions.totalRedactions).toBe(0);
    });
  });

  describe("POST /analyze", () => {
    test("should return 400 when no file is uploaded", async () => {
      const response = await request(app)
        .post("/api/editor/analyze")
        .expect(400);

      expect(response.body).toHaveProperty("error");
    });

    test("should analyze PDF and return statistics without redacting", async () => {
      const response = await request(app)
        .post("/api/editor/analyze")
        .attach("file", await createPdfWithPII(), "cv.pdf")
        .expect(200)
        .expect("Content-Type", /json/);

      expect(response.body.found).toBe(true);
      expect(response.body.statistics).toEqual({
        totalRedactions: 2,
        emails: 1,
        phones: 1,
        pagesAffected: 1,
      });
      expect(response.body.details).toHaveLength(1);
    });

    test("should return detailed coordinate information in analysis", async () => {
      const response = await request(app)
        .post("/api/editor/analyze")
        .attach("file", await createPdfWithPII(), "cv.pdf")
        .expect(200);

      const [firstPage] = response.body.details;
      expect(firstPage.page).toBe(1);
      expect(firstPage.items).toHaveLength(2);

      const [firstItem] = firstPage.items;
      expect(firstItem.type).toBe("email");
      expect(firstItem.text).toBe("jane.doe@example.com");
      expect(firstItem.coordinates).toEqual({
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number),
      });
    });
  });

  describe("Root-level legacy routes", () => {
    let pdfBuffer;

    beforeAll(async () => {
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([600, 400]);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      page.drawText("Email: jane.doe@example.com", { x: 50, y: 350, size: 12, font });
      pdfBuffer = Buffer.from(await pdfDoc.save());
    });

    test("GET / should return service info", async () => {
      const response = await request(app).get("/").expect(200);

      expect(response.body).toHaveProperty("status", "ok");
    });

    test("POST /analyze should find PII in an uploaded PDF", async () => {
      const response = await request(app)
        .post("/analyze")
        .attach("file", pdfBuffer, "cv.pdf")
        .expect(200);

      expect(response.body.statistics.emails).toBe(1);
    });

    test("POST /redact should return a redacted PDF", async () => {
      await request(app)
        .post("/redact")
        .attach("file", pdfBuffer, "cv.pdf")
        .expect(200)
        .expect("Content-Type", "application/pdf");
    });

    test.each(["/analyze", "/redact"])(
      "POST %s should reject non-PDF files",
      async (route) => {
        const response = await request(app)
          .post(route)
          .attach("file", Buffer.from("not a pdf"), "test.txt")
          .expect(400);

        expect(response.body.error).toBe("Invalid file type");
      },
    );
  });

  describe("Password-protected PDFs", () => {
    const encryptedPdf = path.join(__dirname, "fixtures/encrypted.pdf");

    test.each(["/api/editor/analyze", "/api/editor/redact"])(
      "POST %s should tell the user to remove the password",
      async (route) => {
        const response = await request(app)
          .post(route)
          .attach("file", encryptedPdf)
          .expect(400);

        expect(response.body.error).toBe("PDF is Password Protected");
      },
    );
  });

  describe("Error Handling", () => {
    test("should return 404 for unknown endpoints", async () => {
      const response = await request(app).get("/unknown-endpoint").expect(404);

      expect(response.body).toHaveProperty("error");
    });

    test("should handle file size limit violations", async () => {
      // Create a buffer larger than the limit (if applicable)
      // This test assumes MAX_FILE_SIZE is set to 10MB
      const largeBuffer = Buffer.alloc(11 * 1024 * 1024); // 11MB

      const response = await request(app)
        .post("/api/editor/redact")
        .attach("file", largeBuffer, "large.pdf");

      // Should return 413 or 400 depending on multer config
      expect([400, 413]).toContain(response.status);
    });
  });
});
