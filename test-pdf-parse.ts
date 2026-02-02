import { createRequire } from 'module';
import fs from 'fs';

const require = createRequire(import.meta.url);
const { PDFParse } = require('pdf-parse');

async function test() {
  const buffer = fs.readFileSync('data/transactions/pdfs/6529XXXXXXXX7003_262429_Retail_Rubyx_NORM_decrypted.pdf');
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  
  console.log('Type:', typeof result);
  console.log('Keys:', Object.keys(result));
  console.log('Has text property:', 'text' in result);
  console.log('Text type:', typeof result.text);
  console.log('Text length:', result.text?.length);
  console.log('First 200 chars:', result.text?.substring(0, 200));
}

test().catch(console.error);
