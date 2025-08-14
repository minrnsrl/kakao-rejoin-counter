// api/event.js (고정)
const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');

const SHEET_ID = process.env.SHEET_ID;
const CREDENTIALS_JSON = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;

const SHEET_TAB = 'log';
const SHEET_RANGE_ALL = `${SHEET_TAB}!A:E`;
const SHEET_RANGE_ROWS = `${SHEET_TAB}!A2:E`;

function kakaoText(text) {
  return {
    version: '2.0',
    template: { outputs: [{ simpleText: { text } }] }
  };
}

function parseParams(body = {}) {
  const a = body.action?.params || {};
  const d = body.action?.detailParams || {};
  const nickname = body.nickname ?? a.nickname ?? d.nickname?.value;
  const type = body.type ?? a.type ?? d.type?.value;
  return { nickname, type };
}

async function getSheetsClient() {
  if (!CREDENTIALS_JSON) throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS_JSON');
  const credentials = JSON.parse(CREDENTIALS_JSON);
  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];
  const jwt = new google.auth.JWT(credentials.client_email, null, credentials.private_key, scopes);
  await jwt.authorize();
  return google.sheets({ version: 'v4', auth: jwt });
}

async function findRowByNickname(sheets, spreadsheetId, nickname) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: SHEET_RANGE_ROWS
  });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const [name] = rows[i];
    if ((name || '').trim() === String(nickname).trim()) {
      return { rowIndex: i + 2, row: rows[i] };
    }
  }
  return null;
}

async function upsertJoinEvent(sheets, spreadsheetId, nickname) {
  const now = new Date().toISOString();
  const found = await findRowByNickname(sheets, spreadsheetId, nickname);

  if (!found) {
    const values = [[nickname, 1, now, 'join', uuidv4()]];
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: SHEET_RANGE_ALL,
      valueInputOption: 'RAW',
      requestBody: { values }
    });
    return 1;
  } else {
    const { rowIndex, row } = found;
    const prev = parseInt(row[1] || '0', 10) || 0;
    const next = prev + 1;
    const values = [[nickname, next, now, 'join', row[4] || '']];
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_TAB}!A${rowIndex}:E${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values }
    });
    return next;
  }
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      return res.status(200).json({
        ok: true,
        ping: 'event',
        env: {
          SHEET_ID: SHEET_ID ? 'OK' : 'MISSING',
          GOOGLE_APPLICATION_CREDENTIALS_JSON: CREDENTIALS_JSON ? 'OK' : 'MISSING'
        }
      });
    }
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // 1) 파라미터 파싱 + 로깅
    const { nickname, type } = parseParams(req.body || {});
    console.log('[event] body=', JSON.stringify(req.body));
    console.log('[event] parsed=', { nickname, type });

    if (!nickname || !type) {
      return res.status(200).json(kakaoText('파라미터가 부족합니다. (nickname, type)'));
    }

    // 2) 닉네임 변경: 시트 접근 없이 즉시 응답
    if (type === 'nick_change') {
      return res.status(200).json(kakaoText(`알림: ${nickname} 님이 닉네임을 변경했습니다.`));
    }

    // 3) 입장: 이때만 Sheets 초기화/쓰기
    if (type === 'join') {
      if (!SHEET_ID) {
        return res.status(200).json(kakaoText('서버 설정오류: 시트 ID가 없습니다.'));
      }
      let sheets;
      try {
        sheets = await getSheetsClient();
      } catch (e) {
        console.error('[event] auth/init error:', e && e.stack ? e.stack : e);
        return res.status(200).json(kakaoText('구글 인증 오류가 발생했습니다.'));
      }

      try {
        const count = await upsertJoinEvent(sheets, SHEET_ID, nickname);
        if (count === 1) {
          return res.status(200).json(kakaoText(`환영합니다, ${nickname}님! (첫 입장)`));
        }
        return res.status(200).json(kakaoText(`알림: "${nickname}" 닉네임은 이번이 ${count}번째 입장입니다.`));
      } catch (e) {
        console.error('[event] sheets write error:', e && e.stack ? e.stack : e);
        return res.status(200).json(kakaoText('시트 기록 중 오류가 발생했습니다.'));
      }
    }

    // 기타 타입
    return res.status(200).json(kakaoText('이벤트 처리 완료'));
  } catch (e) {
    console.error('[event] fatal:', e && e.stack ? e.stack : e);
    return res.status(200).json(kakaoText('서버 오류가 발생했습니다.'));
  }
};
