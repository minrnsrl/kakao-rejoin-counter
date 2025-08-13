// Vercel Serverless Function: POST /api/event
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');

const SHEET_ID = process.env.SHEET_ID;
if (!SHEET_ID) {
  console.warn('SHEET_ID env is missing');
}

async function getSheetsClient() {
  // Vercel 대시보드 환경변수에 "GOOGLE_APPLICATION_CREDENTIALS_JSON" 전체 JSON을 그대로 붙여넣습니다.
  const credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];
  const jwt = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    scopes
  );
  await jwt.authorize();
  return google.sheets({ version: 'v4', auth: jwt });
}

async function getRows(sheets) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'log!A2:E'
  });
  return res.data.values || [];
}

async function findRowByNickname(sheets, nickname) {
  const rows = await getRows(sheets);
  for (let i = 0; i < rows.length; i++) {
    const [name] = rows[i];
    if ((name || '').trim() === nickname.trim()) {
      return { rowIndex: i + 2, row: rows[i] }; // header가 1행이므로 +2
    }
  }
  return null;
}

async function upsertOnEvent(sheets, nickname, type) {
  const now = new Date().toISOString();
  const found = await findRowByNickname(sheets, nickname);

  if (!found) {
    const enterCount = type === 'join' ? 1 : 0;
    const values = [[nickname, enterCount, type === 'join' ? now : '', type, uuidv4()]];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'log!A:E',
      valueInputOption: 'RAW',
      requestBody: { values }
    });
    return enterCount || 0;
  } else {
    const { rowIndex, row } = found;
    const prevCount = parseInt(row[1] || '0', 10) || 0;
    const nextCount = type === 'join' ? prevCount + 1 : prevCount;
    const values = [[
      nickname,
      nextCount,
      type === 'join' ? now : (row[2] || ''),
      type,
      row[4] || ''
    ]];
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `log!A${rowIndex}:E${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values }
    });
    return nextCount;
  }
}

function kakaoText(text) {
  return { version: '2.0', template: { outputs: [ { simpleText: { text } } ] } };
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      return res.status(200).json({ ok: true, ping: 'event' });
    }
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { nickname, type } = req.body || {};
    if (!nickname || !type) {
      return res.status(200).json(kakaoText('파라미터가 부족합니다. (nickname, type)'));
    }

    const sheets = await getSheetsClient();
    const count = await upsertOnEvent(sheets, nickname, type);

    if (type === 'join') {
      if (count === 1) return res.status(200).json(kakaoText(`환영합니다, ${nickname}님! (첫 입장)`));
      return res.status(200).json(kakaoText(`알림: "${nickname}" 닉네임은 이번이 ${count}번째 입장입니다.`));
    } else if (type === 'nick_change') {
      return res.status(200).json(kakaoText(`알림: ${nickname} 님이 닉네임을 변경했습니다.`));
    }
    return res.status(200).json(kakaoText('이벤트 처리 완료'));
  } catch (e) {
    console.error(e);
    return res.status(200).json(kakaoText('서버 오류가 발생했습니다.'));
  }
};
