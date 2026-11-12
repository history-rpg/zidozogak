-- 지도 조각 대모험 랭킹·이용 현황 저장소 (Cloudflare D1)
-- 여러 번 실행해도 안전하도록 IF NOT EXISTS
CREATE TABLE IF NOT EXISTS scores (
  dev TEXT NOT NULL,            -- 기기마다 만든 무작위 번호 (개인 정보 아님)
  nick TEXT NOT NULL,           -- 별명 2~8글자
  region TEXT NOT NULL,         -- 시도
  total INTEGER NOT NULL,
  animal INTEGER, alien INTEGER, photo INTEGER, passport INTEGER, quiz INTEGER, secret INTEGER, road INTEGER, piece INTEGER,
  play INTEGER,                 -- 플레이 시간(분)
  created TEXT, updated TEXT,
  PRIMARY KEY (dev, nick)
);
CREATE INDEX IF NOT EXISTS idx_total ON scores(total DESC);
CREATE INDEX IF NOT EXISTS idx_region ON scores(region, total DESC);
CREATE TABLE IF NOT EXISTS visits (day TEXT PRIMARY KEY, opens INTEGER DEFAULT 0, starts INTEGER DEFAULT 0, endings INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS live (dev TEXT PRIMARY KEY, seen INTEGER);
CREATE TABLE IF NOT EXISTS ratings (dev TEXT PRIMARY KEY, stars INTEGER, created TEXT);
