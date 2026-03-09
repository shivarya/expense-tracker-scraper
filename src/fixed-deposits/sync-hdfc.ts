import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const INPUT_FILE = path.join(process.cwd(), 'data', 'enriched-hdfc-fd.json');

async function syncHdfcFixedDeposits() {
  console.log('Syncing HDFC fixed deposits');

  const apiUrl = process.env.API_URL;
  const apiToken = process.env.API_TOKEN;

  if (!apiUrl || !apiToken) {
    throw new Error('Missing API_URL or API_TOKEN in .env');
  }

  const raw = await fs.readFile(INPUT_FILE, 'utf-8').catch(() => '');
  if (!raw) {
    throw new Error('Missing enriched-hdfc-fd.json. Run npm run fd:enrich first.');
  }

  const parsed = JSON.parse(raw) as {
    fixed_deposits?: Array<{
      fd_number: string;
      principal_amount: number;
      maturity_date: string;
      maturity_value: number;
      status: string;
    }>;
  };

  const fixedDeposits = Array.isArray(parsed.fixed_deposits) ? parsed.fixed_deposits : [];
  if (fixedDeposits.length === 0) {
    throw new Error('No fixed_deposits found in enriched-hdfc-fd.json');
  }

  console.log(`FD records to sync: ${fixedDeposits.length}`);
  for (const fd of fixedDeposits.slice(0, 5)) {
    console.log(`  ${fd.fd_number} | ${fd.maturity_date} | ${fd.principal_amount.toLocaleString('en-IN')}`);
  }
  if (fixedDeposits.length > 5) {
    console.log(`  ... and ${fixedDeposits.length - 5} more`);
  }

  const response = await axios.post(
    `${apiUrl}/sync/fixed-deposits`,
    {
      source: 'hdfc_deposits_portal',
      fixed_deposits: fixedDeposits,
    },
    {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  console.log('Sync complete');
  console.log(`Created: ${response.data?.data?.created || 0}`);
  console.log(`Updated: ${response.data?.data?.updated || 0}`);
  console.log(`Failed: ${response.data?.data?.failed || 0}`);
}

const isDirectRun = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  syncHdfcFixedDeposits().catch((error: any) => {
    console.error('Error:', error.response?.data || error.message || error);
    process.exit(1);
  });
}
