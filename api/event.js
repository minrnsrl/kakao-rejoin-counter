// api/event.js
// Vercel Serverless Function for Kakao OpenBuilder
// - join: 동일 닉네임 입장 횟수 카운트 후 안내
// - nick_change: 닉네임 변경 안내 (카운트 X)

const { google } = require('googleapis');
const { v4: uuidv4 } = require('uuid');

// ====== 설정(환경변수) ======
const SHEET_ID = process.env.SHEET_ID; // 구글 시트 ID (필수)
const CREDENTIALS_JSON = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON; // 서비스계정 JSON 전체 (필수)
const AUTH_HEADER_KEY = process.env.X_AUTH_HEADER_KEY || 'x-auth-token';  // 선택: 보안 토큰 헤더 키
const AUTH_HEADER_VAL = process.env.X_AUTH_HEADER_VAL || '';              // 선택: 보안 토큰 값

// 시트 탭/범위
const SHEET_TAB = 'log';       // 탭 이름 (A: nickname, B: enter_count, C: last_join_iso, D: last_event, E: uuid)
const SHEET_RANGE_ALL = `${SHEET_TAB}!A:E`;
const SHEET_RANGE_ROWS = `${SHEET_TAB}!A2:E`;

// ====== 공용 도우미 ======
function kakaoText(text) {
  return {
    version: '2.0',
    template: { outputs: [{ simpleText: { text } }] }
  };
}

function nowIso() {
  return new Date().toISOString();
}

// 오픈빌더 바디 안전 파싱: body.nickname / body.type 또는 action.params.* / detailParams.* 를 모두 지원
function parseParams(body = {}) {
  const directNick = body.nickname;
  const directType = body.type;

  const a = body.action?.params || {};
  const d = body.action?.detailParams || {};

  const fromActionNick = a.nickname ?? d.nickname?.value;
  const fromActionType = a.type ?? d.type?.value;

  const nickname = directNick || fromActionNick;
  const type = directType || fromActionType;

  return { nickname, type };
}

// ====== Google Sheets 클라이언트 ======
async function getSheetsClient() {
  if (!CREDENTIALS_JSON) throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS_JSON');
  const credentials = JSON.parse(CREDENTIALS_JSON);

  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];
  const jwt = new google.auth.JWT(credentials.client_email, null, credentials.private_key, scopes);
  await jwt.authorize();
  return google.sheets({ version: 'v4', auth: jwt });
}

// 닉네임으로 행 찾기 (A열)
async function findRowByNickname(sheets, spreadsheetId, nickname) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: SHEET_RANGE_ROWS
  });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const [name] = rows[i];
    if ((name || '').trim() === String(nickname).trim()) {
      return { rowIndex: i + 2, row: rows[i] }; // 헤더가 1행이므로 +2
    }
  }
  return null;
}

// join / nick_change 처리 (join일 때만 enter_count +1)
async function upsertOnEvent(sheets, spreadsheetId, nickname, type) {
  const found = await findRowByNickname(sheets, spreadsheetId, nickname);
  const now = nowIso();

  if (!found) {
    // 신규 닉네임
    const enterCount = type === 'join' ? 1 : 0;
    const values = [[nickname, enterCount, type === 'join' ? now : '', type, uuidv4()]];
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: SHEET_RANGE_ALL,
      valueInputOption: 'RAW',
      requestBody: { values }
    });
    return enterCount; // 0 or 1
  } else {
    // 기존 닉네임
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
      spreadsheetId,
      range: `${SHEET_TAB}!A${rowIndex}:E${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values }
    });
    return nextCount;
  }
}

// ====== 핸들러 ======
module.exports = async (req, res) => {
  try {
    // 간단 헬스체크 (GET)
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
      console.error('[event] 405 method not allowed:', req.method);
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    // (선택) 헤더 토큰 검증
    if (AUTH_HEADER_VAL) {
      const incoming = req.headers[AUTH_HEADER_KEY] || req.headers[AUTH_HEADER_KEY.toLowerCase()];
      if (incoming !== AUTH_HEADER_VAL) {
        console.error('[event] 401 invalid token');
        return res.status(401).json(kakaoText('인증 실패'));
      }
    }

    // 기본 환경 변수 확인
    if (!SHEET_ID) {
      console.error('[event] missing SHEET_ID env');
      return res.status(200).json(kakaoText('서버 설정오류: 시트 ID가 없습니다.'));
    }
    if (!CREDENTIALS_JSON) {
      console.error('[event] missing GOOGLE_APPLICATION_CREDENTIALS_JSON env');
      return res.status(200).json(kakaoText('서버 설정오류: 인증키가 없습니다.'));
    }

    // 원본 바디 로깅
    console.log('[event] raw body =', JSON.stringify(req.body));

    // 파라미터 파싱
    const { nickname, type } = parseParams(req.body);
    console.log('[event] parsed params =', { nickname, type });

    if (!nickname || !type) {
      console.error('[event] missing params:', { nickname, type });
      return res.status(200).json(kakaoText('파라미터가 부족합니다. (nickname, type)'));
    }

    // Sheets 클라이언트 생성
    const sheets = await getSheetsClient();

    // 타입 분기
    if (type === 'nick_change') {
      // 닉네임 변경은 카운트 증가 없이 안내만
      console.log('[event] nick_change for', nickname);
      return res.status(200).json(kakaoText(`알림: ${nickname} 님이 닉네임을 변경했습니다.`));
    }

    if (type === 'join') {
      const count = await upsertOnEvent(sheets, SHEET_ID, nickname, 'join');
      console.log('[event] join count =', count, 'nickname =', nickname);
      if (count === 1) {
        return res.status(200).json(kakaoText(`환영합니다, ${nickname}님! (첫 입장)`));
      }
      return res.status(200).json(kakaoText(`알림: "${nickname}" 닉네임은 이번이 ${count}번째 입장입니다.`));
    }

    // 기타 타입(확장 대비)
    console.log('[event] other type =', type);
    return res.status(200).json(kakaoText('이벤트 처리 완료'));
  } catch (e) {
    console.error('[event] ERROR:', e && e.stack ? e.stack : e);
    return res.status(200).json(kakaoText('서버 오류가 발생했습니다.'));
  }
};
