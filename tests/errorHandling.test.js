/**
 * Tests for error handling middleware and PDF validation.
 * Errors travel through a real Express app so the responses are the ones clients get.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const request = require("supertest");
const { PDFDocument } = require("pdf-lib");
const { upload } = require("../src/config/multer");
const {
  getUserFriendlyError,
  multerErrorHandler,
  notFoundHandler,
  globalErrorHandler,
} = require("../src/middleware/errorHandler");
const { checkPDFEncryption } = require("../src/middleware/pdfValidator");

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const TINY_UPLOAD_LIMIT = 1024;

const createApp = () => {
  const app = express();
  const ok = (req, res) => res.json({ ok: true });

  app.post("/pdf", upload.single("file"), ok);
  app.post(
    "/tiny",
    multer({ limits: { fileSize: TINY_UPLOAD_LIMIT } }).single("file"),
    ok,
  );
  app.get("/fail", (req, res, next) => next(new Error(req.query.message)));

  app.use(multerErrorHandler(MAX_FILE_SIZE));
  app.use(notFoundHandler);
  app.use(globalErrorHandler);
  return app;
};

const app = createApp();

describe("getUserFriendlyError", () => {
  test.each([
    ["File is encrypted", "PDF is Password Protected"],
    ["Document is password-protected", "PDF is Password Protected"],
    ["Invalid PDF structure", "Invalid PDF File"],
    ["File is corrupted", "Invalid PDF File"],
    ["This is not a PDF", "Not a PDF File"],
    ["Failed to extract text", "Cannot Read PDF"],
    ["Something unexpected", "Processing Error"],
  ])("maps %p to %p", (message, expected) => {
    const result = getUserFriendlyError(new Error(message));
    expect(result.error).toBe(expected);
    expect(result.technicalDetails).toBe(message);
  });
});

describe("multerErrorHandler", () => {
  test("returns 403 for CORS errors", async () => {
    const response = await request(app)
      .get("/fail")
      .query({ message: "Not allowed by CORS" })
      .expect(403);

    expect(response.body.error).toBe("CORS Error");
  });

  test("returns 413 with size limit for oversized files", async () => {
    const response = await request(app)
      .post("/tiny")
      .attach("file", Buffer.alloc(TINY_UPLOAD_LIMIT + 1), "large.pdf")
      .expect(413);

    expect(response.body.message).toBe("Maximum file size is 10MB");
  });

  test("returns 400 for other multer errors", async () => {
    const response = await request(app)
      .post("/tiny")
      .attach("wrongField", Buffer.from("%PDF-"), "cv.pdf")
      .expect(400);

    expect(response.body.error).toBe("File upload error");
  });

  test("returns 400 for non-PDF uploads", async () => {
    const response = await request(app)
      .post("/pdf")
      .attach("file", Buffer.from("hello"), "notes.txt")
      .expect(400);

    expect(response.body.error).toBe("Invalid file type");
  });

  test("passes unknown errors to the next handler", async () => {
    const response = await request(app)
      .get("/fail")
      .query({ message: "boom" })
      .expect(500);

    expect(response.body.error).toBe("Internal server error");
  });
});

describe("notFoundHandler", () => {
  test("returns 404", async () => {
    const response = await request(app).get("/nothing-here").expect(404);

    expect(response.body.error).toBe("Endpoint not found");
  });
});

describe("globalErrorHandler", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  test("hides error details in production", async () => {
    process.env.NODE_ENV = "production";

    const response = await request(app)
      .get("/fail")
      .query({ message: "secret internals" })
      .expect(500);

    expect(response.body.message).not.toContain("secret internals");
  });

  test("shows error details outside production", async () => {
    process.env.NODE_ENV = "development";

    const response = await request(app)
      .get("/fail")
      .query({ message: "debug info" })
      .expect(500);

    expect(response.body.message).toBe("debug info");
  });
});

describe("checkPDFEncryption", () => {
  test("accepts a valid unencrypted PDF", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const result = await checkPDFEncryption(Buffer.from(await doc.save()));
    expect(result).toEqual({ isEncrypted: false, error: null });
  });

  test("rejects files too small to be a PDF", async () => {
    const result = await checkPDFEncryption(Buffer.from("%PD"));
    expect(result.error).toMatch(/too small/);
  });

  test("rejects files without a PDF header", async () => {
    const result = await checkPDFEncryption(Buffer.from("hello world"));
    expect(result.error).toMatch(/missing PDF header/);
  });

  test("flags password-protected PDFs", async () => {
    const buffer = fs.readFileSync(
      path.join(__dirname, "fixtures/encrypted.pdf"),
    );
    const result = await checkPDFEncryption(buffer);
    expect(result.isEncrypted).toBe(true);
  });

  test("flags corrupted PDFs as invalid, not encrypted", async () => {
    const result = await checkPDFEncryption(Buffer.from("%PDF-1.7\n1 0 obj <<"));
    expect(result.isEncrypted).toBe(false);
    expect(result.error).toMatch(/Invalid or corrupted/);
  });
});
