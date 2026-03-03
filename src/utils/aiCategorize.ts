import "dotenv/config";
import OpenAI from "openai";

// ─── Canonical category data ────────────────────────────────────────────────

const CANONICAL_IDS = new Set([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,51,52,53,54]);

export const CANONICAL_NAMES: Record<number, string> = {
  1:  "Food & Dining",
  2:  "Transportation",
  3:  "Shopping",
  4:  "Entertainment",
  5:  "Bills & Utilities",
  6:  "Healthcare",
  7:  "Education",
  8:  "Travel",
  9:  "Groceries",
  10: "Insurance",
  11: "Rent/EMI",
  12: "Personal Care",
  13: "Investments",
  14: "Salary",
  15: "Refund",
  16: "Other Income",
  17: "Transfer",
  18: "Uncategorized",
  51: "Miscellaneous",
  52: "Household Help",
  53: "Kids Activities",
  54: "Software & Tools",
};

// ─── System prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a financial transaction categorizer for an Indian expense tracker.

Given a numbered list of credit card / bank transactions, return ONLY a JSON object:
{"results": [ { "index": <int>, "category_id": <int>, "merchant": "<string>", "description": "<string>" }, ... ]}

CANONICAL CATEGORY IDs — return ONLY these integers:
1  = Food & Dining       (restaurants, cafes, Swiggy, Zomato, food delivery, dining out)
2  = Transportation      (Ola, Uber, Rapido, metro, bus, petrol, diesel, cab rides)
3  = Shopping            (Amazon, Flipkart, Myntra, AJIO, retail, fashion, electronics, home goods)
4  = Entertainment       (Netflix, Hotstar, Disney+, Tata Play, Spotify, movies, gaming, concerts, OTT)
5  = Bills & Utilities   (electricity, water, internet, Airtel, Jio, ACT, mobile recharge, BBPS, telecom)
6  = Healthcare          (Apollo, Netmeds, 1mg, pharmacy, hospital, clinic, lab tests, diagnostics)
7  = Education           (school fees, college fees, courses, books, certifications, tuition)
8  = Travel              (flights, hotels, MakeMyTrip, Indigo, Goibibo, Cleartrip, IRCTC, outstation stays)
9  = Groceries           (BigBasket, Blinkit, Zepto, Swiggy Instamart, DMart, supermarket, kirana store)
10 = Insurance           (LIC, HDFC Ergo, Star Health, ICICI Prudential, policy premiums)
11 = Rent/EMI            (house rent, loan EMI, NACH debit, amortization, loan installment)
12 = Personal Care       (salon, haircut, spa, grooming, beauty products, wellness center)
13 = Investments         (SIP, mutual fund, Groww, Zerodha, stocks, NPS, PPF, FD opening, investment)
14 = Salary              (salary credit, payroll deposit from employer)
15 = Refund              (refund, reversal, cashback credited to account)
16 = Other Income        (FD/savings interest, dividends, any non-salary/non-refund credit)
17 = Transfer            (self transfer between own bank accounts)
18 = Uncategorized       (use only if absolutely unclassifiable after all other rules)
51 = Miscellaneous       (UPI to a personal contact, ATM withdrawal, bank charges, tax, fees)
52 = Household Help      (cook, maid, bai, driver, watchman, domestic worker salary/payment)
53 = Kids Activities     (karate, dance class, swimming, cricket academy, kids hobby/sports class)
54 = Software & Tools    (GitHub, AWS, GCP, Azure, Figma, Notion, Vercel, Netlify, domains, SaaS for dev/work)

CLASSIFICATION RULES (apply in order):
1. Credits first: salary (14) / refund (15) / other income (16) unless clearly investment (13) or transfer (17)
2. Interest credited → 16
3. Dev/work SaaS subscriptions (GitHub, AWS, Figma, Notion, Vercel) → 54, NOT 4 or 5
4. OTT / streaming / gaming subscriptions → 4 (Entertainment)
5. Domestic staff UPI payments (cook, maid, driver) → 52
6. Kids sports / hobby / activity class fees → 53
7. Insurance premiums → 10 (not 5)
8. Grocery delivery apps (Blinkit, Zepto, BigBasket, Instamart) → 9 (not 3)
9. Person-to-person UPI, ATM withdrawal → 51
10. Ambiguous debit → 51; ambiguous credit → 16

MERCHANT NAMING RULES:
- Use well-known brand names, max 3 words: "Swiggy" not "SWIGGY FOODS INDIA LTD"
- Strip: bank codes, UPI handles (@upi), trailing city/state/IN tokens, reference numbers
- For personal UPI recipients: use the person name e.g. "Rahul Sharma" not "rahulsh@okicici"
- Keep it human-readable and short

DESCRIPTION RULES:
- 5-10 words, specific and contextual
- Good: "Monthly food delivery via Swiggy", "Electricity bill paid via BESCOM", "GitHub Copilot SaaS subscription", "SIP investment in Axis Bluechip Fund", "UPI transfer to Rahul Sharma", "Kids karate class fee at Academy"
- Bad: "Bill payment", "Other Transaction", "UPI Payment", "Food Delivery at Swiggy"
- For income: "Salary credit for March 2026", "Interest credited by HDFC Bank"
- For refunds: "Refund from Amazon for returned item"

Return ONLY valid JSON, no markdown, no extra text.`;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TxInput {
  index: number;
  raw: string;
  amount: number;
  type: "debit" | "credit";
}

export interface AiCategoryResult {
  index: number;
  category_id: number;
  category: string;
  merchant: string;
  description: string;
}

// ─── Client factory ──────────────────────────────────────────────────────────

function buildClient(): { client: OpenAI; model: string } {
  const isAzure = !!process.env.AZURE_OPENAI_ENDPOINT;

  if (isAzure) {
    const base = process.env.AZURE_OPENAI_ENDPOINT!.replace(/\/?$/, "/");
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT!;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? "2024-02-15-preview";
    return {
      client: new OpenAI({
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        baseURL: base + "openai/deployments/" + deployment,
        defaultQuery: { "api-version": apiVersion },
        defaultHeaders: { "api-key": process.env.AZURE_OPENAI_API_KEY! },
      }),
      model: deployment,
    };
  }

  return {
    client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
    model: process.env.OPENAI_MODEL ?? "gpt-4-turbo",
  };
}

// ─── Fallback (no AI) ────────────────────────────────────────────────────────

function makeFallback(t: TxInput): AiCategoryResult {
  const catId = t.type === "credit" ? 16 : 51;
  const rawWords = t.raw
    .replace(/[^a-zA-Z ]/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(" ");
  return {
    index: t.index,
    category_id: catId,
    category: CANONICAL_NAMES[catId],
    merchant: rawWords || "Unknown",
    description: t.type === "credit" ? "Unclassified credit transaction" : "Unclassified debit transaction",
  };
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Categorize a flat array of transactions using AI.
 * Processes in batches; returns results in the same order as input (matched by .index).
 */
export async function aiCategorizeTransactions(
  transactions: TxInput[],
  batchSize = 25,
): Promise<AiCategoryResult[]> {
  if (transactions.length === 0) return [];

  const { client, model } = buildClient();
  const results: AiCategoryResult[] = [];

  const batches: TxInput[][] = [];
  for (let i = 0; i < transactions.length; i += batchSize) {
    batches.push(transactions.slice(i, i + batchSize));
  }

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    if (batches.length > 1) {
      process.stdout.write(
        `  [AI] batch ${b + 1}/${batches.length} (${batch.length} txns)...\n`,
      );
    }

    const userContent =
      "Categorize these transactions:\n" +
      batch.map(t => `${t.index}. [${t.type.toUpperCase()}] Rs.${t.amount} — ${t.raw}`).join("\n") +
      '\n\nReturn JSON: {"results": [...]}';

    let batchOk = false;
    try {
      const resp = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user",   content: userContent },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

      const content = resp.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(content) as {
        results: Array<{ index: number; category_id: number; merchant: string; description: string }>;
      };
      const aiRows = parsed.results ?? [];

      for (let i = 0; i < batch.length; i++) {
        const t = batch[i];
        const ai = aiRows.find(r => r.index === t.index) ?? aiRows[i];
        if (!ai) { results.push(makeFallback(t)); continue; }

        const catId = CANONICAL_IDS.has(ai.category_id)
          ? ai.category_id
          : (t.type === "credit" ? 16 : 51);

        results.push({
          index: t.index,
          category_id: catId,
          category: CANONICAL_NAMES[catId] ?? "Miscellaneous",
          merchant: (ai.merchant ?? "").trim() || "Unknown",
          description: (ai.description ?? "").trim() || "Transaction",
        });
      }
      batchOk = true;
    } catch (err: any) {
      console.warn(`[aiCategorize] batch ${b + 1} failed: ${err.message}`);
    }

    if (!batchOk) {
      batches[b].forEach(t => results.push(makeFallback(t)));
    }

    // Brief delay between batches to stay under rate limits
    if (b < batches.length - 1) {
      await new Promise(r => setTimeout(r, 600));
    }
  }

  return results;
}
