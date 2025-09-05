import { google } from 'googleapis';

let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const authClient = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  return sheetsClient;
}

// Append one row in fixed header order
export async function appendToSheet({
  orderId,
  buyerName,
  buyerEmail,
  buyerPhone,
  tier,
  seats,
  amount,
  coveredFees,
  donation,
  company,
  recognition
}) {
  const sheets = await getSheetsClient();
  const timestamp = new Date().toISOString();

  const row = [
    timestamp,
    orderId,
    buyerName || '',
    buyerEmail || '',
    buyerPhone || '',
    tier,
    String(seats),
    String(amount),
    coveredFees ? 'Y' : 'N',
    donation,
    company || '',
    recognition || ''
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID,
    range: `${process.env.SHEETS_TAB || 'Orders'}!A:M`, // 13 columns
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] }
  });
}
