# Formbot - PDF Form Analyzer

A simple TypeScript tool that uses **Gemini 2.5 Flash** to analyze PDF documents and determine:

1. **Is this a form?** (Yes/No)
2. **Form Type:**
   - Fillable PDF (interactive form fields)
   - Digital form (printable, fill by hand)
   - Google form
   - MS Office form
   - MS Word document
   - Airtable form
   - Phone (call-in form)
   - Email (email submission)
3. **Sensitive Information:**
   - SSN (Social Security Number)
   - Driver's License Number
   - Financial info
   - Health/Medical info
   - Criminal history

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)

## Usage

Create a `.env` file with your API key:
```
GEMINI_API_KEY=your_api_key_here
```

### Analyze a single PDF URL:
```bash
npm run analyze -- "https://example.com/form.pdf"
```

### Analyze PDFs from a file:
```bash
npm run analyze -- input.txt   # One URL per line
npm run analyze -- input.csv   # Extracts PDF URLs from CSV
```

### Test with sample PDFs:
```bash
npm run test
```

> **Note:** Uses Node's native TypeScript support (`--experimental-strip-types`). Requires Node.js 22.6+.

## Evaluation Mode

Compare LLM analysis against human reviewer data:

```bash
npm run eval -- eval.csv
```

The input CSV should have columns:
- `url` - PDF URL
- `Review: Is this a form` - Yes/No
- `Reviewer: Form Type` - Fillable PDF, Non-Fillable PDF, etc.
- `Reviewer: Does this form ask for SSN, DL#...` - sensitive info

**Output:** `eval_results_<timestamp>.csv` with side-by-side comparison showing:
- ✓/✗ indicators for each field match
- Human vs LLM values for Is Form, Form Type, Sensitive Info
- Summary statistics with match percentages

## Output

Results are saved to both CSV and JSON files with timestamps:
- `results_YYYY-MM-DDTHH-MM-SS.csv`
- `results_YYYY-MM-DDTHH-MM-SS.json`

### CSV Columns:
- URL
- Is Form (Yes/No)
- Form Type
- SSN (Yes/No)
- DL# (Yes/No)
- Financial (Yes/No)
- Health (Yes/No)
- Criminal History (Yes/No)
- Sensitive Info Summary
- Notes
- Error

## How It Works

1. Downloads each PDF from the provided URL
2. Uploads the PDF to Gemini's Files API (supports files up to 2GB)
3. Sends the PDF to Gemini 2.5 Flash with a structured analysis prompt
4. Parses the JSON response
5. Outputs results to CSV and JSON

The full PDF is sent to Gemini (not just extracted text), which allows it to:
- Detect interactive fillable form fields
- Understand visual form layouts
- Identify checkboxes, signature lines, and input fields
