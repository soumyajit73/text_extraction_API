import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs/promises";

dotenv.config();

const app = express();
app.use(express.json());

// Helper for ES Modules to get __dirname and __filename
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure data directories exist
const dataDir = path.join(__dirname, "data");
const uploadsDir = path.join(dataDir, "uploads");

[dataDir, uploadsDir].forEach(async (dir) => {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    console.error(`Error creating directory ${dir}:`, err);
  }
});

// Configure Multer for file storage and filtering
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    // Sanitize filename to prevent path traversal and other issues
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
    cb(null, `${Date.now()}-${sanitizedName}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    // Update file filter to accept common image MIME types
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed."), false);
    }
  },
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, "..", "frontend")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "index.html"));
});

// Basic health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Groq API configuration
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

// Generic error handler middleware
const errorHandler = (err, req, res, next) => {
  console.error("Error:", err);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `File upload error: ${err.message}` });
  }
  res.status(500).json({ error: err.message || "Internal Server Error" });
};

// Main API endpoint to process the image and call the Groq API
app.post("/api/process", upload.single("file"), async (req, res, next) => {
  let filePath;

  try {
    filePath = req.file?.path;
    if (!filePath) {
      throw new Error("No file uploaded.");
    }

    const prompt = "Extract all text from the provided image. Respond with only the extracted text, nothing else. Do not add any introductory or concluding sentences or conversational filler. Provide only the raw text.";
    
    const imageBuffer = await fs.readFile(filePath);
    const base64Image = imageBuffer.toString("base64");
    
    const messages = [
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
            image_url: { url: `data:${req.file.mimetype};base64,${base64Image}` }
          }
        ]
      }
    ];

    // **This is the part that was missing and has been added.**
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
  }
});
// Use the generic error handler
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
