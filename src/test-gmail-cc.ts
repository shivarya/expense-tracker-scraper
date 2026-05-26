/**
 * Test script to check if we can find ICICI credit card statement emails
 */

import { getGmailClient } from './utils/gmail.js';

async function testGmailSearch() {
  console.log('🔍 Testing Gmail search for ICICI credit card statements...\n');

  try {
    const gmail = await getGmailClient();
    console.log('✓ Gmail client authenticated\n');

    // Test different search queries
    const queries = [
      // Old ICICI sender
      'from:credit_cards@icicibank.com subject:statement',
      'from:credit_cards@icicibank.com has:attachment filename:pdf',
      // New ICICI sender (user-reported updated domain)
      'from:credit_cards@icici.bank.in subject:statement',
      'from:credit_cards@icici.bank.in has:attachment',
      'from:icici.bank.in subject:statement has:attachment',
      // Subject-based fallback (catches both old and new)
      'subject:"ICICI Bank Credit Card Statement" has:attachment newer_than:6m',
      'subject:"ICICI Bank Credit Card Statement" newer_than:6m',
    ];

    for (const query of queries) {
      console.log(`📧 Query: "${query}"`);
      
      const response = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 5,
      });

      if (response.data.messages) {
        console.log(`   ✓ Found ${response.data.messages.length} message(s)\n`);
        
        // Get details of first message
        if (response.data.messages.length > 0) {
          const firstMsg = await gmail.users.messages.get({
            userId: 'me',
            id: response.data.messages[0].id!,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date'],
          });

          console.log('   First message details:');
          firstMsg.data.payload?.headers?.forEach(header => {
            if (['From', 'Subject', 'Date'].includes(header.name!)) {
              console.log(`   - ${header.name}: ${header.value}`);
            }
          });
          console.log('');
        }
      } else {
        console.log(`   ❌ No messages found\n`);
      }
    }

    // Also check recent emails from both ICICI domains
    console.log('\n📋 Recent emails from ICICI (both domains):');
    const recentICICI = await gmail.users.messages.list({
      userId: 'me',
      q: '{from:icicibank.com OR from:icici.bank.in} newer_than:6m',
      maxResults: 15,
    });

    if (recentICICI.data.messages) {
      console.log(`Found ${recentICICI.data.messages.length} recent ICICI emails:`);
      
      for (const msg of recentICICI.data.messages) {
        const details = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id!,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date'],
        });

        const subject = details.data.payload?.headers?.find(h => h.name === 'Subject')?.value || '(no subject)';
        const date = details.data.payload?.headers?.find(h => h.name === 'Date')?.value || '';
        console.log(`  - ${date.substring(0, 16)}: ${subject.substring(0, 80)}`);
      }
    }

  } catch (error: any) {
    console.error('❌ Error:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
  }
}

testGmailSearch()
  .then(() => console.log('\n✓ Test complete'))
  .catch(err => console.error('\n✗ Test failed:', err));
