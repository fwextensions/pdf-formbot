/**
 * PDF Form Analyzer using Gemini AI
 *
 * Analyzes PDF files to determine:
 * 1. Is it a form? (yes/no)
 * 2. Form type (fillable PDF, Google form, MS Office form, etc.)
 * 3. Does it ask for sensitive info? (SSN, DL#, financial, health, criminal history)
 *
 * Usage:
 *   GEMINI_API_KEY=your_key npx tsx src/analyze.ts input.csv
 *   GEMINI_API_KEY=your_key npx tsx src/analyze.ts --test  # test with sample URLs
 */

import { createPartFromUri, GoogleGenAI, type File } from "@google/genai";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Types
interface FormAnalysis {
  url: string;
  isForm: "Yes" | "No" | "Error";
  formType:
  | "Fillable PDF"
  | "Digital form"
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
  notes: string;
  error?: string;
}

// Form types that match the reviewer UI
const FORM_TYPES = [
  "Fillable PDF", // Interactive PDF with form fields
  "Digital form", // Generic digital/web form
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
A form is a document designed to collect information from a person. Look for:
- Input fields, text boxes, or blank lines for writing
- Checkboxes or radio buttons
- Signature lines
- Instructions to "fill in", "complete", or "submit"
- Labeled fields like "Name:", "Address:", "Date:", etc.

Answer: "Yes" or "No"

**Question 2: If it IS a form, what type of form is it?**
Choose the MOST appropriate type:
- "Fillable PDF" - A PDF with interactive form fields that can be typed into directly in a PDF reader (look for blue-highlighted fields or AcroForm elements)
- "Digital form" - A printable form designed to be filled by hand (has blank lines/boxes but no interactive fields)
- "Google form" - A Google Forms web form
- "MS Office form" - A Microsoft Office-based form (Word form with content controls, Excel form, etc.)
- "MS Word document" - A Word document template meant to be edited
- "Airtable form" - An Airtable-based form
- "Phone" - Form that must be completed by phone call
- "Email" - Form that must be completed and submitted via email
- "N/A" - Not a form

**Question 3: Does this form ask for any sensitive information?**
Check for each category (answer true/false for each):
- SSN (Social Security Number): Look for "SSN", "Social Security", or 9-digit number fields (XXX-XX-XXXX format)
- Driver's License Number: Look for "DL", "Driver's License", "License Number", state ID fields
- Financial Information: Look for bank account numbers, routing numbers, income, salary, tax info, credit card numbers
- Health/Medical Information: Look for medical history, diagnoses, medications, doctor information, insurance claims
- Criminal History: Look for questions about arrests, convictions, criminal background

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

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  /**
   * Download a PDF from URL and upload it to Gemini Files API
   */
  private async uploadPdfFromUrl(url: string): Promise<File> {
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
    const fileBlob = new Blob([pdfBuffer], { type: "application/pdf" });

    // Extract filename from URL for display
    const urlPath = new URL(url).pathname;
    const displayName = urlPath.split("/").pop() || "document.pdf";

    console.log(`  📤 Uploading to Gemini (${(pdfBuffer.byteLength / 1024).toFixed(1)} KB)`);

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

    return getFile;
  }

  /**
   * Analyze a single PDF
   */
  async analyzePdf(url: string): Promise<FormAnalysis> {
    const result: FormAnalysis = {
      url,
      isForm: "Error",
      formType: "N/A",
      sensitiveInfo: {
        ssn: false,
        driversLicense: false,
        financial: false,
        health: false,
        criminalHistory: false,
      },
      sensitiveInfoSummary: "",
      notes: "",
    };

    try {
      // Upload the PDF
      const file = await this.uploadPdfFromUrl(url);

      if (!file.uri || !file.mimeType) {
        throw new Error("File upload succeeded but missing URI or mimeType");
      }

      console.log(`  🤖 Analyzing with ${this.model}...`);

      // Create content with the file
      const filePart = createPartFromUri(file.uri, file.mimeType);

      const response = await this.ai.models.generateContent({
        model: this.model,
        contents: [{ parts: [filePart, { text: ANALYSIS_PROMPT }] }],
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
    if (normalized.includes("google")) return "Google form";
    if (normalized.includes("airtable")) return "Airtable form";
    if (normalized.includes("office") || normalized.includes("excel"))
      return "MS Office form";
    if (normalized.includes("word")) return "MS Word document";
    if (normalized.includes("phone")) return "Phone";
    if (normalized.includes("email")) return "Email";
    if (normalized.includes("digital") || normalized.includes("printable"))
      return "Digital form";
    if (normalized === "n/a" || normalized === "not a form") return "N/A";

    // If it's a PDF form but not fillable
    if (normalized.includes("pdf")) return "Digital form";

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
 * Write results to CSV (Excel-compatible)
 */
function writeResultsCsv(results: FormAnalysis[], outputPath: string): void {
  // Helper to escape a CSV field (quotes fields containing commas, quotes, or newlines)
  const escapeField = (value: string): string => {
    if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  };

  const headers = [
    "URL",
    "Is Form",
    "Form Type",
    "SSN",
    "DL#",
    "Financial",
    "Health",
    "Criminal History",
    "Sensitive Info Summary",
    "Notes",
    "Error",
  ];

  const rows = results.map((r) => [
    escapeField(r.url),
    r.isForm,
    r.formType,
    r.sensitiveInfo.ssn ? "Yes" : "No",
    r.sensitiveInfo.driversLicense ? "Yes" : "No",
    r.sensitiveInfo.financial ? "Yes" : "No",
    r.sensitiveInfo.health ? "Yes" : "No",
    r.sensitiveInfo.criminalHistory ? "Yes" : "No",
    escapeField(r.sensitiveInfoSummary),
    escapeField(r.notes || ""),
    escapeField(r.error || ""),
  ]);

  // Add UTF-8 BOM for Excel compatibility
  const BOM = "\ufeff";
  const csv = BOM + [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");

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

  const analyzer = new FormAnalyzer(apiKey);

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

  console.log(`🔍 Analyzing ${urls.length} PDF(s)...\n`);

  const results = await analyzer.analyzeAll(urls);

  // Generate output files
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outputDir = resolve(__dirname, "..");

  writeResultsCsv(results, resolve(outputDir, `results_${timestamp}.csv`));
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
}

main().catch(console.error);
