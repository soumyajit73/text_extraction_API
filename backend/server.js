import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs/promises";
import pdf from "pdf-parse";
import Poppler from "pdf-poppler";
import os from "os";

dotenv.config();

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.join(__dirname, "data");
const uploadsDir = path.join(dataDir, "uploads");
// Temporary directory for converted PDF images
const tempDir = os.tmpdir();

(async () => {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(uploadsDir, { recursive: true });
    console.log("Data directories created successfully.");
  } catch (err) {
    console.error(`Error creating directories:`, err);
  }
})();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
    cb(null, `${Date.now()}-${sanitizedName}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/") || file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only image and PDF files are allowed."), false);
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 },
});

app.use(express.static(path.join(__dirname, "..", "frontend")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "index.html"));
});

app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

const errorHandler = (err, req, res, next) => {
  console.error("Error:", err);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `File upload error: ${err.message}` });
  }
  res.status(500).json({ error: err.message || "Internal Server Error" });
};

app.post("/api/process", upload.single("file"), async (req, res, next) => {
  let filePath;
  let tempImagePath;

  try {
    const prompt = req.body.prompt;
    const file = req.file;
    filePath = file?.path;

    if (!file) {
      throw new Error("No file uploaded.");
    }
    if (!prompt) {
      throw new Error("No prompt provided.");
    }

    let messages;
    
    if (file.mimetype === "application/pdf") {
      console.log("Processing PDF file...");
      const pdfBuffer = await fs.readFile(filePath);
      const data = await pdf(pdfBuffer);
      const extractedText = data.text;

      if (extractedText && extractedText.trim().length > 0) {
        // Case 1: The PDF has a text layer, so we use the extracted text.
        console.log("PDF contains a text layer. Analyzing text...");
        messages = [
          {
            role: "system",
            content: "You are a text analysis assistant. Your sole purpose is to analyze the provided text based on the user's prompt. You must not add any commentary, explanations, or conversational text unless explicitly asked."
          },
          {
            role: "user",
            content: [
              { type: "text", text: `Prompt: ${prompt}\n\nDocument Text:\n${extractedText}` },
            ]
          }
        ];
      } else {
        // Case 2: The PDF does NOT have a text layer (it's an image-based PDF).
        // Fall back to converting it to an image for OCR.
        console.log("No text layer found in PDF. Converting to image for OCR.");
        
        const poppler = new Poppler();
        const options = {
            firstPageToConvert: 1,
            lastPageToConvert: 1,
            jpegFile: false,
            pngFile: true,
        };

        const imageFilename = `temp-${Date.now()}`;
        tempImagePath = path.join(tempDir, imageFilename);

        await poppler.pdfToPng(filePath, tempImagePath, options);

        // Read the newly created image file
        const imageBuffer = await fs.readFile(`${tempImagePath}-1.png`);
        const base64Image = imageBuffer.toString("base64");

        messages = [
          {
            role: "system",
            content: "You are a highly efficient text extraction assistant. Your sole purpose is to extract and return text from an image. You must not add any commentary, explanations, or conversational text. Your response should be nothing but the extracted text."
          },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                // Pass the base64-encoded PNG as an image URL
                image_url: { url: `data:image/png;base64,${base64Image}` }
              }
            ]
          }
        ];
      }

    } else if (file.mimetype.startsWith("image/")) {
      // Logic for regular images remains the same
      console.log("Processing image file...");
      const imageBuffer = await fs.readFile(filePath);
      const base64Image = imageBuffer.toString("base64");
      
      messages = [
        {
          role: "system",
          content: "You are a highly efficient text extraction assistant. Your sole purpose is to extract and return text from an image. You must not add any commentary, explanations, or conversational text. Your response should be nothing but the extracted text."
        },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: { url: `data:${file.mimetype};base64,${base64Image}` }
            }
          ]
        }
      ];
    } else {
      throw new Error("Unsupported file type.");
    }
    
    const requestBody = {
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: messages,
      temperature: 0,
      max_tokens: 1024,
    };
    
    console.log("🚀 Sending request to Groq API...");

    const groqResponse = await fetch(GROQ_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody),
    });

    if (!groqResponse.ok) {
      const errorText = await groqResponse.text();
      throw new Error(`Groq API Error: ${groqResponse.status} - ${errorText}`);
    }

    const data = await groqResponse.json();
    const outputText = data.choices?.[0]?.message?.content;

    if (!outputText) {
      throw new Error("Invalid response or missing content from Groq API.");
    }

    res.json({ success: true, output: outputText });

  } catch (error) {
    next(error);
  } finally {
    if (filePath) {
      try {
        await fs.unlink(filePath);
        console.log(`Cleaned up file: ${filePath}`);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.error(`Error cleaning up file ${filePath}:`, err);
        }
      }
    }
    // Clean up temporary image file if it was created
    if (tempImagePath) {
      try {
        await fs.unlink(`${tempImagePath}-1.png`);
        console.log(`Cleaned up temporary image: ${tempImagePath}-1.png`);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          console.error(`Error cleaning up temporary image ${tempImagePath}-1.png}:`, err);
        }
      }
    }
  }
});

app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
