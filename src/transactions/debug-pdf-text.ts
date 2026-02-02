/**
 * Debug script to see actual PDF text structure
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { extractTextFromPDF } from '../utils/pdf.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

(async () => {
  const manifestPath = path.join(__dirname, '../../data/raw-extracts/pdf-manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
  
  // Take first PDF from each bank
  const iciciPDF = manifest.pdfs.find((p: any) => p.filename.includes('4315'));
  const rubyxPDF = manifest.pdfs.find((p: any) => p.filename.includes('6529'));
  const rblPDF = manifest.pdfs.find((p: any) => p.filename.includes('xxxx'));
  
  for (const pdf of [iciciPDF, rubyxPDF, rblPDF]) {
    if (!pdf) continue;
    
    const pdfPath = pdf.decryptedPath;
    console.log(`\n${'='.repeat(80)}`);
    console.log(`PDF: ${pdf.filename}`);
    console.log('='.repeat(80));
    
    try {
      const text = await extractTextFromPDF(pdfPath);
      
      // Show first 3000 characters
      console.log(text.substring(0, 3000));
      
      // Save full text to file for analysis
      const outputPath = path.join(__dirname, `../../data/raw-extracts/debug-${pdf.filename}.txt`);
      await fs.writeFile(outputPath, text);
      console.log(`\n📄 Full text saved to: ${outputPath}`);
      
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
    }
  }
})();
