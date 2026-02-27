import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const INPUT_FILE = path.join(process.cwd(), 'data', 'enriched-mfcentral.json');

async function syncMfcentral() {
  console.log('🚀 Syncing MF Central mutual funds\n');
  console.log('━'.repeat(60));

  const apiUrl = process.env.API_URL;
  const apiToken = process.env.API_TOKEN;

  if (!apiUrl || !apiToken) {
    throw new Error('Missing API_URL or API_TOKEN in .env');
  }

  const raw = await fs.readFile(INPUT_FILE, 'utf-8');
  const data = JSON.parse(raw);
  const funds = data.funds || [];

  if (!Array.isArray(funds) || funds.length === 0) {
    throw new Error('No funds found in enriched-mfcentral.json. Run mfc:enrich first.');
  }

  console.log(`📦 Funds to sync: ${funds.length}`);

  // Show preview
  for (const f of funds.slice(0, 5)) {
    console.log(`   ${f.folio_number} | ${f.fund_name.substring(0, 50)} | ₹${f.current_value.toLocaleString('en-IN')}`);
  }
  if (funds.length > 5) {
    console.log(`   ... and ${funds.length - 5} more`);
  }

  const response = await axios.post(
    `${apiUrl}/sync/mutual-funds`,
    { funds },
    {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  console.log('\n✅ Sync complete');
  console.log(`   Created: ${response.data?.data?.created || 0}`);
  console.log(`   Updated: ${response.data?.data?.updated || 0}`);
  console.log(`   Failed:  ${response.data?.data?.failed || 0}`);

  if (response.data?.data?.errors?.length > 0) {
    console.log('\n⚠️  Errors:');
    for (const err of response.data.data.errors) {
      console.log(`   ${err}`);
    }
  }
}

const isDirectRun = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  syncMfcentral().catch((error: any) => {
    console.error('\n❌ Error:', error.response?.data || error.message || error);
    process.exit(1);
  });
}
