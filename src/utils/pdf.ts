/**
 * PDF Parsing Utility
 * 
 * Handles PDF decryption and text extraction.
 * Supports password-protected PDFs (common for bank/MF statements).
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

/**
 * Parse PDF to text
 * NOTE: Actual AI-powered parsing happens in the Copilot agent
 * This just extracts raw text from PDF
 */
export async function parsePDFToText(buffer: Buffer): Promise<string> {
  try {
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    return result.text;
  } catch (error: any) {
    throw new Error(`PDF parsing failed: ${error.message}`);
  }
}

/**
 * Decrypt password-protected PDF
 */
export async function decryptPDF(
  buffer: Buffer,
  passwords: string[]
): Promise<Buffer> {
  // TODO: Implement using node-qpdf2 or similar
  // For now, return original buffer
  console.log('  ⚠️  PDF decryption not implemented yet');
  return buffer;
}

/**
 * Download and parse PDF from Gmail attachment
 */
export async function downloadAndParsePDF(
  attachment: any,
  passwords: string[] = []
): Promise<string> {
  if (!attachment.data) {
    throw new Error('No attachment data');
  }
  
  const buffer = Buffer.from(attachment.data, 'base64');
  
  // Try to decrypt if needed
  let decryptedBuffer = buffer;
  if (passwords.length > 0) {
    try {
      decryptedBuffer = await decryptPDF(buffer, passwords);
    } catch (err: any) {
      console.log(`    ⚠️  Decryption failed: ${err.message}`);
    }
  }
  
  // Parse to text
  return await parsePDFToText(decryptedBuffer);
}

/**
 * Extract text from PDF file on disk
 */
export async function extractTextFromPDF(pdfPath: string): Promise<string> {
  try {
    const fs = await import('fs/promises');
    const buffer = await fs.readFile(pdfPath);
    return await parsePDFToText(buffer);
  } catch (error: any) {
    throw new Error(`Failed to extract text from ${pdfPath}: ${error.message}`);
  }
}
