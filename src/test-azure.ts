import 'dotenv/config';
import OpenAI from 'openai';

async function testAzureOpenAI() {
  console.log('🔍 Testing Azure OpenAI Configuration...\n');

  // Check environment variables
  const isAzure = !!process.env.AZURE_OPENAI_ENDPOINT;
  
  if (isAzure) {
    console.log('✓ Azure OpenAI mode detected');
    console.log(`  Endpoint: ${process.env.AZURE_OPENAI_ENDPOINT}`);
    console.log(`  Deployment: ${process.env.AZURE_OPENAI_DEPLOYMENT}`);
    console.log(`  API Version: ${process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview'}`);
    console.log(`  API Key: ${process.env.AZURE_OPENAI_API_KEY?.substring(0, 10)}...`);
  } else {
    console.log('✓ Standard OpenAI mode detected');
    console.log(`  Model: ${process.env.OPENAI_MODEL || 'gpt-4-turbo'}`);
    console.log(`  API Key: ${process.env.OPENAI_API_KEY?.substring(0, 10)}...`);
  }

  console.log('\n📡 Making test API call...\n');

  try {
    // Initialize client
    const openai = new OpenAI(
      isAzure
        ? {
            apiKey: process.env.AZURE_OPENAI_API_KEY,
            baseURL: process.env.AZURE_OPENAI_ENDPOINT,
          }
        : {
            apiKey: process.env.OPENAI_API_KEY
          }
    );

    const model = isAzure 
      ? process.env.AZURE_OPENAI_DEPLOYMENT! 
      : (process.env.OPENAI_MODEL || 'gpt-4-turbo');

    // Simple test prompt
    const response = await openai.chat.completions.create({
      model: model,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Reply with just the word "working" if you can read this.' }
      ],
      temperature: 0,
    });

    const reply = response.choices[0].message.content;

    console.log('✅ SUCCESS! Azure OpenAI is working correctly.\n');
    console.log(`Response: "${reply}"`);
    console.log(`\nModel: ${response.model}`);
    console.log(`Tokens used: ${response.usage?.total_tokens || 'N/A'}`);
    console.log(`\n🎉 Your configuration is valid and ready to use!`);

  } catch (error: any) {
    console.error('❌ FAILED! Error connecting to Azure OpenAI:\n');
    
    if (error.status) {
      console.error(`HTTP ${error.status}: ${error.message}`);
    } else {
      console.error(error.message);
    }

    console.error('\n🔧 Troubleshooting tips:');
    console.error('  1. Verify your Azure OpenAI endpoint URL');
    console.error('  2. Check that your API key is correct');
    console.error('  3. Ensure the deployment name matches your Azure resource');
    console.error('  4. Verify the API version is supported (try 2024-02-15-preview)');
    console.error('  5. Check if your Azure resource has the deployment deployed');
    
    process.exit(1);
  }
}

testAzureOpenAI();
