// sheets.js
import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

function getAuth() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('Google service account env vars missing.');
  return new google.auth.JWT(email, null, key, SCOPES);
}

function getClient() {
  const auth = getAuth();
  return google.sheets({ version: 'v4', auth });
}

export async function appendToSheet(row) {
  const spreadsheetId = process.env.GOOGLE_SHEETS_ID;
  const tabName = process.env.GOOGLE_SHEETS_TAB_NAME || 'Orders';
  if (!spreadsheetId) throw new Error('GOOGLE_SHEETS_ID not set');

  const sheets = getClient();

  // Map your row object to columns (adjust headers/order as you like)
  const values = [[
    row.orderId,
    row.buyerName,
    row.buyerEmail,
    row.buyerPhone,
    row.tier,
    row.seats,
    row.amount,         // string like "200.00"
    row.coveredFees ? 'TRUE' : 'FALSE',
    row.donation,       // donation amount string or "0"
    row.company,
    row.recognition,
    new Date().toISOString(),
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tabName}!A:Z`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });
}
