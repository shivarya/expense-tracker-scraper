import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const INPUT_FILE = path.join(process.cwd(), 'data', 'enriched-nps.json');

async function syncNps() {
  console.log('🚀 Syncing NPS long-term data\n');
  console.log('━'.repeat(60));

  const apiUrl = process.env.API_URL;
  const apiToken = process.env.API_TOKEN;

  if (!apiUrl || !apiToken) {
    throw new Error('Missing API_URL or API_TOKEN in .env');
  }

  const raw = await fs.readFile(INPUT_FILE, 'utf-8');
  const data = JSON.parse(raw);
  const funds = data.longTermFunds || [];

  if (!Array.isArray(funds) || funds.length === 0) {
    throw new Error('No longTermFunds found in enriched-nps.json');
  }

  console.log(`📦 Funds to sync: ${funds.length}`);

  const response = await axios.post(
    `${apiUrl}/sync/long-term`,
    {
      source: 'nps_email',
      long_term_funds: funds
    },
    {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );

  console.log('\n✅ Sync complete');
  console.log(`Created: ${response.data?.data?.created || 0}`);
  console.log(`Updated: ${response.data?.data?.updated || 0}`);
  console.log(`Failed: ${response.data?.data?.failed || 0}`);
}

const isDirectRun = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  syncNps().catch((error: any) => {
    console.error('\n❌ Error:', error.response?.data || error.message || error);
    process.exit(1);
  });
}
