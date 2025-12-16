#!/usr/bin/env node
/**
 * PDF Form Analyzer using Gemini AI
 *
 * Analyzes PDF files to determine:
 * 1. Is it a form? (yes/no)
 * 2. Form type (fillable PDF, Google form, MS Office form, etc.)
 * 3. Does it ask for sensitive info? (SSN, DL#, financial, health, criminal history)
 *
 * Usage:
 *   GEMINI_API_KEY=your_key npx github:sfds/pdf-formbot urls.txt      # one URL per line
 *   GEMINI_API_KEY=your_key npx github:sfds/pdf-formbot input.csv     # extracts PDF URLs from CSV
 *   GEMINI_API_KEY=your_key npx github:sfds/pdf-formbot https://example.com/form.pdf
 *   GEMINI_API_KEY=your_key npx github:sfds/pdf-formbot --test
 *
 * Options:
 *   --prompt <file>   Use a custom prompt from a text file
 */

import { createPartFromUri, GoogleGenAI, type File } from "@google/genai";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Logging system to capture console output
const logBuffer: string[] = [];
const originalLog = console.log;
const originalError = console.error;

function log(...args: any[]) {
  const message = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  logBuffer.push(message);
  originalLog(...args);
}

function logError(...args: any[]) {
  const message = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
  logBuffer.push(message);
  originalError(...args);
}

// Replace console methods
console.log = log;
console.error = logError;

function writeLogFile(outputPath: string): void {
  writeFileSync(outputPath, logBuffer.join("\n"), "utf-8");
  originalLog(`📄 Log written to: ${outputPath}`);
}

// Types
interface FormAnalysis {
  url: string;
  isForm: "Yes" | "No" | "";
  formType:
  | "Fillable PDF"
  | "Non-Fillable PDF"
  | "Google form"
  | "MS Office form"
  | "MS Word document"
  | "Airtable form"
  | "Phone"
  | "Email"
  | "N/A"
  | "Unknown";
  sensitiveInfo: {
    ssn: boolean;
    driversLicense: boolean;
    financial: boolean;
    health: boolean;
    criminalHistory: boolean;
  };
  sensitiveInfoSummary: string;
  confidence: number;
  pageCount: number;
  fileSizeKB: number;
  processingTimeSec: number;
  notes: string;
  error?: string;
}

// Form types that match the reviewer UI
const FORM_TYPES = [
  "Fillable PDF", // Interactive PDF with form fields
  "Non-Fillable PDF", // Printable form to fill by hand
  "Google form",
  "MS Office form",
  "MS Word document",
  "Airtable form",
  "Phone", // Phone-based form submission
  "Email", // Email-based form submission
] as const;

// The analysis prompt for Gemini
const ANALYSIS_PROMPT = `Analyze this PDF document and answer the following questions. Be thorough in your analysis.

**Question 1: Is this a form?**
A form is a document whose PRIMARY PURPOSE is to collect information from a person who fills it out.

CLASSIFY AS A FORM (Yes):
- Documents with input fields, text boxes, or blank lines for writing responses
- Documents with checkboxes or radio buttons for the user to select
- Documents with signature lines
- Documents with instructions to "fill in", "complete", or "submit"
- Documents with labeled fields like "Name:", "Address:", "Date:", etc.

DO NOT CLASSIFY AS A FORM (No):
- Checklists or compliance guides (even if they have checkboxes for internal tracking)
- Reports, handbooks, or manuals that happen to contain sample templates
- Documents where less than 50% of the content is form fields
- Informational brochures or reference materials
- Budget documents, meeting minutes, or policy documents

Answer: "Yes" or "No"

**Question 2: If it IS a form, what type of form is it?**
Choose the MOST appropriate type:
- "Fillable PDF" - A PDF with INTERACTIVE FORM FIELDS that can be typed into directly in a PDF reader (look for blue-highlighted fields, text input boxes, or AcroForm elements)
- "Non-Fillable PDF" - A printable PDF form that MUST BE FILLED BY HAND on a printout (has blank lines/boxes but no interactive digital fields)
- "N/A" - Not a form

**Question 3: Does this form ask for any sensitive information?**
Only mark TRUE if the form explicitly asks the USER to provide their own personal sensitive information (not just references to policies or other people's information):

- SSN (Social Security Number): The form asks the user to write their own Social Security Number. Look for "SSN", "Social Security Number", or 9-digit number fields (XXX-XX-XXXX format).
- Driver's License Number: The form asks for the user's own driver's license or state ID number. Look for "Driver's License", "DL#", "License Number", or state ID fields. (Note: Business license numbers do NOT count)
- Financial Information: The form asks for personal financial details like bank account numbers, routing numbers, income amounts, salary, tax information, or credit card numbers.
- Health/Medical Information: The form asks for personal medical history, diagnoses, medications, doctor information, disabilities, or insurance claims.
- Criminal History: The form asks about personal arrests, convictions, or criminal background.

**Question 4: Confidence Level**
Rate your confidence in this assessment from 0.0 to 1.0:
- 0.9-1.0: Very confident - document is clearly a form or clearly not a form
- 0.7-0.8: Confident - some ambiguity but classification is likely correct
- 0.5-0.6: Uncertain - edge case that could go either way
- Below 0.5: Low confidence - document is unusual or hard to classify

**Question 5: Document Metadata**
Count the number of pages in this PDF document.

**Respond in this exact JSON format:**
\`\`\`json
{
  "isForm": "Yes" or "No",
  "formType": "<one of the types listed above>",
  "sensitiveInfo": {
    "ssn": true/false,
    "driversLicense": true/false,
    "financial": true/false,
    "health": true/false,
    "criminalHistory": true/false
  },
  "confidence": <0.0 to 1.0>,
  "pageCount": <number of pages>,
  "notes": "<brief description of what the document is and any relevant observations>"
}
\`\`\``;

// Sample URLs for testing
const TEST_URLS = [
  "http://cspinet.org/new/pdf/cspi_soda_philanthropy_online.pdf",
  "http://forms.sfplanning.org/SchoolChildCareManagementPlan_SupplementalApplication.pdf",
  "http://media.api.sf.gov/documents/Folsom_Street_Entertainment_Zone_Management_Plan_.pdf",
  "http://oag.ca.gov/sites/all/files/agweb/pdfs/victimservices/OVSform.pdf",
  "http://sfbos.org/ftp/uploadedfiles/bdsupvrs/ordinances15/o0099-15.pdf",
  "http://www.cdcr.ca.gov/victim_services/docs/CDCR1707.pdf",
];

class FormAnalyzer {
  private ai: GoogleGenAI;
  private model = "gemini-2.5-flash";
  private prompt: string;

  constructor(apiKey: string, customPrompt?: string) {
    this.ai = new GoogleGenAI({ apiKey });
    this.prompt = customPrompt || ANALYSIS_PROMPT;
  }

  /**
   * Download a PDF from URL and upload it to Gemini Files API
   * Returns the uploaded File and the file size in KB
   */
  private async uploadPdfFromUrl(url: string): Promise<{ file: File; fileSizeKB: number }> {
    console.log(`  📥 Downloading PDF from ${url}`);

    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
    }

    const pdfBuffer = await response.arrayBuffer();
    const fileSizeKB = Math.round(pdfBuffer.byteLength / 1024);
    const fileBlob = new Blob([pdfBuffer], { type: "application/pdf" });

    // Extract filename from URL for display
    const urlPath = new URL(url).pathname;
    const displayName = urlPath.split("/").pop() || "document.pdf";

    console.log(`  📤 Uploading to Gemini (${fileSizeKB} KB)`);

    const file = await this.ai.files.upload({
      file: fileBlob,
      config: { displayName },
    });

    // Wait for processing
    let getFile = await this.ai.files.get({ name: file.name! });
    let attempts = 0;
    while (getFile.state === "PROCESSING" && attempts < 30) {
      console.log(`  ⏳ Processing... (${attempts + 1})`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      getFile = await this.ai.files.get({ name: file.name! });
      attempts++;
    }

    if (getFile.state === "FAILED") {
      throw new Error("Gemini file processing failed");
    }

    return { file: getFile, fileSizeKB };
  }

  /**
   * Analyze a single PDF
   */
  async analyzePdf(url: string): Promise<FormAnalysis> {
    const startTime = Date.now();
    const result: FormAnalysis = {
      url,
      isForm: "",
      formType: "N/A",
      sensitiveInfo: {
        ssn: false,
        driversLicense: false,
        financial: false,
        health: false,
        criminalHistory: false,
      },
      sensitiveInfoSummary: "",
      confidence: 0,
      pageCount: 0,
      fileSizeKB: 0,
      processingTimeSec: 0,
      notes: "",
    };

    try {
      // Upload the PDF
      const { file, fileSizeKB } = await this.uploadPdfFromUrl(url);
      result.fileSizeKB = fileSizeKB;

      if (!file.uri || !file.mimeType) {
        throw new Error("File upload succeeded but missing URI or mimeType");
      }

      console.log(`  🤖 Analyzing with ${this.model}...`);

      // Create content with the file
      const filePart = createPartFromUri(file.uri, file.mimeType);

      const response = await this.ai.models.generateContent({
        model: this.model,
        contents: [{ parts: [filePart, { text: this.prompt }] }],
      });

      const text = response.text || "";

      // Parse the JSON response
      const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
      if (!jsonMatch) {
        // Try parsing the whole response as JSON
        const directMatch = text.match(/\{[\s\S]*\}/);
        if (!directMatch) {
          throw new Error("Could not parse JSON from response");
        }
        const parsed = JSON.parse(directMatch[0]);
        Object.assign(result, this.normalizeResponse(parsed));
      } else {
        const parsed = JSON.parse(jsonMatch[1]);
        Object.assign(result, this.normalizeResponse(parsed));
      }

      // Clean up - delete the uploaded file
      try {
        await this.ai.files.delete({ name: file.name! });
      } catch {
        // Ignore delete errors
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      result.notes = `Error: ${result.error}`;
      console.error(`  ❌ Error: ${result.error}`);
    }

    result.processingTimeSec = Math.round((Date.now() - startTime) / 1000);
    return result;
  }

  /**
   * Normalize the LLM response to our expected format
   */
  private normalizeResponse(parsed: any): Partial<FormAnalysis> {
    const sensitiveInfo = {
      ssn: Boolean(parsed.sensitiveInfo?.ssn),
      driversLicense: Boolean(parsed.sensitiveInfo?.driversLicense),
      financial: Boolean(parsed.sensitiveInfo?.financial),
      health: Boolean(parsed.sensitiveInfo?.health),
      criminalHistory: Boolean(parsed.sensitiveInfo?.criminalHistory),
    };

    // Build summary of sensitive info
    const sensitiveItems = [];
    if (sensitiveInfo.ssn) sensitiveItems.push("SSN");
    if (sensitiveInfo.driversLicense) sensitiveItems.push("DL#");
    if (sensitiveInfo.financial) sensitiveItems.push("Financial");
    if (sensitiveInfo.health) sensitiveItems.push("Health");
    if (sensitiveInfo.criminalHistory) sensitiveItems.push("Criminal");

    return {
      isForm: parsed.isForm === "Yes" ? "Yes" : "No",
      formType: this.normalizeFormType(parsed.formType),
      sensitiveInfo,
      sensitiveInfoSummary:
        sensitiveItems.length > 0 ? sensitiveItems.join(", ") : "None",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      pageCount: typeof parsed.pageCount === "number" ? parsed.pageCount : 0,
      notes: parsed.notes || "",
    };
  }

  /**
   * Normalize form type to match our expected values
   */
  private normalizeFormType(type: string): FormAnalysis["formType"] {
    if (!type) return "N/A";

    const normalized = type.toLowerCase().trim();

    if (normalized.includes("fillable") && normalized.includes("pdf"))
      return "Fillable PDF";
    if (normalized.includes("non-fillable") || normalized.includes("nonfillable"))
      return "Non-Fillable PDF";
    if (normalized.includes("google")) return "Google form";
    if (normalized.includes("airtable")) return "Airtable form";
    if (normalized.includes("office") || normalized.includes("excel"))
      return "MS Office form";
    if (normalized.includes("word")) return "MS Word document";
    if (normalized.includes("phone")) return "Phone";
    if (normalized.includes("email")) return "Email";
    if (normalized.includes("digital") || normalized.includes("printable"))
      return "Non-Fillable PDF";
    if (normalized === "n/a" || normalized === "not a form") return "N/A";

    // If it's a PDF form but not fillable
    if (normalized.includes("pdf")) return "Non-Fillable PDF";

    return "Unknown";
  }

  /**
   * Analyze multiple PDFs from a list of URLs
   */
  async analyzeAll(urls: string[]): Promise<FormAnalysis[]> {
    const results: FormAnalysis[] = [];

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i].trim();
      if (!url) continue;

      console.log(`\n[${i + 1}/${urls.length}] Analyzing: ${url}`);

      const result = await this.analyzePdf(url);
      results.push(result);

      console.log(`  ✅ Is Form: ${result.isForm}`);
      if (result.isForm === "Yes") {
        console.log(`     Type: ${result.formType}`);
        console.log(`     Sensitive: ${result.sensitiveInfoSummary}`);
      }
      if (result.notes) {
        console.log(`     Notes: ${result.notes.substring(0, 100)}...`);
      }

      // Small delay between requests to be nice to the API
      if (i < urls.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    return results;
  }
}

/**
 * Read URLs from a file (.txt or .csv)
 * - .txt: one URL per line
 * - .csv: extracts PDF URLs from anywhere in the file
 */
function readUrlsFromFile(filePath: string): string[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const urls: string[] = [];

  const isTxt = filePath.toLowerCase().endsWith(".txt");

  if (isTxt) {
    // Simple .txt format: one URL per line
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        urls.push(trimmed);
      }
    }
  } else {
    // CSV format: extract PDF URLs from anywhere
    const urlPattern = /https?:\/\/[^\s,\"\'\<\>]+\.pdf/gi;
    for (const line of lines) {
      const matches = line.match(urlPattern);
      if (matches) {
        urls.push(...matches);
      }
    }
  }

  return [...new Set(urls)]; // Deduplicate
}

/**
 * Write results to CSV (Excel-compatible, matching Airtable columns)
 */
function writeResultsCsv(results: FormAnalysis[], outputPath: string, modelName: string): void {
  // Helper to escape a CSV field (quotes fields containing commas, quotes, or newlines)
  const escapeField = (value: string): string => {
    if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  };

  const headers = [
    "url",
    "Review: Is this a form",
    "Reviewer: Form Type",
    "Reviewer: Does this form ask for SSN, DL#, financial, health info or criminal history?",
    "Reviewer: Revisit for further review (optional)",
    "Reviewer: Notes (optional)",
    "Review: Reviewed by",
    // Additional metadata columns
    "Confidence",
    "Page Count",
    "File Size (KB)",
    "Processing Time (sec)",
    "SSN",
    "Driver's License",
    "Financial",
    "Health",
    "Criminal History",
    "Sensitive Info Summary",
    "Error",
  ];

  const rows = results.map((r) => [
    escapeField(r.url),
    r.isForm,
    r.formType,
    r.sensitiveInfoSummary !== "None" ? "Yes" : "No",
    r.confidence < 0.7 ? "checked" : "",
    escapeField(r.notes || ""),
    modelName,
    // Additional metadata
    r.confidence.toFixed(2),
    r.pageCount.toString(),
    r.fileSizeKB.toString(),
    r.processingTimeSec.toString(),
    r.sensitiveInfo.ssn ? "Yes" : "No",
    r.sensitiveInfo.driversLicense ? "Yes" : "No",
    r.sensitiveInfo.financial ? "Yes" : "No",
    r.sensitiveInfo.health ? "Yes" : "No",
    r.sensitiveInfo.criminalHistory ? "Yes" : "No",
    escapeField(r.sensitiveInfoSummary),
    escapeField(r.error || ""),
  ]);

  // Add UTF-8 BOM for Excel compatibility
  const BOM = "\ufeff";
  const escapedHeaders = headers.map(escapeField);
  const csv = BOM + [escapedHeaders.join(","), ...rows.map((row) => row.join(","))].join("\n");

  writeFileSync(outputPath, csv, "utf-8");
  console.log(`\n📄 Results written to: ${outputPath}`);
}

/**
 * Write results to JSON
 */
function writeResultsJson(results: FormAnalysis[], outputPath: string): void {
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`📄 JSON results written to: ${outputPath}`);
}

// Main
async function main() {
  const args = process.argv.slice(2);

  // Check for API key
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("❌ Error: GEMINI_API_KEY environment variable is required");
    console.error("   Set it with: GEMINI_API_KEY=your_key npx tsx src/analyze.ts");
    process.exit(1);
  }

  // Parse --prompt option
  let customPrompt: string | undefined;
  const promptIdx = args.indexOf("--prompt");
  if (promptIdx !== -1 && args[promptIdx + 1]) {
    const promptPath = resolve(args[promptIdx + 1]);
    if (!existsSync(promptPath)) {
      console.error(`❌ Error: Prompt file not found: ${promptPath}`);
      process.exit(1);
    }
    customPrompt = readFileSync(promptPath, "utf-8");
    console.log(`📝 Using custom prompt from: ${promptPath}\n`);
    args.splice(promptIdx, 2);
  }

  const analyzer = new FormAnalyzer(apiKey, customPrompt);

  let urls: string[];

  if (args.includes("--test")) {
    // Test mode: use sample URLs
    console.log("🧪 Test mode: analyzing sample PDFs\n");
    urls = TEST_URLS;
  } else if (args.length > 0 && existsSync(args[0])) {
    // CSV file provided
    const inputPath = resolve(args[0]);
    console.log(`📖 Reading URLs from: ${inputPath}\n`);
    urls = readUrlsFromFile(inputPath);
    console.log(`   Found ${urls.length} PDF URLs\n`);
  } else if (args.length > 0) {
    // Single URL provided
    urls = [args[0]];
  } else {
    console.log("Usage:");
    console.log("  GEMINI_API_KEY=key npx tsx src/analyze.ts input.csv     # Analyze URLs from CSV");
    console.log("  GEMINI_API_KEY=key npx tsx src/analyze.ts <url>         # Analyze single URL");
    console.log("  GEMINI_API_KEY=key npx tsx src/analyze.ts --test        # Run test with sample URLs");
    process.exit(0);
  }

  if (urls.length === 0) {
    console.error("❌ No URLs found to analyze");
    process.exit(1);
  }

  console.log(`🔍 Analyzing ${urls.length} PDF(s)...`);
  const modelName = "gemini-2.5-flash";

  const results = await analyzer.analyzeAll(urls);

  // Generate output files (use local time for filename)
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outputDir = resolve(__dirname, "..");

  writeResultsCsv(results, resolve(outputDir, `results_${timestamp}.csv`), modelName);
  writeResultsJson(results, resolve(outputDir, `results_${timestamp}.json`));

  // Print summary
  console.log("\n📊 Summary:");
  console.log(`   Total analyzed: ${results.length}`);
  console.log(`   Forms found: ${results.filter((r) => r.isForm === "Yes").length}`);
  console.log(`   Errors: ${results.filter((r) => r.error).length}`);

  const withSensitive = results.filter(
    (r) =>
      r.sensitiveInfo.ssn ||
      r.sensitiveInfo.driversLicense ||
      r.sensitiveInfo.financial ||
      r.sensitiveInfo.health ||
      r.sensitiveInfo.criminalHistory
  );
  console.log(`   Forms with sensitive info: ${withSensitive.length}`);

  writeLogFile(resolve(outputDir, `results_${timestamp}.txt`));
}

main().catch(console.error);
