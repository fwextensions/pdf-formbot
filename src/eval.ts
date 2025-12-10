/**
 * Evaluation Script - Compare LLM analysis vs Human reviewers
 *
 * Takes a spreadsheet with human reviewer data, runs LLM analysis on the PDFs,
 * and highlights differences between human and LLM assessments.
 *
 * Usage:
 *   npm run eval -- eval.csv
 */

import { createPartFromUri, GoogleGenAI, type File } from "@google/genai";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parse } from "csv-parse/sync";

// Types
interface HumanReview {
  url: string;
  isForm: string;
  formType: string;
  sensitiveInfo: string;
  reviewer: string;
  notes: string;
}

interface LLMAnalysis {
  url: string;
  isForm: "Yes" | "No" | "Error";
  formType: string;
  sensitiveInfo: {
    ssn: boolean;
    driversLicense: boolean;
    financial: boolean;
    health: boolean;
    criminalHistory: boolean;
  };
  notes: string;
  error?: string;
}

interface ComparisonResult {
  url: string;
  humanIsForm: string;
  llmIsForm: string;
  isFormMatch: boolean;
  humanFormType: string;
  llmFormType: string;
  formTypeMatch: boolean;
  humanSensitive: string;
  llmSensitive: string;
  sensitiveMatch: boolean;
  allMatch: boolean;
  humanReviewer: string;
  humanNotes: string;
  llmNotes: string;
}

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
- "Fillable PDF" - A PDF with interactive form fields that can be typed into directly in a PDF reader (look for blue-highlighted fields, text input boxes, or AcroForm elements)
- "Non-Fillable PDF" - A printable PDF form designed to be filled by hand or printed (has blank lines/boxes but no interactive digital fields)
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
  "notes": "<brief description of what the document is and any relevant observations>"
}
\`\`\``;

class FormAnalyzer {
  private ai: GoogleGenAI;
  private model = "gemini-2.5-flash";

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  private async uploadPdfFromUrl(url: string): Promise<File> {
    console.log(`  📥 Downloading PDF...`);

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
    }

    const pdfBuffer = await response.arrayBuffer();
    const fileBlob = new Blob([pdfBuffer], { type: "application/pdf" });

    const urlPath = new URL(url).pathname;
    const displayName = urlPath.split("/").pop() || "document.pdf";

    console.log(`  📤 Uploading to Gemini (${(pdfBuffer.byteLength / 1024).toFixed(1)} KB)`);

    const file = await this.ai.files.upload({
      file: fileBlob,
      config: { displayName },
    });

    let getFile = await this.ai.files.get({ name: file.name! });
    let attempts = 0;
    while (getFile.state === "PROCESSING" && attempts < 30) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      getFile = await this.ai.files.get({ name: file.name! });
      attempts++;
    }

    if (getFile.state === "FAILED") {
      throw new Error("Gemini file processing failed");
    }

    return getFile;
  }

  async analyzePdf(url: string): Promise<LLMAnalysis> {
    const result: LLMAnalysis = {
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
      notes: "",
    };

    try {
      const file = await this.uploadPdfFromUrl(url);

      if (!file.uri || !file.mimeType) {
        throw new Error("File upload succeeded but missing URI or mimeType");
      }

      console.log(`  🤖 Analyzing with ${this.model}...`);

      const filePart = createPartFromUri(file.uri, file.mimeType);

      const response = await this.ai.models.generateContent({
        model: this.model,
        contents: [{ parts: [filePart, { text: ANALYSIS_PROMPT }] }],
      });

      const text = response.text || "";

      const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
      if (!jsonMatch) {
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

  private normalizeResponse(parsed: any): Partial<LLMAnalysis> {
    return {
      isForm: parsed.isForm === "Yes" ? "Yes" : "No",
      formType: parsed.formType || "N/A",
      sensitiveInfo: {
        ssn: Boolean(parsed.sensitiveInfo?.ssn),
        driversLicense: Boolean(parsed.sensitiveInfo?.driversLicense),
        financial: Boolean(parsed.sensitiveInfo?.financial),
        health: Boolean(parsed.sensitiveInfo?.health),
        criminalHistory: Boolean(parsed.sensitiveInfo?.criminalHistory),
      },
      notes: parsed.notes || "",
    };
  }
}

/**
 * Parse the input CSV and extract human review data
 */
function parseHumanReviews(filePath: string): HumanReview[] {
  let content = readFileSync(filePath, "utf-8");

  // Strip BOM if present (Excel exports UTF-8 with BOM)
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }

  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  });

  const reviews: HumanReview[] = [];

  for (const record of records) {
    const url = record["url"]?.trim();
    if (!url || !url.endsWith(".pdf")) continue;

    reviews.push({
      url,
      isForm: record["Review: Is this a form"]?.trim() || "",
      formType: record["Reviewer: Form Type"]?.trim() || "",
      sensitiveInfo: record["Reviewer: Does this form ask for SSN, DL#, financial, health info or criminal history?"]?.trim() || "",
      reviewer: record["Review: Reviewed by"]?.trim() || "",
      notes: record["Reviewer: Notes (optional)"]?.trim() || "",
    });
  }

  return reviews;
}

/**
 * Normalize form type for comparison
 */
function normalizeFormType(type: string): string {
  if (!type) return "";
  const t = type.toLowerCase().trim();
  if (t.includes("fillable")) return "Fillable PDF";
  if (t.includes("non-fillable") || t.includes("nonfillable")) return "Non-Fillable PDF";
  if (t === "n/a" || t === "na") return "N/A";
  return type;
}

/**
 * Format LLM sensitive info for comparison
 */
function formatSensitiveInfo(info: LLMAnalysis["sensitiveInfo"]): string {
  const items = [];
  if (info.ssn) items.push("SSN");
  if (info.driversLicense) items.push("DL#");
  if (info.financial) items.push("Financial");
  if (info.health) items.push("Health");
  if (info.criminalHistory) items.push("Criminal");
  return items.length > 0 ? items.join(", ") : "No";
}

/**
 * Normalize sensitive info for comparison (human uses Yes/No, LLM uses specific fields)
 */
function normalizeSensitiveForComparison(human: string, llm: string): boolean {
  const humanLower = human.toLowerCase().trim();
  const llmLower = llm.toLowerCase().trim();

  // If human said "No", LLM should also say "No"
  if (humanLower === "no" || humanLower === "") {
    return llmLower === "no" || llmLower === "";
  }

  // If human said "Yes" or listed specifics, LLM should have some sensitive info
  if (humanLower === "yes" || humanLower.includes("ssn") || humanLower.includes("dl")) {
    return llmLower !== "no" && llmLower !== "";
  }

  return humanLower === llmLower;
}

/**
 * Compare human review with LLM analysis
 */
function compare(human: HumanReview, llm: LLMAnalysis): ComparisonResult {
  const humanFormType = normalizeFormType(human.formType);
  const llmFormType = normalizeFormType(llm.formType);
  const llmSensitive = formatSensitiveInfo(llm.sensitiveInfo);

  const isFormMatch = human.isForm.toLowerCase() === llm.isForm.toLowerCase();
  const formTypeMatch = humanFormType.toLowerCase() === llmFormType.toLowerCase() ||
    (human.isForm.toLowerCase() === "no" && llm.isForm === "No"); // Both say not a form
  const sensitiveMatch = normalizeSensitiveForComparison(human.sensitiveInfo, llmSensitive);

  return {
    url: human.url,
    humanIsForm: human.isForm,
    llmIsForm: llm.isForm,
    isFormMatch,
    humanFormType: human.formType,
    llmFormType: llm.formType,
    formTypeMatch,
    humanSensitive: human.sensitiveInfo,
    llmSensitive,
    sensitiveMatch,
    allMatch: isFormMatch && formTypeMatch && sensitiveMatch,
    humanReviewer: human.reviewer,
    humanNotes: human.notes,
    llmNotes: llm.notes,
  };
}

/**
 * Write comparison results to CSV
 */
function writeComparisonCsv(results: ComparisonResult[], outputPath: string): void {
  const escapeField = (value: string): string => {
    if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  };

  const headers = [
    "URL",
    "All Match",
    "Human: Is Form",
    "LLM: Is Form",
    "Is Form Match",
    "Human: Form Type",
    "LLM: Form Type",
    "Form Type Match",
    "Human: Sensitive",
    "LLM: Sensitive",
    "Sensitive Match",
    "Human Reviewer",
    "Human Notes",
    "LLM Notes",
  ];

  const rows = results.map((r) => [
    escapeField(r.url),
    r.allMatch ? "✓" : "✗",
    r.humanIsForm,
    r.llmIsForm,
    r.isFormMatch ? "✓" : "✗",
    escapeField(r.humanFormType),
    escapeField(r.llmFormType),
    r.formTypeMatch ? "✓" : "✗",
    escapeField(r.humanSensitive),
    escapeField(r.llmSensitive),
    r.sensitiveMatch ? "✓" : "✗",
    escapeField(r.humanReviewer),
    escapeField(r.humanNotes),
    escapeField(r.llmNotes),
  ]);

  const BOM = "\ufeff";
  const csv = BOM + [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");

  writeFileSync(outputPath, csv, "utf-8");
  console.log(`\n📄 Comparison results written to: ${outputPath}`);
}

// Main
async function main() {
  const args = process.argv.slice(2);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("❌ Error: GEMINI_API_KEY environment variable is required");
    process.exit(1);
  }

  if (args.length === 0 || !existsSync(args[0])) {
    console.log("Usage: npm run eval -- input.csv");
    console.log("\nThe input CSV should have columns:");
    console.log("  - url: PDF URL");
    console.log("  - Review: Is this a form");
    console.log("  - Reviewer: Form Type");
    console.log("  - Reviewer: Does this form ask for SSN, DL#...");
    process.exit(0);
  }

  const inputPath = resolve(args[0]);
  console.log(`📖 Reading human reviews from: ${inputPath}\n`);

  const humanReviews = parseHumanReviews(inputPath);
  console.log(`   Found ${humanReviews.length} PDF reviews\n`);

  if (humanReviews.length === 0) {
    console.error("❌ No PDF URLs found in input file");
    process.exit(1);
  }

  const analyzer = new FormAnalyzer(apiKey);
  const comparisons: ComparisonResult[] = [];

  for (let i = 0; i < humanReviews.length; i++) {
    const human = humanReviews[i];
    console.log(`\n[${i + 1}/${humanReviews.length}] ${human.url.split("/").pop()}`);
    console.log(`   Human: ${human.isForm} | ${human.formType} | Sensitive: ${human.sensitiveInfo || "?"}`);

    const llm = await analyzer.analyzePdf(human.url);
    const llmSensitive = formatSensitiveInfo(llm.sensitiveInfo);
    console.log(`   LLM:   ${llm.isForm} | ${llm.formType} | Sensitive: ${llmSensitive}`);

    const comparison = compare(human, llm);
    comparisons.push(comparison);

    if (comparison.allMatch) {
      console.log(`   ✅ All match!`);
    } else {
      if (!comparison.isFormMatch) console.log(`   ❌ Is Form mismatch`);
      if (!comparison.formTypeMatch) console.log(`   ❌ Form Type mismatch`);
      if (!comparison.sensitiveMatch) console.log(`   ❌ Sensitive Info mismatch`);
    }

    // Small delay between requests
    if (i < humanReviews.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  // Generate output
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outputDir = resolve(__dirname, "..");

  writeComparisonCsv(comparisons, resolve(outputDir, `eval_results_${timestamp}.csv`));

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("📊 EVALUATION SUMMARY");
  console.log("=".repeat(60));
  console.log(`Total evaluated: ${comparisons.length}`);
  console.log(`Full matches:    ${comparisons.filter((c) => c.allMatch).length} (${((comparisons.filter((c) => c.allMatch).length / comparisons.length) * 100).toFixed(1)}%)`);
  console.log(`Is Form match:   ${comparisons.filter((c) => c.isFormMatch).length} (${((comparisons.filter((c) => c.isFormMatch).length / comparisons.length) * 100).toFixed(1)}%)`);
  console.log(`Form Type match: ${comparisons.filter((c) => c.formTypeMatch).length} (${((comparisons.filter((c) => c.formTypeMatch).length / comparisons.length) * 100).toFixed(1)}%)`);
  console.log(`Sensitive match: ${comparisons.filter((c) => c.sensitiveMatch).length} (${((comparisons.filter((c) => c.sensitiveMatch).length / comparisons.length) * 100).toFixed(1)}%)`);

  // Show mismatches
  const mismatches = comparisons.filter((c) => !c.allMatch);
  if (mismatches.length > 0) {
    console.log("\n📋 MISMATCHES:");
    for (const m of mismatches) {
      console.log(`\n  ${m.url.split("/").pop()}`);
      if (!m.isFormMatch) console.log(`    Is Form: Human="${m.humanIsForm}" vs LLM="${m.llmIsForm}"`);
      if (!m.formTypeMatch) console.log(`    Type: Human="${m.humanFormType}" vs LLM="${m.llmFormType}"`);
      if (!m.sensitiveMatch) console.log(`    Sensitive: Human="${m.humanSensitive}" vs LLM="${m.llmSensitive}"`);
    }
  }
}

main().catch(console.error);
